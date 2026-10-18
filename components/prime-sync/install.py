#!/usr/bin/env python3
"""Install prime-sync from one commit and run it every minute.

usage: python3 -B components/prime-sync/install.py --ref <commit> [--host <name>] [--state-repo <url>]

Copies sync.py from <commit> to ~/.local/share/prime-sync, writes ~/.config/prime-sync/sync.json, clones the state repo,
installs the timer (prime-sync.timer under systemd --user on Linux, com.sieun.prime-sync under launchd on macOS) and runs one sync.
The timer runs the Python that ran this installer. On macOS that Python needs access to the checkout's folder: launchd jobs
under /usr/bin/python3 get "Operation not permitted" in ~/Documents, while /opt/homebrew/bin/python3 reads it.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HOME = Path.home()
SHARE = HOME / ".local/share/prime-sync"
CONFIG = HOME / ".config/prime-sync/sync.json"
STATE_REPO = "https://github.com/sieu-n/prime-shared-state.git"
PYTHON = sys.executable
LABEL = "com.sieun.prime-sync"
GIT_ENV = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}


def write(path: Path, text: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text)
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(REPO), *args], env=GIT_ENV, check=True, capture_output=True, text=True).stdout


def systemd_units(script: Path) -> dict[str, str]:
    service = f"""[Unit]
Description=prime-sync: skills, AGENTS.md, harness entries and the corrections ledger match every box
After=network-online.target

[Service]
Type=oneshot
Nice=10
ExecStart={PYTHON} -B {script}
StandardOutput=null
StandardError=append:{SHARE / 'sync.err'}
"""
    timer = """[Unit]
Description=Run prime-sync every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
"""
    return {"prime-sync.service": service, "prime-sync.timer": timer}


def launchd_plist(script: Path) -> str:
    path = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key><array><string>{PYTHON}</string><string>-B</string><string>{script}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>{path}</string></dict>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>{SHARE / 'sync.err'}</string>
</dict>
</plist>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--ref", required=True)
    parser.add_argument("--host")
    parser.add_argument("--state-repo")
    args = parser.parse_args()
    sha = git("rev-parse", "--verify", f"{args.ref}^{{commit}}").strip()
    script = SHARE / "sync.py"
    write(script, git("show", f"{sha}:components/prime-sync/sync.py"), 0o755)
    write(SHARE / "release.json", json.dumps({"sha": sha, "installedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}) + "\n", 0o644)

    config = json.loads(CONFIG.read_text()) if CONFIG.exists() else {}
    config.update({"checkout": str(REPO), "agentDir": config.get("agentDir", "~/.prime/agent"),
                   "stateDir": config.get("stateDir", str(SHARE / "state")),
                   "stateRepo": args.state_repo or config.get("stateRepo", STATE_REPO)})
    if args.host:
        config["host"] = args.host
    write(CONFIG, json.dumps(config, indent=2) + "\n", 0o600)
    state = Path(os.path.expanduser(config["stateDir"]))
    if not (state / ".git").exists():
        subprocess.run(["git", "clone", "--quiet", config["stateRepo"], str(state)], env=GIT_ENV, check=True)

    first = subprocess.run([PYTHON, "-B", str(script)], env=GIT_ENV, capture_output=True, text=True)
    sys.stdout.write(first.stdout + first.stderr)
    if platform.system() == "Linux":
        units = HOME / ".config/systemd/user"
        for name, text in systemd_units(script).items():
            write(units / name, text, 0o644)
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
        subprocess.run(["systemctl", "--user", "enable", "--now", "prime-sync.timer"], check=True)
    else:
        plist = HOME / "Library/LaunchAgents" / f"{LABEL}.plist"
        write(plist, launchd_plist(script), 0o644)
        domain = f"gui/{os.getuid()}"
        subprocess.run(["launchctl", "bootout", f"{domain}/{LABEL}"], capture_output=True)
        subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True)
    print(f"prime-sync {sha[:7]} installed; status in {SHARE / 'status.json'}")
    return first.returncode


if __name__ == "__main__":
    sys.exit(main())
