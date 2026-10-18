#!/usr/bin/env python3
"""One prime-sync run: make this box's Prime setup match every other box's.

1. The sieun-pi checkout on main moves to GitHub main, with its unpushed commits replayed on top and its dirty files kept.
2. Every home link in install-manifest.json points at the checkout, so skills, the global AGENTS.md,
   pstack-models.json and the extensions match the commit. A copy in a link's place is deleted.
3. config/settings.shared.json sets its keys in ~/.prime/agent/settings.json.
4. Global harness entries (harness_state.json) and the corrections ledger (browser-chat/corrections.json)
   merge three ways with the private state repo, one file per entry, and the newer side wins a clash.

Prime and the chat only read local files, so this run writes them in place, the way each of them writes:
harness_state.json by atomic replace, the ledger under the chat's <file>.lock directory.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
CONFIG = Path(os.environ.get("PRIME_SYNC_CONFIG", HOME / ".config/prime-sync/sync.json"))
SHARE = Path(os.environ.get("PRIME_SYNC_HOME", HOME / ".local/share/prime-sync"))
BASE_REF = "refs/prime-sync/base"
SETTLE_SECONDS = float(os.environ.get("PRIME_SYNC_SETTLE", "2"))
TOKEN_FILE = HOME / ".config/prime-sync/github-token"


def git_env() -> dict[str, str]:
    """The process env without GIT_* keys. With a token file, git reads GitHub credentials from it instead of the gh helper,
    because a launchd job on the Mac cannot open the login keyring ("could not read Username ... Device not configured", 10-18 03:10Z)."""
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    if TOKEN_FILE.exists():
        helper = f"!f() {{ test \"$1\" = get && printf 'username=x-access-token\\npassword=%s\\n' \"$(cat '{TOKEN_FILE}')\"; }}; f"
        env.update({"GIT_CONFIG_COUNT": "2", "GIT_CONFIG_KEY_0": "credential.https://github.com.helper", "GIT_CONFIG_VALUE_0": "",
                    "GIT_CONFIG_KEY_1": "credential.https://github.com.helper", "GIT_CONFIG_VALUE_1": helper, "GIT_TERMINAL_PROMPT": "0"})
    return env


GIT_ENV = git_env()


class Skip(Exception):
    """This step leaves everything as it is this run; the next run tries again."""


def git(repo: Path, *args: str, check: bool = True, input: bytes | None = None, timeout: int = 120) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], input=input, capture_output=True, env=GIT_ENV, timeout=timeout)
    if check and result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {result.stderr.decode(errors='replace').strip()}")
    return result.stdout.decode(errors="replace").strip() if result.returncode == 0 else ""


def rev(repo: Path, ref: str) -> str | None:
    return git(repo, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}", check=False) or None


def write_atomic(path: Path, data: bytes, mode: int = 0o600) -> None:
    target = Path(os.path.realpath(path))
    try:
        mode = os.stat(target).st_mode & 0o777
    except FileNotFoundError:
        pass
    temporary = target.with_name(f"{target.name}.{os.getpid()}.prime-sync.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
        os.chmod(temporary, mode)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def load_config() -> dict:
    config = json.loads(CONFIG.read_text())
    for key in ("checkout", "stateDir", "agentDir"):
        config[key] = Path(os.path.expanduser(config[key]))
    config.setdefault("host", host_name())
    return config


def host_name() -> str:
    """This box's name in sieun-pi's hosts registry (the host whose hostname is this one), else the short hostname."""
    hostname = socket.gethostname()
    names = {hostname, hostname.split(".")[0]}
    try:
        hosts = json.loads((HOME / ".config/sieun-pi/hosts.json").read_text()).get("hosts", [])
    except (OSError, ValueError):
        hosts = []
    for host in hosts:
        if isinstance(host, dict) and host.get("hostname") in names and host.get("name"):
            return host["name"]
    return hostname.split(".")[0]


# 1. Code


def pull_checkout(checkout: Path) -> str:
    """Move a checkout on main to GitHub main. Local commits are replayed on top of it and never pushed, and dirty files ride along.
    Anything that does not apply cleanly leaves the checkout as it was, and the next run tries again."""
    branch = git(checkout, "symbolic-ref", "--short", "-q", "HEAD", check=False)
    if branch != "main":
        return f"checkout is on {branch or 'a detached HEAD'}, not main"
    git(checkout, "fetch", "--quiet", "origin", "main")
    head, remote = rev(checkout, "HEAD"), rev(checkout, "origin/main")
    if head == remote:
        return f"at {head[:7]}"
    if _ancestor(checkout, remote, head):
        return f"ahead of origin/main {remote[:7]} at {head[:7]}"
    if _ancestor(checkout, head, remote):
        move_checkout(checkout, head, remote)
        return f"pulled {head[:7]}..{remote[:7]}"
    target, count = replay(checkout, head, remote)
    move_checkout(checkout, head, target)
    if not count:
        return f"pulled {head[:7]}..{remote[:7]}, whose local commits origin/main already holds"
    return f"rebased {count} local commits from {head[:7]} onto origin/main {remote[:7]} as {target[:7]}"


def replay(checkout: Path, head: str, remote: str) -> tuple[str, int]:
    """Cherry-pick the local commits that origin/main lacks onto it in the object store, without touching the worktree."""
    commits = git(checkout, "rev-list", "--reverse", "--no-merges", "--right-only", "--cherry-pick", f"{remote}...{head}").split()
    tip, count = remote, 0
    for commit in commits:
        merged = subprocess.run(["git", "-C", str(checkout), "merge-tree", "--write-tree", f"--merge-base={commit}^", tip, commit],
                                capture_output=True, env=GIT_ENV, timeout=120)
        if merged.returncode != 0:
            raise Skip(f"diverged from origin/main {remote[:7]} at {head[:7]}, and local commit {commit[:7]} conflicts with it")
        tree = merged.stdout.decode().split()[0]
        if tree == git(checkout, "rev-parse", f"{tip}^{{tree}}"):
            continue
        name, email, date, committer, committer_email = git(checkout, "log", "-1", "--format=%an%x00%ae%x00%ad%x00%cn%x00%ce", "--date=raw", commit).split("\0")
        env = {**GIT_ENV, "GIT_AUTHOR_NAME": name, "GIT_AUTHOR_EMAIL": email, "GIT_AUTHOR_DATE": date,
               "GIT_COMMITTER_NAME": committer, "GIT_COMMITTER_EMAIL": committer_email}
        message = subprocess.run(["git", "-C", str(checkout), "log", "-1", "--format=%B", commit], capture_output=True, env=GIT_ENV, check=True).stdout
        tip = subprocess.run(["git", "-C", str(checkout), "commit-tree", tree, "-p", tip, "-F", "-"], input=message,
                             capture_output=True, env=env, check=True, timeout=120).stdout.decode().strip()
        count += 1
    return tip, count


def move_checkout(checkout: Path, head: str, target: str) -> None:
    """Point main at target and update the worktree like a branch switch. Dirty files on paths the move changes go into a stash first
    and come back on top; an untracked file in the way, a conflict or a commit made meanwhile puts everything back."""
    touched = set(filter(None, git(checkout, "diff", "--name-only", "-z", head, target).split("\0")))
    dirty = set(filter(None, (git(checkout, "diff", "--name-only", "-z", "HEAD") + "\0" + git(checkout, "diff", "--cached", "--name-only", "-z")).split("\0")))
    carry = sorted(touched & dirty)
    stash = None
    if carry:
        before = rev(checkout, "stash@{0}")
        git(checkout, "stash", "push", "--quiet", "-m", "prime-sync carry", "--", *carry)
        stash = rev(checkout, "stash@{0}")
        if stash == before:
            raise Skip(f"git stash kept nothing of {', '.join(carry)}")
        clean = subprocess.run(["git", "-C", str(checkout), "merge-tree", "--write-tree", f"--merge-base={head}", target, stash],
                               capture_output=True, env=GIT_ENV, timeout=120).returncode == 0
        if not clean:
            unstash(checkout, stash)
            raise Skip(f"local changes to {', '.join(carry)} conflict with origin/main")
    if subprocess.run(["git", "-C", str(checkout), "update-ref", "-m", "prime-sync: move to origin/main", "refs/heads/main", target, head],
                      capture_output=True, env=GIT_ENV).returncode != 0:
        if stash:
            unstash(checkout, stash)
        raise Skip("main moved during the run")
    switched = subprocess.run(["git", "-C", str(checkout), "read-tree", "-m", "-u", head, target], capture_output=True, env=GIT_ENV, timeout=120)
    if switched.returncode != 0:
        git(checkout, "update-ref", "-m", "prime-sync: undo move", "refs/heads/main", head, target)
        if stash:
            unstash(checkout, stash)
        raise Skip(f"the worktree could not move: {switched.stderr.decode(errors='replace').strip()[:300]}")
    if stash:
        unstash(checkout, stash)


def unstash(checkout: Path, stash: str) -> None:
    applied = subprocess.run(["git", "-C", str(checkout), "stash", "apply", "--quiet", stash], capture_output=True, env=GIT_ENV, timeout=120)
    if applied.returncode != 0:
        raise Skip(f"stash {stash[:9]} (prime-sync carry) holds local changes that did not apply back: {applied.stderr.decode(errors='replace').strip()[:300]}")
    stashes = git(checkout, "stash", "list", "--format=%H").split()
    if stash in stashes:
        git(checkout, "stash", "drop", "--quiet", f"stash@{{{stashes.index(stash)}}}")


def _ancestor(repo: Path, older: str, newer: str) -> bool:
    return subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", older, newer], env=GIT_ENV).returncode == 0


# 2. Links


def remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def link_manifest(checkout: Path, home: Path, agent_dir: Path) -> list[str]:
    manifest = json.loads((checkout / "install-manifest.json").read_text())
    changes = []
    wanted_skills = set()
    for entry in manifest["entries"]:
        if entry["kind"] != "link" or entry.get("scope") != "home":
            continue
        source, target = checkout / entry["source"], home / entry["target"]
        if target.parent == agent_dir / "skills":
            wanted_skills.add(target.name)
        if not source.exists():
            continue
        if target.is_symlink() and os.readlink(target) == str(source):
            continue
        if target.exists() or target.is_symlink():
            remove_path(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(source, target)
        changes.append(f"linked {entry['target']}")
    skills = agent_dir / "skills"
    if skills.is_dir():
        for path in skills.iterdir():
            if path.name in wanted_skills or not path.is_symlink():
                continue
            if os.readlink(path).startswith(str(checkout / "skills") + os.sep):
                path.unlink()
                changes.append(f"unlinked skills/{path.name}")
    return changes


# 3. Shared settings


def apply_settings(checkout: Path, agent_dir: Path) -> list[str]:
    shared_file = checkout / "config/settings.shared.json"
    if not shared_file.exists():
        return []
    shared = json.loads(shared_file.read_text())
    path = agent_dir / "settings.json"
    settings = json.loads(path.read_text()) if path.exists() else {}
    changed = [key for key, value in shared.items() if settings.get(key) != value]
    if changed:
        settings.update(shared)
        write_atomic(path, (json.dumps(settings, indent=2, ensure_ascii=False) + "\n").encode())
    return [f"set {key}" for key in changed]


# 4. Harness entries and the corrections ledger


def canonical(value) -> bytes:
    return (json.dumps(value, indent=1, ensure_ascii=False, sort_keys=True) + "\n").encode()


def harness_files(state: dict) -> dict[str, bytes]:
    files = {}
    for kind, records in state.get("entries", {}).items():
        for entry_id, entry in records.items():
            files[f"harness/{kind}/{entry_id}.json"] = canonical(entry)
    for event in state.get("refinements", []):
        key = hashlib.sha1(f"{event.get('id')}|{event.get('created_at')}".encode()).hexdigest()[:12]
        files[f"harness/refinements/{event.get('id')}-{key}.json"] = canonical(event)
    return files


def ledger_files(ledger: dict) -> dict[str, bytes]:
    return {f"corrections/{entry['id']}.json": canonical(entry) for entry in ledger.get("corrections", [])}


def stamp(data: bytes) -> str:
    value = json.loads(data)
    stamps = [value.get("updated_at"), value.get("created_at"), value.get("at")]
    stamps += [repeat.get("at") for repeat in value.get("repeats", []) if isinstance(repeat, dict)]
    return max((s for s in stamps if isinstance(s, str)), default="")


def merge(local: dict, base: dict | None, remote: dict) -> dict:
    """Three-way merge of path -> bytes. A side that changed since base wins; when both changed, the newer stamp wins.

    base None means this box never synced: the shared state wins where both sides hold a path, and a path
    only this box holds is added, so joining never deletes another box's entry or this box's own one."""
    if base is None:
        base = {} if not remote else {path: data for path, data in local.items() if path in remote}
    merged = {}
    for path in set(local) | set(remote) | set(base):
        mine, theirs, old = local.get(path), remote.get(path), base.get(path)
        if mine == theirs or theirs == old:
            pick = mine
        elif mine == old:
            pick = theirs
        elif mine is None or theirs is None:
            pick = mine if mine is not None else theirs
        else:
            pick = mine if stamp(mine) > stamp(theirs) else theirs
        if pick is not None:
            merged[path] = pick
    return merged


def guard_deletions(name: str, remote: dict, merged: dict) -> None:
    # Hard limit, data integrity: a truncated or reset local file must not delete every box's entries in one run.
    removed = sum(1 for path in remote if path not in merged)
    if remote and removed * 2 > len(remote):
        raise Skip(f"{name} would delete {removed} of {len(remote)} shared entries")


def read_tree(repo: Path, ref: str) -> dict[str, bytes]:
    listing = git(repo, "ls-tree", "-r", "-z", ref)
    blobs = []
    for line in filter(None, listing.split("\0")):
        meta, path = line.split("\t", 1)
        blobs.append((path, meta.split()[2]))
    if not blobs:
        return {}
    out = subprocess.run(["git", "-C", str(repo), "cat-file", "--batch"], input="".join(f"{sha}\n" for _, sha in blobs).encode(),
                         capture_output=True, env=GIT_ENV, check=True, timeout=120).stdout
    files, offset = {}, 0
    for path, _ in blobs:
        header_end = out.index(b"\n", offset)
        size = int(out[offset:header_end].split()[2])
        files[path] = out[header_end + 1:header_end + 1 + size]
        offset = header_end + 1 + size + 1
    return files


def subset(files: dict[str, bytes], prefix: str) -> dict[str, bytes]:
    return {path: data for path, data in files.items() if path.startswith(prefix)}


def harness_from(files: dict[str, bytes], current: dict) -> dict:
    entries = {kind: {} for kind in current.get("entries", {})}
    order = {kind: list(records) for kind, records in current.get("entries", {}).items()}
    loaded = {}
    for path, data in files.items():
        _, kind, name = path.split("/", 2)
        if kind != "refinements":
            loaded.setdefault(kind, {})[name[:-len(".json")]] = json.loads(data)
    for kind, records in loaded.items():
        known = [entry_id for entry_id in order.get(kind, []) if entry_id in records]
        fresh = sorted((entry_id for entry_id in records if entry_id not in set(known)), key=lambda i: records[i].get("created_at", ""))
        entries[kind] = {entry_id: records[entry_id] for entry_id in known + fresh}
    refinements = sorted((json.loads(data) for path, data in files.items() if path.startswith("harness/refinements/")),
                         key=lambda event: (event.get("created_at", ""), event.get("id", "")))
    return {"schema": current.get("schema", 1), "entries": entries, "refinements": refinements}


def ledger_from(files: dict[str, bytes]) -> dict:
    def order(entry):
        digits = entry["id"].lstrip("c")
        return (int(digits) if digits.isdigit() else 10 ** 9, entry["id"])
    return {"corrections": sorted((json.loads(data) for data in files.values()), key=order)}


class LedgerLock:
    """The chat's lock for one JSON file: a <file>.lock directory holding the owner's pid (locked-json.ts)."""

    def __init__(self, path: Path):
        self.lock = Path(str(path) + ".lock")

    def __enter__(self):
        deadline = time.time() + 3
        while True:
            try:
                self.lock.mkdir(mode=0o700)
                (self.lock / "pid.tmp").write_text(str(os.getpid()))
                os.replace(self.lock / "pid.tmp", self.lock / "pid")
                return self
            except FileExistsError:
                if time.time() > deadline:
                    raise Skip(f"{self.lock.name} is held")
                time.sleep(0.05)

    def __exit__(self, *exc):
        shutil.rmtree(self.lock, ignore_errors=True)


def sync_state(config: dict) -> list[str]:
    repo, agent_dir, host = config["stateDir"], config["agentDir"], config["host"]
    harness_path = agent_dir / "harness/harness_state.json"
    ledger_path = agent_dir / "browser-chat/corrections.json"
    git(repo, "fetch", "--quiet", "origin")
    remote_head = rev(repo, "origin/main")
    remote = read_tree(repo, remote_head) if remote_head else {}
    base_head = rev(repo, BASE_REF)
    base = read_tree(repo, base_head) if base_head else None
    notes = []

    merged = {}
    if harness_path.exists():
        before = harness_path.stat().st_mtime_ns
        current = json.loads(harness_path.read_bytes())
        local = harness_files(current)
        part = merge(local, None if base is None else subset(base, "harness/"), subset(remote, "harness/"))
        guard_deletions("harness", subset(remote, "harness/"), part)
        if part != local:
            written = harness_from(part, current)
            body = json.dumps(written, indent=2, ensure_ascii=False).encode()
            if harness_path.stat().st_mtime_ns != before:
                raise Skip("harness_state.json changed during the merge")
            write_atomic(harness_path, body)
            time.sleep(SETTLE_SECONDS)
            if harness_path.read_bytes() != body:
                raise Skip("Prime rewrote harness_state.json right after the merge")
            notes.append(f"harness: {_diff(local, part)}")
        merged.update(part)
    else:
        merged.update(subset(remote, "harness/"))

    if ledger_path.parent.is_dir():
        with LedgerLock(ledger_path):
            current = json.loads(ledger_path.read_bytes()) if ledger_path.exists() else {"corrections": []}
            local = ledger_files(current)
            part = merge(local, None if base is None else subset(base, "corrections/"), subset(remote, "corrections/"))
            guard_deletions("corrections", subset(remote, "corrections/"), part)
            if part != local:
                write_atomic(ledger_path, json.dumps(ledger_from(part), ensure_ascii=False, separators=(",", ":")).encode())
                notes.append(f"corrections: {_diff(local, part)}")
        merged.update(part)
    else:
        merged.update(subset(remote, "corrections/"))

    if merged != remote:
        commit = commit_tree(repo, merged, remote_head, host)
        pushed = subprocess.run(["git", "-C", str(repo), "push", "--quiet", "origin", f"{commit}:refs/heads/main"], capture_output=True, env=GIT_ENV, timeout=120)
        if pushed.returncode != 0:
            raise Skip(f"push lost a race: {pushed.stderr.decode(errors='replace').strip()[:200]}")
        git(repo, "update-ref", "refs/remotes/origin/main", commit)
        notes.append(f"pushed {_diff(remote, merged)} as {commit[:7]}")
        remote_head = commit
    if remote_head and remote_head != base_head:
        git(repo, "update-ref", BASE_REF, remote_head)
    return notes


def commit_tree(repo: Path, files: dict[str, bytes], parent: str | None, host: str) -> str:
    ref = "refs/prime-sync/next"
    stream = [f"commit {ref}\ncommitter prime-sync {host} <prime-sync@{host}> {int(time.time())} +0000\n".encode()]
    message = f"sync from {host}".encode()
    stream.append(b"data %d\n%s\n" % (len(message), message))
    if parent:
        stream.append(f"from {parent}\n".encode())
    stream.append(b"deleteall\n")
    for path in sorted(files):
        stream.append(b"M 100644 inline %s\ndata %d\n%s\n" % (path.encode(), len(files[path]), files[path]))
    subprocess.run(["git", "-C", str(repo), "fast-import", "--quiet", "--force"], input=b"".join(stream), capture_output=True, env=GIT_ENV, check=True, timeout=120)
    commit = git(repo, "rev-parse", ref)
    git(repo, "update-ref", "-d", ref)
    return commit


def _diff(before: dict, after: dict) -> str:
    added = sum(1 for path in after if path not in before)
    removed = sum(1 for path in before if path not in after)
    changed = sum(1 for path in after if path in before and before[path] != after[path])
    return f"{added} added, {changed} changed, {removed} removed"


def run() -> dict:
    config = load_config()
    SHARE.mkdir(parents=True, exist_ok=True)
    report = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "host": config["host"]}
    with open(SHARE / "run.lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            report["skipped"] = "another run holds run.lock"
            return report
        steps = [("code", lambda: pull_checkout(config["checkout"])),
                 ("links", lambda: link_manifest(config["checkout"], HOME, config["agentDir"])),
                 ("settings", lambda: apply_settings(config["checkout"], config["agentDir"])),
                 ("state", lambda: sync_state(config))]
        for name, step in steps:
            try:
                report[name] = step()
            except Skip as reason:
                report[name] = f"skipped: {reason}"
            except Exception as error:
                report[name] = f"error: {type(error).__name__}: {error}"
    write_atomic(SHARE / "status.json", (json.dumps(report, indent=2) + "\n").encode(), 0o644)
    if any(report.get(key) for key in ("links", "settings", "state")) or str(report.get("code")).startswith(("pulled", "rebased", "skipped")) or "error" in json.dumps(report):
        with open(SHARE / "sync.log", "a") as log:
            log.write(json.dumps(report) + "\n")
    return report


if __name__ == "__main__":
    result = run()
    print(json.dumps(result, indent=2))
    sys.exit(1 if any(isinstance(value, str) and value.startswith("error:") for value in result.values()) else 0)
