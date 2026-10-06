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
    compaction running (60 minutes when a tool call is running): a hung model
    stream, retry wait or tool call. A message cannot reach it; it has to be aborted first, which the chat
    Resume button does before it runs this script with --unstuck.

Runs that were aborted ("Request was aborted") or archived, for example a
helper its parent deleted, do not count. Rate limits (429), overloaded (529)
and 5xx errors count too, but a run is listed only once pi-pool says the
account its next request gets can serve; resuming earlier fails again at once.

Each interrupted run maps to its head (the top-level root). Idle heads get one
message (default "continue") that names the interrupted runs below them.
Working heads get the same list as a steer note. Children are not messaged:
the head re-drives them.

A run stops counting once its head got a user message after the interruption,
or once this script resumed it (the state file remembers the error time).

Usage:
  python3 resume_paused.py                  # find and resume heads
  python3 resume_paused.py --dry-run        # show what would be sent
  python3 resume_paused.py --since-minutes 60
  python3 resume_paused.py --message "continue"
  python3 resume_paused.py --include-children   # also message the interrupted children
  python3 resume_paused.py --json
"""
import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

INTERRUPTION_ERROR = re.compile(
    r"connection error|fetch failed|econnreset|econnrefused|enotfound|etimedout|eai_again|"
    r"socket hang up|network|terminated|other side closed|timed? ?out|websocket closed|"
    r"failed to resolve api key|rate.?limit|\b429\b|overloaded|\b529\b|\b50[234]\b|internal server error|usage limit",
    re.IGNORECASE,
)
BUSY_FLAGS = ("isStreaming", "isRunningTools", "isBashRunning", "hasRunningRlmChildren", "isCompacting")
# A child run or compaction may legitimately take long; a model call or retry wait with no event for 30 min is hung.
# A tool call gets 60 min: blocking calls are short by design, and the 10-06 monitor found two stuck for 31 and 76 min
# on `convex logs`, which streams forever.
WORK_FLAGS = ("hasRunningRlmChildren", "isCompacting")
TOOL_FLAGS = ("isRunningTools", "isBashRunning")
HUNG_MIN = 30.0
TOOL_HUNG_MIN = 60.0
# A cut-off turn younger than this may still be between a tool result and the next model call.
CUT_OFF_GRACE_MIN = 2.0
# Full session ids the caller aborted because they were hung; their "aborted" last message still counts.
UNSTUCK = set()
DEFAULT_STATE = Path.home() / ".prime" / "agent" / "resume-paused-sessions.json"


def prime_agent_bin():
    found = os.environ.get("PRIME_AGENT_BIN") or shutil.which("prime-agent")
    if found:
        return found
    fallback = Path.home() / ".local" / "share" / "prime-agent" / "bin" / "prime-agent"
    return str(fallback) if fallback.exists() else "prime-agent"


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        raise SystemExit(f"{' '.join(cmd)} failed ({p.returncode}): {p.stderr.strip() or p.stdout.strip()}")
    return p.stdout


def list_sessions():
    return json.loads(run([prime_agent_bin(), "list", "--json"]))["sessions"]


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


def stopped_on_purpose(entries, last):
    """The run was aborted or archived (a parent deleted it, or the user pressed stop), so it is not interrupted."""
    msg = last.get("message") or {}
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


def classify(last, now):
    """("error" | "cut_off" | "empty_reply", text) when the last message shows the run stopped mid-work, else None."""
    if not last:
        return None
    msg = last.get("message") or {}
    role, stop = msg.get("role"), msg.get("stopReason")
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


def find_paused(sessions, since_minutes, state, now):
    by_id = {short_id(s): s for s in sessions}
    tails = {}
    accounts = {}

    def entries_of(sid):
        if sid not in tails:
            tails[sid] = tail_entries(by_id[sid].get("sessionFile", ""))
        return tails[sid]

    paused = []
    for s in sessions:
        sid = short_id(s)
        if s.get("lifecycle") != "live":
            continue
        if is_busy(s):
            hung = hung_since(s, now)
            if hung is None or (since_minutes and hung > since_minutes):
                continue
            head = head_of(sid, by_id)
            paused.append({"id": sid, "session_id": s.get("sessionId") or s["id"], "name": s.get("sessionName") or "(unnamed)",
                           "kind": s.get("runtimeKind"), "reason": "hung", "error": (f"Stuck in one tool call for {hung:.0f} min." if any(s.get(flag) for flag in TOOL_FLAGS)
                                     else f"Shows working but did nothing for {hung:.0f} min."),
                           "errored_at": s.get("lastActivityAt") or s.get("modified"), "age_min": round(hung, 1), "head": head})
            continue
        seen_at = parse_ts(s.get("lastActivityAt") or s.get("modified"))
        if since_minutes and seen_at and (now - seen_at).total_seconds() / 60 > since_minutes + 5:
            continue
        last = last_message(entries_of(sid))
        if not last:
            continue
        unstuck = (s.get("sessionId") or s["id"]) in UNSTUCK
        if not unstuck and stopped_on_purpose(entries_of(sid), last):
            continue
        verdict = ("hung", "Was hung; the Resume button aborted it.") if unstuck else classify(last, now)
        if not verdict:
            continue
        ts = parse_ts(last.get("timestamp"))
        age_min = (now - ts).total_seconds() / 60 if ts else None
        if since_minutes and age_min is not None and age_min > since_minutes:
            continue
        if state.get(s.get("sessionId") or s["id"]) == last.get("timestamp"):
            continue  # this script already resumed this interruption
        head = head_of(sid, by_id)
        if head != sid and head in by_id and ts:
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
            **({"aborted": True} if unstuck else {}),
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


def resume(sessions, args, now):
    by_id = {short_id(s): s for s in sessions}
    state = load_state(args.state)
    paused = find_paused(sessions, args.since_minutes, state, now)

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
        if own_hang and not args.dry_run:
            row["result"] = "skipped: hung, abort it first (the chat's Resume button does)"
        elif working and not own_hang and all(p["id"] == h for p in runs):
            row["result"] = "skipped: already working"
        elif args.dry_run:
            row["result"] = "dry-run"
        else:
            row["result"] = send(h, compose(args.message, h, runs, working))
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
            else:
                res = send(p["id"], args.message)
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
    args = ap.parse_args()
    UNSTUCK.update(filter(None, args.unstuck.split(",")))

    report = resume(list_sessions(), args, dt.datetime.now(dt.timezone.utc))
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
