"""The collector core: runs every client module, writes their rows to the sink in JSONEachRow batches, then saves each client's cursor.

A client module in usage_collector/clients defines CLIENT = '<name>' and collect(ctx) -> Iterable[dict | CHECKPOINT]. Each dict holds the
columns of the model_calls table (schema.sql). The module keeps its cursor in ctx.state, a dict the core saves only after every row yielded
before it is in the sink. The module yields CHECKPOINT where ctx.state covers exactly the rows yielded so far, so a long read can be saved
in parts; without a CHECKPOINT the core writes and saves once, after collect returns.
"""
from __future__ import annotations

import hashlib
import importlib
import json
import pkgutil
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, Dict, Iterable, List, Optional

from .sink import Sink
from .state import StateStore, TrackedState

CHECKPOINT = object()

TEXT = ("source_key", "host", "client", "agent", "thread", "thread_name", "session", "provider", "model", "account", "cost_source")
TOKENS = ("input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens", "cache_write_1h_tokens", "duration_ms")
COSTS = ("cost_input_usd", "cost_output_usd", "cost_cache_read_usd", "cost_cache_write_usd")
COLUMNS = ("source_key", "call_at") + TEXT[1:] + TOKENS + COSTS
# ops guy's ask for the prod store: every row names its host, client and session; core fills host and client itself.
REQUIRED = ("source_key", "call_at", "session", "provider", "model", "cost_source")
UINT32_MAX = 2**32 - 1


class RowError(ValueError):
    pass


@dataclass
class Context:
    host: str
    since: int
    home: Path
    state: TrackedState
    cache: Dict[str, Any] = field(default_factory=dict)


def log(message: str) -> None:
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {message}", file=sys.stderr, flush=True)


def discover(names: Optional[List[str]] = None) -> List[ModuleType]:
    from . import clients

    found = []
    for info in sorted(pkgutil.iter_modules(clients.__path__), key=lambda m: m.name):
        module = importlib.import_module(f"{clients.__name__}.{info.name}")
        if isinstance(getattr(module, "CLIENT", None), str) and callable(getattr(module, "collect", None)):
            if names is None or module.CLIENT in names:
                found.append(module)
    return found


def call_at_text(value: Any) -> str:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        moment = datetime.fromtimestamp(value / 1000, timezone.utc)
    elif isinstance(value, str):
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
        moment = moment.replace(tzinfo=timezone.utc) if moment.tzinfo is None else moment.astimezone(timezone.utc)
    else:
        raise RowError(f"call_at {value!r} is neither epoch ms nor ISO time")
    return moment.strftime("%Y-%m-%d %H:%M:%S.") + f"{moment.microsecond // 1000:03d}"


def normalize(row: Dict[str, Any], client: str, host: str) -> Dict[str, Any]:
    """The row in schema column order, with ints clamped to UInt32 and costs as 9-decimal strings, which ClickHouse reads into Decimal
    exactly; a float such as 1.6e-05 would not parse."""
    missing = [name for name in REQUIRED if row.get(name) in (None, "")]
    if missing:
        raise RowError(f"{client} row lacks {', '.join(missing)}")
    out: Dict[str, Any] = {"source_key": str(row["source_key"]), "call_at": call_at_text(row["call_at"])}
    for name in TEXT[1:]:
        out[name] = str(row.get(name) or "")
    out["client"], out["host"] = client, out["host"] or host
    if not out["source_key"].startswith(f"{client}:{out['host']}:"):
        raise RowError(f"source_key {out['source_key']!r} does not start with '{client}:{out['host']}:'")
    for name in TOKENS:
        value = row.get(name) or 0
        out[name] = min(UINT32_MAX, max(0, int(value))) if isinstance(value, (int, float)) and value == value else 0
    for name in COSTS:
        value = row.get(name) or 0
        out[name] = f"{max(0.0, float(value)):.9f}" if isinstance(value, (int, float)) and value == value else "0.000000000"
    return out


def encode(row: Dict[str, Any]) -> bytes:
    return json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"


class Batch:
    """Encoded rows waiting for the sink. Each POST holds at most max_bytes, and its insert_deduplication_token is the sha256 of its
    body: a retried POST of the same rows is dropped, while a later POST that reprices the same keys has another body and lands.
    A batch fills to `parallel` POSTs and sends them at once; the keys fix each row, so their order does not matter."""

    def __init__(self, sink: Optional[Sink], max_bytes: int, parallel: int = 1) -> None:
        self.sink, self.max_bytes, self.parallel = sink, max_bytes, max(1, parallel)
        self.lines: List[bytes] = []
        self.size = 0

    def add(self, line: bytes) -> None:
        self.lines.append(line)
        self.size += len(line)

    def full(self) -> bool:
        return self.size >= self.max_bytes * self.parallel

    def flush(self) -> int:
        bodies: List[bytes] = []
        chunk: List[bytes] = []
        size = 0
        for line in self.lines + [b""]:
            if chunk and (not line or size + len(line) > self.max_bytes):
                bodies.append(b"".join(chunk))
                chunk, size = [], 0
            if line:
                chunk.append(line)
                size += len(line)
        if self.sink is not None and bodies:
            sink = self.sink
            send = lambda body: sink.insert(body, hashlib.sha256(body).hexdigest())
            if len(bodies) == 1 or self.parallel == 1:
                for body in bodies:
                    send(body)
            else:
                with ThreadPoolExecutor(max_workers=self.parallel) as pool:
                    list(pool.map(send, bodies))
        self.lines, self.size = [], 0
        return len(bodies)


@dataclass
class Stats:
    rows: int = 0
    posts: int = 0
    saves: int = 0
    bad: int = 0
    first: str = ""
    last: str = ""
    seconds: float = 0.0
    tokens: Dict[str, int] = field(default_factory=lambda: {name: 0 for name in TOKENS})
    cost_usd: float = 0.0

    def count(self, row: Dict[str, Any]) -> None:
        self.rows += 1
        self.first = min(self.first, row["call_at"]) if self.first else row["call_at"]
        self.last = max(self.last, row["call_at"])
        for name in TOKENS:
            self.tokens[name] += row[name]
        self.cost_usd += sum(float(row[name]) for name in COSTS)


def run_client(module: ModuleType, ctx: Context, sink: Optional[Sink], store: Optional[StateStore], max_bytes: int, parallel: int = 1) -> Stats:
    """One pass of one client. Without a store or sink (dry run) nothing is written or saved."""
    stats = Stats()
    started = time.time()
    batch = Batch(sink, max_bytes, parallel)

    def commit() -> None:
        stats.posts += batch.flush()
        if store is not None and sink is not None:
            store.save(module.CLIENT, ctx.state)
            stats.saves += 1

    for item in module.collect(ctx):
        if item is CHECKPOINT:
            if batch.full():
                commit()
            continue
        try:
            row = normalize(item, module.CLIENT, ctx.host)
        except (RowError, ValueError, TypeError) as error:
            stats.bad += 1
            if stats.bad <= 5:
                log(f"{module.CLIENT}: skipped a row: {error}")
            continue
        stats.count(row)
        batch.add(encode(row))
    commit()
    stats.seconds = round(time.time() - started, 3)
    return stats


@dataclass
class Settings:
    host: str
    since_ms: Callable[[], int]
    home: Path
    sink: Optional[Sink]
    store: StateStore
    dry_run: bool = False
    max_bytes: int = 1_000_000
    parallel: int = 1


def client_loop(module: ModuleType, settings: Settings, every: Optional[float], report: Callable[[str, Stats], None], failed: List[str]) -> None:
    """Runs one client once, or every `every` seconds. After a good pass the state in memory equals the saved one, so it is kept; a pass
    that fails reloads the last saved cursor, so the next pass sends the same rows again."""
    cache: Dict[str, Any] = {}
    state: Optional[TrackedState] = None
    while True:
        lock = None if settings.dry_run else settings.store.lock(module.CLIENT)
        if settings.dry_run or lock is not None:
            try:
                if state is None:
                    state = settings.store.load(module.CLIENT)
                ctx = Context(settings.host, settings.since_ms(), settings.home, state, cache)
                stats = run_client(module, ctx, None if settings.dry_run else settings.sink,
                                   None if settings.dry_run else settings.store, settings.max_bytes, settings.parallel)
                report(module.CLIENT, stats)
            except Exception as error:  # a client's failure must not stop the others
                log(f"{module.CLIENT}: pass failed, cursor kept: {type(error).__name__}: {error}")
                failed.append(module.CLIENT)
                state = None
            finally:
                if lock is not None:
                    lock.release()
        elif every is None:
            log(f"{module.CLIENT}: another collector holds its lock; skipped")
        if every is None:
            return
        time.sleep(every)


def run(modules: Iterable[ModuleType], settings: Settings, every: Optional[float], report: Callable[[str, Stats], None]) -> List[str]:
    """One thread per client, so a long backfill of one client never holds back the live rows of another. Returns the clients whose
    pass failed."""
    failed: List[str] = []
    threads = [threading.Thread(target=client_loop, args=(m, settings, every, report, failed), name=m.CLIENT, daemon=True) for m in modules]
    for thread in threads:
        thread.start()
    for thread in threads:
        while thread.is_alive():
            thread.join(1.0)
    return failed
