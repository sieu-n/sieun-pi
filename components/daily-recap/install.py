#!/usr/bin/env python3
"""Preview a daily recap runtime and launchd plist; write only with --write.

This command never reads config.env, installs packages, or calls launchctl.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import sys
import tempfile

SOURCE = Path(__file__).resolve().parent
LABEL = "com.sieun.daily-recap"
RUNTIME_FILES = (
    "daily_recap.py", "drifty_focus_export.py", "sunsama_fetch.mjs", "run.sh", "launchd_entry.sh",
)
PACKAGE_FILES = ("package.json", "package-lock.json")


def absolute(value: str) -> Path:
    return Path(value).expanduser().absolute()


def bounded_int(low: int, high: int):
    def parse(value: str) -> int:
        number = int(value)
        if not low <= number <= high:
            raise argparse.ArgumentTypeError(f"must be between {low} and {high}")
        return number
    return parse


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="write the reviewed runtime files and plist; never load launchd")
    parser.add_argument("--runtime", type=absolute, default=Path.home() / ".prime/agent/daily-recap")
    parser.add_argument("--plist", type=absolute, default=Path.home() / f"Library/LaunchAgents/{LABEL}.plist")
    parser.add_argument("--hour", type=bounded_int(0, 23), default=21)
    parser.add_argument("--minute", type=bounded_int(0, 59), default=0)
    parser.add_argument("--node-bin-dir", type=absolute, help="Node/prime-agent directory to prepend to launchd PATH")
    return parser.parse_args(argv)


def reject_symlink(path: Path) -> None:
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError(f"refusing symlink destination: {part}")


def build_plan(args: argparse.Namespace) -> dict[Path, bytes]:
    runtime, plist = args.runtime, args.plist
    resolved = runtime.resolve()
    if resolved == SOURCE or resolved in SOURCE.parents or SOURCE in resolved.parents:
        raise ValueError("runtime must not overlap the source component")
    if "Documents" in resolved.parts:
        raise ValueError("runtime must be outside Documents for launchd")
    config = runtime / "config.env"
    files = {runtime / "bin" / name: (SOURCE / name).read_bytes() for name in RUNTIME_FILES}
    files.update({runtime / name: (SOURCE / name).read_bytes() for name in PACKAGE_FILES})
    files[runtime / "config.example.env"] = (SOURCE / "config.example.env").read_bytes()
    if not config.exists():
        files[config] = (SOURCE / "config.example.env").read_bytes()
    node_dir = args.node_bin_dir
    if node_dir is None:
        node = shutil.which("node")
        node_dir = Path(node).parent if node else None
    search_path = ":".join(str(item) for item in (node_dir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin") if item)
    definition = {
        "Label": LABEL,
        "ProgramArguments": ["/bin/bash", str(runtime / "bin/launchd_entry.sh")],
        "WorkingDirectory": str(runtime),
        "EnvironmentVariables": {"PATH": search_path, "HOME": str(Path.home()), "NO_COLOR": "1"},
        "StartCalendarInterval": {"Hour": args.hour, "Minute": args.minute},
        "RunAtLoad": False,
        "StandardOutPath": str(runtime / "logs/launchd.out.log"),
        "StandardErrorPath": str(runtime / "logs/launchd.err.log"),
    }
    protected = (config, runtime / "state", runtime / "reports", runtime / "logs", runtime / "node_modules")
    if (SOURCE == plist.resolve() or SOURCE in plist.resolve().parents
            or plist == runtime or plist in runtime.parents
            or plist in files or any(plist == item or item in plist.parents for item in protected)):
        raise ValueError("plist must not overwrite source, a runtime file, or private data")
    files[plist] = plistlib.dumps(definition, sort_keys=False)
    for path in (*files, *protected):
        reject_symlink(path)
    return files


def write_file(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
        os.chmod(temporary, 0o700 if path.suffix == ".sh" else 0o600)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        files = build_plan(args)
        if args.write:
            for directory in ("bin", "state", "reports", "logs"):
                (args.runtime / directory).mkdir(parents=True, exist_ok=True)
            for path, data in files.items():
                write_file(path, data)
        print(json.dumps({
            "mode": "write" if args.write else "dry-run",
            "runtime": str(args.runtime),
            "files": [{"path": str(path), "sha256": hashlib.sha256(data).hexdigest()} for path, data in files.items()],
            "config": "created from disabled template" if args.runtime / "config.env" in files else "preserved without reading",
            "schedule": {"hour": args.hour, "minute": args.minute, "timezone": "system local time"},
            "plist": plistlib.loads(files[args.plist]),
            "services_loaded": False,
            "dependencies_installed": False,
        }, indent=2))
        return 0
    except (OSError, ValueError) as exc:
        print(f"daily-recap install failed ({type(exc).__name__}): {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
