#!/usr/bin/python3 -B
"""Keeps the agents' control loop in agents.slice and the commands it starts in prime-agent-tools.scope, CPU layer 2 of deploy/linux/README.md.

The owner's t84 answer on 10-19 put CPU priority on us-metal02 under https://cho.sh/ko/1983DC. Since 11-02 every process the Prime workers start
leaves prime-agent-daemon.service for prime-agent-tools.scope, a sibling in app.slice at the default weight: at 18:13Z on 11-02 the unit held 253
processes using 25.9 cores, of which the prime-agent processes used about 2.8, and worker f2f8b4ebd885 waited 1,418 ms for a CPU inside a 5,049
ms stall (~/work/prime-worker-stalls/for-metal-management.md).

Since 11-04 the control loop also leaves user.slice. The Prime supervisor, its workers, its two catalogs and pi-pool token helpers run in
prime-agent-daemon-core.scope, and the main process of each unit in SERVICES in a <unit>-core.scope, all in agents.slice, a root slice beside
virev.slice. A weight only counts against its siblings, and on each CPU a group's weight is its root weight times that CPU's share of its
load. So in user.slice at 1000 with about 25 busy cores of tools, the control loop got about 40 per CPU against CI's 10000 spread over its busy cores, and at 01:55 to
01:58Z on 11-04, right after virev.slice went from 4000 to 10000 (63214791), 14 worker stalls of 5 s or more followed, up to 65.6 s. In
agents.slice the same weight sits on the 2 to 3 cores the loop uses. Everything the loop starts still moves to the tools scope, and every
other process of those services goes back to its unit, so the tools, the job rigs and the services' helpers keep their user.slice weight
under CI (t68).

A user unit's cgroup always lies under user@<uid>.service, so the units stay where they are and own their processes: systemd --user still
starts, reloads and stops them and tracks each main PID, and only the processes move. A supervisor moves only once it is the unit's MainPID,
so a start or reload reads its PIDFile while the new supervisor still runs in the unit. prime-agent-daemon-ctl and what it starts stay in
the unit. Each scope has Delegate=yes, so writing a pid into its cgroup.procs is a supported move, and OOMPolicy=continue, so a kernel OOM
kill of one process ends only that process. systemd stops a scope once it is empty, and the next pass that has a process to move starts it
again with that process.

The catalogs are core because every rename and named create waits for the name catalog's answer. In the tools scope at weight 100, from 21:19Z
on 11-03 to 00:10Z on 11-04, the name catalog's main thread waited 13.3 s in the run queue per CPU-second used, against a median of 1.3 s for
the workers' main threads; in single seconds it waited 0.25 to 0.97 s for 1 to 4 time slices, and at 23:37:52Z a rename's name check took 2,767 ms.

A split inside the unit (Delegate=yes with core and tools leaves) was tried on a scratch unit first. It works live, but systemd 259 then cannot
start the unit while the workers it left behind under KillMode=process still run: it spawns the start task into the unit's own cgroup, whose
enabled controllers refuse a process, and the start fails with EBUSY. The unit's own cgroup stays a plain leaf here, and on 11-04 a scratch
Type=forking unit with KillMode=process whose main process sat in a system scope reloaded, restarted after its main process died, and started
again, and a Type=simple one with KillMode=mixed stopped with its child in the unit killed and its scope gone.
"""
import os
import pwd
import subprocess
import sys
import time

USER = os.environ.get("CPU_PROTECT_USER", "sieun")
DAEMON = "prime-agent-daemon.service"
# The units whose main process serves the owner. meilisearch.service and pi-history.service stay out: their index threads ran 92% and 94% of
# their CPU (10,343 s of 11,289 s and 49,335 s of 52,328 s, read from /proc on 11-04 at 02:5xZ), batch work that must not meet CI as an equal.
SERVICES = ("sieun-pi-chat.service", "sieun-pi-apps-chat.service", "pi-host.service", "pi-host-relay.service")
TOOLS = "prime-agent-tools.scope"
AGENTS = "agents.slice"
# measured: from 19:15 to 19:46Z on 11-02 the passes used 8.6 s of CPU in 31.5 min, 0.46% of one core, so a new process runs at most 2 s in the
# unit before it moves.
INTERVAL_S = 2

Procs = dict[int, tuple[int, list[str]]]


def core(unit: str) -> str:
    """The scope in agents.slice that holds a unit's core processes."""
    return unit.removesuffix(".service") + "-core.scope"


CORE = core(DAEMON)


def runs(argv: list[str], name: str) -> bool:
    """Whether the command is the program name, run directly or through an interpreter (python3 -B <path>)."""
    return any(os.path.basename(arg) == name for arg in argv[:3])


def is_daemon(argv: list[str], public_dir: str) -> bool:
    """A `prime-agent --mode daemon` whose socket lies in the public daemon's directory: the supervisor or one of its workers."""
    if not argv or os.path.basename(argv[0]) != "prime-agent" or "--mode" not in argv or "--daemon-socket" not in argv:
        return False
    mode, sock = argv.index("--mode") + 1, argv.index("--daemon-socket") + 1
    return argv[mode:mode + 1] == ["daemon"] and os.path.dirname(argv[sock] if sock < len(argv) else "") == public_dir


def is_supervisor(argv: list[str], public_dir: str) -> bool:
    """The supervisor: the daemon on the public socket itself, where each worker listens on a socket of its own beside it."""
    return is_daemon(argv, public_dir) and os.path.basename(argv[argv.index("--daemon-socket") + 1]) == "daemon.sock"


def under_ctl(pid: int, procs: Procs) -> bool:
    seen = set()
    while pid in procs and pid not in seen:
        if runs(procs[pid][1], "prime-agent-daemon-ctl"):
            return True
        seen.add(pid)
        pid = procs[pid][0]
    return False


def plan(groups: dict[str, Procs], mains: dict[str, int | None], public_dir: str) -> dict[str, list[int]]:
    """The moves that bring each process to its place, as target -> pids. groups maps each unit and scope name (DAEMON, CORE, TOOLS, and each
    of SERVICES with its core scope) to pid -> (ppid, argv) of that cgroup's processes, TOOLS only its prime-agent ones; mains maps DAEMON and
    each of SERVICES to the unit's MainPID, None when unknown.

    The supervisor goes to CORE once it is the daemon's MainPID and back to the unit while it is not; its workers, its catalogs and pi-pool token
    helpers go to CORE, and every other process of the daemon's side to TOOLS. prime-agent-daemon-ctl and what it starts stay in the unit. A
    service's MainPID goes to its core scope and every other process there back to its unit."""
    side = {**groups.get(TOOLS, {}), **groups.get(CORE, {}), **groups.get(DAEMON, {})}
    main = mains.get(DAEMON)

    def place(pid: int, ppid: int, argv: list[str], here: str) -> str:
        if is_supervisor(argv, public_dir):
            return here if main is None else CORE if pid == main else DAEMON
        by_supervisor = bool(argv) and os.path.basename(argv[0]) == "prime-agent" and ppid in side and is_supervisor(side[ppid][1], public_dir)
        return CORE if is_daemon(argv, public_dir) or by_supervisor or runs(argv, "pi-pool-token") else TOOLS

    moves: dict[str, list[int]] = {}
    for here in (DAEMON, CORE, TOOLS):
        for pid, (ppid, argv) in groups.get(here, {}).items():
            to = here if here == DAEMON and under_ctl(pid, side) else place(pid, ppid, argv, here)
            if to != here:
                moves.setdefault(to, []).append(pid)
    for unit in SERVICES:
        if mains.get(unit) is None:
            continue
        for here, to, wanted in ((unit, core(unit), True), (core(unit), unit, False)):
            for pid in groups.get(here, {}):
                if (pid == mains[unit]) == wanted:
                    moves.setdefault(to, []).append(pid)
    return {to: sorted(pids) for to, pids in moves.items()}


def candidates(groups: dict[str, Procs], manager: int, public_dir: str) -> frozenset[tuple[str, int]]:
    """The processes that may be a MainPID the last ask did not see: a supervisor that no ctl runs, wherever it is, and each child of the user
    manager in a service's unit or core scope. A start or reload makes a new one, so the steady state asks systemd nothing."""
    side = {**groups.get(TOOLS, {}), **groups.get(CORE, {}), **groups.get(DAEMON, {})}
    found = {(DAEMON, pid) for here in (DAEMON, CORE, TOOLS) for pid, (_, argv) in groups.get(here, {}).items()
             if is_supervisor(argv, public_dir) and not under_ctl(pid, side)}
    found |= {(unit, pid) for unit in SERVICES for here in (unit, core(unit)) for pid, (ppid, _) in groups.get(here, {}).items() if ppid == manager}
    return frozenset(found)


def read(path: str) -> str | None:
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return None


def procs(cgroup: str, only_comm: str | None = None) -> Procs:
    """pid -> (ppid, argv) of a cgroup's processes; with only_comm, only those whose comm is that."""
    found = {}
    for line in (read(f"{cgroup}/cgroup.procs") or "").split():
        pid = int(line)
        if only_comm is not None and (read(f"/proc/{pid}/comm") or "").strip() != only_comm:
            continue
        stat, cmdline = read(f"/proc/{pid}/stat"), read(f"/proc/{pid}/cmdline")
        if stat is None or cmdline is None:
            continue
        found[pid] = (int(stat.rsplit(")", 1)[1].split()[1]), [arg for arg in cmdline.split("\0") if arg])
    return found


def as_user(argv: list[str]) -> list[str]:
    """argv run as the user through setpriv on the user's own bus. `--machine=<user>@.host` starts a unit and a session scope of its own for
    each call, and a root ssh login's DBUS_SESSION_BUS_ADDRESS names root's bus, which fails with EPERM (11-02 23:47Z)."""
    entry = pwd.getpwnam(USER)
    return ["setpriv", f"--reuid={entry.pw_uid}", f"--regid={entry.pw_gid}", "--init-groups", "env", f"XDG_RUNTIME_DIR=/run/user/{entry.pw_uid}",
            f"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{entry.pw_uid}/bus", *argv]


def parse_mains(out: str, units: tuple[str, ...]) -> dict[str, int | None]:
    """Each unit's MainPID from `systemctl show -p Id -p MainPID -p ActiveState`, None when there is none, and for each of SERVICES also
    while the unit is not active yet. systemd --user drops a notification whose sender lies outside the unit's cgroup, and the chat's READY=1
    comes from a systemd-notify child, which starts in the cgroup of its parent. So a main process moved to its core scope before its READY=1
    left the unit starting: on 11-08 sieun-pi-chat sent READY=1 at 14:42:19Z, 21:55:28Z and 22:01:18Z and systemd counted it started only at
    14:49:53Z, never and 22:06:20Z. A move also races the start itself: at 09:29:13Z its process, moved before it ran node, failed to attach to
    the unit's cgroup (status=219/CGROUP)."""
    shown = {}
    for block in out.split("\n\n"):
        props = dict(line.split("=", 1) for line in block.strip().split("\n") if "=" in line)
        if props.get("Id"):
            shown[props["Id"]] = props
    mains: dict[str, int | None] = {}
    for unit in units:
        props = shown.get(unit, {})
        value = props.get("MainPID", "")
        started = unit not in SERVICES or props.get("ActiveState") == "active"
        mains[unit] = int(value) if value.isdigit() and value != "0" and started else None
    return mains


def main_pids() -> dict[str, int | None]:
    units = (DAEMON, *SERVICES)
    out = subprocess.run(as_user(["systemctl", "--user", "show", "-p", "Id", "-p", "MainPID", "-p", "ActiveState", *units]), capture_output=True, text=True).stdout
    return parse_mains(out, units)


def start_scope(name: str, pid: int, user: bool) -> None:
    """Starts a scope with pid as its first process: the tools scope in the user's app.slice, a core scope in the system's agents.slice."""
    slice_, about = ("app.slice", "Commands the Prime workers start") if user else (AGENTS, "The agents' control loop")
    call = ["busctl", *(["--user"] if user else []), "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager",
            "StartTransientUnit", "ssa(sv)a(sa(sv))", name, "fail", "5", "PIDs", "au", "1", str(pid), "Delegate", "b", "true", "OOMPolicy", "s", "continue",
            "Slice", "s", slice_, "Description", "s", f"{about}, CPU layer 2 of sieun-pi deploy/linux/README.md", "0"]
    subprocess.run(as_user(call) if user else call, capture_output=True, text=True)


def move(pid: int, cgroup: str, source: str) -> bool:
    """Writes pid into cgroup when it still lies in source, so a process that a handoff moved meanwhile stays where it went."""
    if (read(f"/proc/{pid}/cgroup") or "").strip() != f"0::{source.removeprefix('/sys/fs/cgroup')}":
        return False
    try:
        with open(f"{cgroup}/cgroup.procs", "w") as f:
            f.write(str(pid))
        return True
    except OSError:
        return False


def nice_to_zero(pid: int) -> None:
    try:
        tids = os.listdir(f"/proc/{pid}/task")
    except OSError:
        return
    for tid in map(int, tids):
        try:
            if os.getpriority(os.PRIO_PROCESS, tid) < 0:
                os.setpriority(os.PRIO_PROCESS, tid, 0)
        except OSError:
            pass


def run_once(paths: dict[str, str], known: tuple[dict[str, int | None], frozenset], manager: int, public_dir: str) -> tuple[dict[str, int | None], frozenset]:
    """One pass. known is the MainPIDs from the last ask and the candidates it saw. A pass asks again when the candidates changed, while a
    supervisor that is not the known MainPID runs outside a ctl, because systemd reads the PIDFile only after the ctl that wrote it exits, and
    while a service that has a candidate is still starting (parse_mains)."""
    groups = {name: procs(path, only_comm="prime-agent" if name == TOOLS else None) for name, path in paths.items()}
    mains, seen = known
    now = candidates(groups, manager, public_dir)
    if now != seen or any(unit == DAEMON and pid != mains.get(DAEMON) or unit in SERVICES and mains.get(unit) is None for unit, pid in now):
        mains, seen = main_pids(), now
    for to, pids in plan(groups, mains, public_dir).items():
        if to.endswith(".scope") and not os.path.isdir(paths[to]):
            start_scope(to, pids[0], user=to == TOOLS)
        for pid in pids:
            source = next(paths[name] for name, found in groups.items() if pid in found)
            if move(pid, paths[to], source) and to == TOOLS:
                nice_to_zero(pid)
    return mains, seen


if __name__ == "__main__":
    uid = pwd.getpwnam(USER).pw_uid
    user = f"/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service"
    app, agents = f"{user}/app.slice", f"/sys/fs/cgroup/{AGENTS}"
    paths = {name: f"{app}/{name}" for name in (DAEMON, TOOLS, *SERVICES)} | {core(unit): f"{agents}/{core(unit)}" for unit in (DAEMON, *SERVICES)}
    known: tuple[dict[str, int | None], frozenset] = ({}, frozenset({("", 0)}))
    while True:
        manager = int((read(f"{user}/init.scope/cgroup.procs") or "0").split()[0])
        known = run_once(paths, known, manager, f"/tmp/prime-agent-{uid}")
        if "--once" in sys.argv:
            break
        time.sleep(INTERVAL_S)
