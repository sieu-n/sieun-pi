#!/usr/bin/env python3
"""Resume Prime Agent runs that an interruption stopped.

An interruption is a wifi drop, a sleeping or shut-down Mac, or a sign-in
token that could not refresh while offline. A run counts as interrupted when
it is live and idle, and either:

  - its last message is an assistant error that names a network or sign-in
    failure ("Connection error.", "fetch failed", "WebSocket closed",
    "Failed to resolve API key ..."), or
  - its last message is a tool result, a user message or a tool call with no
    reply after it: the turn was cut off, or
  - its last message is an empty model reply that asked for a tool, or
  - it shows "working" but did nothing for 30 minutes with no child run or
    compaction running (120 minutes when a tool call is running): a hung model
    stream, retry wait or tool call. A message cannot reach it; it has to be aborted first, which the chat
    Resume button does before it runs this script with --unstuck.

A run whose Prime worker died (workerState "failed") cannot take an abort, a stop
or a message; every command answers "Session worker is failed". It is listed as
"worker_failed", its head is not messaged, and the chat Resume button reopens the
head from its saved file first, which starts it on a new worker.

Runs that were aborted ("Request was aborted") or archived, for example a
helper its parent deleted, do not count, with two exceptions: an abort that
ended the retry of an interruption error counts as that error, and an abort
written when the daemon shut the run's worker down (a "received SIGTERM" line
in the daemon log at that moment) counts as "worker_stopped", and an abort
or archive written while the daemon supervisor restarted (from its last log
line to the new supervisor's "listening" line) counts as "daemon_restart". Rate limits (429), overloaded (529),
5xx errors and a model refusal (often a false positive that passes on retry;
the head decides) count too, but a run is listed only once pi-pool says the
account its next request gets can serve; resuming earlier fails again at once.

Each interrupted run maps to its head (the top-level root). Idle heads get one
message (default "continue") that names the interrupted runs below them.
Working heads get the same list as a steer note. Children are not messaged:
the head re-drives them.

A run stops counting once its head got a user message after the interruption,
or once this script resumed it (the state file remembers the error time).

With --direct each interrupted run gets the message itself and no head gets a
list, and a message to the head no longer hides a run below it. The chat
server runs it that way for the jobs of its chats, naming them with --only.

--owners names the sessions that own an open step of a chat. Each one is looked
at even when its worker is gone or it was archived (read from its session file
on disk), an empty aborted reply counts for it ("aborted"), and a spawned job
whose worker stopped before its first task reached it ("never_started") gets
that task from its rlm-subagent.json instead of "continue". On 10-15 a worker
stop at 16:07Z lost the first task of watchlist viewers and scroll for 3 h, the
workers SIGTERMed at 17:43:22Z left stuck steps root cause unloaded and out of
the default list, and the owner's stop archived three step owners at 18:25Z;
nothing resumed any of them.

A job deleted on purpose never counts: one the chat service deleted or parked
(deleted-jobs.json), one under such a job, one whose parent's rlm.delete_subagent
returned it, and one archived right before its aborted reply outside a daemon
restart. Each of these writes the same archive and abort a restart writes.

Usage:
  python3 resume_paused.py                  # find and resume heads
  python3 resume_paused.py --dry-run        # show what would be sent
  python3 resume_paused.py --since-minutes 60
  python3 resume_paused.py --message "continue"
  python3 resume_paused.py --include-children   # also message the interrupted children
  python3 resume_paused.py --direct --only <session id>,<session id>
  python3 resume_paused.py --json
"""
import argparse
import datetime as dt
import json
import mmap
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

INTERRUPTION_ERROR = re.compile(
    r"connection error|fetch failed|econnreset|econnrefused|enotfound|etimedout|eai_again|"
    r"socket hang up|network|terminated|other side closed|timed? ?out|websocket closed|"
    r"failed to resolve api key|rate.?limit|\b429\b|overloaded|\b529\b|\b50[234]\b|internal server error|usage limit|refused to respond",
    re.IGNORECASE,
)
BUSY_FLAGS = ("isStreaming", "isRunningTools", "isBashRunning", "hasRunningRlmChildren", "isCompacting")
# A child run or compaction may legitimately take long; a model call or retry wait with no event for 30 min is hung.
# A tool call gets 120 min: the 10-06 monitor found two stuck on `convex logs` (streams forever), but also bounded
# deploy polls inside one call that wait up to 90 and 108 min on purpose.
WORK_FLAGS = ("hasRunningRlmChildren", "isCompacting")
TOOL_FLAGS = ("isRunningTools", "isBashRunning")
HUNG_MIN = 30.0
TOOL_HUNG_MIN = 120.0
# A cut-off turn younger than this may still be between a tool result and the next model call.
CUT_OFF_GRACE_MIN = 2.0
# Full session ids the caller aborted because they were hung; their "aborted" last message still counts.
UNSTUCK = set()
DEFAULT_STATE = Path.home() / ".prime" / "agent" / "resume-paused-sessions.json"
SESSIONS_DIR = Path.home() / ".prime" / "agent" / "sessions"
ARTIFACTS_DIR = Path.home() / ".prime" / "agent" / "session-artifacts"
DELETED_JOBS = Path.home() / ".prime" / "agent" / "browser-chat" / "deleted-jobs.json"
LOG_DIR = Path.home() / ".prime" / "agent" / "logs"
SHUTDOWN_LINE = re.compile(r"^\[(\S+Z)\] supervisor: Session worker \w+ stderr: received SIGTERM", re.MULTILINE)
# A stopped worker writes "Request was aborted" to its running turn. On 10-15 the four such aborts in live chat jobs
# came 0.002 s before to 0.049 s after their worker's SIGTERM line, so an abort this close to one is the shutdown's.
SHUTDOWN_MATCH_S = 1.0
RESTART_LINE = re.compile(r"^\[(\S+Z)\] supervisor: Prime Agent daemon supervisor \S+ listening", re.MULTILINE)
# A supervisor that stops archives its live sessions just before its last log line: at the 10-16 00:19:58Z restart 14 archives fell
# 1.0 s before to 0.6 s after that line, and at the 10-15 18:25Z stop 93 fell up to 4.4 s before it.
RESTART_LEAD_S = 5.0
# Full session ids that own an open step of a chat (--owners).
OWNERS = set()
RECOVERY_NOTICE = "prime-agent.worker_recovery"
NEVER_STARTED_INTRO = ("[resume] Your parent spawned you, but its worker stopped before your task reached you, so the chat service sends it now. "
                       "Your task, as your parent wrote it:\n\n")


def prime_agent_bin():
    found = os.environ.get("PRIME_AGENT_BIN") or shutil.which("prime-agent")
    if found:
        return found
    fallback = Path.home() / ".local" / "share" / "prime-agent" / "bin" / "prime-agent"
    return str(fallback) if fallback.exists() else "prime-agent"


class CommandError(Exception):
    pass


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        raise CommandError(f"{' '.join(cmd)} failed ({p.returncode}): {p.stderr.strip() or p.stdout.strip()}")
    return p.stdout


def list_sessions():
    return json.loads(run([prime_agent_bin(), "list", "--json"]))["sessions"]


def session_files(ids):
    """{full session id: its transcript} for each id found on disk: a thread under SESSIONS_DIR, a job under ARTIFACTS_DIR/<root>/sub-*/...

    `prime-agent list --all` answered in 30.9 s against its 30 s timeout on 10-16, so every resume pass that named an owner failed from 04:20Z;
    a walk of the 6,768 job folders took 3.7 s."""
    wanted = set(ids)
    found = {sid: SESSIONS_DIR / f"{sid}.jsonl" for sid in wanted if (SESSIONS_DIR / f"{sid}.jsonl").is_file()}
    stack = [ARTIFACTS_DIR]
    while stack and len(found) < len(wanted):
        try:
            entries = list(os.scandir(stack.pop()))
        except OSError:
            continue
        for entry in entries:
            if entry.name.endswith(".jsonl") and entry.name[:-6] in wanted:
                found.setdefault(entry.name[:-6], Path(entry.path))
            elif entry.is_dir(follow_symlinks=False) and (entry.name.startswith("sub-") or Path(entry.path).parent == ARTIFACTS_DIR):
                stack.append(entry.path)
    return found


def saved_rows(ids):
    """A row like `prime-agent list --all` gives for each session in `ids` the daemon does not hold, read from its file on disk."""
    rows = []
    for sid, path in session_files(ids).items():
        try:
            meta = json.loads((path.parent / "rlm-subagent.json").read_text())
        except (OSError, ValueError):
            meta = {}
        name = meta.get("sessionName") if isinstance(meta, dict) else None
        stamp = dt.datetime.fromtimestamp(path.stat().st_mtime, dt.timezone.utc).isoformat().replace("+00:00", "Z")
        rows.append({"id": sid, "sessionId": sid, "lifecycle": "archived", "activity": "idle", "sessionFile": str(path),
                     "sessionName": name if isinstance(name, str) else sid, "runtimeKind": "subagent" if meta else "top-level",
                     "lastActivityAt": stamp})
    return rows


def deleted_on_purpose(path):
    """The job at `path` or a job above it was deleted on purpose: the chat service deleted it (deleted-jobs.json, the parker included), or
    its parent called rlm.delete_subagent and got it back. Every such delete archives the job and aborts its turn within milliseconds, the
    same lines a daemon restart writes: on 10-16 the Whole system duty counted ci train, new ci server, fair-self-heal, spec-junit and the two
    jobs under the parked checkin pushes goals as cut by a restart, and a continue would have revived all six."""
    folder = Path(path).parent
    try:
        deleted = json.loads(DELETED_JOBS.read_text())
    except (OSError, ValueError):
        deleted = {}
    gone = {child for chat in deleted.values() if isinstance(chat, dict) for child in chat}
    while folder.name.startswith("sub-"):
        if folder.name in gone or parent_deleted(folder):
            return True
        folder = folder.parent
    return False


def parent_deleted(folder):
    """The transcript above the job folder `folder` holds an rlm.delete_subagent call whose result names it. A chat's transcript reached
    152 MB on 10-16, so the file is searched for the job's id before any line is read."""
    above = folder.parent
    parent = next((p for p in above.glob("*.jsonl") if len(p.name) == 42), None) if above.name.startswith("sub-") else SESSIONS_DIR / f"{above.name}.jsonl"
    named = f"rlm_child_id='{folder.name}'".encode()
    try:
        with open(parent, "rb") as fh, mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as text:
            at = text.find(named)
            while at >= 0:
                start = text.rfind(b"\n", 0, at) + 1
                call = text.rfind(b'"toolCall"', 0, start)
                if text.find(b'"toolResult"', start, at) >= 0 and call >= 0 and text.find(b"delete_subagent", text.rfind(b"\n", 0, call) + 1, start) >= 0:
                    return True
                at = text.find(named, at + len(named))
    except (OSError, TypeError, ValueError):
        return False
    return False


def with_saved_owners(sessions, saved_rows, owners):
    """The resident sessions plus each owner the daemon only lists as saved (no worker, or archived), marked `saved`."""
    seen = {s.get("sessionId") or s["id"] for s in sessions}
    extra = [{**row, "saved": True} for row in saved_rows
             if (row.get("sessionId") or row["id"]) in owners and (row.get("sessionId") or row["id"]) not in seen]
    # The default list also shows a recently archived session; an owner there counts as saved too, else the next sweep skips it.
    listed = [{**s, "saved": True} if (s.get("sessionId") or s["id"]) in owners and s.get("lifecycle") != "live" else s for s in sessions]
    return [*listed, *extra]


def tail_entries(path, nbytes=256_000):
    """Parsed entries from the tail of a session jsonl."""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - nbytes))
            chunk = fh.read().decode("utf-8", "ignore")
    except OSError:
        return []
    entries = []
    for line in chunk.split("\n"):
        if not line.strip():
            continue
        try:
            entries.append(json.loads(line))
        except ValueError:
            continue
    return entries


def last_message(entries):
    for entry in reversed(entries):
        if entry.get("type") == "message":
            return entry
    return None


def run_provider(entries):
    """The provider of the last model call, so the account check asks about the right pool."""
    for entry in reversed(entries):
        msg = entry.get("message") or {}
        if entry.get("type") == "message" and msg.get("role") == "assistant" and msg.get("provider"):
            return msg["provider"]
        if entry.get("type") == "model_change" and entry.get("provider"):
            return entry["provider"]
    return None


def pool_bin():
    found = shutil.which("pi-pool") or str(Path.home() / ".config" / "pi-pool" / "bin" / "pi-pool")
    return found if Path(found).exists() else None


def account_blocker(root_session_id, provider, cache):
    """Why the account this tree's next request gets cannot serve, or None when it can (or there is no pool to ask).

    A run that stopped on a rate limit or a used-up account fails again at once if it resumes on the same account,
    so it stays off the list until pi-pool has an account for it.
    """
    tool = pool_bin()
    if not tool or provider not in ("anthropic", "openai-codex"):
        return None
    try:
        if provider not in cache:
            listed = subprocess.run([tool, "ls", "--json", "--provider", provider], capture_output=True, text=True, timeout=30)
            cache[provider] = {row["id"]: row for row in json.loads(listed.stdout).get("rows", [])} if listed.returncode == 0 else None
        rows = cache[provider]
        who = subprocess.run([tool, "who", "--json", "--session", root_session_id], capture_output=True, text=True, timeout=30)
        resolved = (json.loads(who.stdout).get("providers") or {}).get(provider) if who.returncode == 0 else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    if rows is None or resolved is None:
        return None
    account = resolved.get("account")
    if not account:
        return f"no {provider} account can serve"
    row = rows.get(account)
    if row and not row.get("usable"):
        return f"{row.get('email')} is {row.get('reason') or 'not usable'}"
    return None


def last_user_at(entries):
    for entry in reversed(entries):
        if entry.get("type") == "message" and (entry.get("message") or {}).get("role") == "user":
            return parse_ts(entry.get("timestamp"))
    return None


def parse_ts(value):
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def short_id(session):
    return session["id"][-12:]


def head_of(sid, by_id):
    seen = set()
    cur = sid
    while True:
        s = by_id.get(cur)
        if not s:
            return cur
        # The daemon gives a resident parent's short id, and a parent's full session id once it was reloaded.
        parent = s.get("parentActiveSessionId") or s.get("parentSessionId")
        parent = parent[-12:] if parent else parent
        if not parent or parent in seen or parent not in by_id:
            return cur
        seen.add(cur)
        cur = parent


def is_busy(session):
    return session.get("activity") == "working" or any(session.get(flag) for flag in BUSY_FLAGS)


def stopped_on_purpose(entries, last, restarts=list):
    """The run was aborted or archived (a parent deleted it, or the user pressed stop), so it is not interrupted.

    An archive that a daemon restart wrote does not count, and an archive written just before the aborted reply outside a restart does, even
    next to a worker's SIGTERM, since an archive stops the worker too. `find_paused` also drops a recorded delete (`deleted_on_purpose`)."""
    if archived_by_restart(entries, restarts):
        return False
    msg = last.get("message") or {}
    if msg.get("role") == "assistant" and msg.get("stopReason") == "aborted" and archive_before(entries, last):
        return True
    if msg.get("role") == "toolResult" and any(
            isinstance(part, dict) and part.get("text") == "Request was aborted" for part in msg.get("content") or []):
        return True
    after = entries[entries.index(last) + 1:] if last in entries else []
    return any(e.get("type") == "session_state" and (e.get("state") or {}).get("status") == "archived" for e in after)


def hung_since(session, now):
    """Minutes a session has shown as working with no activity and nothing legitimately long running, else None.

    After a sleep or a network drop a model stream or a retry wait can hang for hours while the session still reads
    "working". Sending it a message does nothing: it has to be aborted first (the chat's Resume button does that).
    """
    if not is_busy(session) or any(session.get(flag) for flag in WORK_FLAGS):
        return None
    # lastActivityAt can lag: a retry loop keeps writing error messages to the session file without moving it.
    stamps = [parse_ts(session.get("lastActivityAt") or session.get("modified"))]
    path = session.get("sessionFile")
    entries = tail_entries(path, 64_000) if path else []
    stamps += [parse_ts(entry.get("timestamp")) for entry in entries[-5:]]
    try:
        stamps.append(dt.datetime.fromtimestamp(os.path.getmtime(path), dt.timezone.utc) if path else None)
    except OSError:
        pass
    stamps = [stamp for stamp in stamps if stamp]
    if not stamps:
        return None
    last = last_message(entries)
    msg = (last or {}).get("message") or {}
    if msg.get("role") == "assistant" and msg.get("stopReason") == "stop":
        return None  # the turn finished; the daemon's "working" is stale, and there is nothing to resume
    idle = (now - max(stamps)).total_seconds() / 60
    limit = TOOL_HUNG_MIN if any(session.get(flag) for flag in TOOL_FLAGS) else HUNG_MIN
    return idle if idle >= limit else None


def worker_shutdowns():
    """Each time the daemon sent a session worker SIGTERM, from its logs and their rotated .old files, oldest first."""
    stamps = []
    for path in sorted(LOG_DIR.glob("daemon.sock.*.log*")):
        try:
            text = path.read_text(errors="ignore")
        except OSError:
            continue
        stamps += [stamp for stamp in map(parse_ts, SHUTDOWN_LINE.findall(text)) if stamp]
    return sorted(stamps)


def daemon_restarts():
    """(start, end) of each time the Prime daemon supervisor stopped and a new one started, from its logs, oldest first.

    The window runs from RESTART_LEAD_S before the old supervisor's last log line to the new one's "listening" line.
    A daemon restart archives every live session and aborts its turn, which no one asked for.
    """
    windows = []
    for path in sorted(LOG_DIR.glob("daemon.sock.*.log*")):
        try:
            text = path.read_text(errors="ignore")
        except OSError:
            continue
        previous = None
        for line in text.splitlines():
            if not line.startswith("["):
                continue
            stamp = parse_ts(line[1:line.find("]")])
            match = RESTART_LINE.match(line)
            if match and stamp and previous and previous <= stamp:
                windows.append((previous - dt.timedelta(seconds=RESTART_LEAD_S), stamp))
            previous = stamp or previous
    return sorted(set(windows))


# An archive writes its aborted reply within milliseconds; RESTART_ABORT_MS in components/user-history/src/cut-end.ts uses the same 5 s.
ARCHIVE_ABORT_S = 5.0


def archive_before(entries, last):
    """An archive came right before the aborted reply `last`, with no message between them."""
    ts = parse_ts(last.get("timestamp"))
    index = entries.index(last) if last in entries else -1
    for entry in reversed(entries[:max(index, 0)]):
        if entry.get("type") == "message":
            return False
        if entry.get("type") == "session_state":
            stamp = parse_ts(entry.get("timestamp"))
            return (entry.get("state") or {}).get("status") == "archived" and bool(ts and stamp) and (ts - stamp).total_seconds() <= ARCHIVE_ABORT_S
    return False


def in_restart(stamp, restarts):
    return bool(stamp) and any(start <= stamp <= end for start, end in restarts())


def archived_by_restart(entries, restarts):
    """The session's last archive came from a daemon restart, not from a person or a parent."""
    archives = [e for e in entries if e.get("type") == "session_state" and (e.get("state") or {}).get("status") == "archived"]
    return bool(archives) and in_restart(parse_ts(archives[-1].get("timestamp")), restarts)


def aborted_verdict(last, entries, shutdowns, owner=False, restarts=list):
    """("error", text) for an abort that ended the retry of an interruption error, ("worker_stopped", text) for one the
    daemon wrote when it shut the run's worker down, ("aborted", text) for an empty one of a step owner, else None: the
    user or a parent stopped the run."""
    before = last_message(entries[:entries.index(last)]) if last in entries else None
    msg = (before or {}).get("message") or {}
    err = str(msg.get("errorMessage") or "")
    if msg.get("role") == "assistant" and msg.get("stopReason") == "error" and INTERRUPTION_ERROR.search(err):
        return ("error", err)
    ts = parse_ts(last.get("timestamp"))
    if ts and any(abs((ts - stamp).total_seconds()) <= SHUTDOWN_MATCH_S for stamp in shutdowns()):
        return ("worker_stopped", f"The daemon shut its worker down at {last.get('timestamp')} in the middle of the turn.")
    if in_restart(ts, restarts):
        return ("daemon_restart", f"The Prime daemon restarted at {last.get('timestamp')} in the middle of the turn.")
    if owner and not reply_text(last):
        return ("aborted", "Its turn was aborted with no reply while it owned an open step.")
    return None


def reply_text(entry):
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return content.strip()
    return "".join(part.get("text") or "" for part in content or [] if isinstance(part, dict) and part.get("type") == "text").strip()


def never_started(session, entries, nbytes=256_000):
    """(notice, task) for a spawned job whose worker stopped before its first task reached it: its whole file holds no
    message, a worker recovery notice, and rlm-subagent.json next to it keeps the task its parent gave rlm.spawn."""
    path = session.get("sessionFile")
    notice = next((e for e in reversed(entries) if e.get("type") == "custom_message" and e.get("customType") == RECOVERY_NOTICE), None)
    if not path or not notice or last_message(entries):
        return None
    try:
        if os.path.getsize(path) > nbytes:
            return None
        record = json.loads((Path(path).parent / "rlm-subagent.json").read_text())
    except (OSError, ValueError):
        return None
    task = record.get("prompt") if isinstance(record, dict) else None
    return (notice, task) if isinstance(task, str) and task.strip() else None


def classify(last, now, entries=(), shutdowns=list, owner=False, restarts=list):
    """("error" | "cut_off" | "empty_reply" | "worker_stopped" | "aborted", text) when the last message shows the run stopped mid-work, else None."""
    if not last:
        return None
    msg = last.get("message") or {}
    role, stop = msg.get("role"), msg.get("stopReason")
    if role == "assistant" and stop == "aborted":
        return aborted_verdict(last, list(entries), shutdowns, owner, restarts)
    if role == "assistant" and stop == "toolUse" and not msg.get("content"):
        ts = parse_ts(last.get("timestamp"))
        if ts is None or (now - ts).total_seconds() / 60 < CUT_OFF_GRACE_MIN:
            return None
        return ("empty_reply", "The model returned an empty reply that asked for a tool, so the turn ended.")
    if role == "assistant" and stop == "error":
        err = str(msg.get("errorMessage") or "")
        return ("error", err) if INTERRUPTION_ERROR.search(err) else None
    cut_off = role in ("user", "toolResult") or (role == "assistant" and stop == "toolUse")
    if not cut_off:
        return None
    ts = parse_ts(last.get("timestamp"))
    if ts is None or (now - ts).total_seconds() / 60 < CUT_OFF_GRACE_MIN:
        return None
    return ("cut_off", "The turn stopped with no reply after a " + ("tool call" if role != "user" else "message") + ".")


def load_state(path):
    try:
        data = json.loads(Path(path).read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(path, state, now, keep_minutes):
    cutoff = now - dt.timedelta(minutes=max(keep_minutes, 1440))
    kept = {k: v for k, v in state.items() if (parse_ts(v) or now) >= cutoff}
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(kept, indent=1))
    tmp.replace(path)


def find_paused(sessions, since_minutes, state, now, direct=False):
    by_id = {short_id(s): s for s in sessions}
    tails = {}
    accounts = {}
    stops = []

    def shutdowns():
        if not stops:
            stops.append(worker_shutdowns())
        return stops[0]

    restart_windows = []

    def restarts():
        if not restart_windows:
            restart_windows.append(daemon_restarts())
        return restart_windows[0]

    def head_session(head, s):
        row = by_id.get(head, s)
        return row.get("sessionId") or row["id"]

    def entries_of(sid):
        if sid not in tails:
            tails[sid] = tail_entries(by_id[sid].get("sessionFile", ""))
        return tails[sid]

    paused = []
    for s in sessions:
        sid = short_id(s)
        full = s.get("sessionId") or s["id"]
        owner = full in OWNERS
        if s.get("lifecycle") != "live" and not (owner and s.get("saved")) and not archived_by_restart(entries_of(sid), restarts):
            continue
        if s.get("workerState") == "failed":
            head = head_of(sid, by_id)
            paused.append({"id": sid, "session_id": s.get("sessionId") or s["id"], "name": s.get("sessionName") or "(unnamed)",
                           "kind": s.get("runtimeKind"), "reason": "worker_failed",
                           "error": "Its Prime worker died; reopening its head starts it on a new worker.",
                           "errored_at": s.get("lastActivityAt") or s.get("modified"), "age_min": None, "head": head,
                           "head_session_id": by_id.get(head, s).get("sessionId") or by_id.get(head, s)["id"]})
            continue
        if is_busy(s):
            hung = hung_since(s, now)
            if hung is None or (since_minutes and hung > since_minutes):
                continue
            head = head_of(sid, by_id)
            paused.append({"id": sid, "session_id": s.get("sessionId") or s["id"], "name": s.get("sessionName") or "(unnamed)",
                           "kind": s.get("runtimeKind"), "reason": "hung", "error": (f"Stuck in one tool call for {hung:.0f} min." if any(s.get(flag) for flag in TOOL_FLAGS)
                                     else f"Shows working but did nothing for {hung:.0f} min."),
                           "errored_at": s.get("lastActivityAt") or s.get("modified"), "age_min": round(hung, 1), "head": head,
                           "head_session_id": head_session(head, s)})
            continue
        seen_at = parse_ts(s.get("lastActivityAt") or s.get("modified"))
        if since_minutes and seen_at and (now - seen_at).total_seconds() / 60 > since_minutes + 5:
            continue
        last = last_message(entries_of(sid))
        task = None
        if not last:
            started = never_started(s, entries_of(sid)) if owner else None
            if not started:
                continue
            last, task = started
            verdict = ("never_started", "Its worker stopped before its first task reached it.")
        else:
            unstuck = full in UNSTUCK
            if not unstuck and stopped_on_purpose(entries_of(sid), last, restarts):
                continue
            verdict = ("hung", "Was hung; the Resume button aborted it.") if unstuck else classify(last, now, entries_of(sid), shutdowns, owner, restarts)
            if not verdict:
                continue
        if s.get("sessionFile") and deleted_on_purpose(s["sessionFile"]):
            continue
        ts = parse_ts(last.get("timestamp"))
        age_min = (now - ts).total_seconds() / 60 if ts else None
        if since_minutes and age_min is not None and age_min > since_minutes:
            continue
        if state.get(s.get("sessionId") or s["id"]) == last.get("timestamp"):
            continue  # this script already resumed this interruption
        head = head_of(sid, by_id)
        if not direct and head != sid and head in by_id and ts:
            redriven = last_user_at(entries_of(head))
            if redriven and redriven > ts:
                continue  # someone sent the head a message after the interruption
        root = by_id.get(head, s)
        blocker = account_blocker(root.get("sessionId") or root["id"], run_provider(entries_of(sid)), accounts)
        if blocker:
            continue  # resuming now would fail on the same account; it shows again once pi-pool has one
        paused.append({
            "id": sid,
            # The short id changes when a session is reloaded; the state file keys by the full session id.
            "session_id": s.get("sessionId") or s["id"],
            "name": s.get("sessionName") or "(unnamed)",
            "kind": s.get("runtimeKind"),
            "reason": verdict[0],
            "error": verdict[1][:160],
            "errored_at": last.get("timestamp"),
            "age_min": round(age_min, 1) if age_min is not None else None,
            "head": head,
            "head_session_id": head_session(head, s),
            **({"aborted": True} if full in UNSTUCK else {}),
            # A saved session has no short id the daemon answers to; it takes its full id, and the message reopens it.
            **({"target": full} if s.get("saved") or s.get("lifecycle") != "live" else {}),
            **({"task": task} if task else {}),
        })
    return paused


def compose(message, head_id, runs, working):
    others = [p for p in runs if p["id"] != head_id]
    if not others:
        return message
    lines = [f"- {p['name']} ({p['id']}), {p['errored_at']}: {p['error']}" for p in others]
    intro = "Note while you work:" if working else message + "\n\n"
    return (intro + ("\n" if working else "") +
            "These runs below you stopped on an interruption (network drop, sleep or sign-in refresh) and are idle:\n" +
            "\n".join(lines) + "\nCheck each one and re-drive it if it still has work.")


def send(target, message):
    out = run([prime_agent_bin(), "send", "--json", target, message])
    try:
        j = json.loads(out)
    except ValueError:
        return {"deliveryStatus": "unknown", "raw": out[:200]}
    return {"deliveryStatus": j.get("deliveryStatus"), "deliveryMode": j.get("deliveryMode")}


def live_id(session_id):
    """The short id the daemon now runs `session_id` under, or None. A job the chat service just reopened from its file runs on a new
    worker, and a send to its full id answers "Unknown active session": at 19:51Z on 10-17 six reopened jobs ran again while the log
    said their continue failed."""
    try:
        rows = list_sessions()
    except CommandError:
        return None
    row = next((s for s in rows if (s.get("sessionId") or s["id"]) == session_id and s.get("lifecycle") == "live"), None)
    return row["id"] if row else None


def direct_resume(paused, args, state, now):
    """--direct: each interrupted run gets the message itself, and no head gets a list. A hung run takes no message until
    it is aborted, and a run in a dead worker takes none at all."""
    actions = []
    sent_any = False
    for p in paused:
        if p["reason"] in ("hung", "worker_failed") and not p.get("aborted"):
            res = f"skipped: {p['reason']}"
        elif args.dry_run:
            res = "dry-run"
        else:
            text = NEVER_STARTED_INTRO + p["task"] if "task" in p else args.message
            try:
                res = send(p.get("target", p["id"]), text)
            except CommandError as error:
                live = live_id(p["session_id"]) if "target" in p and "Unknown active session" in str(error) else None
                try:
                    res = send(live, text) if live else {"error": str(error)[:300]}
                except CommandError as again:
                    res = {"error": str(again)[:300]}
            if "error" not in res:
                state[p["session_id"]] = p["errored_at"]
                sent_any = True
        actions.append({"id": p["id"], "name": p["name"], "head": p["head"], "result": res})
    if sent_any:
        save_state(args.state, state, now, args.since_minutes)
    return {"paused": paused, "heads": [], "children": actions, "message": args.message,
            "since_minutes": args.since_minutes, "checked_at": now.isoformat()}


def resume(sessions, args, now):
    by_id = {short_id(s): s for s in sessions}
    state = load_state(args.state)
    direct = getattr(args, "direct", False)
    only = set(filter(None, getattr(args, "only", "").split(",")))
    paused = find_paused(sessions, args.since_minutes, state, now, direct)
    if only:
        paused = [p for p in paused if p["session_id"] in only]
    if direct:
        return direct_resume(paused, args, state, now)

    heads = {}
    for p in paused:
        heads.setdefault(p["head"], []).append(p)

    actions = []
    sent_any = False
    for h, runs in heads.items():
        hs = by_id.get(h, {})
        working = is_busy(hs)
        row = {
            "id": h,
            "name": hs.get("sessionName") or "(unnamed)",
            "activity": hs.get("activity"),
            "working": working,
            "paused_in_tree": [p["id"] for p in runs],
        }
        own_hang = any(p["id"] == h and p["reason"] == "hung" and not p.get("aborted") for p in runs)
        if hs.get("workerState") == "failed" and not args.dry_run:
            row["result"] = "skipped: its worker failed, reopen it first (the chat's Resume button does)"
        elif own_hang and not args.dry_run:
            row["result"] = "skipped: hung, abort it first (the chat's Resume button does)"
        elif working and not own_hang and all(p["id"] == h for p in runs):
            row["result"] = "skipped: already working"
        elif args.dry_run:
            row["result"] = "dry-run"
        else:
            try:
                row["result"] = send(h, compose(args.message, h, runs, working))
            except CommandError as error:
                row["result"] = {"error": str(error)[:300]}
            else:
                for p in runs:
                    state[p["session_id"]] = p["errored_at"]
                sent_any = True
        actions.append(row)

    child_actions = []
    if args.include_children:
        for p in paused:
            if p["id"] in heads:
                continue
            if args.dry_run:
                res = "dry-run"
            elif p["reason"] == "worker_failed":
                res = "skipped: its worker failed, its head is reopened instead"
            else:
                try:
                    res = send(p["id"], args.message)
                except CommandError as error:
                    res = {"error": str(error)[:300]}
                else:
                    state[p["session_id"]] = p["errored_at"]
                    sent_any = True
            child_actions.append({"id": p["id"], "name": p["name"], "head": p["head"], "result": res})

    if sent_any:
        save_state(args.state, state, now, args.since_minutes)
    return {"paused": paused, "heads": actions, "children": child_actions, "message": args.message,
            "since_minutes": args.since_minutes, "checked_at": now.isoformat()}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--message", default="continue", help='message to send (default "continue")')
    ap.add_argument("--since-minutes", type=float, default=1440, help="ignore interruptions older than this (default 1440 = 24 h; 0 = no limit)")
    ap.add_argument("--dry-run", action="store_true", help="show targets, send nothing")
    ap.add_argument("--include-children", action="store_true", help="also message interrupted child sessions, not only heads")
    ap.add_argument("--state", default=str(DEFAULT_STATE), help="file that remembers resumed interruptions")
    ap.add_argument("--json", action="store_true", help="print JSON")
    ap.add_argument("--unstuck", default="", help="comma-separated full session ids the caller aborted because they were hung")
    ap.add_argument("--direct", action="store_true", help="message each interrupted run itself and send no head a list")
    ap.add_argument("--only", default="", help="comma-separated full session ids: act only on these interrupted runs")
    ap.add_argument("--owners", default="", help="comma-separated full session ids that own an open step of a chat (see above)")
    args = ap.parse_args()
    UNSTUCK.update(filter(None, args.unstuck.split(",")))
    OWNERS.update(filter(None, args.owners.split(",")))

    try:
        sessions = list_sessions()
        if OWNERS:
            sessions = with_saved_owners(sessions, saved_rows(OWNERS - {s.get("sessionId") or s["id"] for s in sessions}), OWNERS)
        report = resume(sessions, args, dt.datetime.now(dt.timezone.utc))
    except CommandError as error:
        raise SystemExit(str(error))
    if args.json:
        print(json.dumps(report, indent=1))
        return

    paused, actions, child_actions = report["paused"], report["heads"], report["children"]
    if not paused:
        print(f"no interrupted live run in the last {args.since_minutes:g} min")
        return
    print(f"interrupted runs ({len(paused)}):")
    for p in paused:
        print(f"  {p['id']}  {p['name'][:40]:<40} {p['kind'] or '':<9} head={p['head']}  {p['errored_at']}  {p['error'][:80]}")
    print(f"\nheads ({len(actions)}), message={args.message!r}:")
    for a in actions:
        print(f"  {a['id']}  {a['name'][:40]:<40} {a['activity'] or '':<8} -> {a['result']}")
    if child_actions:
        print(f"\nchildren ({len(child_actions)}):")
        for c in child_actions:
            print(f"  {c['id']}  {c['name'][:40]:<40} head={c['head']} -> {c['result']}")


if __name__ == "__main__":
    sys.exit(main())
