#!/usr/bin/python3
"""Fast-forward the box auto-sns-agent checkout to the Mac checkout's sieun/dev.

Run by asa-mac-sync.timer and by tip-host.mjs after each land (systemctl --user start asa-mac-sync.service).
Installed as a copy in ~/.local/share/asa-mac-sync; its log, blocked.json and carried/ live in ~/.local/state/asa-mac-sync. Each run fetches the Mac's local sieun/dev over ssh into
refs/remotes/mac/sieun/dev and fast-forwards the box's sieun/dev only when:
  - the box checkout is on sieun/dev and its HEAD is an ancestor of the Mac tip,
  - no .git/index.lock exists and the index stages nothing,
  - every path the fast-forward writes is clean on disk, or already holds the Mac
    tip's bytes (a file another session copied over by hand).
A wiki page (apps/llm-wiki/content/) that the Mac tip changes while the box holds
other bytes keeps the box's bytes: since 2026-10-18 04:17Z the wiki host (this box)
is the one writer of wiki pages, and the Mac gets them from wiki-box-commit's
ci/wiki-box objects, so the box copy is the same page or newer. The fast-forward
leaves that file as a local edit on the new HEAD, and wiki-box-commit ships it.
Outside the wiki, a live edit on a path the fast-forward writes rides on the move: it is
merged onto the tip's bytes, a hunk both sides changed keeps the live side, and the old
bytes are saved in CARRY_DIR. A file that cannot be merged as text (binary, symlink, added
or deleted on one side) keeps its bytes as a local edit on the new HEAD. Until 2026-10-18
such a path skipped the run, and with dozens of sessions editing the checkout the box sat
at b9df6df9df from 06:36Z to 08:3xZ, over 120 commits behind, because some live path always
overlapped the incoming range. Live edits on other paths stay untouched, because a
fast-forward never writes them.
A .git/index.lock that no process holds open, with no git process running in the checkout,
is removed once it is older than STALE_LOCK_S.
When the box line is not an ancestor of the Mac tip, the run moves the box to the
Mac tip only if the Mac tip already holds every box-only commit: as a Replayed-From
trailer (tip-host.mjs and the 2026-10-18 replay write it) or as the same bytes on every
path the commit changed. Since 2026-10-18 the box is a follower: commit.mjs and
land-object.mjs land on the Mac over ssh (.git/agent-tip-host.json), so the box branch
only ever follows the Mac. Any box-only commit the Mac lacks skips the run and is named.
It never drops a commit the Mac lacks and never pushes. Every run writes one JSON
line to the log, and a skipped run names its reason.
"""
import calendar, fcntl, json, os, re, shutil, stat, subprocess, sys, tempfile, time

REPO = os.environ.get("ASA_SYNC_REPO") or os.path.expanduser("~/Documents/Github/auto-sns-agent")
URL = os.environ.get("ASA_SYNC_URL") or "mac:/Users/sieunpark/Documents/Github/auto-sns-agent"
BRANCH = "refs/heads/sieun/dev"
TRACK = "refs/remotes/mac/sieun/dev"
STATE = os.environ.get("ASA_SYNC_STATE") or os.path.expanduser("~/.local/state/asa-mac-sync")
LOG = os.environ.get("ASA_SYNC_LOG") or os.path.join(STATE, "sync.log")
CARRY_DIR = os.environ.get("ASA_SYNC_CARRY") or os.path.join(STATE, "carried")
BLOCK_STATE = os.environ.get("ASA_SYNC_BLOCK_STATE") or os.path.join(STATE, "blocked.json")
# The VP of CI asked on 2026-10-18 for an alert after 10 min blocked; the box sat 73 min behind (06:06Z to 07:19Z) with no alert.
BLOCK_ALERT_S = int(os.environ.get("ASA_SYNC_BLOCK_ALERT_S") or 600)
# The ops chat box-memory-guard sends to.
OPS_THREAD = os.environ.get("ASA_SYNC_OPS_THREAD") or "01a11af8-962e-773d-a19a-ee4104011987"
PRIME_BIN = os.environ.get("ASA_SYNC_PRIME_BIN") or os.path.expanduser("~/.local/bin/prime-agent")
# The 10 min ops alert at 08:24Z on 2026-10-18 sat with nobody acting while ecosystem.config.cjs held the box. So the VP of CI asked for the
# session that wrote a blocking path to hear of it at BLOCK_ALERT_S, and for one line on the AI harness chat's For you list at FORYOU_S.
FORYOU_S = int(os.environ.get("ASA_SYNC_FORYOU_S") or 1800)
FORYOU_CHAT = os.environ.get("ASA_SYNC_FORYOU_CHAT") or "01a1164b-4a2d-742d-b27a-82f086ed0200"
USER_HISTORY = os.path.expanduser("~/.local/share/sieun-pi-chat/current/components/user-history")
BOARD_APPLY = (os.environ["ASA_SYNC_BOARD_APPLY"].split() if os.environ.get("ASA_SYNC_BOARD_APPLY") else
               [os.path.expanduser("~/.local/node/bin/node"), "--import", "tsx", "scripts/board-apply.ts"])
TRANSCRIPTS = os.environ.get("ASA_SYNC_TRANSCRIPTS") or os.path.expanduser("~/.prime/agent")
SESSION_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
# The longest .git/index.lock a live git held in sync.log on 2026-10-18 was 65 s (08:18:51Z to 08:19:56Z).
STALE_LOCK_S = int(os.environ.get("ASA_SYNC_STALE_LOCK_S") or 70)
GIT = "/usr/bin/git"
WIKI = "apps/llm-wiki/content/"
READ_ENV = {**os.environ, "GIT_OPTIONAL_LOCKS": "0",
            "GIT_SSH_COMMAND": "ssh -o BatchMode=yes -o ConnectTimeout=15"}
for k in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
    READ_ENV.pop(k, None)


def log(outcome, **kw):
    line = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "outcome": outcome, **kw}
    with open(LOG, "a") as f:
        f.write(json.dumps(line) + "\n")
    print(json.dumps(line))
    if kw.get("reason") != "another run holds the lock" and "--dry-run" not in sys.argv:
        watch_block(outcome, line)


def watch_block(outcome, line):
    """Tell the ops chat and the session that wrote each blocking path at BLOCK_ALERT_S, and the owner's For you at FORYOU_S.

    It only tells: a live edit stays where it is until its session commits it or puts it back.
    """
    try:
        state = json.load(open(BLOCK_STATE))
    except (OSError, ValueError):
        state = {}
    now = time.time()
    if outcome in ("noop", "fast-forward", "converge"):
        if state.get("alerted"):
            send(OPS_THREAD, f"[asa-mac-sync] us-metal02 follows the Mac again: {outcome} at {line['ts']}, HEAD {line.get('now') or line.get('head')}.")
        if state.get("todo"):
            board_ops([{"op": "todo_update", "id": state["todo"], "done": True}])
        state = {}
    elif outcome != "stale-lock":
        state.setdefault("since", now)
        mins = int((now - state["since"]) // 60)
        if now - state["since"] >= BLOCK_ALERT_S:
            if not state.get("alerted"):
                state["alerted"] = send(OPS_THREAD, f"[asa-mac-sync] us-metal02 auto-sns-agent sieun/dev has not followed the Mac for {mins} min. "
                                                    f"Last run: {json.dumps(line)[:900]}. Log: {LOG}")
            owners = state.setdefault("owners", {})
            for rel, session, why in blockers(line):
                if rel in owners:
                    continue
                told = bool(session) and send(session, f"[asa-mac-sync] us-metal02's auto-sns-agent checkout has not followed the Mac's sieun/dev for {mins} min, "
                                                       f"because {why}. Please commit it or put it back to HEAD. The sync never drops it on its own. Log: {LOG}")
                owners[rel] = {"session": session, "told": told}
        if now - state["since"] >= FORYOU_S and not state.get("todo"):
            state["todo"] = ask_owner(mins, line, state.get("owners", {}))
    with open(BLOCK_STATE + ".tmp", "w") as f:
        json.dump(state, f)
    os.replace(BLOCK_STATE + ".tmp", BLOCK_STATE)


def send(agent, text):
    r = subprocess.run([PRIME_BIN, "send", agent, text], capture_output=True, timeout=60)
    return r.returncode == 0


def board_ops(ops):
    """Applies chat_board ops to FORYOU_CHAT's board with the chat's own board-apply script. Its summary lines, or "" when it refused."""
    r = subprocess.run([*BOARD_APPLY, FORYOU_CHAT, json.dumps(ops)], cwd=USER_HISTORY if os.path.isdir(USER_HISTORY) else None,
                       capture_output=True, timeout=120)
    return r.stdout.decode(errors="replace") if r.returncode == 0 else ""


def ask_owner(mins, line, owners):
    """Puts one line on FORYOU_CHAT's For you list. The todo id, or None when the board took nothing."""
    who = "; ".join(f"session {v['session'][:8]} wrote {rel}" + (" and was told" if v["told"] else "") for rel, v in owners.items() if v["session"])
    paths = [rel for rel in owners] or [line.get("reason", "an unknown reason")]
    text = (f"The box copy of auto-sns-agent has not followed the Mac for {mins} min, held up by {', '.join(paths[:3])}. "
            f"{(who[0].upper() + who[1:] + '.') if who else 'No session could be found for it.'} Should this chat get it committed or dropped?")
    links = [{"label": f"session {v['session'][:8]}", "target": f"thread:{v['session']}"} for v in owners.values() if v["session"]][:4]
    out = board_ops([{"op": "todo_add", "text": text, "choices": ["Yes, get it sorted", "Leave it"],
                      "links": links + [{"label": "sync log", "target": f"file:{LOG}"}]}])
    m = re.search(r"[Aa]dded a todo (t\d+)", out)
    return m.group(1) if m else None


def blockers(line):
    """(path, session or None, why) for each path that holds a skipped run: a dirty or staged path, or a held .git/index.lock."""
    if line.get("reason") == ".git/index.lock exists":
        lock = os.path.join(REPO, ".git", "index.lock")
        return [(".git/index.lock", session, f"a git process of your session (pid {pid}) holds .git/index.lock")
                for pid, session in ((pid, environ_session(pid)) for pid in lock_holders(lock))][:1] or [(".git/index.lock", None, "")]
    rows = []
    for rel in (line.get("dirty") or line.get("staged") or [])[:10]:
        found = writer(rel)
        rows.append((rel, found and found[0], found and f"your session last wrote {rel} at {time.strftime('%H:%M:%SZ', time.gmtime(found[1]))} "
                                                       f"and the run skips on it ({line['reason']})"))
    return rows


def environ_session(pid):
    try:
        env = open(f"/proc/{pid}/environ", "rb").read().decode(errors="replace").split("\0")
    except OSError:
        return None
    harness = next((e.split("=", 1)[1] for e in env if e.startswith("RLM_HARNESS_STATE_DIR=")), "")
    m = SESSION_ID.search(os.path.basename(os.path.dirname(harness)))
    return m.group(0) if m else None


def writer(rel):
    """(session id, call time) of the newest Prime tool call that names rel at or before the file's mtime, preferring one that writes it.

    A transcript is <session id>.jsonl under TRANSCRIPTS/sessions or session-artifacts, and only one written since the file was can hold the call.
    On 2026-10-18 the 08:25:43Z write of ecosystem.config.cjs was session 01a14dfb's ipython call with open(..., 'w'), found this way.
    """
    try:
        mtime = os.lstat(os.path.join(REPO, rel)).st_mtime
    except FileNotFoundError:
        mtime = time.time()
    needle, best = rel.encode(), {}
    for top in ("sessions", "session-artifacts"):
        for dirpath, _dirs, files in os.walk(os.path.join(TRANSCRIPTS, top)):
            for name in files:
                path = os.path.join(dirpath, name)
                if not name.endswith(".jsonl") or not SESSION_ID.fullmatch(name[:-6]):
                    continue
                try:
                    if os.stat(path).st_mtime < mtime:
                        continue
                    with open(path, "rb") as f:
                        data = f.read()
                except OSError:
                    continue
                if needle not in data:
                    continue
                for raw in data.splitlines():
                    if needle not in raw:
                        continue
                    try:
                        row = json.loads(raw)
                        at = calendar.timegm(time.strptime(row["timestamp"][:19], "%Y-%m-%dT%H:%M:%S"))
                        calls = [c for c in row["message"]["content"] if c.get("type") in ("toolCall", "tool_use")]
                    except (ValueError, KeyError, TypeError, AttributeError):
                        continue
                    if at > mtime + 2:
                        continue
                    for c in calls:
                        args = json.dumps(c.get("arguments", c.get("input")))
                        if rel not in args:
                            continue
                        writes = c.get("name") == "edit" or bool(WRITES.search(args))
                        if (writes, at) > best.get("key", (False, 0)):
                            best = {"key": (writes, at), "session": name[:-6]}
    return (best["session"], best["key"][1]) if best else None


WRITES = re.compile(r"'w'|\\\"w\\\"|write_text|write_bytes|old_str|sed -i|--write|\bcp |\bmv |checkout |git apply|tee | > ")


def git(*args, check=True, inp=None, timeout=300):
    # Another session's git holds .git/index.lock for a moment; on 2026-10-18 07:17:28Z one
    # did mid-move. Wait for it instead of stopping halfway.
    for _ in range(40):
        r = subprocess.run([GIT, "-C", REPO, *args], env=READ_ENV, input=inp, capture_output=True, timeout=timeout)
        if r.returncode == 0 or b"index.lock': File exists" not in r.stderr:
            break
        time.sleep(0.25)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args[:3])}: {r.stderr.decode(errors='replace').strip()[-400:]}")
    return r


def out(*args):
    return git(*args).stdout.decode().strip()


def lock_holders(lock):
    """Pids that hold lock open or run git with their working directory in REPO."""
    real, holders = os.path.realpath(REPO), []
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            if any(os.readlink(f"/proc/{pid}/fd/{fd}") == lock for fd in os.listdir(f"/proc/{pid}/fd")):
                holders.append(int(pid))
                continue
            cmd = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
            if os.path.basename(cmd[0]) == b"git" and (os.path.realpath(os.readlink(f"/proc/{pid}/cwd")) + "/").startswith(real + "/"):
                holders.append(int(pid))
        except OSError:
            continue
    return holders


def clear_stale_lock():
    """Remove .git/index.lock when it is older than STALE_LOCK_S and nothing holds it. True when it is gone."""
    lock = os.path.join(REPO, ".git", "index.lock")
    try:
        age = time.time() - os.lstat(lock).st_mtime
    except FileNotFoundError:
        return True
    if age < STALE_LOCK_S or lock_holders(lock):
        return False
    os.remove(lock)
    log("stale-lock", detail=f"removed .git/index.lock, {int(age)} s old, no holder")
    return True


def disk_state(rel):
    p = os.path.join(REPO, rel)
    try:
        st = os.lstat(p)
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(st.st_mode):
        target = os.readlink(p).encode()
        return ("120000", git("hash-object", "--stdin", "--no-filters", inp=target).stdout.decode().strip())
    if not stat.S_ISREG(st.st_mode):
        return ("dir", "")
    mode = "100755" if st.st_mode & 0o111 else "100644"
    return (mode, git("hash-object", "--", rel).stdout.decode().strip())


def changed_paths(old, new):
    raw = git("diff-tree", "-r", "-z", "--no-renames", old, new).stdout.decode().split("\0")
    rows = []
    for i in range(0, len(raw) - 1, 2):
        meta, rel = raw[i], raw[i + 1]
        if not meta.startswith(":"):
            continue
        om, nm, ob, nb, _ = meta[1:].split(" ")
        rows.append((rel, None if om == "000000" else (om, ob), None if nm == "000000" else (nm, nb)))
    return rows


def carry(rel, disk, old, new, favor=None):
    """The live edit on rel merged onto the tip's bytes, or None when it does not merge cleanly.

    With favor="--ours", a hunk that both sides changed keeps the live side, so every line the
    live edit wrote stays and the tip's other changes land around it.
    """
    if disk is None or old is None or new is None or disk[0] == "dir" or "120000" in (disk[0], old[0], new[0]):
        return None
    if disk[0] != old[0] and disk[0] != new[0]:
        return None
    d = tempfile.mkdtemp(prefix="asa-carry-")
    try:
        mine, base, theirs = (os.path.join(d, n) for n in ("mine", "base", "theirs"))
        with open(os.path.join(REPO, rel), "rb") as src, open(mine, "wb") as f:
            f.write(src.read())
        for path, blob in ((base, old[1]), (theirs, new[1])):
            with open(path, "wb") as f:
                f.write(git("cat-file", "blob", blob).stdout)
        r = git("merge-file", "-p", *([favor] if favor else []), mine, base, theirs, check=False)
        return r.stdout if r.returncode == 0 else None
    finally:
        shutil.rmtree(d, ignore_errors=True)


def write_file(rel, mode, data):
    p = os.path.join(REPO, rel)
    tmp = p + ".asa-sync.tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.chmod(tmp, 0o755 if mode == "100755" else 0o644)
    os.replace(tmp, p)


def superseded(rel, head, tip):
    """True when the file on disk is older than the newest commit in head..tip that changed it.

    On 2026-10-18 from 08:13Z six crawler-v3 and infra files held drafts written 05:46Z to 07:42Z, and
    box sessions then landed other bytes for them at 08:14Z to 08:21Z, so the box stopped following the
    Mac. A file nobody wrote after its commit is that commit's draft. Its bytes are saved in CARRY_DIR and
    the file takes the tip's bytes; a file written after the commit stays a live edit and holds the move.
    """
    if rel.startswith(WIKI):
        return False
    try:
        mtime = os.lstat(os.path.join(REPO, rel)).st_mtime
    except FileNotFoundError:
        return False
    ts = out("log", "-1", "--format=%ct", f"{head}..{tip}", "--", rel)
    return bool(ts) and mtime < int(ts)


def unlanded(box_only, head, tip):
    """Box-only commits the Mac tip holds neither as a Replayed-From trailer nor as the same bytes."""
    base = out("merge-base", head, tip)
    replayed = set()
    for line in out("log", "--format=%B", f"{base}..{tip}").splitlines():
        if line.startswith("Replayed-From: "):
            replayed.add(line.split()[1])
    missing = []
    for c in box_only:
        if c in replayed:
            continue
        rows = changed_paths(f"{c}^", c)
        if not rows or any(tip_entry(tip, rel) != new for rel, _old, new in rows):
            missing.append(c)
    return missing


def index_entry(rel):
    row = out("ls-files", "-s", "--", rel)
    if not row:
        return None
    mode, blob, _stage = row.split("\t")[0].split(" ")
    return (mode, blob)


def tip_entry(tip, rel):
    row = git("ls-tree", "--full-tree", tip, "--", rel).stdout.decode().strip()
    if not row:
        return None
    mode, _type, blob = row.split("\t")[0].split(" ")
    return (mode, blob)


def main():
    lock = open(LOG + ".lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return log("skip", reason="another run holds the lock")

    f = git("fetch", "--no-tags", "--quiet", URL, f"{BRANCH}:{TRACK}", check=False, timeout=180)
    if f.returncode != 0:
        return log("skip", reason="fetch failed", detail=f.stderr.decode(errors="replace").strip()[-300:])

    head_ref = git("symbolic-ref", "-q", "HEAD", check=False).stdout.decode().strip()
    if head_ref != BRANCH:
        return log("skip", reason=f"checkout is on {head_ref or 'a detached HEAD'}, not sieun/dev")
    head, tip = out("rev-parse", "HEAD"), out("rev-parse", TRACK)
    if head == tip:
        return log("noop", head=head[:10])
    converge = git("merge-base", "--is-ancestor", head, tip, check=False).returncode != 0
    if converge:
        box_only = out("rev-list", f"{tip}..{head}").split()
        missing = unlanded(box_only, head, tip)
        if missing:
            return log("skip", reason="box sieun/dev has commits the Mac tip lacks", head=head[:10], tip=tip[:10],
                       box_only_commits=len(box_only), missing=[c[:10] for c in missing][:20],
                       mac_only_commits=int(out("rev-list", "--count", f"{head}..{tip}")))
    if os.path.exists(os.path.join(REPO, ".git", "index.lock")) and not clear_stale_lock():
        return log("skip", reason=".git/index.lock exists", head=head[:10], tip=tip[:10])
    staged = out("diff-index", "--cached", "--name-only", head).splitlines()
    # A path staged at the Mac tip's bytes is a move half done (a sync that stopped after
    # setting the index). Its entry goes back to HEAD's, and the move below sets it again.
    halfway = [rel for rel in staged if index_entry(rel) == tip_entry(tip, rel)]
    for rel in halfway:
        entry = tip_entry(head, rel)
        if entry is None:
            git("update-index", "--force-remove", "--", rel)
        else:
            git("update-index", "--add", "--cacheinfo", f"{entry[0]},{entry[1]},{rel}")
    staged = [rel for rel in staged if rel not in halfway]
    if staged:
        return log("skip", reason="the index stages changes", head=head[:10], tip=tip[:10], staged=staged[:20], staged_count=len(staged))

    rows = changed_paths(head, tip)
    dirty, preapplied, kept, carried, overlap = [], [], [], [], []
    for rel, old, new in rows:
        disk = disk_state(rel)
        if disk == old:
            continue
        if disk == new:
            preapplied.append((rel, old, new))
        elif rel.startswith(WIKI) and new is not None and disk is not None and disk[0] == new[0]:
            preapplied.append((rel, old, new))
            kept.append(rel)
        elif (merged := carry(rel, disk, old, new)) is not None:
            carried.append((rel, old, new, disk, merged))
        elif new is not None and disk is not None and disk[0] != "dir" and superseded(rel, head, tip):
            carried.append((rel, old, new, disk, None))
        elif (merged := carry(rel, disk, old, new, favor="--ours")) is not None:
            carried.append((rel, old, new, disk, merged))
            overlap.append(rel)
        elif disk is None or disk[0] != "dir":
            preapplied.append((rel, old, new))
            kept.append(rel)
        else:
            dirty.append(rel)
    if dirty:
        return log("skip", reason="paths the fast-forward writes hold local changes", head=head[:10], tip=tip[:10],
                   dirty=dirty[:30], dirty_count=len(dirty))

    if "--dry-run" in sys.argv:
        return print(json.dumps({"dry_run": True, "head": head[:10], "tip": tip[:10], "paths": len(rows),
                                 "preapplied": len(preapplied) - len(kept), "kept_local": kept,
                                 "carried": [c[0] for c in carried if c[4] is not None], "overlap": overlap,
                                 "superseded": [c[0] for c in carried if c[4] is None]}))

    # A carried path holds a live edit on a file the move changes. Its bytes are saved in
    # CARRY_DIR, the file gets the tip's bytes for the move, and the edit goes back on top.
    saved = None
    if carried:
        saved = os.path.join(CARRY_DIR, time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"-{head[:10]}-{tip[:10]}")
        for rel, _old, new, disk, _merged in carried:
            if disk_state(rel) != disk:
                return log("skip", reason="a carried path changed while the run read it", path=rel)
            dst = os.path.join(saved, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(os.path.join(REPO, rel), "rb") as src, open(dst, "wb") as f:
                f.write(src.read())
        for rel, _old, new, _disk, _merged in carried:
            write_file(rel, new[0], git("cat-file", "blob", new[1]).stdout)
            preapplied.append((rel, _old, new))

    def set_index(rel, entry):
        if entry is None:
            git("update-index", "--force-remove", "--", rel)
        else:
            git("update-index", "--add", "--cacheinfo", f"{entry[0]},{entry[1]},{rel}")

    def undo():
        for rel, old, _new in preapplied:
            set_index(rel, old)
        for rel, _old, _new, disk, _merged in carried:
            write_file(rel, disk[0], open(os.path.join(saved, rel), "rb").read())

    try:
        for rel, _old, new in preapplied:
            set_index(rel, new)
    except Exception:
        undo()
        raise
    if converge:
        m = git("update-ref", "-m", "asa-mac-sync: follow the Mac tip, every box-only commit is on it", BRANCH, tip, head, check=False)
        if m.returncode == 0:
            m = git("read-tree", "-m", "-u", head, tip, check=False)
            if m.returncode != 0:
                git("update-ref", "-m", "asa-mac-sync: read-tree refused, back", BRANCH, head, tip, check=False)
    else:
        m = git("merge", "--ff-only", "--no-stat", "--quiet", tip, check=False)
    if m.returncode != 0:
        undo()
        return log("skip", reason="the move to the Mac tip was refused", head=head[:10], tip=tip[:10],
                   detail=m.stderr.decode(errors="replace").strip()[-600:])
    now = out("rev-parse", "HEAD")
    for rel, _old, new, disk, merged in carried:
        if merged is None and now == tip:
            continue
        write_file(rel, new[0] if now == tip else disk[0], merged if now == tip else open(os.path.join(saved, rel), "rb").read())
    log(("converge" if converge else "fast-forward") if now == tip else "error", head=head[:10], tip=tip[:10], now=now[:10],
        commits=int(out("rev-list", "--count", f"{head}..{now}")), paths=len(rows), preapplied=len(preapplied) - len(kept) - len(carried),
        carried=[c[0] for c in carried if c[4] is not None], overlap=overlap, superseded=[c[0] for c in carried if c[4] is None],
        carried_saved=saved, kept_local=kept[:30])


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log("error", detail=str(e)[-600:])
        sys.exit(1)
