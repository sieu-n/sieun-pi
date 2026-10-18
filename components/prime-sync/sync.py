#!/usr/bin/env python3
"""One prime-sync run: make this box's Prime setup match every other box's.

1. The sieun-pi checkout on main moves to GitHub main, with its unpushed commits replayed on top and its live edits carried onto the new bytes.
   First each shared index entry that holds an older committed version of its path goes back to HEAD's, with its file when the file holds it too.
2. Every home link in install-manifest.json points at the checkout, so skills, the global AGENTS.md,
   pstack-models.json and the extensions match the commit. A copy in a link's place is deleted.
3. config/settings.shared.json sets its keys in ~/.prime/agent/settings.json.
4. Global harness entries (harness_state.json) and the corrections ledger (browser-chat/corrections.json)
   merge three ways with the private state repo, one file per entry, and the newer side wins a clash.
5. When the checkout has not followed main for 10 min, the session that wrote a blocking path hears of it, and at 30 min the AI harness chat gets a todo.

Prime and the chat only read local files, so this run writes them in place, the way each of them writes:
harness_state.json by atomic replace, the ledger under the chat's <file>.lock directory.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
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
    """This step leaves everything as it is this run; the next run tries again. paths names what holds it, for the block watch."""

    def __init__(self, message: str, paths: list[str] | None = None):
        super().__init__(message)
        self.paths = paths or []


class Alert(Skip):
    """Like Skip, but the run reports it as an alert and exits 1, because a person has to fix origin/main."""


MAX_DROP_SHARE = 0.05
DECLARED = re.compile(r"^Deletes: (\d+) files? on purpose\.?\s*$", re.M)


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
    git(checkout, "rev-parse", "--git-dir")
    branch = git(checkout, "symbolic-ref", "--short", "-q", "HEAD", check=False)
    if branch != "main":
        return f"checkout is on {branch or 'a detached HEAD'}, not main"
    git(checkout, "fetch", "--quiet", "origin", "main")
    head, remote = rev(checkout, "HEAD"), rev(checkout, "origin/main")
    if head == remote:
        return f"at {head[:7]}"
    if _ancestor(checkout, remote, head):
        return f"ahead of origin/main {remote[:7]} at {head[:7]}"
    check_drop(checkout, head, remote)
    if _ancestor(checkout, head, remote):
        return f"pulled {head[:7]}..{remote[:7]}" + move_checkout(checkout, head, remote, remote)
    target, count = replay(checkout, head, remote)
    carried = move_checkout(checkout, head, target, remote)
    if not count:
        return f"pulled {head[:7]}..{remote[:7]}, whose local commits origin/main already holds" + carried
    return f"rebased {count} local commits from {head[:7]} onto origin/main {remote[:7]} as {target[:7]}" + carried


def _paths(checkout: Path, *args: str) -> list[str]:
    return [path for path in git(checkout, *args).split("\0") if path]


def check_drop(checkout: Path, head: str, remote: str) -> None:
    """Refuse to move onto an origin/main that drops more than 5% of the tracked files since the checkout's base with it,
    unless its commits declare as many with `Deletes: <n> files on purpose` lines.
    On 10-18 at 05:34Z, 5557c587a deleted all 712 files of main, and every box moved onto it within a minute."""
    base = git(checkout, "merge-base", head, remote, check=False)
    if not base:
        return
    dropped = len(_paths(checkout, "diff-tree", "-r", "-z", "--no-renames", "--diff-filter=D", "--name-only", base, remote))
    total = len(_paths(checkout, "ls-tree", "-r", "-z", "--name-only", base))
    if dropped <= total * MAX_DROP_SHARE:
        return
    messages = git(checkout, "log", "--format=%B%x00", f"{base}..{remote}").split("\0")
    declared = sum(max((int(n) for n in DECLARED.findall(message)), default=0) for message in messages)
    if declared >= dropped:
        return
    raise Alert(f"origin/main {remote[:9]} drops {dropped} of {total} tracked files since {base[:9]}, over {MAX_DROP_SHARE:.0%}, "
                f"and its commits declare {declared} with Deletes: lines, so the checkout stays at {head[:9]}")


def replay(checkout: Path, head: str, remote: str) -> tuple[str, int]:
    """Cherry-pick the local commits that origin/main lacks onto it in the object store, without touching the worktree."""
    commits = git(checkout, "rev-list", "--reverse", "--no-merges", "--right-only", "--cherry-pick", f"{remote}...{head}").split()
    tip, count = remote, 0
    for commit in commits:
        merged = subprocess.run(["git", "-C", str(checkout), "merge-tree", "--write-tree", f"--merge-base={commit}^", tip, commit],
                                capture_output=True, env=GIT_ENV, timeout=120)
        if merged.returncode != 0:
            raise Skip(f"diverged from origin/main {remote[:7]} at {head[:7]}, and local commit {commit[:7]} conflicts with it", [f"commit {commit[:9]}"])
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


def move_checkout(checkout: Path, head: str, target: str, remote: str) -> str:
    """Point main at target and update the worktree like a branch switch, keeping every live edit on a path the move changes.

    A live edit is merged onto the target's bytes with git merge-file. When the file was last written before the newest origin/main
    commit that changed it, it is that commit's draft and takes the target's bytes. Otherwise a hunk both sides changed keeps the live
    side, and a file that cannot be merged as text (binary, symlink, added or deleted on one side) keeps its bytes as a local edit.
    The old bytes of every carried or superseded file are saved under carried/ first. asa-tip-sync moves the Mac's auto-sns-agent
    checkout this way since 10-18, because a stash that refused any overlap held the Mac's checkout from 05:24Z until a chat stashed 15 files.
    Only a staged edit that differs from both the disk and the target, or a folder in a file's place, holds the move, and it is named."""
    dirty, preset, carried, kept = [], [], [], []
    live = set(_paths(checkout, "diff", "--name-only", "-z", "--no-renames", "HEAD"))
    for rel, old, new in changed_paths(checkout, head, target):
        if rel not in live and (old is not None or not os.path.lexists(checkout / rel)):
            continue
        disk, staged = disk_state(checkout, rel), index_entry(checkout, rel)
        if staged not in (old, new, disk) or (disk is not None and disk[0] == "dir"):
            dirty.append(rel)
        elif disk == old and staged == old:
            continue
        elif disk == new:
            preset.append((rel, old, new))
        elif (merged := carry(checkout, rel, disk, old, new)) is not None:
            carried.append((rel, old, new, disk, merged))
        elif new is not None and disk is not None and disk[0] != "120000" and superseded(checkout, rel, head, remote):
            carried.append((rel, old, new, disk, None))
        elif (merged := carry(checkout, rel, disk, old, new, "--ours")) is not None:
            carried.append((rel, old, new, disk, merged))
        else:
            preset.append((rel, old, new))
            kept.append(rel)
    if dirty:
        raise Skip(f"staged changes or folders on {', '.join(dirty[:10])} differ from what the move writes", dirty)
    saved = SHARE / "carried" / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{head[:9]}-{target[:9]}"
    for rel, _old, _new, disk, _merged in carried:
        if disk_state(checkout, rel) != disk:
            raise Skip(f"{rel} changed while the run read it", [rel])
        (saved / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(checkout / rel, saved / rel, follow_symlinks=False)
    for rel, old, new, _disk, _merged in carried:
        write_file(checkout / rel, new[0], blob(checkout, new[1]))
        preset.append((rel, old, new))

    def undo(moved: bool) -> None:
        if moved:
            git(checkout, "update-ref", "-m", "prime-sync: undo move", "refs/heads/main", head, target)
        for rel, old, _new in preset:
            set_index(checkout, rel, old)
        for rel, _old, _new, disk, _merged in carried:
            write_file(checkout / rel, disk[0], (saved / rel).read_bytes())

    for rel, _old, new in preset:
        set_index(checkout, rel, new)
    if subprocess.run(["git", "-C", str(checkout), "update-ref", "-m", "prime-sync: move to origin/main", "refs/heads/main", target, head],
                      capture_output=True, env=GIT_ENV).returncode != 0:
        undo(False)
        raise Skip("main moved during the run")
    switched = subprocess.run(["git", "-C", str(checkout), "read-tree", "-m", "-u", head, target], capture_output=True, env=GIT_ENV, timeout=120)
    if switched.returncode != 0:
        undo(True)
        reason = switched.stderr.decode(errors="replace").strip()
        raise Skip(f"the worktree could not move: {reason[:300]}", re.findall(r"^\t(\S.*)$", reason, re.M))
    for rel, _old, new, _disk, merged in carried:
        if merged is not None:
            write_file(checkout / rel, new[0], merged)
    notes = [f"carried {', '.join(c[0] for c in carried if c[4] is not None)}" if any(c[4] is not None for c in carried) else "",
             f"took the tip for superseded {', '.join(c[0] for c in carried if c[4] is None)}" if any(c[4] is None for c in carried) else "",
             f"kept local {', '.join(kept)}" if kept else ""]
    notes = [note for note in notes if note]
    return f"; {'; '.join(notes)}; old bytes in {saved}" if notes else ""


Entry = tuple[str, str]


def heal_index(checkout: Path) -> list[str]:
    """Put each shared index entry that holds an older committed version of its path back to HEAD's.

    A commit built in a private index and moved onto main with update-ref leaves the shared index at the commit's parent for its paths.
    faa58cd5 did so at 08:26Z on 10-18. A later git command that copies the index into the worktree (a checkout or restore of a path, a
    stash that keeps the index, a failed merge) then wrote faa58cd5^'s bytes over ThroughputLine.svelte, WorkRow.svelte, app.css and
    clock.svelte.ts and deleted chat-idle-motion.test.ts, and they stayed so until 12:45Z. A file on disk that holds the same older version
    takes HEAD's bytes too. A staged or unstaged live edit, bytes no commit of the path has, stays as it is."""
    if rev(checkout, "HEAD") is None:
        return []
    raw = git(checkout, "diff-index", "--cached", "-z", "--no-renames", "HEAD").split("\0")
    healed = []
    for meta, rel in zip(raw[0::2], raw[1::2]):
        head_mode, index_mode, head_blob, index_blob, status = meta.lstrip(":").split(" ")
        if status == "U" or "160000" in (head_mode, index_mode) or index_blob not in earlier_blobs(checkout, rel) - {head_blob}:
            continue
        head = None if head_mode == "000000" else (head_mode, head_blob)
        staged = None if index_mode == "000000" else (index_mode, index_blob)
        if disk_state(checkout, rel) == staged:
            if head is None:
                (checkout / rel).unlink()
            else:
                (checkout / rel).parent.mkdir(parents=True, exist_ok=True)
                write_file(checkout / rel, head[0], blob(checkout, head[1]))
            healed.append(f"{rel} and its file")
        else:
            healed.append(rel)
        set_index(checkout, rel, head)
    return [f"reset to HEAD from an older commit: {', '.join(healed)}"] if healed else []


def earlier_blobs(checkout: Path, rel: str) -> set[str]:
    """Every blob the path held in HEAD's history, with the all-zero id for a commit that added or deleted it."""
    rows = git(checkout, "log", "--format=", "--raw", "--no-abbrev", "HEAD", "--", rel).splitlines()
    return {blob_id for row in rows if row.startswith(":") for blob_id in row.split("\t")[0].split(" ")[2:4]}


def changed_paths(checkout: Path, old: str, new: str) -> list[tuple[str, Entry | None, Entry | None]]:
    raw = git(checkout, "diff-tree", "-r", "-z", "--no-renames", old, new).split("\0")
    rows = []
    for meta, rel in zip(raw[0::2], raw[1::2]):
        old_mode, new_mode, old_blob, new_blob, _ = meta.lstrip(":").split(" ")
        rows.append((rel, None if old_mode == "000000" else (old_mode, old_blob), None if new_mode == "000000" else (new_mode, new_blob)))
    return rows


def disk_state(checkout: Path, rel: str) -> Entry | None:
    path = checkout / rel
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(info.st_mode):
        return ("120000", git(checkout, "hash-object", "--stdin", "--no-filters", input=os.readlink(path).encode()))
    if not stat.S_ISREG(info.st_mode):
        return ("dir", "")
    return ("100755" if info.st_mode & 0o111 else "100644", git(checkout, "hash-object", "--", rel))


def index_entry(checkout: Path, rel: str) -> Entry | None:
    row = git(checkout, "ls-files", "-s", "--", rel)
    if not row:
        return None
    mode, sha, _stage = row.split("\t")[0].split(" ")
    return (mode, sha)


def set_index(checkout: Path, rel: str, entry: Entry | None) -> None:
    if entry is None:
        git(checkout, "update-index", "--force-remove", "--", rel)
    else:
        git(checkout, "update-index", "--add", "--cacheinfo", f"{entry[0]},{entry[1]},{rel}")


def blob(checkout: Path, sha: str) -> bytes:
    return subprocess.run(["git", "-C", str(checkout), "cat-file", "blob", sha], capture_output=True, env=GIT_ENV, check=True, timeout=120).stdout


def write_file(path: Path, mode: str, data: bytes) -> None:
    if path.is_symlink():
        path.unlink()
    temporary = path.with_name(f"{path.name}.prime-sync.tmp")
    temporary.write_bytes(data)
    os.chmod(temporary, 0o755 if mode == "100755" else 0o644)
    os.replace(temporary, path)


def carry(checkout: Path, rel: str, disk: Entry | None, old: Entry | None, new: Entry | None, favor: str | None = None) -> bytes | None:
    """The live edit on rel merged onto new's bytes, or None when it does not merge as text. favor="--ours" keeps the live side of a clash."""
    if disk is None or old is None or new is None or "120000" in (disk[0], old[0], new[0]) or disk[0] not in (old[0], new[0]):
        return None
    with tempfile.TemporaryDirectory(prefix="prime-sync-carry-") as folder:
        mine, base, theirs = (Path(folder) / name for name in ("mine", "base", "theirs"))
        mine.write_bytes((checkout / rel).read_bytes())
        base.write_bytes(blob(checkout, old[1]))
        theirs.write_bytes(blob(checkout, new[1]))
        merged = subprocess.run(["git", "merge-file", "-p", *([favor] if favor else []), str(mine), str(base), str(theirs)],
                                capture_output=True, env=GIT_ENV, timeout=120)
    return merged.stdout if merged.returncode == 0 else None


def superseded(checkout: Path, rel: str, head: str, remote: str) -> bool:
    """True when the file on disk is older than the newest commit in head..origin/main that changed it, so it is that commit's draft."""
    stamp = git(checkout, "log", "-1", "--format=%ct", f"{head}..{remote}", "--", rel)
    return bool(stamp) and os.lstat(checkout / rel).st_mtime < int(stamp)


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


# 5. The block watch


# The AI harness chat asked on 10-18 for asa-mac-sync's two steps here: the session that wrote a blocking path hears of it after 10 min,
# and its own For you list gets one todo after 30 min. The Mac's checkout sat at 461986e from 08:26Z to 10:45Z that day with nobody told.
BLOCK_ALERT_S = int(os.environ.get("PRIME_SYNC_BLOCK_ALERT_S") or 600)
FORYOU_S = int(os.environ.get("PRIME_SYNC_FORYOU_S") or 1800)
FORYOU_CHAT = os.environ.get("PRIME_SYNC_FORYOU_CHAT") or "01a1164b-4a2d-742d-b27a-82f086ed0200"
PRIME_BIN = os.environ.get("PRIME_SYNC_PRIME_BIN") or str(HOME / ".local/share/prime-agent/bin/prime-agent")
TRANSCRIPTS = Path(os.environ.get("PRIME_SYNC_TRANSCRIPTS") or HOME / ".prime/agent")
USER_HISTORY = HOME / ".local/share/sieun-pi-chat/current/components/user-history"
SESSION_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
WRITES = re.compile(r"'w'|\\\"w\\\"|write_text|write_bytes|old_str|sed -i|--write|\bcp |\bmv |checkout |git apply|tee | > ")
FOLLOWING = ("at ", "pulled ", "rebased ", "ahead of ")


def board_apply() -> list[str]:
    if os.environ.get("PRIME_SYNC_BOARD_APPLY"):
        return os.environ["PRIME_SYNC_BOARD_APPLY"].split()
    node = next((str(p) for p in (HOME / ".local/node/bin/node", HOME / ".local/bin/node") if p.exists()), shutil.which("node") or "node")
    return [node, "--import", "tsx", "scripts/board-apply.ts"]


def watch_block(report: dict, config: dict, paths: list[str]) -> None:
    """Tell the session that wrote each blocking path once the checkout has not followed main for BLOCK_ALERT_S,
    and put one todo on FORYOU_CHAT's For you list at FORYOU_S. It only tells: a live edit stays until its session commits it or puts it back."""
    path = SHARE / "blocked.json"
    try:
        state = json.loads(path.read_text())
    except (OSError, ValueError):
        state = {}
    code, now = str(report.get("code", "")), time.time()
    if code.startswith(FOLLOWING):
        if state.get("todo"):
            board_ops([{"op": "todo_update", "id": state["todo"], "done": True}])
        state = {}
    else:
        state.setdefault("since", now)
        minutes = int((now - state["since"]) // 60)
        owners = state.setdefault("owners", {})
        if now - state["since"] >= BLOCK_ALERT_S:
            for rel in paths:
                if rel in owners:
                    continue
                found = writer(config["checkout"], rel)
                told = bool(found) and send(found[0], f"[prime-sync] {config['host']}'s sieun-pi checkout {config['checkout']} has not followed GitHub main "
                                                       f"for {minutes} min, because your session last wrote {rel} at {time.strftime('%H:%M:%SZ', time.gmtime(found[1]))} "
                                                       f"and the run stops on it ({code[:300]}). Please commit it or put it back to HEAD. "
                                                       f"prime-sync never drops it on its own. Log: {SHARE / 'sync.log'}")
                owners[rel] = {"session": found and found[0], "told": told}
        if now - state["since"] >= FORYOU_S and not state.get("todo"):
            state["todo"] = ask_owner(config, minutes, code, owners)
    write_atomic(path, json.dumps(state).encode(), 0o644)


def send(session: str, text: str) -> bool:
    try:
        return subprocess.run([PRIME_BIN, "send", session, text], capture_output=True, timeout=60).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def board_ops(ops: list[dict]) -> str:
    """Applies chat_board ops to FORYOU_CHAT's board with the chat's board-apply script, which forwards them to the chat host. Its output, or ""."""
    try:
        result = subprocess.run([*board_apply(), FORYOU_CHAT, json.dumps(ops)], cwd=USER_HISTORY if USER_HISTORY.is_dir() else None,
                                capture_output=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return result.stdout.decode(errors="replace") if result.returncode == 0 else ""


def ask_owner(config: dict, minutes: int, code: str, owners: dict) -> str | None:
    who = "; ".join(f"session {v['session'][:8]} wrote {rel}" + (" and was told" if v["told"] else "") for rel, v in owners.items() if v["session"])
    held = ", ".join(list(owners)[:3]) or code[:300]
    text = (f"The {config['host']} copy of sieun-pi has not followed GitHub main for {minutes} min, held up by {held}. "
            f"{(who[0].upper() + who[1:] + '.') if who else 'No session could be found for it.'} Should this chat get it sorted?")
    links = [{"label": f"session {v['session'][:8]}", "target": f"thread:{v['session']}"} for v in owners.values() if v["session"]][:4]
    out = board_ops([{"op": "todo_add", "text": text, "choices": ["Yes, get it sorted", "Leave it"],
                      "links": links + [{"label": "sync log", "target": f"file:{SHARE / 'sync.log'}"}]}])
    found = re.search(r"[Aa]dded a todo (t\d+)", out)
    return found.group(1) if found else None


def writer(checkout: Path, rel: str) -> tuple[str, float] | None:
    """(session id, call time) of the newest Prime tool call that names rel at or before the file's mtime, preferring one that writes it.
    A transcript is <session id>.jsonl under TRANSCRIPTS/sessions or session-artifacts, and only one written since the file was can hold the call.
    A "commit <sha>" path is looked up by its sha and the commit's time."""
    needle = rel.split(" ", 1)[1] if rel.startswith("commit ") else rel
    try:
        mtime = float(git(checkout, "log", "-1", "--format=%ct", needle)) if rel.startswith("commit ") else os.lstat(checkout / rel).st_mtime
    except (OSError, RuntimeError, ValueError):
        mtime = time.time()
    best: dict = {}
    for top in ("sessions", "session-artifacts"):
        for folder, _dirs, files in os.walk(TRANSCRIPTS / top):
            for name in files:
                if not name.endswith(".jsonl") or not SESSION_ID.fullmatch(name[:-6]):
                    continue
                try:
                    if os.stat(os.path.join(folder, name)).st_mtime < mtime:
                        continue
                    data = Path(folder, name).read_bytes()
                except OSError:
                    continue
                if needle.encode() not in data:
                    continue
                for raw in data.splitlines():
                    if needle.encode() not in raw:
                        continue
                    try:
                        row = json.loads(raw)
                        at = datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00")).timestamp()
                        calls = [c for c in row["message"]["content"] if c.get("type") in ("toolCall", "tool_use")]
                    except (ValueError, KeyError, TypeError, AttributeError):
                        continue
                    if at > mtime + 2:
                        continue
                    for call in calls:
                        args = json.dumps(call.get("arguments", call.get("input")))
                        if needle not in args:
                            continue
                        key = (call.get("name") == "edit" or bool(WRITES.search(args)), at)
                        if key > best.get("key", (False, 0)):
                            best = {"key": key, "session": name[:-6]}
    return (best["session"], best["key"][1]) if best else None


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
        steps = [("index", lambda: heal_index(config["checkout"])),
                 ("code", lambda: pull_checkout(config["checkout"])),
                 ("links", lambda: link_manifest(config["checkout"], HOME, config["agentDir"])),
                 ("settings", lambda: apply_settings(config["checkout"], config["agentDir"])),
                 ("state", lambda: sync_state(config))]
        blocking: list[str] = []
        for name, step in steps:
            try:
                report[name] = step()
            except Alert as reason:
                report[name] = f"alert: {reason}"
            except Skip as reason:
                report[name] = f"skipped: {reason}"
                blocking += reason.paths if name == "code" else []
            except Exception as error:
                report[name] = f"error: {type(error).__name__}: {error}"
        try:
            watch_block(report, config, blocking)
        except Exception as error:
            report["watch"] = f"error: {type(error).__name__}: {error}"
    write_atomic(SHARE / "status.json", (json.dumps(report, indent=2) + "\n").encode(), 0o644)
    if any(report.get(key) for key in ("index", "links", "settings", "state")) or str(report.get("code")).startswith(("pulled", "rebased", "skipped", "alert")) or "error" in json.dumps(report):
        with open(SHARE / "sync.log", "a") as log:
            log.write(json.dumps(report) + "\n")
    return report


if __name__ == "__main__":
    result = run()
    print(json.dumps(result, indent=2))
    sys.exit(1 if any(isinstance(value, str) and value.startswith(("error:", "alert:")) for value in result.values()) else 0)
