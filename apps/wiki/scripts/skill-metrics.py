#!/usr/bin/env python
"""Machine-local skill metrics store. Never ships: the wiki serves it in dev only.

Read events already live in the wiki's own SQLite store, so this attaches that
file read-only instead of copying rows. Only context snapshots are stored here,
because "what each host injects" is state that nothing else records.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import duckdb

SCRIPT_DIR = Path(__file__).resolve().parent
# The wiki engine passes its content root and the code repo whose skills it measures (WIKI_CONTENT_ROOT, WIKI_CODE_REPO).
CONTENT = Path(os.environ.get("WIKI_CONTENT_ROOT") or SCRIPT_DIR.parent / "content")
REPO_ROOT = Path(os.environ.get("WIKI_CODE_REPO") or SCRIPT_DIR.parent.parent.parent)
STORE = CONTENT / ".wiki" / "skill-metrics.duckdb"
WIKI_DB = CONTENT / ".wiki" / "wiki.db"
DERIVER = REPO_ROOT / "scripts" / "skills" / "derive-context.mjs"

SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshot_runs (
    snapshot_id VARCHAR PRIMARY KEY,
    snapshot_ts TIMESTAMP NOT NULL,
    repo VARCHAR,
    repo_head VARCHAR,
    rows_digest VARCHAR,
    row_count INTEGER,
    skipped VARCHAR
);
CREATE TABLE IF NOT EXISTS context_snapshots (
    snapshot_id VARCHAR NOT NULL,
    snapshot_ts TIMESTAMP NOT NULL,
    host VARCHAR NOT NULL,
    layer VARCHAR NOT NULL,
    skill_key VARCHAR NOT NULL,
    display_id VARCHAR,
    name VARCHAR,
    description VARCHAR,
    description_chars INTEGER,
    body_chars INTEGER,
    visible BOOLEAN,
    root_kind VARCHAR,
    precedence_rank INTEGER
);
"""


def connect() -> duckdb.DuckDBPyConnection:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(STORE))
    con.execute(SCHEMA)
    if WIKI_DB.exists():
        con.execute("INSTALL sqlite; LOAD sqlite;")
        con.execute(f"ATTACH '{WIKI_DB}' AS wiki (TYPE sqlite, READ_ONLY)")
    return con


def derive() -> dict:
    out = subprocess.run(
        ["node", str(DERIVER), str(REPO_ROOT)],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    if out.returncode != 0:
        raise RuntimeError(f"derive-context.mjs exited {out.returncode}: {out.stderr[-400:]}")
    return json.loads(out.stdout)


def snapshot(con: duckdb.DuckDBPyConnection, force: bool) -> dict:
    payload = derive()
    latest = con.execute("SELECT rows_digest FROM snapshot_runs ORDER BY snapshot_ts DESC LIMIT 1").fetchone()
    if latest and latest[0] == payload["rows_digest"] and not force:
        return {"stored": False, "reason": "context unchanged since the last snapshot", "digest": payload["rows_digest"]}

    con.execute(
        "INSERT INTO snapshot_runs VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            payload["snapshot_id"],
            payload["snapshot_ts"],
            payload["repo"],
            payload["repo_head"],
            payload["rows_digest"],
            len(payload["rows"]),
            json.dumps(payload["skipped"]),
        ],
    )
    con.executemany(
        "INSERT INTO context_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            [
                payload["snapshot_id"],
                payload["snapshot_ts"],
                r["host"],
                r["layer"],
                r["skill_key"],
                r["display_id"],
                r["name"],
                r["description"],
                r["description_chars"],
                r["body_chars"],
                r["visible"],
                r["root_kind"],
                r["precedence_rank"],
            ]
            for r in payload["rows"]
        ],
    )
    return {
        "stored": True,
        "snapshot_id": payload["snapshot_id"],
        "rows": len(payload["rows"]),
        "skipped": payload["skipped"],
    }


def rows(con: duckdb.DuckDBPyConnection, sql: str, params: list | None = None) -> list[dict]:
    cur = con.execute(sql, params or [])
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def export(con: duckdb.DuckDBPyConnection, days: int) -> dict:
    run = con.execute(
        "SELECT snapshot_id, CAST(snapshot_ts AS VARCHAR), repo_head, skipped FROM snapshot_runs ORDER BY snapshot_ts DESC LIMIT 1"
    ).fetchone()
    if not run:
        return {"error": "no snapshot yet; run `snapshot` first"}
    snapshot_id, snapshot_ts, repo_head, skipped = run

    has_wiki = WIKI_DB.exists()
    reads_cte = (
        """
        WITH reads AS (
            SELECT
                'repo:' || replace(path, '@code/', '') AS skill_key,
                count(*) AS reads,
                count(DISTINCT session_id) AS reader_sessions,
                max(ts) AS last_read
            FROM wiki.views
            WHERE viewer_kind = 'agent' AND path LIKE '@code/%'
            GROUP BY 1
        )
        """
        if has_wiki
        else "WITH reads AS (SELECT NULL AS skill_key, 0 AS reads, 0 AS reader_sessions, NULL AS last_read WHERE FALSE)"
    )

    hosts = rows(
        con,
        """
        SELECT host,
               count(*) FILTER (layer = 'skill') AS skills,
               count(*) FILTER (layer = 'skill' AND visible) AS visible_skills,
               sum(description_chars) FILTER (layer = 'skill') AS skill_description_chars,
               count(*) FILTER (layer = 'rule') AS rules,
               sum(body_chars) FILTER (layer = 'rule' AND visible) AS always_injected_rule_chars
        FROM context_snapshots WHERE snapshot_id = ?
        GROUP BY host ORDER BY host
        """,
        [snapshot_id],
    )

    items = rows(
        con,
        reads_cte
        + """
        SELECT c.host, c.layer, c.display_id, c.name, c.description, c.description_chars,
               c.body_chars, c.visible, c.root_kind, c.precedence_rank, c.skill_key,
               coalesce(r.reads, 0) AS reads,
               coalesce(r.reader_sessions, 0) AS reader_sessions,
               r.last_read
        FROM context_snapshots c
        LEFT JOIN reads r ON r.skill_key = c.skill_key
        WHERE c.snapshot_id = ?
        ORDER BY c.host, c.layer, reads DESC, c.display_id
        """,
        [snapshot_id],
    )

    reads_by_host = (
        rows(
            con,
            """
            SELECT coalesce(agent_id, 'unattributed') AS agent,
                   count(*) AS reads,
                   count(DISTINCT session_id) AS sessions,
                   min(ts) AS first_seen,
                   max(ts) AS last_seen
            FROM wiki.views WHERE viewer_kind = 'agent' AND path LIKE '@code/%'
            GROUP BY 1 ORDER BY reads DESC
            """,
        )
        if has_wiki
        else []
    )

    daily = (
        rows(
            con,
            f"""
            SELECT CAST(CAST(ts AS DATE) AS VARCHAR) AS day,
                   coalesce(agent_id, 'unattributed') AS agent,
                   count(*) AS reads
            FROM wiki.views
            WHERE viewer_kind = 'agent' AND path LIKE '@code/%'
              AND CAST(ts AS DATE) >= current_date - {int(days)}
            GROUP BY 1, 2 ORDER BY 1, 2
            """,
        )
        if has_wiki
        else []
    )

    return {
        "snapshot": {"id": snapshot_id, "ts": str(snapshot_ts), "repo_head": repo_head, "skipped": json.loads(skipped or "[]")},
        "hosts": hosts,
        "items": items,
        "reads_by_host": reads_by_host,
        "reads_daily": daily,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="skill metrics store (local only)")
    sub = parser.add_subparsers(dest="command", required=True)
    snap = sub.add_parser("snapshot")
    snap.add_argument("--force", action="store_true")
    exp = sub.add_parser("export")
    exp.add_argument("--days", type=int, default=30)
    args = parser.parse_args()

    con = connect()
    try:
        if args.command == "snapshot":
            result = snapshot(con, args.force)
        else:
            result = export(con, args.days)
    finally:
        con.close()
    json.dump(result, sys.stdout, default=str)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
