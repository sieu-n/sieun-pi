#!/usr/bin/python3 -B
"""earlyoom's -N hook: after each earlyoom kill, SIGKILL the rest of the agent command session that oom-protect.py marked.

earlyoom kills one process per pick, so a session of thousands of small forks would take thousands of picks; on 10-26 a
recursive agent command held 11,017 bash processes when the box ran out of RAM and swap. oom-protect.py writes that
session's id to MARK_FILE and sets every process in it to 1000, which forks inherit, so earlyoom's pick comes from it.
This hook kills only processes that are in that session and still carry 1000, so a stale file or a reused id kills
nothing. It runs as earlyoom's user, with earlyoom's CAP_KILL.
"""
import os
import signal
from importlib.util import module_from_spec, spec_from_file_location

spec = spec_from_file_location("oom_protect", os.path.join(os.path.dirname(os.path.abspath(__file__)), "oom-protect.py"))
oom = module_from_spec(spec)
spec.loader.exec_module(oom)


def members(sid: int, proc: str = "/proc") -> list[int]:
    """The processes in session sid that still carry oom-protect's mark."""
    found = []
    for name in os.listdir(proc):
        if not name.isdigit():
            continue
        stat, adj = oom.read(f"{proc}/{name}/stat"), oom.read(f"{proc}/{name}/oom_score_adj")
        if stat is None or adj is None:
            continue
        if int(stat.rsplit(")", 1)[1].split()[3]) == sid and int(adj) == oom.MARK_ADJ:
            found.append(int(name))
    return found


def main() -> None:
    held = oom.read(oom.MARK_FILE)
    if not held or not held.strip().isdigit():
        return
    sid = int(held)
    pids = members(sid)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    print(f"oom-kill-session: earlyoom took pid {os.environ.get('EARLYOOM_PID', '?')} ({os.environ.get('EARLYOOM_NAME', '?')}); "
          f"SIGKILLed {len(pids)} processes of the marked session {sid}", flush=True)


if __name__ == "__main__":
    main()
