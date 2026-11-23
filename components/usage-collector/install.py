#!/usr/bin/env python3
"""Installs the usage collector on this box: one command, and a second run changes nothing.

usage: python3 -B components/usage-collector/install.py [--dry-run] [--home DIR] [--no-service]

1. Copies usage_collector/ into ~/.local/share/usage-collector/app, so the service never reads the checkout, which prime-sync moves
   every minute and which macOS keeps launchd jobs out of under Documents.
2. Writes the systemd user unit usage-collector.service on Linux, or the launchd agent com.sieun.usage-collector on macOS, running
   `collect --loop 10`.
3. Enables and starts it, and restarts it only when the copy or the unit changed.

The first pass of a client with no cursor reads back 90 days, so the service's first pass is the backfill. Each client runs in its own
thread, so the Prime backfill never holds back pi-host's live rows, and a separate backfill unit would only race the service for the
same cursors.

The sink config ~/.config/usage-collector/sink.json must exist first (usage_collector/sink.py lists its keys); the install stops without it.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List

HERE = Path(__file__).resolve().parent
LABEL = "com.sieun.usage-collector"
UNIT = "usage-collector.service"
LOOP_S = "10"


def python() -> str:
    return "/usr/bin/python3" if Path("/usr/bin/python3").exists() else (shutil.which("python3") or sys.executable)


def app_files() -> Dict[str, bytes]:
    files = {}
    for path in sorted((HERE / "usage_collector").rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts:
            files[str(path.relative_to(HERE))] = path.read_bytes()
    files["schema.sql"] = (HERE / "schema.sql").read_bytes()
    return files


def systemd_unit(app: Path) -> str:
    return f"""[Unit]
Description=usage-collector: this box's model calls into usage.model_calls
After=network-online.target

[Service]
WorkingDirectory={app}
ExecStart={python()} -B -m usage_collector collect --loop {LOOP_S}
UnsetEnvironment=PYTHONPATH
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
"""


def launchd_plist(app: Path, home: Path) -> str:
    log = home / "Library/Logs/usage-collector.log"
    args = "".join(f"\n    <string>{a}</string>" for a in [python(), "-B", "-m", "usage_collector", "collect", "--loop", LOOP_S])
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>{args}
  </array>
  <key>WorkingDirectory</key>
  <string>{app}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"""


def sync(target: Path, files: Dict[str, bytes], dry_run: bool) -> List[str]:
    """Makes `target` hold exactly `files`; returns what changed."""
    changed = []
    for name, data in files.items():
        path = target / name
        if not path.exists() or path.read_bytes() != data:
            changed.append(f"write {path}")
            if not dry_run:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
    if target.exists():
        for path in sorted(target.rglob("*")):
            if path.is_file() and str(path.relative_to(target)) not in files and "__pycache__" not in path.parts:
                changed.append(f"remove {path}")
                if not dry_run:
                    path.unlink()
    return changed


def run(command: List[str], dry_run: bool, changes: List[str]) -> subprocess.CompletedProcess:
    changes.append("run " + " ".join(command))
    if dry_run:
        return subprocess.CompletedProcess(command, 0, "", "")
    return subprocess.run(command, capture_output=True, text=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="print what would change, change nothing")
    parser.add_argument("--home", default=str(Path.home()), help="install under this home (a test home needs --no-service)")
    parser.add_argument("--no-service", action="store_true", help="write the files only; never call systemctl or launchctl")
    args = parser.parse_args()
    home = Path(args.home).expanduser()
    if not (home / ".config/usage-collector/sink.json").exists():
        print(f"no sink config at {home}/.config/usage-collector/sink.json; write it first (see usage_collector/sink.py)", file=sys.stderr)
        if not args.dry_run:
            return 2
    app = home / ".local/share/usage-collector/app"
    code = sync(app, app_files(), args.dry_run)
    service: List[str] = []
    if sys.platform == "darwin":
        unit_path = home / "Library/LaunchAgents" / f"{LABEL}.plist"
        unit = launchd_plist(app, home)
    else:
        unit_path = home / ".config/systemd/user" / UNIT
        unit = systemd_unit(app)
    unit_changed = [] if unit_path.exists() and unit_path.read_text() == unit else [f"write {unit_path}"]
    if unit_changed and not args.dry_run:
        unit_path.parent.mkdir(parents=True, exist_ok=True)
        unit_path.write_text(unit)
    changes = code + unit_changed
    if not args.no_service:
        if sys.platform == "darwin":
            domain = f"gui/{os.getuid()}"
            loaded = subprocess.run(["launchctl", "print", f"{domain}/{LABEL}"], capture_output=True).returncode == 0
            if loaded and unit_changed:
                run(["launchctl", "bootout", f"{domain}/{LABEL}"], args.dry_run, service)
                loaded = False
            if not loaded:
                run(["launchctl", "bootstrap", domain, str(unit_path)], args.dry_run, service)
            elif code:
                run(["launchctl", "kickstart", "-k", f"{domain}/{LABEL}"], args.dry_run, service)
        else:
            if unit_changed:
                run(["systemctl", "--user", "daemon-reload"], args.dry_run, service)
            enabled = subprocess.run(["systemctl", "--user", "is-enabled", "-q", UNIT]).returncode == 0
            active = subprocess.run(["systemctl", "--user", "is-active", "-q", UNIT]).returncode == 0
            if not enabled or not active:
                run(["systemctl", "--user", "enable", "--now", UNIT], args.dry_run, service)
            elif code or unit_changed:
                run(["systemctl", "--user", "restart", UNIT], args.dry_run, service)
    for line in changes + service:
        print(("would " if args.dry_run else "") + line)
    if not changes and not service:
        print("nothing to change")
    return 0


if __name__ == "__main__":
    sys.exit(main())
