"""pi-host threads: the `usage` table of ~/.prime/agent/pi-host/durable/index.sqlite, one row per model answer, read as apps/chat reads it
(packages/pi-host/src/durable/index-db.ts readUsageRows): by rowid, on a read-only connection that never waits for pi-host's writes.

The agent comes from the chat server's agent records on this box (apps/chat/server/agent-store.ts): an agent's work thread, its comm
thread per room and every aliased root job thread name it. On a box with no chat server, such as the Mac, the agent stays empty.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Dict, Iterator

from ..core import CHECKPOINT

CLIENT = "pi-host"
PAGE_ROWS = 2000


def open_ro(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
    db.row_factory = sqlite3.Row
    return db


def agent_records(chat: Path) -> Dict[str, Any]:
    """{agents, aliases} from chat.sqlite once the server keeps the agents kind there, else from agents.json."""
    database = chat / "chat.sqlite"
    if database.exists():
        db = open_ro(database)
        try:
            kinds = {row[0] for row in db.execute("SELECT kind FROM db_kinds")}
            if "agents" in kinds:
                agents = [json.loads(row[0]) for row in db.execute("SELECT body FROM agents_agents ORDER BY ord")]
                aliases = {row[0]: row[1] for row in db.execute("SELECT thread, agent FROM agents_aliases")}
                return {"agents": agents, "aliases": aliases}
        except sqlite3.Error:
            pass
        finally:
            db.close()
    try:
        return json.loads((chat / "agents.json").read_text())
    except (FileNotFoundError, ValueError):
        return {"agents": [], "aliases": {}}


def agent_by_thread(home: Path) -> Dict[str, str]:
    records = agent_records(home / ".pi/agent/chat")
    names: Dict[str, str] = {}
    by_id: Dict[str, str] = {}
    for agent in records.get("agents") or []:
        name = str(agent.get("name") or agent.get("slug") or agent.get("id") or "")
        by_id[str(agent.get("id"))] = name
        if agent.get("workThread"):
            names[str(agent["workThread"])] = name
        for thread in (agent.get("comm") or {}).values():
            names.setdefault(str(thread), name)
    for thread, agent_id in (records.get("aliases") or {}).items():
        if agent_id in by_id:
            names.setdefault(str(thread), by_id[agent_id])
    return names


def collect(ctx: Any) -> Iterator[Any]:
    path = ctx.home / ".prime/agent/pi-host/durable/index.sqlite"
    if not path.exists():
        return
    db = open_ro(path)
    try:
        top = db.execute("SELECT max(rowid) FROM usage").fetchone()[0] or 0
        cursor = ctx.state.get("cursor")
        after = 0
        if cursor:
            # pi-host rebuilds the usage table after a schema change, which renumbers rowids; then the row at the cursor is another
            # row or gone, and the read starts again at ctx.since, whose rows the table already holds under the same keys.
            at_cursor = db.execute("SELECT thread, entry_id FROM usage WHERE rowid = ?", (cursor["after"],)).fetchone()
            if at_cursor is not None and [at_cursor[0], at_cursor[1]] == [cursor["thread"], cursor["entry"]]:
                after = cursor["after"]
        if top <= after:
            return
        agents = agent_by_thread(ctx.home)
        thread_names = {row[0]: row[1] for row in db.execute("SELECT id, name FROM threads")}
        while after < top:
            rows = db.execute(
                "SELECT rowid AS id, thread, conversation, entry_id, model, at, input, output, cache_read, cache_write, cost_input, cost_output,"
                " cost_cache_read, cost_cache_write FROM usage WHERE rowid > ? AND rowid <= ? AND at >= ? ORDER BY rowid LIMIT ?",
                (after, top, ctx.since, PAGE_ROWS)).fetchall()
            if not rows:
                last = db.execute("SELECT rowid, thread, entry_id FROM usage WHERE rowid <= ? ORDER BY rowid DESC LIMIT 1", (top,)).fetchone()
                if last is not None:
                    ctx.state["cursor"] = {"after": last[0], "thread": last[1], "entry": last[2]}
                break
            for row in rows:
                provider, _, model = str(row["model"]).partition("/")
                if not model:
                    provider, model = "", provider
                yield {
                    "source_key": f"{CLIENT}:{ctx.host}:{row['thread']}:{row['entry_id']}",
                    "call_at": row["at"],
                    "agent": agents.get(row["thread"], ""),
                    "thread": row["thread"],
                    "thread_name": thread_names.get(row["thread"], ""),
                    "session": str(row["conversation"]),
                    "provider": provider or "unknown",
                    "model": model,
                    "input_tokens": row["input"],
                    "output_tokens": row["output"],
                    "cache_read_tokens": row["cache_read"],
                    "cache_write_tokens": row["cache_write"],
                    "cost_input_usd": row["cost_input"],
                    "cost_output_usd": row["cost_output"],
                    "cost_cache_read_usd": row["cost_cache_read"],
                    "cost_cache_write_usd": row["cost_cache_write"],
                    "cost_source": "reported",
                }
            last = rows[-1]
            after = last["id"]
            ctx.state["cursor"] = {"after": after, "thread": last["thread"], "entry": last["entry_id"]}
            yield CHECKPOINT
    finally:
        db.close()
