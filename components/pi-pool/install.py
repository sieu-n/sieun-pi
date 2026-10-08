#!/usr/bin/python3 -B
"""Install pi-pool from a commit into its own folder, so Prime never runs checkout files.

    /usr/bin/python3 -B components/pi-pool/install.py [install] [--ref <commit>]
    /usr/bin/python3 -B components/pi-pool/install.py rollback
    /usr/bin/python3 -B components/pi-pool/install.py status

install exports components/pi-pool at the commit (default HEAD) into a staging
folder, runs the pool's Python tests there, renames it to releases/<tree id>,
points every runtime link at <root>/current, flips `current` in one rename, and
runs both token hooks through the runtime links. A hook that fails puts the
previous release back. rollback swaps `current` and `previous` and runs the same
check. State (state.json, pi-pool.log, config.json, accounts) never moves.
"""
import argparse, json, os, shutil, stat, subprocess, sys, tarfile, tempfile, time
from pathlib import Path

CHECKOUT = Path(__file__).resolve().parents[2]
COMPONENT = "components/pi-pool"
KEEP = 10
PROVIDERS = (["--provider", "anthropic"], ["--provider", "openai-codex"])
# Runtime link (under HOME) -> path inside the release. Prime's models.json names
# ~/.config/pi-pool/bin/pi-pool-token, so it follows `current` with no edit.
LINKS = {
    ".config/pi-pool/vend.py": "vend.py",
    ".config/pi-pool/app": "app",
    ".config/pi-pool/bin": "bin",
    ".local/bin/pi-pool": "bin/pi-pool",
    ".prime/agent/extensions/pi-pool": "app/extension",
}


class InstallError(Exception):
    pass


def root_of(home):
    return home / ".local/share/pi-pool"


def git(*args):
    return subprocess.run(["git", "-C", str(CHECKOUT), *args], check=True, capture_output=True, text=True).stdout.strip()


def relink(path, target):
    """Point `path` at `target` in one rename. Refuses to replace anything but a link."""
    if path.exists() and not path.is_symlink():
        raise InstallError(f"{path} is not a link; move it aside first")
    if path.is_symlink() and os.readlink(path) == str(target):
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.pi-pool-tmp")
    if tmp.is_symlink() or tmp.exists():
        tmp.unlink()
    os.symlink(target, tmp)
    os.replace(tmp, path)
    return True


def set_writable(path, writable):
    for directory, dirs, files in os.walk(path):
        for name in [*dirs, *files, None]:
            entry = Path(directory, name) if name else Path(directory)
            if entry.is_symlink():
                continue
            mode = entry.stat().st_mode
            os.chmod(entry, (mode | stat.S_IWUSR) if writable else (mode & ~0o222))


def export(ref, into):
    """components/pi-pool exactly as committed at `ref`: uncommitted edits never ship."""
    archive = subprocess.run(["git", "-C", str(CHECKOUT), "archive", "--format=tar", ref, COMPONENT],
                             check=True, capture_output=True).stdout
    with tempfile.TemporaryDirectory() as unpack:
        tar = Path(unpack, "a.tar")
        tar.write_bytes(archive)
        with tarfile.open(tar) as t:
            t.extractall(unpack)
        shutil.move(str(Path(unpack, COMPONENT)), str(into))


def run_tests(release):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    done = subprocess.run(["/usr/bin/python3", "-B", "-m", "unittest", "discover", "-s", "tests"],
                          cwd=release, env=env, capture_output=True, text=True)
    tail = done.stderr.strip().splitlines()[-3:]
    if done.returncode:
        raise InstallError("pool tests failed in the staged release:\n" + done.stderr[-4000:])
    return " ".join(line for line in tail if line.strip())


def check_hooks(home):
    """Both token hooks through the runtime link, the way Prime runs them. Only the
    length of the token is read; it is never printed."""
    hook = home / ".config/pi-pool/bin/pi-pool-token"
    results = {}
    for args in PROVIDERS:
        started = time.monotonic()
        # HOME stays the caller's: the macOS Keychain the anthropic stores live in follows it.
        done = subprocess.run([str(hook), *args], capture_output=True, text=True, timeout=10,
                              env=dict(os.environ, PI_POOL_DIR=str(home / ".config/pi-pool")))
        ok = done.returncode == 0 and len(done.stdout.strip()) > 20
        results[args[1]] = {"ok": ok, "exit": done.returncode, "token_chars": len(done.stdout.strip()),
                            "sec": round(time.monotonic() - started, 2)}
    return results


def current_id(root):
    link = root / "current"
    return os.readlink(link).split("/")[-1] if link.is_symlink() else None


def flip(root, release_id):
    """`current` -> releases/<id> in one rename; the release it replaced becomes `previous`."""
    before = current_id(root)
    if before == release_id:
        return before
    relink(root / "current", Path("releases", release_id))
    if before:
        relink(root / "previous", Path("releases", before))
    return before


def link_targets(home):
    return {name: os.readlink(home / name) if (home / name).is_symlink() else None for name in LINKS}


def link_runtime(home):
    current = root_of(home) / "current"
    return [str(home / name) for name, inside in LINKS.items() if relink(home / name, current / inside)]


def restore_links(home, targets):
    for name, target in targets.items():
        if target is None:
            if (home / name).is_symlink():
                (home / name).unlink()
        else:
            relink(home / name, target)


def prune(root):
    keep = {current_id(root), os.readlink(root / "previous").split("/")[-1] if (root / "previous").is_symlink() else None}
    releases = sorted((p for p in (root / "releases").iterdir() if not p.name.startswith(".")),
                      key=lambda p: p.stat().st_mtime, reverse=True)
    for old in releases[KEEP:]:
        if old.name not in keep:
            set_writable(old, True)
            shutil.rmtree(old)


def checked_switch(home, release_id, before, links_before):
    """Run both hooks after a flip. On a failure put `current` and every runtime
    link back where they were, then raise."""
    hooks = check_hooks(home)
    if all(h["ok"] for h in hooks.values()):
        return hooks
    root = root_of(home)
    if before:
        flip(root, before)
    elif (root / "current").is_symlink():
        (root / "current").unlink()
    restore_links(home, links_before)
    raise InstallError(f"hook check failed on {release_id}; links and current are back as they were: {json.dumps(hooks)}")


def install(home, ref):
    root = root_of(home)
    commit = git("rev-parse", "--verify", f"{ref}^{{commit}}")
    release_id = git("rev-parse", f"{commit}:{COMPONENT}")[:12]
    release = root / "releases" / release_id
    tests = "already installed"
    if not release.exists():
        staging = root / "releases" / f".staging-{release_id}-{os.getpid()}"
        staging.parent.mkdir(parents=True, exist_ok=True)
        try:
            export(commit, staging)
            tests = run_tests(staging)
            (staging / "RELEASE.json").write_text(json.dumps(
                {"id": release_id, "commit": commit, "installed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "tests": tests}, indent=2) + "\n")
            set_writable(staging, False)
            os.rename(staging, release)
        except BaseException:
            if staging.exists():
                set_writable(staging, True)
                shutil.rmtree(staging)
            raise
    links_before = link_targets(home)
    # `current` first, so no link ever names a path that does not exist yet.
    before = flip(root, release_id)
    linked = link_runtime(home)
    hooks = checked_switch(home, release_id, before, links_before)
    prune(root)
    return {"current": release_id, "commit": commit, "previous": before, "tests": tests, "relinked": linked, "hooks": hooks}


def rollback(home):
    root = root_of(home)
    if not (root / "previous").is_symlink():
        raise InstallError("no previous release to roll back to")
    target = os.readlink(root / "previous").split("/")[-1]
    before = flip(root, target)
    return {"current": target, "previous": before, "hooks": checked_switch(home, target, before, link_targets(home))}


def status(home):
    root = root_of(home)
    links = link_targets(home)
    releases = sorted(p.name for p in (root / "releases").iterdir()) if (root / "releases").exists() else []
    previous = os.readlink(root / "previous").split("/")[-1] if (root / "previous").is_symlink() else None
    return {"root": str(root), "current": current_id(root), "previous": previous, "releases": releases, "links": links}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", nargs="?", default="install", choices=["install", "rollback", "status"])
    parser.add_argument("--ref", default="HEAD")
    parser.add_argument("--home", default=str(Path.home()))
    args = parser.parse_args()
    home = Path(args.home)
    try:
        if args.command == "install":
            out = install(home, args.ref)
        elif args.command == "rollback":
            out = rollback(home)
        else:
            out = status(home)
    except (InstallError, subprocess.CalledProcessError) as e:
        print(f"pi-pool install: {e}", file=sys.stderr)
        return 1
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
