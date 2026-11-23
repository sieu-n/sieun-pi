"""Each client's cursor, kept in one SQLite file as (client, key, JSON value) rows, and a lock per client so two collectors never read
the same cursor at once."""
from __future__ import annotations

import fcntl
import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Optional, Set


class TrackedState(dict):
    """A dict that remembers which top-level keys changed since the last save. A client changes a nested value by setting its key again,
    so the Prime client's 100k file cursors are not all rewritten on every 10 s pass."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.dirty: Set[str] = set()

    def __setitem__(self, key: str, value: Any) -> None:
        super().__setitem__(key, value)
        self.dirty.add(key)

    def __delitem__(self, key: str) -> None:
        super().__delitem__(key)
        self.dirty.add(key)

    def pop(self, key: str, *default: Any) -> Any:
        if key in self:
            self.dirty.add(key)
        return super().pop(key, *default)

    def setdefault(self, key: str, default: Any = None) -> Any:
        if key not in self:
            self[key] = default
        return self[key]

    def update(self, *args: Any, **kwargs: Any) -> None:
        for key, value in dict(*args, **kwargs).items():
            self[key] = value


class Lock:
    def __init__(self, handle: Any) -> None:
        self.handle = handle

    def release(self) -> None:
        fcntl.flock(self.handle, fcntl.LOCK_UN)
        self.handle.close()


class StateStore:
    def __init__(self, folder: Path) -> None:
        self.folder = folder
        self.path = folder / "state.sqlite"

    def connect(self) -> sqlite3.Connection:
        self.folder.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(str(self.path), timeout=30)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE IF NOT EXISTS state (client TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (client, key))")
        return db

    def exists(self) -> bool:
        return self.path.exists()

    def load(self, client: str) -> TrackedState:
        state = TrackedState()
        if not self.path.exists():
            return state
        db = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, timeout=30)
        try:
            for key, value in db.execute("SELECT key, value FROM state WHERE client = ?", (client,)):
                dict.__setitem__(state, key, json.loads(value))
        except sqlite3.OperationalError:
            return TrackedState()
        finally:
            db.close()
        return state

    def save(self, client: str, state: TrackedState) -> None:
        if not state.dirty:
            return
        db = self.connect()
        try:
            with db:
                for key in sorted(state.dirty):
                    if key in state:
                        db.execute("INSERT OR REPLACE INTO state (client, key, value) VALUES (?, ?, ?)",
                                   (client, key, json.dumps(state[key], separators=(",", ":"))))
                    else:
                        db.execute("DELETE FROM state WHERE client = ? AND key = ?", (client, key))
        finally:
            db.close()
        state.dirty.clear()

    def lock(self, client: str) -> Optional[Lock]:
        """The client's lock, or None when another collector process holds it."""
        self.folder.mkdir(parents=True, exist_ok=True)
        handle = open(self.folder / f"{client}.lock", "a+")
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            handle.close()
            return None
        handle.seek(0)
        handle.truncate()
        handle.write(f"{os.getpid()}\n")
        handle.flush()
        return Lock(handle)
