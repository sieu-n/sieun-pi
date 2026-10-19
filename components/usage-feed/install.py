#!/usr/bin/env python3
"""Install usage-feed from one commit and keep it running: launchd on the Mac, a systemd user service on Linux.

usage: python3 -B components/usage-feed/install.py --ref <commit>
       python3 -B components/usage-feed/install.py uninstall

Copies feed.py from <commit> to ~/.local/share/usage-feed, deletes an old `handed-off` marker and starts the feed, so a later
checkout change cannot alter the running copy until someone installs again. `uninstall` stops it and keeps the log.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HOME = Path.home()
SHARE = HOME / ".local/share/usage-feed"
LABEL = "com.sieun.usage-feed"
PLIST = HOME / "Library/LaunchAgents" / f"{LABEL}.plist"
UNIT = "usage-feed.service"
UNIT_FILE = HOME / ".config/systemd/user" / UNIT
MAC = sys.platform == "darwin"
PYTHON = "/usr/bin/python3"  # the installed copy lives outside ~/Documents, so the Mac's system Python can read it


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
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>{SHARE / 'feed.log'}</string>
  <key>StandardErrorPath</key><string>{SHARE / 'feed.log'}</string>
</dict>
</plist>
"""


def unit(script: Path) -> str:
    return f"""[Unit]
Description=usage-feed: Prime model call usage from session transcripts to LGTM until Prime's OTLP exporter is live (components/usage-feed)

[Service]
ExecStart=/usr/bin/python3 -B {script}
Restart=on-failure
StandardOutput=append:{SHARE / 'feed.log'}
StandardError=append:{SHARE / 'feed.log'}

[Install]
WantedBy=default.target
"""


def stop() -> None:
    if MAC:
        subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], capture_output=True)
    else:
        subprocess.run(["systemctl", "--user", "disable", "--now", UNIT], capture_output=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("action", nargs="?", default="install", choices=["install", "uninstall"])
    parser.add_argument("--ref")
    args = parser.parse_args()
    stop()
    if args.action == "uninstall":
        (PLIST if MAC else UNIT_FILE).unlink(missing_ok=True)
        if not MAC:
            subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
        print(f"usage-feed removed; log kept in {SHARE / 'feed.log'}")
        return 0
    if not args.ref:
        parser.error("install needs --ref <commit>")
    sha = git("rev-parse", "--verify", f"{args.ref}^{{commit}}").strip()
    script = SHARE / "feed.py"
    write(script, git("show", f"{sha}:components/usage-feed/feed.py"), 0o755)
    (SHARE / "handed-off").unlink(missing_ok=True)
    write(SHARE / "release.json", json.dumps({"sha": sha, "installedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}) + "\n", 0o644)
    if MAC:
        write(PLIST, plist(script), 0o644)
        subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(PLIST)], check=True)
    else:
        write(UNIT_FILE, unit(script), 0o644)
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
        subprocess.run(["systemctl", "--user", "enable", "--now", UNIT], check=True)
    print(f"usage-feed {sha[:7]} installed as {LABEL if MAC else UNIT}; log in {SHARE / 'feed.log'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
