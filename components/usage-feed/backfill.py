#!/usr/bin/env python3
"""usage-feed backfill: the token history before the live feed started, as Prometheus blocks with the feed's counters.

usage:
  python3 -B backfill.py extract --until <iso> --out calls.jsonl.gz         # on each host: every Prime call that ended before --until
  python3 -B backfill.py build --calls <box>=<file> ... --since <minute> --until <iso> [--seam <box>=<iso>] --out <dir> [--promtool <path>]
  python3 -B backfill.py upload <dir> [--target us-metal01:/srv/staging/prometheus]

The live feed (feed.py) counts calls that end after it starts, and Prometheus takes no remote write sample older than its head block.
So the history goes in as TSDB blocks: build writes the five counters of feed.py per box, model and kind as OpenMetrics text, one file
per 54 h block, and promtool tsdb create-blocks-from openmetrics turns each file into a block that upload copies into the Prometheus
data folder, where the next block reload (every minute) picks it up. The series carry instance="usage-backfill-<box>" and
feed="backfill" next to the live feed's labels, so Settings > Usage sums both.

Every counter has two samples in each minute, 1 ms after the minute starts (the value before the minute) and 1 ms before it ends
(the value after it), so increase() over any window that starts and ends on a minute adds up the calls of exactly those minutes.
The token, cost and call counters keep their samples every minute from their first call to --until, so a quiet hour reads 0 with no
extrapolation. The two per-session counters get samples only in minutes with a call, the same minutes for both, so their ratio (output
tokens per second of generation) holds over any window.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import shutil
import subprocess
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
from feed import PRIME, epoch_ms, header_session, transcripts  # noqa: E402

MINUTE_MS = 60_000
# promtool cuts blocks on multiples of its block duration; 54 h is one of the TSDB block ranges (2 h times powers of 3).
BLOCK_MS = 54 * 3_600_000
KINDS = (("input", "input"), ("output", "output"), ("cache_read", "cacheRead"), ("cache_write", "cacheWrite"))


def iso_ms(value: str) -> int:
    moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return int(moment.timestamp() * 1000)


def stamp(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def all_transcripts(prime: Path) -> Iterator[Path]:
    """feed.py's transcripts plus sessions-archive, since an archived session may be gone from sessions/; call ids drop the copies."""
    yield from transcripts(prime)
    archive = prime / "sessions-archive"
    for folder, _, names in os.walk(archive):
        for name in names:
            if name.endswith(".jsonl"):
                yield Path(folder) / name


def calls_in(path: Path) -> Iterator[list]:
    """[call id, ended ms, started ms, session, provider, model, stop reason, input, output, cache read, cache write, cost] per call,
    read as feed.py's Usage.record reads one; the call id is truth.py's (responseId, else msg:<entry id>:<timestamp>)."""
    session = header_session(path)
    with open(path, "rb") as handle:
        for line in handle:
            if b'"assistant"' not in line or not line.endswith(b"\n"):
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            message = entry.get("message") if isinstance(entry, dict) and entry.get("type") == "message" else None
            if not isinstance(message, dict) or message.get("role") != "assistant" or not isinstance(message.get("usage"), dict):
                continue
            model = message.get("responseModel") or message.get("model")
            ended = epoch_ms(entry.get("timestamp"))
            if not isinstance(model, str) or not isinstance(message.get("provider"), str) or ended is None:
                continue
            call = message.get("responseId") or (f"msg:{entry.get('id')}:{entry.get('timestamp')}" if entry.get("id") else None)
            if not call:
                continue
            usage = message["usage"]
            counts = [usage.get(field) or 0 for _, field in KINDS]
            counts = [value if isinstance(value, (int, float)) and value > 0 else 0 for value in counts]
            cost = usage.get("cost")
            total = cost.get("total") or 0 if isinstance(cost, dict) else 0
            started = message.get("timestamp")
            yield [call, int(ended), started if isinstance(started, (int, float)) else None, session, message["provider"], model,
                   str(message.get("stopReason") or "unknown"), *counts, total if isinstance(total, (int, float)) and total > 0 else 0]


def extract(args: argparse.Namespace) -> int:
    until = iso_ms(args.until)
    begun = time.time()
    seen: Dict[str, list] = {}
    files = 0
    for path in all_transcripts(Path(args.prime).expanduser()):
        files += 1
        try:
            for call in calls_in(path):
                if call[1] < until and call[0] not in seen:
                    seen[call[0]] = call
        except OSError:
            continue
    calls = sorted(seen.values(), key=lambda call: call[1])
    with gzip.open(args.out, "wt") as out:
        for call in calls:
            out.write(json.dumps(call) + "\n")
    first, last = (stamp(calls[0][1]), stamp(calls[-1][1])) if calls else ("-", "-")
    print(json.dumps({"files": files, "calls": len(calls), "first": first, "last": last, "until": stamp(until),
                      "output": sum(call[8] for call in calls), "seconds": round(time.time() - begun, 1), "out": args.out}))
    return 0


def read_calls(path: str) -> Iterator[list]:
    with gzip.open(path, "rt") as handle:
        for line in handle:
            yield json.loads(line)


Key = Tuple[str, Tuple[Tuple[str, str], ...]]


class Counters:
    """Per series, the amount added in each minute."""

    def __init__(self) -> None:
        self.minutes: Dict[Key, Dict[int, float]] = defaultdict(lambda: defaultdict(float))

    def add(self, name: str, labels: Dict[str, str], minute: int, value: float) -> None:
        if value > 0:
            self.minutes[(name, tuple(sorted(labels.items())))][minute] += value

    def record(self, box: str, call: list) -> None:
        _, ended, started, session, provider, model, stop, *rest = call
        counts, cost = rest[:4], rest[4]
        base = {"job": "prime-agent", "instance": f"usage-backfill-{box}", "box": box, "feed": "backfill", "provider": provider, "model": model}
        minute = ended // MINUTE_MS
        for (kind, _), value in zip(KINDS, counts):
            self.add("prime_agent_tokens", {**base, "kind": kind}, minute, value)
        self.add("prime_agent_cost_USD", base, minute, cost)
        self.add("prime_agent_calls", {**base, "stop_reason": stop}, minute, 1)
        output = counts[1]
        if session and output > 0:
            labels = {**base, "session": session}
            self.add("prime_agent_session_output_tokens", labels, minute, output)
            seconds = max(0.0, ended - started) / 1000 if started is not None else 0.0
            self.minutes[("prime_agent_session_generation_seconds", tuple(sorted(labels.items())))][minute] += seconds


SESSION_PAIRS = {"prime_agent_session_output_tokens": "prime_agent_session_generation_seconds"}
INTEGER = {"prime_agent_tokens", "prime_agent_calls", "prime_agent_session_output_tokens"}


def samples(name: str, minutes: Dict[int, float], last_minute: int, active: Optional[List[int]] = None) -> Iterator[Tuple[int, float]]:
    """(ms, cumulative value) pairs: 1 ms into each minute the value before it, 1 ms before its end the value after it. A token, cost or
    call counter covers every minute from its first to last_minute; a session counter only the minutes in `active`."""
    total = 0.0
    if active is not None:
        total = sum(value for minute, value in minutes.items() if minute < active[0])
        every: Iterable[int] = active
    else:
        every = range(min(minutes), last_minute + 1)
    for minute in every:
        start = minute * MINUTE_MS
        yield start + 1, total
        total += minutes.get(minute, 0.0)
        yield start + MINUTE_MS - 1, total


def number(name: str, value: float) -> str:
    return str(int(round(value))) if name in INTEGER else repr(float(value))


def labels_text(labels: Tuple[Tuple[str, str], ...]) -> str:
    return ",".join(f'{k}="{v.replace(chr(92), chr(92) * 2).replace(chr(34), chr(92) + chr(34))}"' for k, v in labels)


def build(args: argparse.Namespace) -> int:
    since, until = iso_ms(args.since), iso_ms(args.until)
    if since % MINUTE_MS:
        raise SystemExit("--since must sit on a minute")
    seams = {box: iso_ms(at) for box, at in (spec.split("=", 1) for spec in args.seam or [])}
    counters = Counters()
    boxes: Dict[str, int] = {}
    owner: Dict[str, str] = {}
    duplicates = 0
    for spec in args.calls:
        box, path = spec.split("=", 1)
        boxes[box] = 0
        for call in read_calls(path):
            if call[0] in owner:
                duplicates += 1
                continue
            owner[call[0]] = box
            if call[1] < min(until, seams.get(box, until)):
                counters.record(box, call)
                boxes[box] += 1
    first_minute, last_minute = since // MINUTE_MS, (until - 1) // MINUTE_MS
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    texts = out / "openmetrics"
    texts.mkdir(exist_ok=True)
    plain = sorted(key for key in counters.minutes if not key[0].startswith("prime_agent_session_"))
    sessions = sorted(key for key in counters.minutes if key[0] == "prime_agent_session_output_tokens")
    families = defaultdict(list)
    for key in plain:
        families[key[0]].append((key, None))
    for key in sessions:
        active = [minute for minute in sorted(counters.minutes[key]) if first_minute <= minute <= last_minute]
        if not active:
            continue
        twin = ("prime_agent_session_generation_seconds", key[1])
        families[key[0]].append((key, active))
        families[twin[0]].append((twin, active))
    chunks: Dict[int, Path] = {}
    handles = {}
    written = 0
    for name in sorted(families):
        for handle in handles.values():
            handle.write(f"# TYPE {name} counter\n")
        for key, active in families[name]:
            for at, value in samples(name, counters.minutes[key], last_minute, active):
                if at < since:
                    continue
                chunk = at // BLOCK_MS
                if chunk not in handles:
                    chunks[chunk] = texts / f"chunk-{chunk}.om"
                    handles[chunk] = open(chunks[chunk], "w")
                    handles[chunk].write(f"# TYPE {name} counter\n")
                handles[chunk].write(f"{name}_total{{{labels_text(key[1])}}} {number(name, value)} {at / 1000:.3f}\n")
                written += 1
    for handle in handles.values():
        handle.write("# EOF\n")
        handle.close()
    blocks = out / "blocks"
    blocks.mkdir(exist_ok=True)
    for chunk in sorted(chunks):
        result = subprocess.run([args.promtool, "tsdb", "create-blocks-from", "openmetrics", "--max-block-duration=54h",
                                 str(chunks[chunk]), str(blocks)], capture_output=True, text=True)
        if result.returncode != 0:
            raise SystemExit(f"promtool failed on {chunks[chunk]}: {result.stderr[-2000:]}")
    print(json.dumps({"calls": boxes, "duplicates_across_boxes": duplicates, "series": len(counters.minutes), "samples": written,
                      "since": stamp(since), "until": stamp(until), "chunks": len(chunks),
                      "blocks": sorted(p.name for p in blocks.iterdir() if p.is_dir())}))
    return 0


def upload(args: argparse.Namespace) -> int:
    """Copies each block into the Prometheus data folder as the user Prometheus runs as, through a temporary name, so the reload
    never reads half a block."""
    host, folder = args.target.split(":", 1)
    blocks = sorted(p for p in Path(args.dir, "blocks").iterdir() if p.is_dir())
    staging = f"{folder}/../usage-backfill-upload"
    subprocess.run(["ssh", host, f"mkdir -p {staging}"], check=True)
    subprocess.run(["rsync", "-a", *[str(p) for p in blocks], f"{host}:{staging}/"], check=True)
    owner = subprocess.run(["ssh", host, f"stat -c %u:%g {folder}"], check=True, capture_output=True, text=True).stdout.strip()
    names = " ".join(p.name for p in blocks)
    subprocess.run(["ssh", host, f"cd {staging} && chown -R {owner} {names} && mv {names} {folder}/ && rmdir {staging}"], check=True)
    print(json.dumps({"uploaded": [p.name for p in blocks], "to": args.target}))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    one = sub.add_parser("extract")
    one.add_argument("--until", required=True)
    one.add_argument("--out", required=True)
    one.add_argument("--prime", default=str(PRIME))
    two = sub.add_parser("build")
    two.add_argument("--calls", action="append", required=True, help="<box>=<calls.jsonl.gz>, first box wins a call id both hold")
    two.add_argument("--since", required=True)
    two.add_argument("--until", required=True, help="the end of the samples, and of the calls of a box with no --seam")
    two.add_argument("--seam", action="append", help="<box>=<iso>: count only that box's calls before the live feed started there")
    two.add_argument("--out", required=True)
    two.add_argument("--promtool", default=shutil.which("promtool") or "promtool")
    three = sub.add_parser("upload")
    three.add_argument("dir")
    three.add_argument("--target", default="us-metal01:/srv/staging/prometheus")
    args = parser.parse_args()
    return {"extract": extract, "build": build, "upload": upload}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
