#!/usr/bin/env python3
"""usage-feed: Prime model call usage from the session transcripts, as the OTLP counters Prime's own exporter writes.

usage: python3 -B feed.py [--once] [--dry-run]

Settings > Usage, the sidebar Throughput line and the Skills and tools cache shares read prime_agent_* series from LGTM
(components/user-history/src/usage/lgtm.ts). Prime's OTLP exporter (prime-agent 973cf9c) writes them, but no box runs a Prime build
with it yet, so on 10-19 LGTM held no prime_agent series. This feed reads each assistant message's usage from the transcripts
under ~/.prime/agent and sends the same five counters to the box's Alloy on 127.0.0.1:14318, with the extra label
feed="transcripts". It counts calls that end after it starts; Prometheus cannot take older samples.

When LGTM shows prime_agent_calls_total on this box from any other source, Prime's exporter is live here: the feed writes
`handed-off` next to itself and exits 0, and it never starts again until someone installs it again.
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, Iterator, List, Optional, Tuple

HOME = Path.home()
PRIME = HOME / ".prime/agent"
HERE = Path(__file__).resolve().parent
ENDPOINT = "http://127.0.0.1:14318/v1/metrics"
GRAFANA = PRIME / "browser-chat/grafana-alerts.json"
DATASOURCE = "estate_prometheus_stg"
# Every 10 s, the export interval the otel-tok-meter job set for Prime's exporter (~/work/otel-tok-meter/CONTRACT.md).
INTERVAL_S = 10
# How often the feed asks LGTM whether Prime's own exporter writes this box's series.
HANDOFF_EVERY_S = 60
FEED = "transcripts"
# A session point goes out for this long after its last call, then stops: lgtm.ts rates() reads a session's live speed over [1m], and two
# windows of 10 s exports keep two samples in it. Before 10-23 every session point went out every 10 s for the feed's whole life, so one feed
# process held 4,280 live session series and the 24h per-model speed query read 70.7M samples and took 15 s.
SESSION_IDLE_S = 2 * 60

Attributes = Tuple[Tuple[str, str], ...]


class Sum:
    """A cumulative monotonic sum. A new attribute set goes out as 0 first and gets its value after that export, because
    Prometheus increase() counts nothing for a series' first sample; Prime's exporter does the same."""

    def __init__(self, name: str, unit: str, integer: bool, idle_s: Optional[float] = None, clock: Callable[[], float] = time.time):
        self.name, self.unit, self.integer, self.idle_s, self.clock = name, unit, integer, idle_s, clock
        self.points: Dict[Attributes, List[float]] = {}  # attributes -> [exported value, held value, time of the last add]

    def add(self, attributes: Dict[str, str], value: float) -> None:
        if not (isinstance(value, (int, float)) and value > 0 and value == value and value != float("inf")):
            return
        key = tuple(sorted({**attributes, "feed": FEED}.items()))
        point = self.points.get(key)
        if point is None:
            self.points[key] = [0.0, value, self.clock()]
        else:
            point[1] += value
            point[2] = self.clock()

    def settle(self) -> None:
        for point in self.points.values():
            point[0] += point[1]
            point[1] = 0.0

    def otlp(self, start_ns: int, now_ns: int) -> dict:
        def point(attributes: Attributes, value: float) -> dict:
            number = {"asInt": str(round(value))} if self.integer else {"asDouble": value}
            return {"attributes": [{"key": k, "value": {"stringValue": v}} for k, v in attributes],
                    "startTimeUnixNano": str(start_ns), "timeUnixNano": str(now_ns), **number}
        now = self.clock()
        live = [(k, v) for k, v in self.points.items() if self.idle_s is None or v[1] > 0 or now - v[2] <= self.idle_s]
        return {"name": self.name, "unit": self.unit, "sum": {"aggregationTemporality": 2, "isMonotonic": True,
                "dataPoints": [point(k, v[0]) for k, v in live]}}


class Usage:
    """The five counters of Prime's exporter (otlp-usage-exporter.ts), plus output tokens and generation seconds per model with no session
    label, which Settings > Usage reads for its speed column. Fed one transcript assistant message at a time."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self.tokens = Sum("prime_agent.tokens", "{token}", True)
        self.cost = Sum("prime_agent.cost", "USD", False)
        self.calls = Sum("prime_agent.calls", "{call}", True)
        self.session_output = Sum("prime_agent.session.output_tokens", "{token}", True, SESSION_IDLE_S, clock)
        self.session_seconds = Sum("prime_agent.session.generation_seconds", "s", False, SESSION_IDLE_S, clock)
        self.generation_output = Sum("prime_agent.generation.output_tokens", "{token}", True)
        self.generation_seconds = Sum("prime_agent.generation.seconds", "s", False)

    def sums(self) -> List[Sum]:
        return [self.tokens, self.cost, self.calls, self.session_output, self.session_seconds, self.generation_output, self.generation_seconds]

    def record(self, entry: dict, session: Optional[str]) -> bool:
        message = entry.get("message") if entry.get("type") == "message" else None
        if not isinstance(message, dict) or message.get("role") != "assistant" or not isinstance(message.get("usage"), dict):
            return False
        usage = message["usage"]
        model = message.get("responseModel") or message.get("model")
        if not isinstance(model, str) or not isinstance(message.get("provider"), str):
            return False
        labels = {"provider": message["provider"], "model": model}
        for kind, field in (("input", "input"), ("output", "output"), ("cache_read", "cacheRead"), ("cache_write", "cacheWrite")):
            self.tokens.add({"kind": kind, **labels}, usage.get(field) or 0)
        cost = usage.get("cost")
        self.cost.add(labels, cost.get("total") or 0 if isinstance(cost, dict) else 0)
        self.calls.add({**labels, "stop_reason": str(message.get("stopReason") or "unknown")}, 1)
        output = usage.get("output") or 0
        if isinstance(output, (int, float)) and output > 0:
            ended, started = epoch_ms(entry.get("timestamp")), message.get("timestamp")
            seconds = max(0.0, ended - started) / 1000 if ended is not None and isinstance(started, (int, float)) else None
            if session:
                self.session_output.add({"session": session, **labels}, output)
                if seconds is not None:
                    self.session_seconds.add({"session": session, **labels}, seconds)
            if seconds is not None:
                self.generation_output.add(labels, output)
                self.generation_seconds.add(labels, seconds)
        return True

    def payload(self, resource: Dict[str, str], start_ns: int, now_ns: int) -> Optional[dict]:
        sums = [m for m in (s.otlp(start_ns, now_ns) for s in self.sums()) if m["sum"]["dataPoints"]]
        if not sums:
            return None
        return {"resourceMetrics": [{"resource": {"attributes": [{"key": k, "value": {"stringValue": v}} for k, v in resource.items()]},
                "scopeMetrics": [{"scope": {"name": "sieun-pi-usage-feed"}, "metrics": sums}]}]}

    def settle(self) -> None:
        for s in self.sums():
            s.settle()


def epoch_ms(value: object) -> Optional[float]:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def transcripts(prime: Path) -> Iterator[Path]:
    """Prime session transcripts: ~/.prime/agent/sessions/*.jsonl and each RLM child's under session-artifacts/<root>/sub-*/.
    sessions-archive is left out, because an archived transcript is a copy of one already read."""
    sessions = prime / "sessions"
    if sessions.is_dir():
        for entry in os.scandir(sessions):
            if entry.name.endswith(".jsonl") and entry.is_file():
                yield Path(entry.path)
    artifacts = prime / "session-artifacts"
    if not artifacts.is_dir():
        return
    for root in os.scandir(artifacts):
        if not root.is_dir():
            continue
        stack = [Path(root.path)]
        while stack:
            folder = stack.pop()
            try:
                entries = list(os.scandir(folder))
            except OSError:
                continue
            for entry in entries:
                if entry.name.startswith("sub-") and entry.is_dir():
                    stack.append(Path(entry.path))
                elif folder.name.startswith("sub-") and entry.name.endswith(".jsonl") and entry.name != "rlm-subagents.jsonl" and entry.is_file():
                    yield Path(entry.path)


def header_session(path: Path) -> Optional[str]:
    try:
        with open(path, "rb") as handle:
            for _ in range(8):
                line = handle.readline()
                if not line:
                    return None
                try:
                    entry = json.loads(line)
                except ValueError:
                    return None
                if isinstance(entry, dict) and entry.get("type") == "session":
                    return entry.get("id") if isinstance(entry.get("id"), str) else None
    except OSError:
        return None
    return None


class Tail:
    """Byte offsets per transcript. A file seen at the first scan starts at its end, so only calls after the feed started count;
    a file that shows up later is read from its start. A file that shrank starts again at its new end."""

    def __init__(self, files: Callable[[], Iterator[Path]]):
        self.files = files
        self.offsets: Dict[Path, int] = {}
        self.sessions: Dict[Path, Optional[str]] = {}
        self.started = False

    def read(self, usage: Usage) -> int:
        calls = 0
        for path in self.files():
            try:
                size = path.stat().st_size
            except OSError:
                continue
            if path not in self.offsets:
                self.offsets[path] = 0 if self.started else size
                self.sessions[path] = header_session(path)
            offset = self.offsets[path]
            if size < offset:
                self.offsets[path] = size
                continue
            if size == offset:
                continue
            with open(path, "rb") as handle:
                handle.seek(offset)
                chunk = handle.read(size - offset)
            end = chunk.rfind(b"\n") + 1
            if self.sessions[path] is None:
                self.sessions[path] = header_session(path)
            for line in chunk[:end].splitlines():
                if b'"assistant"' not in line:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if isinstance(entry, dict) and usage.record(entry, self.sessions[path]):
                    calls += 1
            self.offsets[path] = offset + end
        self.started = True
        return calls


def grafana_query(promql: str) -> list:
    config = json.loads(GRAFANA.read_text())
    url = f"{config['url'].rstrip('/')}/api/datasources/proxy/uid/{DATASOURCE}/api/v1/query?" + urllib.parse.urlencode({"query": promql})
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {config['token']}"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)["data"]["result"]


def prime_exporter_box(instance: str, query: Callable[[str], list] = grafana_query) -> Optional[str]:
    """This box's name when Prime's own exporter writes its series, else None. The box label comes from the feed's own series."""
    own = query(f'group by (box) (last_over_time(prime_agent_calls_total{{job="prime-agent",instance="{instance}"}}[1h]))')
    boxes = [row["metric"].get("box") for row in own if row["metric"].get("box")]
    if not boxes:
        return None
    others = query(f'count(last_over_time(prime_agent_calls_total{{job="prime-agent",box="{boxes[0]}",feed!="{FEED}"}}[5m]))')
    return boxes[0] if others and float(others[0]["value"][1]) > 0 else None


def send(body: dict) -> bool:
    request = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return 200 <= response.status < 300
    except OSError as error:
        print(f"{time.strftime('%FT%TZ', time.gmtime())} export failed: {error}", file=sys.stderr, flush=True)
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--once", action="store_true", help="read and export once, then exit")
    parser.add_argument("--dry-run", action="store_true", help="print the payload instead of sending it")
    args = parser.parse_args()
    marker = HERE / "handed-off"
    if marker.exists() and not args.dry_run:
        print(f"handed off already: {marker.read_text().strip()}", flush=True)
        return 0
    started = time.time()
    instance = f"usage-feed-{socket.gethostname()}-{int(started)}"
    resource = {"service.name": "prime-agent", "service.instance.id": instance, "host.name": socket.gethostname()}
    usage, tail = Usage(), Tail(lambda: transcripts(PRIME))
    tail.read(usage)
    print(f"{time.strftime('%FT%TZ', time.gmtime())} started as {instance}; {len(tail.offsets)} transcripts", flush=True)
    last_check = started
    while True:
        calls = tail.read(usage)
        body = usage.payload(resource, int(started * 1e9), time.time_ns())
        if body and args.dry_run:
            print(json.dumps(body, indent=1))
        elif body and send(body):
            usage.settle()
        if args.once:
            print(f"{calls} calls read", flush=True)
            return 0
        if time.time() - last_check >= HANDOFF_EVERY_S:
            last_check = time.time()
            try:
                box = prime_exporter_box(instance)
            except (OSError, ValueError, KeyError) as error:
                box = None
                print(f"{time.strftime('%FT%TZ', time.gmtime())} handoff check failed: {error}", file=sys.stderr, flush=True)
            if box:
                note = f"{time.strftime('%FT%TZ', time.gmtime())} Prime's exporter writes prime_agent_calls_total for box {box}"
                marker.write_text(note + "\n")
                print(note + "; the feed stops", flush=True)
                return 0
        time.sleep(INTERVAL_S)


if __name__ == "__main__":
    sys.exit(main())
