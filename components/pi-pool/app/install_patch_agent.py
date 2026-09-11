#!/usr/bin/python3 -B
import argparse
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import tempfile


HERE = Path(__file__).resolve().parent
CODE_ROOT = HERE.parent
LABEL = "com.sieun.pi-pool-patch"
RUNTIME_FILES = ("patch_prime_agent.py", "pi-pool-status.js")


def write_if_changed(path, content, staging_dir):
    if path.is_file() and path.read_bytes() == content:
        return
    with tempfile.NamedTemporaryFile(dir=staging_dir, delete=False) as staged:
        staged.write(content)
    try:
        os.replace(staged.name, path)
    finally:
        Path(staged.name).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description="Print the pi-pool patch LaunchAgent plist; --write generates its runtime and plist without loading it.")
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--prime-root", default=os.environ.get("PI_POOL_PRIME_AGENT_ROOT"))
    args = parser.parse_args()
    home = Path.home().resolve()
    state = Path(os.environ.get("PI_POOL_DIR") or home / ".config" / "pi-pool").expanduser().resolve()
    destination = home / "Library" / "LaunchAgents" / (LABEL + ".plist")
    runtime_root = home / ".local" / "share" / "sieun-pi" / "pool-patch"
    runtime_app = runtime_root / "app"
    if any(path.resolve().is_relative_to(CODE_ROOT) for path in (state, destination, runtime_app)):
        parser.error("state, runtime and LaunchAgent files must be outside the pi-pool source directory")
    if runtime_app.resolve().is_relative_to(home / "Documents"):
        parser.error("generated patch runtime must be outside Documents")
    if state.is_relative_to(runtime_root.resolve()):
        parser.error("PI_POOL_DIR must be outside the generated patch runtime")
    if args.prime_root:
        root = Path(args.prime_root).expanduser().resolve()
    else:
        executable = shutil.which("prime-agent")
        if not executable:
            parser.error("prime-agent not found on PATH; pass --prime-root")
        root = Path(executable).resolve().parents[2]
    if not (root / "package.json").is_file():
        parser.error("--prime-root must contain Prime Agent package.json")
    if root.is_relative_to(CODE_ROOT):
        parser.error("Prime Agent must be outside the pi-pool source directory")
    environment = {
        "HOME": str(home),
        "PATH": os.environ.get("PATH", os.defpath),
        "PI_POOL_DIR": str(state),
        "PI_POOL_PRIME_AGENT_ROOT": str(root),
        "PRIME_AGENT_CODING_AGENT_DIR": os.environ.get("PRIME_AGENT_CODING_AGENT_DIR") or str(home / ".prime" / "agent"),
    }
    command = "sleep 20; exec /usr/bin/python3 -B " + shlex.quote(str(runtime_app / "patch_prime_agent.py")) + " apply --bundle-only"
    content = plistlib.dumps({
        "Label": LABEL,
        "ProgramArguments": ["/bin/sh", "-c", command],
        "EnvironmentVariables": environment,
        "WatchPaths": [str(root.parent), str(root / "package.json")],
        "StartInterval": 1800,
        "RunAtLoad": True,
        "ThrottleInterval": 30,
        "StandardOutPath": str(state / "patch.out.log"),
        "StandardErrorPath": str(state / "patch.err.log"),
    })
    if not args.write:
        print(content.decode(), end="")
        return
    if destination.is_symlink():
        parser.error("refusing to replace a symlink at " + str(destination))
    if runtime_root.is_symlink() or runtime_app.is_symlink():
        parser.error("refusing a symlinked patch runtime")
    if runtime_app.exists():
        if not runtime_app.is_dir():
            parser.error("patch runtime app path is not a directory")
        for path in runtime_app.iterdir():
            if path.name not in RUNTIME_FILES or path.is_symlink() or not path.is_file():
                parser.error("unexpected patch runtime entry: " + str(path))
    runtime_content = {name: (HERE / name).read_bytes() for name in RUNTIME_FILES}
    destination.parent.mkdir(parents=True, exist_ok=True)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    runtime_app.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name, data in runtime_content.items():
        write_if_changed(runtime_app / name, data, runtime_root)
    write_if_changed(destination, content, destination.parent)
    print(str(destination))


if __name__ == "__main__":
    main()
