#!/usr/bin/env python3
"""Install idle-reaper from one commit and run it every 5 minutes under launchd.

usage: python3 -B legacy/prime/idle-reaper/install.py --ref <commit>
       python3 -B legacy/prime/idle-reaper/install.py uninstall

Copies reaper.py from <commit> to ~/.local/share/idle-reaper and loads com.sieun.idle-reaper,
so a later checkout change cannot alter the running copy until someone installs again.
`uninstall` boots the agent out and deletes its plist, and keeps the log.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
HOME = Path.home()
SHARE = HOME / ".local/share/idle-reaper"
LABEL = "com.sieun.idle-reaper"
PLIST = HOME / "Library/LaunchAgents" / f"{LABEL}.plist"
PYTHON = "/usr/bin/python3"  # the installed copy lives outside ~/Documents, so the system Python can read it
DOMAIN = f"gui/{os.getuid()}"


def write(path: Path, text: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text)
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def git(*args: str) -> str:
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    return subprocess.run(["git", "-C", str(REPO), *args], env=env, check=True, capture_output=True, text=True).stdout


def plist(script: Path) -> str:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key><array><string>{PYTHON}</string><string>-B</string><string>{script}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>{SHARE / 'last-run.txt'}</string>
  <key>StandardErrorPath</key><string>{SHARE / 'reaper.err'}</string>
</dict>
</plist>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("action", nargs="?", default="install", choices=["install", "uninstall"])
    parser.add_argument("--ref")
    args = parser.parse_args()
    subprocess.run(["launchctl", "bootout", f"{DOMAIN}/{LABEL}"], capture_output=True)
    if args.action == "uninstall":
        PLIST.unlink(missing_ok=True)
        print(f"{LABEL} removed; log kept in {SHARE / 'reaper.log'}")
        return 0
    if not args.ref:
        parser.error("install needs --ref <commit>")
    sha = git("rev-parse", "--verify", f"{args.ref}^{{commit}}").strip()
    script = SHARE / "reaper.py"
    write(script, git("show", f"{sha}:legacy/prime/idle-reaper/reaper.py"), 0o755)
    write(SHARE / "release.json", json.dumps({"sha": sha, "installedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}) + "\n", 0o644)
    write(PLIST, plist(script), 0o644)
    subprocess.run(["launchctl", "bootstrap", DOMAIN, str(PLIST)], check=True)
    print(f"idle-reaper {sha[:7]} installed as {LABEL}; log in {SHARE / 'reaper.log'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
