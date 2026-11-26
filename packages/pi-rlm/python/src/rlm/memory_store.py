"""A local harness store's memory entries in ``memory.sqlite`` next to ``harness_state.json``.

pi-harness ``memory-store.ts`` reads and writes the same file with the same schema and tokenizer, so the kernel, pi-host's digest and the
chat's Agents tab share one store. Each write touches one row and a search ranks the whole store with SQLite FTS5's BM25, so an agent's
memory can hold tens of thousands of entries (~/work/agent-memory-scale, 11-26: 0.6 to 3 ms per search at 50,000 entries).
"""

from __future__ import annotations

import json
import sqlite3
import threading
import unicodedata
from pathlib import Path
from typing import Any, Iterator

MEMORY_DB = "memory.sqlite"

SCHEMA = """
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, path TEXT NOT NULL DEFAULT 'general', source TEXT NOT NULL DEFAULT 'agent',
  metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
  extra TEXT NOT NULL DEFAULT '{}'
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_terms USING fts5(id_terms, title_terms, content_terms, tokenize = 'unicode61 remove_diacritics 0');
CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO memory_meta (key, value) VALUES ('revision', '0');
"""

_CJK_RANGES = (
    (0x1100, 0x11FF), (0x3040, 0x30FF), (0x3130, 0x318F), (0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF), (0xAC00, 0xD7AF), (0x20000, 0x3347F),
)
_STOP = set(
    (
        "the and for that this with from are was were you your but not have has had its into than then them they will would can could should about "
        "there their what when which who how all any been being our out use used using via per one two also just only some more most such each other over very"
    ).split()
)
_KNOWN = {"id", "kind", "title", "content", "path", "scope", "source", "metadata", "created_at", "updated_at", "version", "reference", "arguments"}


def _cjk(ch: str) -> bool:
    code = ord(ch)
    return any(low <= code <= high for low, high in _CJK_RANGES)


def _runs(text: str) -> Iterator[str]:
    run: list[str] = []
    for ch in text:
        if ch.isalnum() or unicodedata.category(ch).startswith("M"):
            run.append(ch)
        elif run:
            yield "".join(run)
            run = []
    if run:
        yield "".join(run)


def _pieces(run: str) -> Iterator[str]:
    piece: list[str] = []
    piece_cjk = False
    for ch in run:
        is_cjk = _cjk(ch)
        if piece and is_cjk != piece_cjk:
            yield "".join(piece)
            piece = []
        piece_cjk = is_cjk
        piece.append(ch)
    if piece:
        yield "".join(piece)


def memory_terms(text: str) -> list[str]:
    """pi-harness ``memoryTerms``: letter and digit runs of 3+ characters (2 with a digit), minus common English words, and Hangul,
    kana or CJK runs as character bigrams."""
    out: list[str] = []
    for run in _runs(text.lower()):
        for piece in _pieces(run):
            if _cjk(piece[0]):
                if len(piece) == 1:
                    out.append(piece)
                out.extend(piece[i : i + 2] for i in range(len(piece) - 1))
            elif (len(piece) >= 3 or (len(piece) == 2 and any(ch.isdigit() for ch in piece))) and piece not in _STOP:
                out.append(piece)
    return out


def memory_query(text: str) -> str:
    """The FTS5 query for ``text``: its distinct terms, any of which may match."""
    terms = list(dict.fromkeys(memory_terms(text)))
    # A lone CJK character is a word, which an indexed bigram starts with, so it matches as a prefix.
    return " OR ".join('"' + term.replace('"', '""') + '"' + ("*" if len(term) == 1 and _cjk(term) else "") for term in terms)


def _terms_text(text: str) -> str:
    return " ".join(memory_terms(text))


class MemoryStore:
    """One ``memory.sqlite``. Entries go in and come out as dicts with harness entry fields."""

    _open: dict[Path, "MemoryStore"] = {}
    _guard = threading.Lock()

    @classmethod
    def at(cls, directory: str | Path) -> "MemoryStore":
        path = (Path(directory).expanduser().resolve() / MEMORY_DB)
        with cls._guard:
            store = cls._open.get(path)
            if store is None:
                store = cls._open[path] = cls(path)
            return store

    def __init__(self, path: Path):
        self.path = path
        self._db: sqlite3.Connection | None = None

    def _conn(self, create: bool = True) -> sqlite3.Connection | None:
        if self._db is not None:
            return self._db
        if not create and not self.path.exists():
            return None
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None, check_same_thread=False)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout = 10000")
        db.execute("PRAGMA journal_mode = WAL")
        db.execute("PRAGMA synchronous = NORMAL")
        db.execute("PRAGMA mmap_size = 268435456")
        db.executescript(SCHEMA)
        self._db = db
        return db

    def _write(self, work) -> Any:
        db = self._conn()
        db.execute("BEGIN IMMEDIATE")
        try:
            result = work(db)
            db.execute("UPDATE memory_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'")
            db.execute("COMMIT")
            return result
        except BaseException:
            db.execute("ROLLBACK")
            raise

    @staticmethod
    def _entry(row: sqlite3.Row) -> dict[str, Any]:
        try:
            extra = json.loads(row["extra"])
        except ValueError:
            extra = {}
        try:
            metadata = json.loads(row["metadata"])
        except ValueError:
            metadata = {}
        return {
            **(extra if isinstance(extra, dict) else {}),
            "id": row["id"], "kind": "memory", "title": row["title"], "content": row["content"], "path": row["path"], "scope": "local",
            "reference": {}, "arguments": {}, "metadata": metadata if isinstance(metadata, dict) else {}, "source": row["source"],
            "created_at": row["created_at"], "updated_at": row["updated_at"], "version": int(row["version"]),
        }

    def put(self, entries: list[dict[str, Any]]) -> None:
        if not entries:
            return

        def work(db: sqlite3.Connection) -> None:
            for entry in entries:
                extra = {key: value for key, value in entry.items() if key not in _KNOWN}
                db.execute(
                    """INSERT INTO memory (id, title, content, path, source, metadata, created_at, updated_at, version, extra) VALUES (?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, path = excluded.path, source = excluded.source,
                    metadata = excluded.metadata, created_at = excluded.created_at, updated_at = excluded.updated_at, version = excluded.version, extra = excluded.extra""",
                    (
                        entry["id"], entry["title"], entry["content"], entry.get("path") or "general", entry.get("source") or "agent",
                        json.dumps(entry.get("metadata") or {}, ensure_ascii=False), entry.get("created_at") or "", entry.get("updated_at") or "",
                        int(entry.get("version") or 1), json.dumps(extra, ensure_ascii=False),
                    ),
                )
                rowid = db.execute("SELECT rowid FROM memory WHERE id = ?", (entry["id"],)).fetchone()[0]
                db.execute("DELETE FROM memory_terms WHERE rowid = ?", (rowid,))
                db.execute(
                    "INSERT INTO memory_terms (rowid, id_terms, title_terms, content_terms) VALUES (?,?,?,?)",
                    (rowid, _terms_text(entry["id"].replace("_", " ")), _terms_text(entry["title"]), _terms_text(entry["content"])),
                )

        self._write(work)
        # A bulk write goes into the main file at once, so later reads come through mmap and not the WAL (as memory-store.ts does).
        if len(entries) >= 500:
            self._conn().execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def delete(self, entry_id: str) -> bool:
        if self._conn(create=False) is None:
            return False

        def work(db: sqlite3.Connection) -> bool:
            row = db.execute("SELECT rowid FROM memory WHERE id = ?", (entry_id,)).fetchone()
            if row is None:
                return False
            db.execute("DELETE FROM memory_terms WHERE rowid = ?", (row[0],))
            db.execute("DELETE FROM memory WHERE id = ?", (entry_id,))
            return True

        return self._write(work)

    def get(self, entry_id: str) -> dict[str, Any] | None:
        db = self._conn(create=False)
        row = db.execute("SELECT * FROM memory WHERE id = ?", (entry_id,)).fetchone() if db else None
        return self._entry(row) if row else None

    def ids(self) -> list[str]:
        db = self._conn(create=False)
        return [row[0] for row in db.execute("SELECT id FROM memory ORDER BY id")] if db else []

    def all(self) -> list[dict[str, Any]]:
        db = self._conn(create=False)
        return [self._entry(row) for row in db.execute("SELECT * FROM memory ORDER BY rowid")] if db else []

    def count(self) -> int:
        db = self._conn(create=False)
        return int(db.execute("SELECT count(*) FROM memory").fetchone()[0]) if db else 0

    def search(self, text: str, limit: int) -> list[dict[str, Any]]:
        query = memory_query(text)
        db = self._conn(create=False) if query else None
        if db is None:
            return []
        rows = db.execute(
            """SELECT m.* FROM memory_terms JOIN memory m ON m.rowid = memory_terms.rowid
            WHERE memory_terms MATCH ? ORDER BY bm25(memory_terms, 1.0, 2.0, 1.0) LIMIT ?""",
            (query, limit),
        )
        return [self._entry(row) for row in rows]
