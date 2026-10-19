#!/usr/bin/python3 -B
"""Gives the Prime supervisor and its workers nice -10 while the commands they run stay at 0, CPU layer 2 of deploy/linux/README.md.

The owner's t84 answer on 10-19 put CPU priority on us-metal02 under https://cho.sh/ko/1983DC. The supervisor, its workers and their job
commands share prime-agent-daemon.service's cgroup, so a unit weight would lift the commands too. Within one cgroup the scheduler weighs each
thread by its nice value, and nice -10 weighs 9548 against 1024 for nice 0, the same 10 to 1 as CPUWeight 1000 against the default 100. A user
cannot lower a nice value, so root sets it. Nice is per thread, so each pass sets every thread of every prime-agent process, and a process forked
from a worker inherits -10, so each pass puts every other thread of the unit below 0 back to 0. A thread a job niced up keeps its value.
"""
import os
import sys
import time

USER = os.environ.get("CPU_PROTECT_USER", "sieun")
DAEMON = "prime-agent-daemon.service"
CORE_NICE = -10
# A pass over the daemon's 2731 threads took 28 ms of CPU on us-metal02 at 19:5xZ on 10-19, so passes 2 s apart cost about 1.4% of one core,
# and a job command runs at most 2 s at -10 before it goes back to 0.
INTERVAL_S = 2


def plan(threads: dict[int, tuple[str, int]]) -> dict[int, int]:
    """The writes that bring every thread to its nice value. threads maps tid -> (comm of its process, its nice value)."""
    writes = {}
    for tid, (comm, nice) in threads.items():
        if comm == "prime-agent":
            if nice != CORE_NICE:
                writes[tid] = CORE_NICE
        elif nice < 0:
            writes[tid] = 0
    return writes


def read(path: str) -> str | None:
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return None


def snapshot(unit: str) -> dict[int, tuple[str, int]]:
    threads = {}
    for line in (read(f"{unit}/cgroup.procs") or "").split():
        comm = read(f"/proc/{line}/comm")
        try:
            tids = os.listdir(f"/proc/{line}/task")
        except OSError:
            continue
        if comm is None:
            continue
        for tid in map(int, tids):
            try:
                threads[tid] = (comm.strip(), os.getpriority(os.PRIO_PROCESS, tid))
            except OSError:
                pass
    return threads


def run_once(unit: str) -> None:
    threads = snapshot(unit)
    for tid, nice in plan(threads).items():
        try:
            os.setpriority(os.PRIO_PROCESS, tid, nice)
        except OSError:
            pass


if __name__ == "__main__":
    import pwd
    uid = pwd.getpwnam(USER).pw_uid
    unit = f"/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service/app.slice/{DAEMON}"
    while True:
        run_once(unit)
        if "--once" in sys.argv:
            break
        time.sleep(INTERVAL_S)
