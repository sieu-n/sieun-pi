#!/usr/bin/env python3
"""Run the unowned scratch reaper (job-leftovers.ts unowned --scratch) every hour on the Mac under launchd.

usage: python3 -B components/scratch-reaper/install.py
       python3 -B components/scratch-reaper/install.py remove

The run deletes the folders in ~/scratch that no owner record on any box names, that changed over 2 h ago and that nothing uses
(job-leftovers.ts reapUnowned), and logs one line per folder to ~/.local/state/sieun-pi/unowned-reaped.jsonl. It runs from the installed
runtime (~/.local/share/sieun-pi-runtime/current) when the box has one, else from this checkout. Until 11-18 nothing ran it on a schedule, so
~/scratch/sieun-pi-runtime-8fClKx (258 MB) sat on the Mac from 19:52Z on 11-17 until a hand run. The hour follows from the 2 h idle line:
a folder goes within 3 h of its last write. launchd's calendar interval also fires at wake when the Mac slept through the hour.
On us-metal02 the Komodo Procedure m02-scratch-reaper runs the same command hourly at :09 from the job service scratch-reaper of the
Stack box-sieun-pi (auto-sns-agent apps/infra/box/compose.sieun-pi.yml), so this installer refuses to run on Linux.
"""
from __future__ import annotations

import os
import platform
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path

HOME = Path.home()
CHECKOUT = Path(__file__).resolve().parents[2]
RUNTIME = HOME / ".local/share/sieun-pi-runtime/current"
LABEL = "com.sieun.scratch-reaper"
LOG = HOME / ".local/state/sieun-pi/scratch-reaper.log"
PATH = os.pathsep.join([str(HOME / ".local/node/bin"), str(HOME / ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])


def command() -> tuple[list[str], Path]:
    root = RUNTIME if RUNTIME.exists() else CHECKOUT
    node = shutil.which("node", path=PATH)
    if not node:
        sys.exit(f"no node on {PATH}")
    return [node, "--import", "tsx", "src/job-leftovers.ts", "unowned", "--scratch"], root / "legacy/prime/user-history"


def write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.with_name(path.name + ".tmp").write_bytes(data)
    os.replace(path.with_name(path.name + ".tmp"), path)


def install_launchd(argv: list[str], cwd: Path) -> None:
    plist = HOME / "Library/LaunchAgents" / f"{LABEL}.plist"
    write(plist, plistlib.dumps({"Label": LABEL, "ProgramArguments": argv, "WorkingDirectory": str(cwd), "RunAtLoad": True,
                                 "StartCalendarInterval": {"Minute": 7}, "EnvironmentVariables": {"PATH": PATH},
                                 "StandardOutPath": str(LOG), "StandardErrorPath": str(LOG), "ProcessType": "Background"}))
    domain = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", f"{domain}/{LABEL}"], capture_output=True)
    subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True)


def remove() -> None:
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], capture_output=True)
    (HOME / "Library/LaunchAgents" / f"{LABEL}.plist").unlink(missing_ok=True)


def main() -> int:
    if platform.system() != "Darwin":
        sys.exit("on us-metal02 the Komodo Procedure m02-scratch-reaper runs the reaper (auto-sns-agent apps/infra/box/compose.sieun-pi.yml)")
    if sys.argv[1:] == ["remove"]:
        remove()
        print("scratch-reaper removed")
        return 0
    argv, cwd = command()
    LOG.parent.mkdir(parents=True, exist_ok=True)
    install_launchd(argv, cwd)
    print(f"scratch-reaper runs hourly at :07 from {cwd}; log {LOG}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
