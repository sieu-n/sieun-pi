#!/usr/bin/python3 -B
"""Install pi-pool from a commit into its own folder, so Prime never runs checkout files.

    /usr/bin/python3 -B components/pi-pool/install.py [install] [--ref <commit>] [--borrow <holder>]
    /usr/bin/python3 -B components/pi-pool/install.py rollback
    /usr/bin/python3 -B components/pi-pool/install.py status

install exports components/pi-pool at the commit (default HEAD) into a staging
folder, runs the pool's Python tests there, renames it to releases/<tree id>,
points every runtime link at <root>/current, flips `current` in one rename, and
runs both token hooks through the runtime links. A hook that fails puts the
previous release back. rollback swaps `current` and `previous` and runs the same
check; after the first install it puts back the links that install replaced. State (state.json, pi-pool.log, config.json, accounts) never moves.

--borrow sets the machine up to borrow tokens from the one machine that holds the accounts. <holder>
is the holder's ssh target (user@host), whose ~/.config/pi-pool/serve.json gives the address and the
secret, or its pool URL (http://<tailnet ip>:7781) with the secret on stdin. It writes remote.json,
points Prime's models.json at the token hook for both providers, and checks both hooks through the
holder. Turn slots stay on this machine (pool/remote.py).
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


def holder_remote(holder, stdin=sys.stdin):
    """remote.json's {url, secret} for `holder`: an ssh target whose serve.json names both, or a URL and the secret on stdin."""
    if holder.startswith(("http://", "https://")):
        secret = stdin.read().strip()
        if not secret:
            raise InstallError(f"--borrow {holder} reads the holder's secret on stdin, and stdin was empty")
        return {"url": holder.rstrip("/"), "secret": secret}
    done = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", holder, "cat", ".config/pi-pool/serve.json"],
                          capture_output=True, text=True)
    try:
        serve = json.loads(done.stdout) if done.returncode == 0 else None
    except ValueError:
        serve = None
    if not (isinstance(serve, dict) and serve.get("host") and serve.get("port") and serve.get("secret")):
        raise InstallError(f"could not read host, port and secret from {holder}:.config/pi-pool/serve.json: {done.stderr.strip() or done.stdout[:200]}")
    return {"url": f"http://{serve['host']}:{int(serve['port'])}", "secret": serve["secret"]}


def write_remote(home, remote):
    """remote.json, 0600, in one rename. Returns True when it changed."""
    path = home / ".config/pi-pool/remote.json"
    try:
        if json.loads(path.read_text()) == remote:
            return False
    except (OSError, ValueError):
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(".remote.json.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(remote) + "\n")
    os.replace(tmp, path)
    return True


def borrow(home, holder):
    """Point this machine's pool at `holder`. Hard refusal (data integrity): a machine that holds accounts of its own
    is a second holder, and refresh tokens rotate, so two holders of one account log each other out."""
    held = {p[1]: pooled_accounts(home, p[1]) for p in PROVIDERS}
    if any(held.values()):
        raise InstallError(f"this machine holds pooled accounts {held}; a borrower holds none, so move them to the holder first")
    changed = write_remote(home, holder_remote(holder))
    pool = str(home / ".local/bin/pi-pool")
    enabled = {}
    for args in PROVIDERS:
        done = subprocess.run([pool, "enable", args[1]], capture_output=True, text=True,
                              env=dict(os.environ, PI_POOL_DIR=str(home / ".config/pi-pool"), PI_POOL_REMOTE="off"))
        if done.returncode:
            raise InstallError(f"pi-pool enable {args[1]} failed: {done.stderr.strip() or done.stdout.strip()}")
        enabled[args[1]] = done.stdout.strip()
    return {"remote_changed": changed, "enable": enabled}


def run_tests(release):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    done = subprocess.run(["/usr/bin/python3", "-B", "-m", "unittest", "discover", "-s", "tests"],
                          cwd=release, env=env, capture_output=True, text=True)
    tail = done.stderr.strip().splitlines()[-3:]
    if done.returncode:
        raise InstallError("pool tests failed in the staged release:\n" + done.stderr[-4000:])
    return " ".join(line for line in tail if line.strip())


# The account index per provider. A provider with no index file, or none of its
# accounts listed, has nothing to vend yet: a fresh machine installs the pool before
# its first `pi-pool login`.
def pooled_accounts(home, provider):
    try:
        index = json.loads((home / ".config/pi-pool/accounts" / f"{provider}.json").read_text())
    except FileNotFoundError:
        return 0
    except (OSError, ValueError):
        return None  # present but unreadable: let the hook report it
    return len(index.get("accounts") or []) if isinstance(index, dict) else None


def check_hooks(home):
    """Both token hooks through the runtime link, the way Prime runs them. Only the
    length of the token is read; it is never printed. A provider with no pooled
    account is skipped; then `pi-pool config` must still run through the link."""
    hook = home / ".config/pi-pool/bin/pi-pool-token"
    results = {}
    for args in PROVIDERS:
        started = time.monotonic()
        if pooled_accounts(home, args[1]) == 0 and not (home / ".config/pi-pool/remote.json").exists():
            try:
                done = subprocess.run([str(home / ".local/bin/pi-pool"), "config"], capture_output=True,
                                      text=True, timeout=10, env=dict(os.environ, PI_POOL_DIR=str(home / ".config/pi-pool")))
                exit_code = done.returncode
            except (OSError, subprocess.TimeoutExpired) as e:
                exit_code = type(e).__name__
            results[args[1]] = {"ok": exit_code == 0, "exit": exit_code, "skipped": "no pooled account yet",
                                "sec": round(time.monotonic() - started, 2)}
            continue
        # HOME stays the caller's: the macOS Keychain the anthropic credentials live in follows it.
        try:
            done = subprocess.run([str(hook), *args], capture_output=True, text=True, timeout=10,
                                  env=dict(os.environ, PI_POOL_DIR=str(home / ".config/pi-pool")))
            exit_code, chars = done.returncode, len(done.stdout.strip())
        except (OSError, subprocess.TimeoutExpired) as e:
            exit_code, chars = type(e).__name__, 0
        results[args[1]] = {"ok": exit_code == 0 and chars > 20, "exit": exit_code, "token_chars": chars,
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


def install(home, ref, holder=None):
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
    if current_id(root) is None:
        # The first install keeps the links it replaced, so `rollback` can put them back.
        (root / "links-before-install.json").write_text(json.dumps(links_before, indent=2) + "\n")
    # `current` first, so no link ever names a path that does not exist yet.
    before = flip(root, release_id)
    linked = link_runtime(home)
    try:
        borrowed = borrow(home, holder) if holder else None
    except InstallError:
        if before:
            flip(root, before)
        elif (root / "current").is_symlink():
            (root / "current").unlink()
        restore_links(home, links_before)
        raise
    hooks = checked_switch(home, release_id, before, links_before)
    prune(root)
    return {"current": release_id, "commit": commit, "previous": before, "tests": tests, "relinked": linked, "hooks": hooks,
            **({"borrow": borrowed} if holder else {})}


def rollback(home):
    root = root_of(home)
    saved = root / "links-before-install.json"
    if not (root / "previous").is_symlink() and saved.exists():
        before = current_id(root)
        restore_links(home, json.loads(saved.read_text()))
        (root / "current").unlink()
        return {"current": None, "links": link_targets(home), "uninstalled": before, "hooks": check_hooks(home)}
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
    parser.add_argument("--borrow", metavar="HOLDER", help="borrow tokens from the holder: its ssh target, or its URL with the secret on stdin")
    args = parser.parse_args()
    if args.borrow and args.command != "install":
        parser.error("--borrow goes with install")
    home = Path(args.home)
    try:
        if args.command == "install":
            out = install(home, args.ref, args.borrow)
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
