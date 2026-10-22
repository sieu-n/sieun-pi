#!/usr/bin/env python3
"""Install the Prime Agent watchdog from one commit and run it every 10 minutes under systemd or launchd.

usage: python3 -B components/watchdog/install.py --ref <commit>
       python3 -B components/watchdog/install.py rollback

Copies the watchdog's code from <commit> to ~/.local/share/prime-watchdog/releases/<sha>, points `current` at it in one
rename, and on Linux writes prime-agent-watchdog.service and .timer into ~/.config/systemd/user and enables the timer. On the
Mac, launchd's com.sieun.prime-agent-watchdog already runs ~/.prime/agent/watchdog/cron_cycle.py. The next run uses the new code; nothing running is stopped. The state and logs stay in ~/.prime/agent/watchdog, and each code
file name there becomes a link into `current`. Old copies (.bak files, tests, run_cycle.py) are deleted from that
folder. `rollback` points `current` back at the release it replaced.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HOME = Path.home()
SHARE = HOME / ".local/share/prime-watchdog"
WATCH = HOME / ".prime/agent/watchdog"
UNITS = HOME / ".config/systemd/user"
UNIT_FILES = ("prime-agent-watchdog.service", "prime-agent-watchdog.timer")
NOT_CODE = {"install.py", "README.md", *UNIT_FILES}
LEGACY = ("run_cycle.py", "test_repl_guard.py", "test_watchdog_pressure.py", "test_watchdog_scan.py", "test_watchdog_budget.py",
          "test_watchdog_heartbeats.py", "__pycache__")


def write(path: Path, text: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text)
    os.chmod(temporary, mode)
    os.replace(temporary, path)


def relink(link: Path, target: Path) -> None:
    temporary = link.with_name(link.name + ".tmp")
    if temporary.is_symlink() or temporary.exists():
        temporary.unlink()
    temporary.symlink_to(target)
    os.replace(temporary, link)


def git(*args: str) -> str:
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    return subprocess.run(["git", "-C", str(REPO), *args], env=env, check=True, capture_output=True, text=True).stdout


def code_files(sha: str) -> list[str]:
    names = git("ls-tree", "--name-only", sha, "components/watchdog/").split()
    return sorted(Path(n).name for n in names if Path(n).suffix in (".py", ".patch") and Path(n).name not in NOT_CODE)


def link_watch_folder(names: list[str]) -> list[str]:
    """Each code file name in ~/.prime/agent/watchdog points into `current`; old copies go. Returns what was deleted."""
    WATCH.mkdir(parents=True, exist_ok=True)
    gone = []
    for path in sorted(WATCH.iterdir()):
        if path.name in LEGACY or ".bak" in path.name:
            shutil.rmtree(path) if path.is_dir() and not path.is_symlink() else path.unlink()
            gone.append(path.name)
    for name in names:
        relink(WATCH / name, SHARE / "current" / name)
    return gone


def install_units() -> None:
    if platform.system() == "Darwin":
        return
    for name in UNIT_FILES:
        write(UNITS / name, (Path(__file__).resolve().parent / name).read_text(), 0o644)
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", "prime-agent-watchdog.timer"], check=True)


def install(ref: str) -> int:
    sha = git("rev-parse", "--verify", f"{ref}^{{commit}}").strip()
    names = code_files(sha)
    release = SHARE / "releases" / sha[:12]
    for name in names:
        write(release / name, git("show", f"{sha}:components/watchdog/{name}"), 0o755 if name.endswith(".py") else 0o644)
    write(release / "release.json", json.dumps({"sha": sha, "installedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}) + "\n", 0o644)
    current = SHARE / "current"
    before = os.readlink(current) if current.is_symlink() else None
    if before != str(Path("releases", sha[:12])):
        relink(current, Path("releases", sha[:12]))
        if before:
            relink(SHARE / "previous", Path(before))
    gone = link_watch_folder(names)
    install_units()
    print(f"watchdog {sha[:7]} installed in {release}; the next timer run uses it")
    if gone:
        print("deleted from " + str(WATCH) + ": " + ", ".join(gone))
    return 0


def rollback() -> int:
    previous = SHARE / "previous"
    if not previous.is_symlink():
        print("no previous release to roll back to", file=sys.stderr)
        return 1
    target, now = os.readlink(previous), os.readlink(SHARE / "current")
    relink(SHARE / "current", Path(target))
    relink(previous, Path(now))
    print(f"current -> {target}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("action", nargs="?", default="install", choices=["install", "rollback"])
    parser.add_argument("--ref")
    args = parser.parse_args()
    if platform.system() not in ("Linux", "Darwin"):
        parser.error("this installer knows systemd on Linux and launchd on the Mac")
    if args.action == "rollback":
        return rollback()
    if not args.ref:
        parser.error("install needs --ref <commit>")
    return install(args.ref)


if __name__ == "__main__":
    sys.exit(main())
