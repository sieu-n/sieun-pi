#!/usr/bin/env python3
"""The copy rig's stand-in for cpu-protect.py (sieun-pi deploy/linux/cpu/cpu-protect.py, which is root and moves only the live units): every
2 s it moves the copy unit's MainPID into <unit>-core.scope, a scope outside the unit's cgroup, and every other process found in that scope
back into the unit, the same plan cpu-protect.py runs for sieun-pi-apps-chat.service. systemd --user then drops a notify from a process in
the scope, as it does on live.

Usage: mover.py <unit>   (run.sh starts it; it runs until stopped and starts the scope itself with a sleep as its first process)"""
import os
import subprocess
import sys
import time

UNIT = sys.argv[1]
SCOPE = UNIT.removesuffix(".service") + "-core.scope"
INTERVAL_S = 2  # cpu-protect.py INTERVAL_S
ROOT = f"/sys/fs/cgroup/user.slice/user-{os.getuid()}.slice/user@{os.getuid()}.service/app.slice"


def procs(cgroup: str) -> list[int]:
    try:
        with open(f"{ROOT}/{cgroup}/cgroup.procs") as fh:
            return [int(line) for line in fh if line.strip()]
    except FileNotFoundError:
        return []


def main_pid() -> int:
    out = subprocess.run(["systemctl", "--user", "show", "-p", "MainPID", "-p", "ActiveState", UNIT], capture_output=True, text=True).stdout
    props = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    return int(props.get("MainPID", "0") or 0) if props.get("ActiveState") == "active" else 0


def move(pid: int, cgroup: str) -> None:
    try:
        with open(f"{ROOT}/{cgroup}/cgroup.procs", "w") as fh:
            fh.write(str(pid))
        print(f"{time.strftime('%H:%M:%S')} moved {pid} to {cgroup}", flush=True)
    except OSError as error:
        print(f"{time.strftime('%H:%M:%S')} could not move {pid} to {cgroup}: {error}", flush=True)


def comm(pid: int) -> str:
    try:
        with open(f"/proc/{pid}/comm") as fh:
            return fh.read().strip()
    except OSError:
        return ""


subprocess.run(["systemd-run", "--user", "--scope", "--collect", f"--unit={SCOPE}", "--", "sh", "-c", "sleep infinity &"], check=False)
while True:
    main = main_pid()
    if main:
        for pid in procs(UNIT):
            if pid == main:
                move(pid, SCOPE)
        for pid in procs(SCOPE):
            if pid != main and comm(pid) != "sleep":
                move(pid, UNIT)
    time.sleep(INTERVAL_S)
