#!/usr/bin/env python3
"""Resume Prime Agent sessions that stopped on a network error.

Finds live sessions whose last message ended with stopReason == "error" and a
network-type error message, maps each one to its head (the top-level root
session), and sends one message (default "continue") to each idle head.
Children are not messaged: the head re-drives them.

Usage:
  python3 resume_paused.py                  # find and resume heads
  python3 resume_paused.py --dry-run        # show what would be sent
  python3 resume_paused.py --since-minutes 30
  python3 resume_paused.py --message "continue"
  python3 resume_paused.py --include-children   # also message the errored children
  python3 resume_paused.py --json
"""
import argparse
import datetime as dt
import json
import re
import subprocess
import sys

NETWORK_ERROR = re.compile(
    r"connection error|fetch failed|econnreset|econnrefused|enotfound|etimedout|"
    r"socket hang up|network|terminated|other side closed|timeout",
    re.IGNORECASE,
)


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f"{' '.join(cmd)} failed ({p.returncode}): {p.stderr.strip() or p.stdout.strip()}")
    return p.stdout


def list_sessions():
    return json.loads(run(["prime-agent", "list", "--json"]))["sessions"]


def last_message(path, nbytes=600_000):
    """Last entry of type "message" in a session jsonl. Reads only the tail."""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - nbytes))
            chunk = fh.read().decode("utf-8", "ignore")
    except OSError:
        return None
    last = None
    for line in chunk.split("\n"):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get("type") == "message":
            last = entry
    return last


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
        parent = s.get("parentActiveSessionId")
        if not parent or parent in seen or parent not in by_id:
            return cur
        seen.add(cur)
        cur = parent


def find_paused(sessions, since_minutes):
    now = dt.datetime.now(dt.timezone.utc)
    paused = []
    for s in sessions:
        if s.get("lifecycle") != "live":
            continue
        last = last_message(s.get("sessionFile", ""))
        if not last:
            continue
        msg = last.get("message") or {}
        if msg.get("stopReason") != "error":
            continue
        err = str(msg.get("errorMessage") or "")
        if not NETWORK_ERROR.search(err):
            continue
        ts = parse_ts(last.get("timestamp"))
        age_min = (now - ts).total_seconds() / 60 if ts else None
        if since_minutes and age_min is not None and age_min > since_minutes:
            continue
        paused.append({
            "id": short_id(s),
            "name": s.get("sessionName") or "(unnamed)",
            "kind": s.get("runtimeKind"),
            "activity": s.get("activity"),
            "error": err[:80],
            "errored_at": last.get("timestamp"),
            "age_min": round(age_min, 1) if age_min is not None else None,
        })
    return paused


def send(target, message):
    out = run(["prime-agent", "send", "--json", target, message])
    try:
        j = json.loads(out)
    except ValueError:
        return {"deliveryStatus": "unknown", "raw": out[:200]}
    return {"deliveryStatus": j.get("deliveryStatus"), "deliveryMode": j.get("deliveryMode")}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--message", default="continue", help='message to send (default "continue")')
    ap.add_argument("--since-minutes", type=float, default=180, help="ignore errors older than this (default 180; 0 = no limit)")
    ap.add_argument("--dry-run", action="store_true", help="show targets, send nothing")
    ap.add_argument("--include-children", action="store_true", help="also message errored child sessions, not only heads")
    ap.add_argument("--json", action="store_true", help="print JSON")
    args = ap.parse_args()

    sessions = list_sessions()
    by_id = {short_id(s): s for s in sessions}
    paused = find_paused(sessions, args.since_minutes)

    heads = {}
    for p in paused:
        h = head_of(p["id"], by_id)
        p["head"] = h
        heads.setdefault(h, []).append(p["id"])

    actions = []
    for h, kids in heads.items():
        hs = by_id.get(h, {})
        row = {
            "id": h,
            "name": hs.get("sessionName") or "(unnamed)",
            "activity": hs.get("activity"),
            "streaming": bool(hs.get("isStreaming")),
            "paused_in_tree": kids,
        }
        if hs.get("isStreaming") or hs.get("activity") == "working":
            row["result"] = "skipped: already working"
        elif args.dry_run:
            row["result"] = "dry-run"
        else:
            row["result"] = send(h, args.message)
        actions.append(row)

    child_actions = []
    if args.include_children:
        for p in paused:
            if p["id"] in heads:
                continue
            s = by_id[p["id"]]
            if s.get("isStreaming") or s.get("activity") == "working":
                res = "skipped: already working"
            elif args.dry_run:
                res = "dry-run"
            else:
                res = send(p["id"], args.message)
            child_actions.append({"id": p["id"], "name": p["name"], "head": p["head"], "result": res})

    report = {"paused": paused, "heads": actions, "children": child_actions, "message": args.message}
    if args.json:
        print(json.dumps(report, indent=1))
        return

    if not paused:
        print(f"no live session ended on a network error in the last {args.since_minutes:g} min")
        return
    print(f"paused sessions ({len(paused)}):")
    for p in paused:
        print(f"  {p['id']}  {p['name'][:40]:<40} {p['kind']:<9} head={p['head']}  {p['errored_at']}  {p['error']}")
    print(f"\nheads ({len(actions)}), message={args.message!r}:")
    for a in actions:
        print(f"  {a['id']}  {a['name'][:40]:<40} {a['activity']:<8} -> {a['result']}")
    if child_actions:
        print(f"\nchildren ({len(child_actions)}):")
        for c in child_actions:
            print(f"  {c['id']}  {c['name'][:40]:<40} head={c['head']} -> {c['result']}")


if __name__ == "__main__":
    sys.exit(main())
