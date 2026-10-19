#!/usr/bin/python3 -B
"""Keeps the harness core at a low OOM score, memory layer 5 of https://cho.sh/ko/1983DC (owner ask, 2026-10-19).

A user unit cannot lower its own oom_score_adj, so root sets it. Each pass reads the main PIDs of the protected user
units and writes their scores. A process forked from a protected one inherits its low score, so every other process in
those units goes back to the user units' default of 200, the value systemd --user gave every unit on us-metal02 on 10-19.
Prime workers spawn kernels and agent commands, which must stay killable.
"""
import os
import subprocess
import sys
import time

USER = os.environ.get("OOM_PROTECT_USER", "sieun")
DAEMON = "prime-agent-daemon.service"
CORE_UNITS = (DAEMON, "sieun-pi-chat.service", "pi-pool-serve.service", "pi-pool-hookd.service")
MAIN_ADJ = -900
WORKER_ADJ = -500
UNIT_DEFAULT_ADJ = 200
# A pass reads about 400 processes in these four units; 5 s bounds how long an agent command keeps an inherited score.
INTERVAL_S = 5


def plan(units: dict[str, dict[int, str]], main_pids: dict[str, int], current: dict[int, int]) -> dict[int, int]:
    """The writes that bring every process in the core units to its score. units maps unit -> {pid: comm}."""
    writes = {}
    for unit, procs in units.items():
        main = main_pids.get(unit, 0)
        for pid, comm in procs.items():
            if pid == main:
                want = MAIN_ADJ
            elif unit == DAEMON and comm == "prime-agent":
                want = WORKER_ADJ
            elif current.get(pid, UNIT_DEFAULT_ADJ) < UNIT_DEFAULT_ADJ:
                want = UNIT_DEFAULT_ADJ
            else:
                continue
            if current.get(pid) != want:
                writes[pid] = want
    return writes


def read(path: str) -> str | None:
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return None


def snapshot(uid: int) -> tuple[dict[str, dict[int, str]], dict[int, int]]:
    app = f"/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service/app.slice"
    units, current = {}, {}
    for unit in CORE_UNITS:
        procs = {}
        for line in (read(f"{app}/{unit}/cgroup.procs") or "").split():
            pid = int(line)
            comm, adj = read(f"/proc/{pid}/comm"), read(f"/proc/{pid}/oom_score_adj")
            if comm is None or adj is None:
                continue
            procs[pid] = comm.strip()
            current[pid] = int(adj)
        units[unit] = procs
    return units, current


def main_pids() -> dict[str, int]:
    out = subprocess.run(["systemctl", "--user", f"--machine={USER}@", "show", "-p", "MainPID", "--value", *CORE_UNITS],
                         capture_output=True, text=True).stdout
    values = [line for line in out.split("\n") if line.strip()]
    return {unit: int(value) for unit, value in zip(CORE_UNITS, values) if value.isdigit()}


def run_once(uid: int) -> None:
    units, current = snapshot(uid)
    for pid, adj in plan(units, main_pids(), current).items():
        try:
            with open(f"/proc/{pid}/oom_score_adj", "w") as f:
                f.write(str(adj))
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
