from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

PI_HOST_SCHEMA = """
CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE usage (
  thread TEXT NOT NULL, conversation INTEGER NOT NULL, entry_id INTEGER NOT NULL, model TEXT NOT NULL, at INTEGER NOT NULL,
  input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cost REAL NOT NULL,
  cost_input REAL NOT NULL DEFAULT 0, cost_output REAL NOT NULL DEFAULT 0, cost_cache_read REAL NOT NULL DEFAULT 0,
  cost_cache_write REAL NOT NULL DEFAULT 0, PRIMARY KEY (thread, entry_id)
);
"""


class FakeSink:
    """Keeps each POST; fail_on makes the nth POST (1-based) raise, as a dropped connection would."""

    def __init__(self, fail_on: Optional[int] = None) -> None:
        self.posts: List[tuple] = []
        self.attempts = 0
        self.fail_on = fail_on
        self.max_body_bytes = 1_000_000

    def insert(self, body: bytes, token: str) -> None:
        self.attempts += 1
        if self.fail_on is not None and self.attempts == self.fail_on:
            raise OSError("connection reset")
        self.posts.append((body, token))

    def rows(self) -> List[Dict[str, Any]]:
        return [json.loads(line) for body, _ in self.posts for line in body.splitlines()]


def pi_host_db(home: Path, rows: List[tuple], threads: Dict[str, str]) -> Path:
    path = home / ".prime/agent/pi-host/durable/index.sqlite"
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(path))
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name = 'usage'").fetchone():
        db.executescript(PI_HOST_SCHEMA)
    db.executemany("INSERT OR REPLACE INTO threads (id, name) VALUES (?, ?)", list(threads.items()))
    db.executemany("INSERT INTO usage VALUES (?, 1, ?, 'anthropic/claude-opus-5-5', ?, 2, 100, 1000, 50, ?, 0.00001, 0.0025, 0.0005, ?)",
                   [(thread, entry, at, 0.00301 + w, w) for thread, entry, at, w in rows])
    db.commit()
    db.close()
    return path


def assistant(entry_id: str, at_ms: int, response_id: Optional[str], output: int = 100, cost: float = 0.01) -> dict:
    stamp = f"{_iso(at_ms)}"
    return {"type": "message", "id": entry_id, "parentId": None, "timestamp": stamp,
            "message": {"role": "assistant", "content": [{"type": "text", "text": "assistant reply"}], "provider": "anthropic",
                        "model": "claude-opus-5-5", "responseId": response_id, "stopReason": "stop", "timestamp": at_ms - 2000,
                        "usage": {"input": 3, "output": output, "cacheRead": 5000, "cacheWrite": 200, "totalTokens": 5303,
                                  "cost": {"input": 0.00001, "output": cost - 0.00301, "cacheRead": 0.0025, "cacheWrite": 0.0005, "total": cost}}}}


def _iso(at_ms: int) -> str:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(at_ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{at_ms % 1000:03d}Z"


def transcript(path: Path, session: str, entries: List[dict], name: Optional[str] = None, partial: bytes = b"") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [{"type": "session", "version": 3, "id": session, "timestamp": "2026-11-23T00:00:00.000Z", "cwd": "/tmp"}]
    if name:
        lines.append({"type": "session_info", "id": "info0001", "parentId": None, "timestamp": "2026-11-23T00:00:00.000Z", "name": name})
    with open(path, "wb") as handle:
        for line in lines + entries:
            handle.write(json.dumps(line, separators=(",", ":")).encode() + b"\n")
        handle.write(partial)
