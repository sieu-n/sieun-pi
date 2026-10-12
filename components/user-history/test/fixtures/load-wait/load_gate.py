#!/usr/bin/env python3
"""Exit 0 once the Mac passes the load gate on 2 samples in a row.

Gate numbers come from the mac-memory-guard LaunchAgent (alerts on free memory
under 20% or 1m load over 30, each on 2 samples in a row), harness memory 2026-10-12.
Run it with bash() and end the turn; the handle's completion wakes the caller.
"""
import re, subprocess, sys, time

def sample():
    load1 = float(subprocess.run(["sysctl", "-n", "vm.loadavg"], capture_output=True, text=True).stdout.split()[1])
    out = subprocess.run(["memory_pressure"], capture_output=True, text=True).stdout
    free = int(re.search(r"free percentage: (\d+)%", out).group(1))
    return load1, free

ok = 0
while True:
    load1, free = sample()
    ok = ok + 1 if (load1 < 30 and free >= 20) else 0
    print(f"{time.strftime('%H:%M:%S')} load1={load1} free={free}% ok={ok}", flush=True)
    if ok >= 2:
        sys.exit(0)
    time.sleep(60)
