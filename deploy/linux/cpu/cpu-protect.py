#!/usr/bin/python3 -B
"""Keeps the Prime supervisor and its workers alone in prime-agent-daemon.service and moves every process they start into
prime-agent-tools.scope, CPU layer 2 of deploy/linux/README.md.

The owner's t84 answer on 10-19 put CPU priority on us-metal02 under https://cho.sh/ko/1983DC. The daemon unit runs at CPUWeight 10000 so its
supervisor and workers win against the job rigs in app.slice, but until 11-02 the kernels and every command they ran shared that cgroup: at 18:13Z
on 11-02 it held 253 processes and used 25.9 cores, of which the prime-agent processes used about 2.8, and worker f2f8b4ebd885 waited 1,418 ms
for a CPU inside a 5,049 ms stall (~/work/prime-worker-stalls/for-metal-management.md). So each pass moves every process of the daemon unit that is
not core into the tools scope, a sibling of the unit in app.slice at the default weight, and its later children start there. Core is a
`prime-agent --mode daemon` on the public daemon's socket directory (the supervisor and its workers), a pi-pool token helper, and
prime-agent-daemon-ctl with what it starts, so a reload's update keeps running in the unit. A supervisor that an update started from the tools
scope goes back to the unit. A nice value below 0 that a moved process inherited from the old nice layer goes back to 0.

The scope has Delegate=yes, so writing a pid into its cgroup.procs is a supported move, and OOMPolicy=continue, so a kernel OOM kill of one
command ends only that command, as in the daemon unit. systemd stops the scope once it is empty, and the next pass that has a process to move
starts it again with that process.

A split inside the unit (Delegate=yes with core and tools leaves) was tried on a scratch unit first. It works live, but systemd 259 then cannot
start the unit while the workers it left behind under KillMode=process still run: it spawns the start task into the unit's own cgroup, whose
enabled controllers refuse a process, and the start fails with EBUSY.
"""
import os
import pwd
import subprocess
import sys
import time

USER = os.environ.get("CPU_PROTECT_USER", "sieun")
DAEMON = "prime-agent-daemon.service"
TOOLS = "prime-agent-tools.scope"
# measured: from 19:15 to 19:46Z on 11-02 the passes used 8.6 s of CPU in 31.5 min, 0.46% of one core, so a new process runs at most 2 s in the
# unit before it moves.
INTERVAL_S = 2


def runs(argv: list[str], name: str) -> bool:
    """Whether the command is the program name, run directly or through an interpreter (python3 -B <path>)."""
    return any(os.path.basename(arg) == name for arg in argv[:3])


def is_daemon(argv: list[str], public_dir: str) -> bool:
    """A `prime-agent --mode daemon` whose socket lies in the public daemon's directory: the supervisor or one of its workers."""
    if not argv or os.path.basename(argv[0]) != "prime-agent" or "--mode" not in argv or "--daemon-socket" not in argv:
        return False
    mode, sock = argv.index("--mode") + 1, argv.index("--daemon-socket") + 1
    return argv[mode:mode + 1] == ["daemon"] and os.path.dirname(argv[sock] if sock < len(argv) else "") == public_dir


def plan(daemon: dict[int, tuple[int, list[str]]], tools: dict[int, tuple[int, list[str]]], public_dir: str) -> tuple[list[int], list[int]]:
    """The moves that bring each process to its side: (pids from the unit to the scope, pids from the scope to the unit). daemon and tools map
    pid -> (ppid, argv) for the processes of each cgroup."""
    def under_ctl(pid: int) -> bool:
        seen = set()
        while pid in daemon and pid not in seen:
            if runs(daemon[pid][1], "prime-agent-daemon-ctl"):
                return True
            seen.add(pid)
            pid = daemon[pid][0]
        return False

    def core(pid: int) -> bool:
        argv = daemon[pid][1]
        return is_daemon(argv, public_dir) or runs(argv, "pi-pool-token") or under_ctl(pid)

    out = sorted(pid for pid in daemon if not core(pid))
    back = sorted(pid for pid, (_, argv) in tools.items() if is_daemon(argv, public_dir))
    return out, back


def read(path: str) -> str | None:
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return None


def procs(cgroup: str, only_comm: str | None = None) -> dict[int, tuple[int, list[str]]]:
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


def start_scope(pid: int) -> None:
    """Starts the tools scope in the user's manager with pid as its first process. It calls the user's bus as the user through setpriv, since
    `--machine=<user>@.host` starts a unit and a session scope of its own for each call. It names the bus by path, because `busctl --user`
    follows an inherited DBUS_SESSION_BUS_ADDRESS, and from a root ssh login that names root's bus and fails with EPERM (11-02 23:47Z)."""
    entry = pwd.getpwnam(USER)
    subprocess.run(["setpriv", f"--reuid={entry.pw_uid}", f"--regid={entry.pw_gid}", "--init-groups",
                    "busctl", f"--address=unix:path=/run/user/{entry.pw_uid}/bus", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
                    "org.freedesktop.systemd1.Manager", "StartTransientUnit", "ssa(sv)a(sa(sv))", TOOLS, "fail", "5",
                    "PIDs", "au", "1", str(pid), "Delegate", "b", "true", "OOMPolicy", "s", "continue", "Slice", "s", "app.slice",
                    "Description", "s", "Commands the Prime workers start, CPU layer 2 of sieun-pi deploy/linux/README.md", "0"],
                   capture_output=True, text=True)


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


def run_once(app: str, public_dir: str) -> None:
    unit, scope = f"{app}/{DAEMON}", f"{app}/{TOOLS}"
    out, back = plan(procs(unit), procs(scope, only_comm="prime-agent"), public_dir)
    if out and not os.path.isdir(scope):
        start_scope(out[0])
    for pid in out:
        if move(pid, scope, unit):
            nice_to_zero(pid)
    for pid in back:
        move(pid, unit, scope)


def nice_reset(app: str) -> None:
    """Puts every thread of the unit back to nice 0 once, after the old nice layer set the supervisor and workers to -10."""
    for pid in (read(f"{app}/{DAEMON}/cgroup.procs") or "").split():
        nice_to_zero(int(pid))


if __name__ == "__main__":
    uid = pwd.getpwnam(USER).pw_uid
    app = f"/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service/app.slice"
    public_dir = f"/tmp/prime-agent-{uid}"
    nice_reset(app)
    while True:
        run_once(app, public_dir)
        if "--once" in sys.argv:
            break
        time.sleep(INTERVAL_S)
