"""One run history for every experiment component, read by the wiki.

Each run is one JSON file at content/experiments/runs/<component>/<run_id>.json. The file is the record:
git tracks it, wiki-box-commit commits it on the wiki host, and the origin remote is its backup.
content/.wiki/run-history.duckdb is built from those files and is never written any other way, so
deleting it loses nothing. Each build writes a new file and renames it over the old one, so a reader
never meets a lock or a half-written store.

Run from apps/llm-wiki:
  uv run --no-project --with duckdb python scripts/run_history.py record < run.json
  uv run --no-project --with duckdb python scripts/run_history.py build
  uv run --no-project --with duckdb python scripts/run_history.py export [--component email-finder]

A Python writer imports record_run(run) instead.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

# The wiki engine passes its content root in WIKI_CONTENT_ROOT; without it the content sits beside scripts/.
WIKI_DIR = Path(os.environ.get("WIKI_CONTENT_ROOT") or Path(__file__).resolve().parent.parent / "content").parent
CONTENT = Path(os.environ.get("WIKI_CONTENT_ROOT") or WIKI_DIR / "content")
RUNS_DIR = CONTENT / "experiments" / "runs"
STORE = CONTENT / ".wiki" / "run-history.duckdb"

SLUG = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
KINDS = ("eval", "benchmark", "load-test", "probe", "arm")
FIELDS = (
    "component", "run_id", "kind", "started_at", "ended_at", "commit", "model", "prompt_hash",
    "dataset", "config", "config_hash", "metrics", "artifacts", "source", "notes", "recorded_at",
)

SCHEMA = """
-- Every time column holds UTC.
CREATE TABLE runs (
  component TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP,
  commit TEXT,
  model TEXT,
  prompt_hash TEXT,
  dataset TEXT,
  config JSON,
  config_hash TEXT NOT NULL,
  artifacts JSON,
  source TEXT NOT NULL,
  notes TEXT,
  recorded_at TIMESTAMP NOT NULL,
  PRIMARY KEY (component, run_id)
);
CREATE TABLE metrics (
  component TEXT NOT NULL,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value DOUBLE,
  ci_low DOUBLE,
  ci_high DOUBLE,
  unit TEXT,
  PRIMARY KEY (component, run_id, name)
);
"""


class RunError(ValueError):
    pass


def config_hash(config: dict) -> str:
    canon = json.dumps(config, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canon.encode()).hexdigest()[:16]


def utc_iso(value: str | None, field: str) -> str | None:
    if value is None:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError as e:
        raise RunError(f"{field} is not an ISO time: {value!r}") from e
    if parsed.tzinfo is None:
        raise RunError(f"{field} has no time zone: {value!r}")
    return parsed.astimezone(dt.UTC).isoformat().replace("+00:00", "Z")


def parse_metric(m: dict, run: str) -> dict:
    if not isinstance(m, dict) or not isinstance(m.get("name"), str) or not m["name"]:
        raise RunError(f"{run}: every metric needs a name")
    out = {"name": m["name"], "unit": m.get("unit")}
    for key in ("value", "ci_low", "ci_high"):
        v = m.get(key)
        if v is not None and not isinstance(v, (int, float)):
            raise RunError(f"{run}: metric {m['name']} {key} is not a number")
        out[key] = None if v is None else float(v)
    return out


def parse_run(raw: dict) -> dict:
    """Checks one run and returns it in the stored shape. Raises RunError on a bad run."""
    if not isinstance(raw, dict):
        raise RunError("a run is a JSON object")
    unknown = set(raw) - set(FIELDS)
    if unknown:
        raise RunError(f"unknown fields: {sorted(unknown)}")
    for key in ("component", "run_id"):
        if not isinstance(raw.get(key), str) or not SLUG.match(raw[key]):
            raise RunError(f"{key} must match {SLUG.pattern}: {raw.get(key)!r}")
    name = f"{raw['component']}/{raw['run_id']}"
    if raw.get("kind") not in KINDS:
        raise RunError(f"{name}: kind must be one of {KINDS}")
    if not isinstance(raw.get("source"), str) or not raw["source"]:
        raise RunError(f"{name}: source names the script or route that made the run")
    config = raw.get("config") or {}
    if not isinstance(config, dict):
        raise RunError(f"{name}: config is an object")
    metrics = [parse_metric(m, name) for m in raw.get("metrics") or []]
    names = [m["name"] for m in metrics]
    if len(names) != len(set(names)):
        raise RunError(f"{name}: metric names repeat")
    artifacts = raw.get("artifacts") or []
    if not all(isinstance(a, dict) and isinstance(a.get("path"), str) for a in artifacts):
        raise RunError(f"{name}: every artifact is an object with a path")
    started = utc_iso(raw.get("started_at"), "started_at")
    if started is None:
        raise RunError(f"{name}: started_at is required")
    now = dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z")
    run = {
        "component": raw["component"],
        "run_id": raw["run_id"],
        "kind": raw["kind"],
        "started_at": started,
        "ended_at": utc_iso(raw.get("ended_at"), "ended_at"),
        "commit": raw.get("commit"),
        "model": raw.get("model"),
        "prompt_hash": raw.get("prompt_hash"),
        "dataset": raw.get("dataset"),
        "config": config,
        "config_hash": config_hash(config),
        "metrics": metrics,
        "artifacts": artifacts,
        "source": raw["source"],
        "notes": raw.get("notes"),
        "recorded_at": utc_iso(raw.get("recorded_at"), "recorded_at") or now,
    }
    if raw.get("config_hash") not in (None, run["config_hash"]):
        raise RunError(f"{name}: config_hash does not match config")
    return run


def naive(iso: str | None) -> str | None:
    """A stored UTC ISO time without its Z, for a TIMESTAMP column."""
    return None if iso is None else iso.removesuffix("Z")


def run_path(run: dict, runs_dir: Path = RUNS_DIR) -> Path:
    return runs_dir / run["component"] / f"{run['run_id']}.json"


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def head_commit() -> str | None:
    out = subprocess.run(["git", "rev-parse", "HEAD"], cwd=WIKI_DIR, capture_output=True, text=True, check=False)
    return out.stdout.strip() or None


def write_run(raw: dict, runs_dir: Path = RUNS_DIR) -> Path:
    """Writes one run file. A second write of the same component and run_id replaces it."""
    run = parse_run(raw)
    path = run_path(run, runs_dir)
    write_atomic(path, json.dumps(run, indent=1, ensure_ascii=False) + "\n")
    return path


def load_runs(runs_dir: Path = RUNS_DIR) -> list[dict]:
    return [parse_run(json.loads(p.read_text())) for p in sorted(runs_dir.glob("*/*.json"))]


def build(runs_dir: Path = RUNS_DIR, store: Path = STORE) -> int:
    """Builds the store from every run file into a new file, then renames it over the old store."""
    import duckdb

    runs = load_runs(runs_dir)
    store.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=store.parent, prefix=f".{store.name}.", suffix=".tmp")
    os.close(fd)
    os.unlink(tmp)
    con = duckdb.connect(tmp)
    try:
        con.execute(SCHEMA)
        if runs:
            con.executemany(
                "INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [
                    (r["component"], r["run_id"], r["kind"], naive(r["started_at"]), naive(r["ended_at"]), r["commit"],
                     r["model"], r["prompt_hash"], r["dataset"], json.dumps(r["config"]), r["config_hash"],
                     json.dumps(r["artifacts"]), r["source"], r["notes"], naive(r["recorded_at"]))
                    for r in runs
                ],
            )
        rows = [
            (r["component"], r["run_id"], m["name"], m["value"], m["ci_low"], m["ci_high"], m["unit"])
            for r in runs for m in r["metrics"]
        ]
        if rows:
            con.executemany("INSERT INTO metrics VALUES (?,?,?,?,?,?,?)", rows)
    finally:
        con.close()
    os.replace(tmp, store)
    return len(runs)


def record_run(raw: dict, runs_dir: Path = RUNS_DIR, store: Path = STORE) -> Path:
    """Writes one run and rebuilds the store. The commit defaults to this checkout's HEAD."""
    if "commit" not in raw:
        raw = {**raw, "commit": head_commit()}
    path = write_run(raw, runs_dir)
    build(runs_dir, store)
    return path


def export(component: str | None, store: Path = STORE) -> dict:
    import duckdb

    if not store.exists():
        build(store=store)
    con = duckdb.connect(str(store), read_only=True)
    try:
        where, args = ("WHERE component = ?", [component]) if component else ("", [])
        cols = ["component", "run_id", "kind", "started_at", "ended_at", "commit", "model", "prompt_hash", "dataset",
                "config", "config_hash", "artifacts", "source", "notes"]
        runs = con.execute(
            f"SELECT {', '.join(cols)} FROM runs {where} ORDER BY started_at", args
        ).fetchall()
        metrics = con.execute(
            f"SELECT component, run_id, name, value, ci_low, ci_high, unit FROM metrics {where}", args
        ).fetchall()
    finally:
        con.close()
    by_run: dict[tuple[str, str], list[dict]] = {}
    for c, rid, n, v, lo, hi, u in metrics:
        by_run.setdefault((c, rid), []).append({"name": n, "value": v, "ci_low": lo, "ci_high": hi, "unit": u})
    out = []
    for row in runs:
        r = dict(zip(cols, row, strict=True))
        for key in ("started_at", "ended_at"):
            if r[key] is not None:
                r[key] = r[key].isoformat() + "Z"
        r["config"] = json.loads(r["config"]) if r["config"] else {}
        r["artifacts"] = json.loads(r["artifacts"]) if r["artifacts"] else []
        r["metrics"] = by_run.get((r["component"], r["run_id"]), [])
        out.append(r)
    return {"runs": out}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("record", help="read one run as JSON on stdin, write its file and rebuild the store")
    sub.add_parser("build", help="rebuild the store from every run file")
    ex = sub.add_parser("export", help="print runs and metrics as JSON")
    ex.add_argument("--component")
    args = ap.parse_args()
    try:
        if args.cmd == "record":
            path = record_run(json.load(sys.stdin))
            print(json.dumps({"path": str(path.relative_to(WIKI_DIR))}))
        elif args.cmd == "build":
            print(json.dumps({"runs": build()}))
        else:
            print(json.dumps(export(args.component)))
    except RunError as e:
        print(f"run_history: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
