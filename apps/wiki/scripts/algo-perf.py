#!/usr/bin/env python3
"""Algorithm-performance ledger over a local DuckDB store.

The store lives at content/.wiki/algo-perf.duckdb (canonical, machine-local,
gitignored with the rest of .wiki). One row per benchmark RUN in `runs`
(algorithm family x variant x benchmark frame, timestamped), long-format
metrics in `metrics` (one row per metric, optional CI bounds).

Time model: `run_at` is the measured-at moment as a NAIVE local wall-clock
timestamp (Asia/Seoul) — never timezone-aware; a `00:00:00` time means only
the date is known. `recorded_at` is a distinct fact: the ledger write time,
refreshed on upsert.

Run with:  uv run --no-project --with duckdb python scripts/algo-perf.py <cmd>

Commands:
  init                      create tables if missing (also migrates run_date -> run_at)
  record --run-id ... --at 'YYYY-MM-DD[THH:MM[:SS]]' --algo ... --variant ... --benchmark ...
         [--n N] [--source PATH] [--notes TEXT] [--commit SHA] [--artifact PATH]...
         --metric name=value[:lo,hi]   (repeatable; upserts the whole run)
                            also writes the run to the shared run history
                            (run_history.py) as component <algo>, with the
                            commit defaulting to this checkout's HEAD
  preset-set --id ... --label ... --algo ... --metric ...
         [--benchmarks a,b] [--description TEXT] [--sort N]
                            upsert a dashboard quick-view (ACTIVELY MANAGED:
                            recording a new benchmark family includes updating
                            the preset that shows it)
  preset-rm --id ...        delete a preset
  metric-set --metric ... [--description ...] [--higher-is-better/--lower-is-better]
             [--unit ratio|seconds|ms|count|kb] [--pair-with METRIC]
                            `pair-with` is a publishing contract: the dashboard
                            renders that metric beside this one and no control
                            can hide it (recall_strict -> e2e_yield).
  benchmark-set --benchmark ... [--description ...] [--source PATH] [--label ...]
             [--primary-metric ...] [--n-rows N] [--exposure held_out|selection]
             [--status active|archived] [--caveat TEXT] [--sort N] [--task ALGO]
                            annotate a DATASET (MANDATORY for every name in use
                            — `record` warns on unannotated names, the dashboard
                            flags them). A dataset OWNS its metrics: the
                            leaderboard's columns are whatever its runs carry,
                            and `primary-metric` is the north star it sorts by.
                            `sort` is the dashboard's dataset order; the lowest
                            active dataset of a task is that task's landing view.
                            `--task` lets a frame register BEFORE it is scored
                            and still appear as a tab (with "0 runs").
  variant-set --variant ... [--task ALGO] [--label ...] [--kind product|research]
             [--description ...] [--status active|superseded] [--sort N]
                            annotate an ARM. `kind=product` is what the
                            leaderboard shows by default; everything else is a
                            research arm behind the "show all variants" toggle.
                            An unregistered variant is research by default, so
                            only the shipped endpoints need a row.
                            All three def commands UPSERT — only the flags you
                            pass are written, the rest of the row is left alone.
  metric-rm / benchmark-rm / variant-rm
                            delete an annotation
  export                    full JSON dump: runs + presets + metric/benchmark defs
  sql "SELECT ..."          one read-only SELECT/WITH statement -> JSON
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import duckdb
import run_history

# The wiki engine passes its content root in WIKI_CONTENT_ROOT; without it the content sits beside scripts/.
CONTENT_DIR = Path(os.environ.get("WIKI_CONTENT_ROOT") or Path(__file__).resolve().parent.parent / "content")
DB_PATH = CONTENT_DIR / ".wiki" / "algo-perf.duckdb"
LEDGER_TZ = ZoneInfo("Asia/Seoul")
RUN_SOURCE = "apps/llm-wiki/scripts/algo-perf.py record"
KIND_BY_ALGO = {"email-finder": "eval"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  run_id      VARCHAR PRIMARY KEY,
  run_at      TIMESTAMP NOT NULL,   -- measured-at, local wall clock (Asia/Seoul); 00:00:00 = date-only precision
  algo        VARCHAR NOT NULL,
  variant     VARCHAR NOT NULL,
  benchmark   VARCHAR NOT NULL,
  n           INTEGER,
  source      VARCHAR,
  notes       VARCHAR,
  recorded_at TIMESTAMP NOT NULL DEFAULT current_timestamp  -- ledger write time; upsert refreshes it
);
CREATE TABLE IF NOT EXISTS metrics (
  run_id  VARCHAR NOT NULL,
  metric  VARCHAR NOT NULL,
  value   DOUBLE NOT NULL,
  ci_low  DOUBLE,
  ci_high DOUBLE,
  PRIMARY KEY (run_id, metric)
);
CREATE TABLE IF NOT EXISTS presets (
  id          VARCHAR PRIMARY KEY,
  label       VARCHAR NOT NULL,
  description VARCHAR,
  algo        VARCHAR NOT NULL,
  metric      VARCHAR NOT NULL,
  benchmarks  VARCHAR,
  sort        INTEGER NOT NULL DEFAULT 100
);
CREATE TABLE IF NOT EXISTS metric_defs (
  metric           VARCHAR PRIMARY KEY,
  description      VARCHAR,
  higher_is_better BOOLEAN NOT NULL DEFAULT true,
  unit             VARCHAR DEFAULT 'ratio',   -- ratio | seconds | ms | count | kb; drives formatting
  pair_with        VARCHAR                    -- metric that must be published beside this one
);
CREATE TABLE IF NOT EXISTS benchmark_defs (
  benchmark      VARCHAR PRIMARY KEY,
  description    VARCHAR,
  source         VARCHAR,
  label          VARCHAR,                     -- plain-words noun phrase: "creators with no address on their profile"
  primary_metric VARCHAR,                     -- the dataset's north star
  n_rows         INTEGER,                     -- the dataset's size
  exposure       VARCHAR,                     -- held_out | selection
  status         VARCHAR DEFAULT 'active',    -- active | archived
  caveat         VARCHAR,                     -- one-line warning shown above the leaderboard
  sort           INTEGER DEFAULT 100,         -- dataset order; lowest active = the task's landing dataset
  task           VARCHAR                      -- owning algo family; lets a registered-but-unscored frame show up
);
CREATE TABLE IF NOT EXISTS variant_defs (
  variant     VARCHAR PRIMARY KEY,
  task        VARCHAR,
  label       VARCHAR,
  kind        VARCHAR DEFAULT 'research',  -- product | research; the leaderboard defaults to products
  description VARCHAR,
  status      VARCHAR DEFAULT 'active',    -- active | superseded
  sort        INTEGER DEFAULT 100
);
"""

# Additive migrations for a store created before these columns existed. Every
# entry is idempotent, so `init` (and every write connect) can replay the list.
_ADDED_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "metric_defs": [
        ("unit", "VARCHAR DEFAULT 'ratio'"),
        ("pair_with", "VARCHAR"),
    ],
    "benchmark_defs": [
        ("label", "VARCHAR"),
        ("primary_metric", "VARCHAR"),
        ("n_rows", "INTEGER"),
        ("exposure", "VARCHAR"),
        ("status", "VARCHAR DEFAULT 'active'"),
        ("caveat", "VARCHAR"),
        ("sort", "INTEGER DEFAULT 100"),
        ("task", "VARCHAR"),
    ],
}
# A row can record only an operational fact (status=archived) without anyone
# inventing a description for it.
_DROP_NOT_NULL = [("metric_defs", "description"), ("benchmark_defs", "description")]

EXPOSURES = ("held_out", "selection")
STATUSES = ("active", "archived")
UNITS = ("ratio", "seconds", "ms", "count", "kb")
KINDS = ("product", "research")
VARIANT_STATUSES = ("active", "superseded")


_OLD_COLUMN_GUARD = (
    "SELECT count(*) FROM information_schema.columns"
    " WHERE table_name='runs' AND column_name='run_date'"
)


def _column_names(con: duckdb.DuckDBPyConnection, table: str) -> set[str]:
    rows = con.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = ?", [table]
    ).fetchall()
    return {r[0] for r in rows}


def _missing_columns(con: duckdb.DuckDBPyConnection) -> list[str]:
    """Names an unmigrated store is missing — used by the read-only guard."""
    missing = []
    for table, cols in _ADDED_COLUMNS.items():
        have = _column_names(con, table)
        missing += [f"{table}.{c}" for c, _ in cols if c not in have]
    return missing


def _connect() -> duckdb.DuckDBPyConnection:
    """Open the store read-write: run every additive migration, then ensure SCHEMA."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB_PATH))
    has_old = con.execute(_OLD_COLUMN_GUARD).fetchone()[0]
    if has_old:
        con.execute("BEGIN")
        con.execute("ALTER TABLE runs RENAME COLUMN run_date TO run_at")
        con.execute("ALTER TABLE runs ALTER COLUMN run_at SET DATA TYPE TIMESTAMP")
        con.execute("COMMIT")
    con.execute(SCHEMA)
    # Additive only: a column is added, never dropped or retyped, so an older
    # store keeps every row it had and just gains the defaults.
    for table, cols in _ADDED_COLUMNS.items():
        for name, decl in cols:
            con.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {name} {decl}")  # noqa: S608 — code constants
    for table, col in _DROP_NOT_NULL:
        if con.execute(
            "SELECT is_nullable FROM information_schema.columns WHERE table_name = ? AND column_name = ?",
            [table, col],
        ).fetchone() == ("NO",):
            con.execute(f"ALTER TABLE {table} ALTER COLUMN {col} DROP NOT NULL")  # noqa: S608 — code constants
    return con


def _connect_read_only() -> duckdb.DuckDBPyConnection:
    """Read-only connect; cannot ALTER, so an unmigrated store is a loud failure."""
    if not DB_PATH.exists():
        raise SystemExit(f"store missing: {DB_PATH} — run init + record first")
    con = duckdb.connect(str(DB_PATH), read_only=True)
    if con.execute(_OLD_COLUMN_GUARD).fetchone()[0]:
        con.close()
        raise SystemExit("store still has legacy run_date column — run `init` once to migrate to run_at")
    missing = _missing_columns(con)
    if missing:
        con.close()
        raise SystemExit(f"store is missing {', '.join(missing)} — run `init` once to migrate")
    return con


def parse_at(spec: str) -> datetime:
    """ISO local timestamp; date-only means midnight; timezone-aware input is rejected."""
    try:
        dt = datetime.fromisoformat(spec)
    except ValueError as e:
        raise SystemExit(f"bad --at {spec!r}: expected YYYY-MM-DD[THH:MM[:SS]]") from e
    if dt.tzinfo is not None:
        raise SystemExit("naive local time only — no timezone suffix")
    return dt


def parse_metric(spec: str) -> tuple[str, float, float | None, float | None]:
    """'recall=0.837:0.78,0.88' -> (name, value, lo, hi); CI part optional."""
    name, _, rest = spec.partition("=")
    if not name or not rest:
        raise SystemExit(f"bad --metric {spec!r}: expected name=value[:lo,hi]")
    val_s, _, ci_s = rest.partition(":")
    value = float(val_s)
    lo: float | None = None
    hi: float | None = None
    if ci_s:
        lo_s, _, hi_s = ci_s.partition(",")
        if not hi_s:
            raise SystemExit(f"bad --metric {spec!r}: CI needs lo,hi")
        lo, hi = float(lo_s), float(hi_s)
    return name, value, lo, hi


def cmd_init() -> None:
    con = _connect()
    con.close()
    print(f"ok: {DB_PATH}")


def run_slug(run_id: str) -> str:
    """A ledger run_id as a run-history run_id: lowercase, other characters folded to '-'."""
    return re.sub(r"[^a-z0-9._-]+", "-", run_id.lower()).strip("-._")


def content_path(path: str) -> str:
    """A path under apps/llm-wiki/content as a path relative to it; any other path as given."""
    p = Path(path)
    if p.is_absolute() and p.is_relative_to(CONTENT_DIR):
        return str(p.relative_to(CONTENT_DIR))
    return path


def shared_run(
    *,
    run_id: str,
    run_at: datetime,
    algo: str,
    variant: str,
    benchmark: str,
    n: int | None,
    source: str | None,
    notes: str | None,
    metrics: list[tuple[str, float, float | None, float | None]],
    units: dict[str, str],
    commit: str | None,
    artifacts: list[str],
) -> dict:
    """One ledger run in the shared run-history shape (run_history.py), component = algo."""
    config = {"variant": variant, "benchmark": benchmark} | ({} if n is None else {"n": n})
    links = ([{"label": "source", "path": content_path(source)}] if source else []) + [
        {"label": "artifact", "path": content_path(a)} for a in artifacts
    ]
    return {
        "component": algo,
        "run_id": run_slug(run_id),
        "kind": KIND_BY_ALGO.get(algo, "benchmark"),
        "started_at": run_at.replace(tzinfo=LEDGER_TZ).isoformat(),
        "commit": commit,
        "dataset": benchmark,
        "config": config,
        "metrics": [
            {"name": name, "value": value, "ci_low": lo, "ci_high": hi, "unit": units.get(name)}
            for name, value, lo, hi in metrics
        ],
        "artifacts": links,
        "source": RUN_SOURCE,
        "notes": notes,
    }


def cmd_record(args: argparse.Namespace) -> None:
    metrics = [parse_metric(m) for m in args.metric]
    if not metrics:
        raise SystemExit("at least one --metric is required")
    run_at = parse_at(args.at)
    con = _connect()
    units = dict(con.execute("SELECT metric, unit FROM metric_defs").fetchall())
    run = shared_run(
        run_id=args.run_id, run_at=run_at, algo=args.algo, variant=args.variant, benchmark=args.benchmark,
        n=args.n, source=args.source, notes=args.notes, metrics=metrics, units=units,
        commit=args.commit or run_history.head_commit(), artifacts=args.artifact,
    )
    try:
        run_history.parse_run(run)
    except run_history.RunError as e:
        con.close()
        raise SystemExit(f"run history refuses this run: {e}") from e
    con.execute("BEGIN")
    con.execute("DELETE FROM metrics WHERE run_id = ?", [args.run_id])
    con.execute("DELETE FROM runs WHERE run_id = ?", [args.run_id])
    con.execute(
        "INSERT INTO runs (run_id, run_at, algo, variant, benchmark, n, source, notes)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [args.run_id, run_at, args.algo, args.variant, args.benchmark, args.n, args.source, args.notes],
    )
    for name, value, lo, hi in metrics:
        con.execute(
            "INSERT INTO metrics (run_id, metric, value, ci_low, ci_high) VALUES (?, ?, ?, ?, ?)",
            [args.run_id, name, value, lo, hi],
        )
    con.execute("COMMIT")
    known_metrics = {r[0] for r in con.execute("SELECT metric FROM metric_defs WHERE description IS NOT NULL").fetchall()}
    described = {r[0] for r in con.execute("SELECT benchmark FROM benchmark_defs WHERE description IS NOT NULL").fetchall()}
    starred = {r[0] for r in con.execute("SELECT benchmark FROM benchmark_defs WHERE primary_metric IS NOT NULL").fetchall()}
    con.close()
    path = run_history.record_run(run, run_history.RUNS_DIR, run_history.STORE)
    print(f"recorded {args.run_id}: {len(metrics)} metric(s); run file {content_path(str(path))}")
    for name, _, _, _ in metrics:
        if name not in known_metrics:
            print(f"WARNING: metric {name!r} has no annotation — run metric-set", file=sys.stderr)
    if args.benchmark not in described:
        print(f"WARNING: dataset {args.benchmark!r} has no description — run benchmark-set", file=sys.stderr)
    if args.benchmark not in starred:
        print(
            f"WARNING: dataset {args.benchmark!r} has no primary_metric — the dashboard cannot rank it;"
            " run benchmark-set --primary-metric",
            file=sys.stderr,
        )


def cmd_preset_set(args: argparse.Namespace) -> None:
    con = _connect()
    con.execute("DELETE FROM presets WHERE id = ?", [args.id])
    con.execute(
        "INSERT INTO presets (id, label, description, algo, metric, benchmarks, sort) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [args.id, args.label, args.description, args.algo, args.metric, args.benchmarks, args.sort],
    )
    con.close()
    print(f"preset {args.id} set")


def cmd_preset_rm(preset_id: str) -> None:
    con = _connect()
    con.execute("DELETE FROM presets WHERE id = ?", [preset_id])
    con.close()
    print(f"preset {preset_id} removed")


def cmd_def_upsert(table: str, key_col: str, key: str, values: dict[str, object]) -> None:
    """Write ONLY the fields that were passed; leave the rest of the row alone.

    The old DELETE+INSERT meant `benchmark-set --status archived` silently wiped
    the description someone spent an hour writing. An empty string clears a
    field to NULL, so a value can still be removed on purpose.
    """
    values = {k: (None if v == "" else v) for k, v in values.items() if v is not None}
    con = _connect()
    exists = con.execute(f"SELECT count(*) FROM {table} WHERE {key_col} = ?", [key]).fetchone()[0]  # noqa: S608
    if exists:
        if not values:
            con.close()
            raise SystemExit(f"{table}: {key} already exists and no field was given — nothing to write")
        sets = ", ".join(f"{k} = ?" for k in values)
        con.execute(f"UPDATE {table} SET {sets} WHERE {key_col} = ?", [*values.values(), key])  # noqa: S608
    else:
        cols = ", ".join([key_col, *values.keys()])
        marks = ", ".join(["?"] * (1 + len(values)))
        con.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", [key, *values.values()])  # noqa: S608
    con.close()
    print(f"{table}: {key} {'updated' if exists else 'created'} ({', '.join(values) or 'no fields'})")


def _one_of(name: str, value: str | None, allowed: tuple[str, ...]) -> str | None:
    """Reject a typo at write time — the dashboard branches on these strings."""
    if value is None or value == "":
        return value
    if value not in allowed:
        raise SystemExit(f"bad --{name} {value!r}: expected one of {', '.join(allowed)}")
    return value


def cmd_def_rm(table: str, key_col: str, key: str) -> None:
    con = _connect()
    con.execute(f"DELETE FROM {table} WHERE {key_col} = ?", [key])  # noqa: S608
    con.close()
    print(f"{table}: {key} removed")


def cmd_export() -> None:
    con = _connect_read_only()
    runs = con.execute(
        "SELECT run_id, run_at, algo, variant, benchmark, n, source, notes FROM runs ORDER BY run_at, run_id"
    ).fetchall()
    mrows = con.execute("SELECT run_id, metric, value, ci_low, ci_high FROM metrics").fetchall()
    prows = con.execute(
        "SELECT id, label, description, algo, metric, benchmarks, sort FROM presets ORDER BY sort, id"
    ).fetchall()
    mdefs = con.execute(
        "SELECT metric, description, higher_is_better, unit, pair_with FROM metric_defs"
    ).fetchall()
    bdefs = con.execute(
        "SELECT benchmark, description, source, label, primary_metric, n_rows, exposure, status, caveat, sort, task"
        " FROM benchmark_defs"
    ).fetchall()
    vdefs = con.execute(
        "SELECT variant, task, label, kind, description, status, sort FROM variant_defs"
    ).fetchall()
    con.close()
    metric_defs = {
        m[0]: {"description": m[1], "higher_is_better": m[2], "unit": m[3] or "ratio", "pair_with": m[4]}
        for m in mdefs
    }
    benchmark_defs = {
        b[0]: {
            "description": b[1],
            "source": b[2],
            "label": b[3],
            "primary_metric": b[4],
            "n_rows": b[5],
            "exposure": b[6],
            "status": b[7] or "active",
            "caveat": b[8],
            "sort": b[9] if b[9] is not None else 100,
            "task": b[10],
        }
        for b in bdefs
    }
    variant_defs = {
        v[0]: {
            "task": v[1],
            "label": v[2],
            "kind": v[3] or "research",
            "description": v[4],
            "status": v[5] or "active",
            "sort": v[6] if v[6] is not None else 100,
        }
        for v in vdefs
    }
    presets = [
        {
            "id": p[0],
            "label": p[1],
            "description": p[2],
            "algo": p[3],
            "metric": p[4],
            "benchmarks": [b.strip() for b in p[5].split(",")] if p[5] else None,
            "sort": p[6],
        }
        for p in prows
    ]
    by_run: dict[str, dict[str, Any]] = {}
    for run_id, metric, value, lo, hi in mrows:
        by_run.setdefault(run_id, {})[metric] = {"value": value, "ci_low": lo, "ci_high": hi}
    out = [
        {
            "run_id": r[0],
            "run_at": r[1].isoformat(),
            "algo": r[2],
            "variant": r[3],
            "benchmark": r[4],
            "n": r[5],
            "source": r[6],
            "notes": r[7],
            "metrics": by_run.get(r[0], {}),
        }
        for r in runs
    ]
    json.dump(
        {
            "db": str(DB_PATH),
            "runs": out,
            "presets": presets,
            "metric_defs": metric_defs,
            "benchmark_defs": benchmark_defs,
            "variant_defs": variant_defs,
        },
        sys.stdout,
        default=str,
    )


def cmd_sql(query: str) -> None:
    q = query.strip().rstrip(";")
    if not q.lower().startswith(("select", "with")):
        raise SystemExit("only SELECT / WITH queries are allowed")
    if ";" in q:
        raise SystemExit("one statement only")
    con = _connect_read_only()
    cur = con.execute(q)
    columns = [d[0] for d in cur.description]
    rows = cur.fetchall()
    con.close()
    json.dump({"columns": columns, "rows": rows}, sys.stdout, default=str)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    rec = sub.add_parser("record")
    rec.add_argument("--run-id", required=True)
    rec.add_argument(
        "--at",
        required=True,
        help="'YYYY-MM-DD[THH:MM[:SS]]' — when the measurement was taken (local); date-only = midnight",
    )
    rec.add_argument("--algo", required=True, help="algorithm family, e.g. email-finder")
    rec.add_argument("--variant", required=True, help="arm / preset / model under test")
    rec.add_argument("--benchmark", required=True, help="frame id, e.g. benchmark-500")
    rec.add_argument("--n", type=int, default=None, help="scored rows")
    rec.add_argument("--source", default=None, help="wiki page path or evidence link")
    rec.add_argument("--notes", default=None)
    rec.add_argument("--metric", action="append", default=[], help="name=value[:lo,hi]; repeatable")
    rec.add_argument("--commit", default=None, help="git sha the run measured; default: this checkout's HEAD")
    rec.add_argument("--artifact", action="append", default=[], help="path of a file the run wrote; repeatable")
    ps = sub.add_parser("preset-set")
    ps.add_argument("--id", required=True)
    ps.add_argument("--label", required=True, help="chip text, keep it short")
    ps.add_argument("--description", default=None, help="one line shown when the preset is active")
    ps.add_argument("--algo", required=True)
    ps.add_argument("--metric", required=True)
    ps.add_argument("--benchmarks", default=None, help="comma-separated frame subset; omit = all frames")
    ps.add_argument("--sort", type=int, default=100)
    pr = sub.add_parser("preset-rm")
    pr.add_argument("--id", required=True)
    ms = sub.add_parser("metric-set")
    ms.add_argument("--metric", required=True)
    ms.add_argument("--description", default=None, help="what it measures, incl. the denominator")
    ms.add_argument("--higher-is-better", dest="higher_is_better", action="store_const", const=True, default=None)
    ms.add_argument("--lower-is-better", dest="higher_is_better", action="store_const", const=False)
    ms.add_argument("--unit", default=None, help=f"one of {', '.join(UNITS)}; drives how the value is formatted")
    ms.add_argument(
        "--pair-with",
        default=None,
        help="metric that must be published beside this one; the dashboard pins it as the next column",
    )
    mr = sub.add_parser("metric-rm")
    mr.add_argument("--metric", required=True)
    bs = sub.add_parser("benchmark-set")
    bs.add_argument("--benchmark", required=True)
    bs.add_argument("--description", default=None, help="what the dataset is, how it was built, its caveats")
    bs.add_argument("--source", default=None, help="wiki page path")
    bs.add_argument("--label", default=None, help='plain words, no size: "creators with no address on their profile"')
    bs.add_argument("--primary-metric", default=None, help="the north star the leaderboard sorts by")
    bs.add_argument("--n-rows", type=int, default=None, help="the dataset's size")
    bs.add_argument("--exposure", default=None, help=f"one of {', '.join(EXPOSURES)}")
    bs.add_argument("--status", default=None, help=f"one of {', '.join(STATUSES)}")
    bs.add_argument("--caveat", default=None, help="one line shown above the leaderboard as a warning")
    bs.add_argument("--sort", type=int, default=None, help="dataset order; lowest active = the task's landing view")
    bs.add_argument("--task", default=None, help="owning algo family; set it to register a frame BEFORE it is scored")
    br = sub.add_parser("benchmark-rm")
    br.add_argument("--benchmark", required=True)
    vs = sub.add_parser("variant-set")
    vs.add_argument("--variant", required=True, help="the arm name exactly as `record --variant` writes it")
    vs.add_argument("--task", default=None)
    vs.add_argument("--label", default=None, help="display name, if the raw variant string is not readable")
    vs.add_argument("--kind", default=None, help=f"one of {', '.join(KINDS)}; product = shown by default")
    vs.add_argument("--description", default=None, help="what this arm IS, in plain words")
    vs.add_argument("--status", default=None, help=f"one of {', '.join(VARIANT_STATUSES)}")
    vs.add_argument("--sort", type=int, default=None, help="row order among products")
    vr = sub.add_parser("variant-rm")
    vr.add_argument("--variant", required=True)
    sub.add_parser("export")
    q = sub.add_parser("sql")
    q.add_argument("query")
    args = p.parse_args()
    if args.cmd == "init":
        cmd_init()
    elif args.cmd == "record":
        cmd_record(args)
    elif args.cmd == "preset-set":
        cmd_preset_set(args)
    elif args.cmd == "preset-rm":
        cmd_preset_rm(args.id)
    elif args.cmd == "metric-set":
        cmd_def_upsert(
            "metric_defs",
            "metric",
            args.metric,
            {
                "description": args.description,
                "higher_is_better": args.higher_is_better,
                "unit": _one_of("unit", args.unit, UNITS),
                "pair_with": args.pair_with,
            },
        )
    elif args.cmd == "metric-rm":
        cmd_def_rm("metric_defs", "metric", args.metric)
    elif args.cmd == "benchmark-set":
        cmd_def_upsert(
            "benchmark_defs",
            "benchmark",
            args.benchmark,
            {
                "description": args.description,
                "source": args.source,
                "label": args.label,
                "primary_metric": args.primary_metric,
                "n_rows": args.n_rows,
                "exposure": _one_of("exposure", args.exposure, EXPOSURES),
                "status": _one_of("status", args.status, STATUSES),
                "caveat": args.caveat,
                "sort": args.sort,
                "task": args.task,
            },
        )
    elif args.cmd == "variant-set":
        cmd_def_upsert(
            "variant_defs",
            "variant",
            args.variant,
            {
                "task": args.task,
                "label": args.label,
                "kind": _one_of("kind", args.kind, KINDS),
                "description": args.description,
                "status": _one_of("status", args.status, VARIANT_STATUSES),
                "sort": args.sort,
            },
        )
    elif args.cmd == "variant-rm":
        cmd_def_rm("variant_defs", "variant", args.variant)
    elif args.cmd == "benchmark-rm":
        cmd_def_rm("benchmark_defs", "benchmark", args.benchmark)
    elif args.cmd == "export":
        cmd_export()
    else:
        cmd_sql(args.query)


if __name__ == "__main__":
    main()
