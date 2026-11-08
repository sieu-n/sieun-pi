#!/usr/bin/env python3
"""Install the idle session archive sweep from one commit and run it once a day under systemd.

usage: python3 -B components/session-archive/install.py --ref <commit>
       python3 -B components/session-archive/install.py rollback

Writes sweep.py from <commit> to ~/.local/share/session-archive/releases/<sha>/, points `current` at it in one rename, writes
session-archive.service and .timer into ~/.config/systemd/user and enables the timer. A second install of the same commit
changes nothing. `rollback` points `current` back at the release it replaced.
"""
from __future__ import annotations

import argparse
import os
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SHARE = Path.home() / ".local/share/session-archive"
UNITS = Path.home() / ".config/systemd/user"
UNIT_FILES = ("session-archive.service", "session-archive.timer")


def git(*args: str) -> str:
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    return subprocess.run(["git", "-C", str(REPO), *args], env=env, check=True, capture_output=True, text=True).stdout


def point(target: Path) -> None:
    current, previous = SHARE / "current", SHARE / "previous"
    if current.is_symlink() and current.resolve() != target.resolve():
        tmp = SHARE / "previous.tmp"
        tmp.unlink(missing_ok=True)
        tmp.symlink_to(current.resolve())
        os.replace(tmp, previous)
    tmp = SHARE / "current.tmp"
    tmp.unlink(missing_ok=True)
    tmp.symlink_to(target)
    os.replace(tmp, current)


def install(ref: str) -> None:
    sha = git("rev-parse", "--verify", f"{ref}^{{commit}}").strip()
    release = SHARE / "releases" / sha
    release.mkdir(parents=True, exist_ok=True)
    (release / "sweep.py").write_text(git("show", f"{sha}:components/session-archive/sweep.py"))
    point(release)
    UNITS.mkdir(parents=True, exist_ok=True)
    for name in UNIT_FILES:
        (UNITS / name).write_text(git("show", f"{sha}:components/session-archive/{name}"))
    (Path.home() / ".prime/agent/session-archive").mkdir(parents=True, exist_ok=True)
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "--user", "enable", "--now", "session-archive.timer"], check=True)
    print(f"session-archive: installed {sha[:12]} at {release}")


def rollback() -> None:
    previous = SHARE / "previous"
    if not previous.is_symlink():
        raise SystemExit("session-archive: no previous release to roll back to")
    point(previous.resolve())
    print(f"session-archive: current is {previous.resolve()}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Install the idle session archive sweep.")
    parser.add_argument("command", nargs="?", choices=["rollback"])
    parser.add_argument("--ref")
    args = parser.parse_args()
    if args.command == "rollback":
        rollback()
    elif args.ref:
        install(args.ref)
    else:
        parser.error("pass --ref <commit> or rollback")


if __name__ == "__main__":
    main()
