#!/usr/bin/env python3
"""cache_writes: where a window's prompt cache writes came from, per call, ranked by cause.

usage: python3 -B cache_writes.py calls --since <ISO UTC> --until <ISO UTC> --box <name> > calls.jsonl
       python3 -B cache_writes.py rank calls.jsonl [more.jsonl] [--pool-log ~/.config/pi-pool/pi-pool.log] [--pool-utc-offset-h 0]

The Skills and tools duty flags an hour whose cache read share is under 90% (owner c41) and names the box and model pairs that wrote
the most. LGTM has no session label on token counts, so this script reads the transcripts' usage numbers (never their text) and
splits each call's cache write into two parts:

- growth, the new turn appended after the prefix the previous call of the same session cached, which every call pays;
- lost, the part of that cached prefix the call wrote again, with its cause: a first call, an idle gap over the cache TTL,
  a compaction, a model change, a pi-pool account switch for the session between the two calls, or an unexplained prefix change.

`calls` runs on each box, since its transcripts stay there. `rank` joins the rows with the pi-pool log on the box whose pool vends the
tokens (us-metal02 serves the Mac too), whose timestamps are naive local time, hence --pool-utc-offset-h.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from feed import transcripts  # noqa: E402

PRIME = Path.home() / ".prime/agent"
# Anthropic's cache lives 5 min, or 1 h with cache_control.ttl "1h", which Prime sends when PI_CACHE_RETENTION=long (both boxes on 10-23).
TTL_S = 3600 if os.environ.get("PI_CACHE_RETENTION") == "long" else 300
BREAKS = {"compaction", "model_change", "branch_summary"}


def epoch(value: object) -> Optional[float]:
    if isinstance(value, (int, float)):
        return value / 1000 if value > 1e11 else float(value)
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def session_calls(lines: Iterable[str], box: str, since: float, until: float) -> Iterator[dict]:
    """Each finished call in [since, until) with the previous finished call's prompt and what happened between the two."""
    session, previous, between = None, None, []
    for line in lines:
        if line.startswith('{"type":"message"') and '"role":"assistant"' not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        kind = entry.get("type")
        if kind == "session":
            session = entry.get("id") if session is None else session
            continue
        if kind in BREAKS:
            between.append(kind)
            continue
        message = entry.get("message") if kind == "message" else None
        if not isinstance(message, dict) or message.get("role") != "assistant" or not isinstance(message.get("usage"), dict):
            continue
        usage = message["usage"]
        prompt = sum(int(usage.get(k) or 0) for k in ("input", "cacheRead", "cacheWrite"))
        if message.get("stopReason") == "error" or prompt == 0:
            continue
        at = epoch(entry.get("timestamp")) or epoch(message.get("timestamp"))
        if at is None:
            continue
        model = f"{message.get('provider')}/{message.get('model')}"
        if since <= at < until:
            yield {"box": box, "session": session, "at": at, "model": model, "input": int(usage.get("input") or 0),
                   "cacheRead": int(usage.get("cacheRead") or 0), "cacheWrite": int(usage.get("cacheWrite") or 0),
                   "previous": previous and {"at": previous["at"], "prompt": previous["prompt"], "output": previous["output"], "model": previous["model"]},
                   "between": sorted(set(between))}
        previous = {"at": at, "prompt": prompt, "output": int(usage.get("output") or 0), "model": model}
        between = []


def window_calls(files: Iterable[Path], box: str, since: float, until: float) -> Iterator[dict]:
    for path in files:
        try:
            if path.stat().st_mtime < since:
                continue
            with open(path, encoding="utf-8", errors="replace") as handle:
                yield from session_calls(handle, box, since, until)
        except OSError:
            continue


def switches(pool_lines: Iterable[str], offset_h: float) -> Dict[str, List[tuple]]:
    """pi-pool account moves per session: (epoch, why), from 'switch' events and from a vend that names a previous account."""
    moves: Dict[str, List[tuple]] = defaultdict(list)
    zone = timezone(timedelta(hours=offset_h))
    for line in pool_lines:
        if '"switch"' not in line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("event") != "switch" or not event.get("session"):
            continue
        try:
            at = datetime.fromisoformat(event["ts"]).replace(tzinfo=zone).timestamp()
        except (KeyError, ValueError):
            continue
        moves[event["session"]].append((at, str(event.get("why") or event.get("reason") or "switch")))
    return moves


def classify(call: dict, moves: Dict[str, List[tuple]], ttl_s: float = TTL_S) -> tuple:
    """(cause, lost tokens): the cached prefix the call wrote again and why. Growth is cacheWrite minus lost."""
    previous = call.get("previous")
    write = call["cacheWrite"]
    if not previous:
        return "first call", write
    lost = max(0, min(previous["prompt"], call["input"] + call["cacheRead"] + write) - call["cacheRead"])
    lost = min(lost, write)
    if lost < 1024:
        return "growth", 0
    gap = call["at"] - previous["at"]
    moved = [why for at, why in moves.get(call.get("session") or "", []) if previous["at"] - 1 <= at <= call["at"] + 1]
    if moved:
        return f"account switch ({moved[-1]})", lost
    if gap >= ttl_s:
        return "idle over TTL", lost
    if "compaction" in call["between"] or "branch_summary" in call["between"]:
        return "compaction", lost
    if previous["model"] != call["model"] or "model_change" in call["between"]:
        return "model change", lost
    return "prefix changed", lost


def rank(calls: List[dict], moves: Dict[str, List[tuple]], ttl_s: float = TTL_S) -> dict:
    causes: Dict[str, dict] = defaultdict(lambda: {"calls": 0, "written": 0})
    sessions: Dict[str, dict] = defaultdict(lambda: {"written": 0, "lost": 0, "calls": 0})
    total = {"input": 0, "cacheRead": 0, "cacheWrite": 0, "calls": 0}
    for call in calls:
        for key in ("input", "cacheRead", "cacheWrite"):
            total[key] += call[key]
        total["calls"] += 1
        cause, lost = classify(call, moves, ttl_s)
        growth = call["cacheWrite"] - lost
        if growth:
            causes["growth"]["written"] += growth
        if cause != "growth":
            causes[cause]["calls"] += 1
            causes[cause]["written"] += lost
        else:
            causes["growth"]["calls"] += 1
        row = sessions[f"{call['box']} {call.get('session')}"]
        row["written"] += call["cacheWrite"]; row["lost"] += lost; row["calls"] += 1
    prompt = total["input"] + total["cacheRead"] + total["cacheWrite"]
    return {"calls": total["calls"], "read_share": round(100 * total["cacheRead"] / prompt, 1) if prompt else None,
            "cache_written": total["cacheWrite"], "prompt": prompt,
            "causes": dict(sorted(causes.items(), key=lambda item: -item[1]["written"])),
            "sessions": dict(sorted(sessions.items(), key=lambda item: -item[1]["lost"])[:15])}


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    rows = sub.add_parser("calls")
    rows.add_argument("--since", required=True)
    rows.add_argument("--until", required=True)
    rows.add_argument("--box", required=True)
    ranks = sub.add_parser("rank")
    ranks.add_argument("files", nargs="+")
    ranks.add_argument("--pool-log", default=str(Path.home() / ".config/pi-pool/pi-pool.log"))
    ranks.add_argument("--pool-utc-offset-h", type=float, default=0.0)
    args = parser.parse_args()
    if args.command == "calls":
        since, until = epoch(args.since), epoch(args.until)
        for call in window_calls(transcripts(PRIME), args.box, since, until):
            print(json.dumps(call))
        return 0
    calls = [json.loads(line) for name in args.files for line in open(name) if line.strip()]
    with open(args.pool_log, encoding="utf-8", errors="replace") as handle:
        moves = switches(handle, args.pool_utc_offset_h)
    print(json.dumps(rank(calls, moves), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
