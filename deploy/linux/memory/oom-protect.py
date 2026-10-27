#!/usr/bin/python3 -B
"""Keeps the harness core at a low OOM score, memory layer 5 of https://cho.sh/ko/1983DC (owner ask, 2026-10-19).

A user unit cannot lower its own oom_score_adj, so root sets it. Each pass reads the main PIDs of the protected user
units and writes their scores. A process forked from a protected one inherits its low score, so every other process in
those units goes back to the user units' default of 200, the value systemd --user gave every unit on us-metal02 on 10-19.
Prime workers spawn kernels and agent commands, which must stay killable.

The dev servers (auto-sns-dev-pm2.service with every pm2 app, and llm-wiki.service) go to -500 in every process, so
earlyoom takes them after the CI guests (qemu:ci-, avoided, about 390) and every adj-200 agent command (800). Every
agent writes its session to the wiki on :5176, and search on :5174 takes 60 to 97 s to cold start (ops, 2026-10-26).

Every agent command starts its own session (rlm bash() runs with start_new_session), and its forks stay in it. The
command session whose processes hold the most RAM and swap goes to 1000 in every process, when that sum is more than any
one killable process outside it holds, and its id goes to MARK_FILE. Then the kernel and earlyoom pick it before
anything else, and earlyoom's -N hook (oom-kill-session.py) kills the rest of it. Both killers score one process at a
time, so a tree of small processes never came first: from 02:17 to 02:28Z on 10-26 a recursive agent command grew to
11,017 bash processes of 4 to 33 MB each, 101 GB of RAM and 65 GB of swap in the daemon unit. The kernel killed 7 prod
Chromiums (adj 300) and two node builds (500), its 50 MB memcg killed earlyoom, and earlyoom killed 22 pytest runs and 6
CI guests, while the tree kept growing until it ended on its own.

A command that comes in over ssh runs in a login session scope (user-<uid>.slice/session-*.scope) and inherits -500
from tailscaled or sshd, so every process in those scopes except the ssh carriers goes back to 200 as well. When the
Prime supervisor itself runs in such a scope, its scope counts as the daemon unit. On 10-27 a Prime supervisor started
over ssh at 12:55Z took over the daemon socket, and until the box hung at 15:14:58Z its 61 workers, 135 kernels and
every agent command ran in session-c155369.scope at -500, where no pass of this script looked. They held about 80 GB
of RAM and swap that neither earlyoom nor the kernel would pick, and earlyoom killed 314 small processes of score 200
and more instead.
"""
import os
import subprocess
import sys
import time

USER = os.environ.get("OOM_PROTECT_USER", "sieun")
DAEMON = "prime-agent-daemon.service"
CORE_UNITS = (DAEMON, "sieun-pi-chat.service", "pi-pool-serve.service", "pi-pool-hookd.service")
DEV_UNITS = ("auto-sns-dev-pm2.service", "llm-wiki.service")
SSH_CARRIERS = ("tailscaled", "sshd", "sshd-session")
MAIN_ADJ = -900
WORKER_ADJ = -500
DEV_ADJ = -500
UNIT_DEFAULT_ADJ = 200
MARK_ADJ = 1000
MARK_FILE = "/run/oom-protect/marked-session"
# A pass reads about 400 processes in these four units; 5 s bounds how long an agent command keeps an inherited score.
INTERVAL_S = 5
seen_scope: str | None = None


def plan(units: dict[str, dict[int, str]], main_pids: dict[str, int], current: dict[int, int],
         marked: frozenset[int] = frozenset()) -> dict[int, int]:
    """The writes that bring every process in the core units to its score. units maps unit -> {pid: comm}, and marked
    holds the processes of the command session that goes first (runaway)."""
    writes = {}
    for unit, procs in units.items():
        main = main_pids.get(unit, 0)
        for pid, comm in procs.items():
            if comm in SSH_CARRIERS:
                continue
            if unit in DEV_UNITS:
                if current.get(pid, UNIT_DEFAULT_ADJ) > UNIT_DEFAULT_ADJ:
                    continue
                want = DEV_ADJ
            elif pid == main:
                want = MAIN_ADJ
            elif unit == DAEMON and comm == "prime-agent":
                want = WORKER_ADJ
            elif pid in marked:
                want = MARK_ADJ
            elif current.get(pid, UNIT_DEFAULT_ADJ) < UNIT_DEFAULT_ADJ or (unit == DAEMON and current.get(pid) == MARK_ADJ):
                want = UNIT_DEFAULT_ADJ
            else:
                continue
            if current.get(pid) != want:
                writes[pid] = want
    return writes


def is_login_scope(unit: str) -> bool:
    return unit.startswith("session-") and unit.endswith(".scope")


def daemon_scope(units: dict[str, dict[int, str]], main: int) -> str | None:
    """The login scope that holds the daemon's main process, when a supervisor started over ssh owns the socket."""
    return next((unit for unit, procs in units.items() if is_login_scope(unit) and main in procs), None)


def with_scope_as_daemon(units: dict[str, dict[int, str]], scope: str | None) -> dict[str, dict[int, str]]:
    if scope is None:
        return units
    merged = {unit: procs for unit, procs in units.items() if unit != scope}
    merged[DAEMON] = {**units.get(DAEMON, {}), **units[scope]}
    return merged


def runaway(procs: dict[int, str], main: int, sessions: dict[int, int], memory: dict[int, int]) -> int | None:
    """The command session in the daemon unit that goes first: the one whose processes hold the most RAM and swap, when
    that sum is more than any one killable process outside it holds. A session that holds the main process or a Prime
    worker is a worker's, with its kernels, and never a command's."""
    protected = {pid for pid, comm in procs.items() if pid == main or comm == "prime-agent"}
    worker_sessions = {sessions[pid] for pid in protected if pid in sessions}
    totals: dict[int, int] = {}
    for pid in procs:
        sid = sessions.get(pid)
        if sid is not None and sid not in worker_sessions:
            totals[sid] = totals.get(sid, 0) + memory.get(pid, 0)
    if not totals:
        return None
    sid = max(totals, key=lambda s: totals[s])
    largest_outside = max((memory.get(pid, 0) for pid in procs if pid not in protected and sessions.get(pid) != sid), default=0)
    return sid if totals[sid] > largest_outside else None


def read(path: str) -> str | None:
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return None


def snapshot(uid: int) -> tuple[dict[str, dict[int, str]], dict[int, int]]:
    user_slice = f"/sys/fs/cgroup/user.slice/user-{uid}.slice"
    app = f"{user_slice}/user@{uid}.service/app.slice"
    logins = sorted(name for name in os.listdir(user_slice) if is_login_scope(name))
    units, current = {}, {}
    for unit, path in [(unit, f"{app}/{unit}") for unit in CORE_UNITS + DEV_UNITS] + [(name, f"{user_slice}/{name}") for name in logins]:
        procs = {}
        pids = []
        for cg, _, _ in os.walk(path):
            pids += (read(f"{cg}/cgroup.procs") or "").split()
        for line in pids:
            pid = int(line)
            comm, adj = read(f"/proc/{pid}/comm"), read(f"/proc/{pid}/oom_score_adj")
            if comm is None or adj is None:
                continue
            procs[pid] = comm.strip()
            current[pid] = int(adj)
        units[unit] = procs
    return units, current


def session_and_memory(pids) -> tuple[dict[int, int], dict[int, int]]:
    """Each process's session id from /proc/<pid>/stat and its RAM plus swap in kB (VmRSS + VmSwap)."""
    sessions, memory = {}, {}
    for pid in pids:
        stat, status = read(f"/proc/{pid}/stat"), read(f"/proc/{pid}/status")
        if stat is None or status is None:
            continue
        sessions[pid] = int(stat.rsplit(")", 1)[1].split()[3])
        memory[pid] = sum(int(line.split()[1]) for line in status.splitlines() if line.startswith(("VmRSS:", "VmSwap:")))
    return sessions, memory


def main_pids() -> dict[str, int]:
    out = subprocess.run(["systemctl", "--user", f"--machine={USER}@", "show", "-p", "MainPID", "--value", *CORE_UNITS],
                         capture_output=True, text=True).stdout
    values = [line for line in out.split("\n") if line.strip()]
    return {unit: int(value) for unit, value in zip(CORE_UNITS, values) if value.isdigit()}


def write_mark(sid: int | None) -> int | None:
    """Writes the marked session id to MARK_FILE, or removes it, and returns the id it held before."""
    before = read(MARK_FILE)
    if sid is None:
        if before is not None:
            os.remove(MARK_FILE)
    elif before != f"{sid}\n":
        os.makedirs(os.path.dirname(MARK_FILE), exist_ok=True)
        with open(f"{MARK_FILE}.tmp", "w") as f:
            f.write(f"{sid}\n")
        os.replace(f"{MARK_FILE}.tmp", MARK_FILE)
    return int(before) if before and before.strip().isdigit() else None


def run_once(uid: int) -> None:
    units, current = snapshot(uid)
    mains = main_pids()
    global seen_scope
    scope = daemon_scope(units, mains.get(DAEMON, 0))
    if scope is not None and scope != seen_scope:
        print(f"the Prime supervisor {mains[DAEMON]} runs in {scope}, outside {DAEMON}; that scope is scored as the daemon", flush=True)
    seen_scope = scope
    units = with_scope_as_daemon(units, scope)
    procs = units.get(DAEMON, {})
    sessions, memory = session_and_memory(procs)
    sid = runaway(procs, mains.get(DAEMON, 0), sessions, memory)
    marked = frozenset(pid for pid in procs if sid is not None and sessions.get(pid) == sid)
    if write_mark(sid) != sid and sid is not None:
        held = sum(memory.get(pid, 0) for pid in marked) / 1048576
        print(f"session {sid} ({procs.get(sid, 'leader gone')}, {len(marked)} processes, {held:.1f} GiB RAM and swap) goes first at {MARK_ADJ}", flush=True)
    for pid, adj in plan(units, mains, current, marked).items():
        try:
            with open(f"/proc/{pid}/oom_score_adj", "w") as f:
                f.write(str(adj))
            if adj != MARK_ADJ:
                print(f"pid {pid} ({units_comm(units, pid)}) oom_score_adj {current.get(pid)} -> {adj}", flush=True)
        except OSError:
            pass


def units_comm(units: dict[str, dict[int, str]], pid: int) -> str:
    return next((procs[pid] for procs in units.values() if pid in procs), "?")


if __name__ == "__main__":
    import pwd
    uid = pwd.getpwnam(USER).pw_uid
    while True:
        run_once(uid)
        if "--once" in sys.argv:
            break
        time.sleep(INTERVAL_S)
