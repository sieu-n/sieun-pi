#!/usr/bin/env python3
"""Install usage-feed from one commit and keep it running: launchd on the Mac, a Komodo container on Linux (us-metal02).

usage: python3 -B legacy/prime/usage-feed/install.py --ref <commit>
       python3 -B legacy/prime/usage-feed/install.py uninstall

Copies feed.py from <commit> to ~/.local/share/usage-feed, deletes an old `handed-off` marker and starts the feed, so a later
checkout change cannot alter the running copy until someone installs again. `uninstall` stops it and keeps the log (the Mac only).
On Linux the feed is the container box-sieun-pi-usage-feed-1 of the Komodo Stack box-sieun-pi (auto-sns-agent
apps/infra/box/compose.sieun-pi.yml), which runs ~/.local/share/usage-feed/feed.py, so the install restarts the container.
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
sys.path.insert(0, str(REPO / "deploy/linux"))
import komodo_stack  # noqa: E402

HOME = Path.home()
SHARE = HOME / ".local/share/usage-feed"
LABEL = "com.sieun.usage-feed"
PLIST = HOME / "Library/LaunchAgents" / f"{LABEL}.plist"
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


def stop() -> None:
    subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], capture_output=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("action", nargs="?", default="install", choices=["install", "uninstall"])
    parser.add_argument("--ref")
    args = parser.parse_args()
    if args.action == "uninstall":
        if not MAC:
            parser.error("on Linux the feed is a service of the Komodo Stack box-sieun-pi; remove it from auto-sns-agent apps/infra/box/compose.sieun-pi.yml")
        stop()
        PLIST.unlink(missing_ok=True)
        print(f"usage-feed removed; log kept in {SHARE / 'feed.log'}")
        return 0
    if not args.ref:
        parser.error("install needs --ref <commit>")
    sha = git("rev-parse", "--verify", f"{args.ref}^{{commit}}").strip()
    script = SHARE / "feed.py"
    write(script, git("show", f"{sha}:legacy/prime/usage-feed/feed.py"), 0o755)
    (SHARE / "handed-off").unlink(missing_ok=True)
    write(SHARE / "release.json", json.dumps({"sha": sha, "installedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}) + "\n", 0o644)
    if not MAC:
        komodo_stack.restart("usage-feed")
        print(f"usage-feed {sha[:7]} installed; the Komodo container {komodo_stack.STACK}-usage-feed-1 runs it; log in {SHARE / 'feed.log'}")
        return 0
    stop()
    write(PLIST, plist(script), 0o644)
    subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(PLIST)], check=True)
    print(f"usage-feed {sha[:7]} installed as {LABEL}; log in {SHARE / 'feed.log'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
