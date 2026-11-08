#!/usr/bin/env python3
"""Archive the job sessions on this box that finished and stayed idle for over 24 h, once a day.

usage: python3 -B sweep.py [--dry-run] [--limit N] [--idle-hours 24]

A job is a subagent session, or a root a chat started with rlm.create_session (`chat-jobs.json`, or a root the chat's agents list
shows). A chat thread and any other top-level session stay. A job stays when it or a session below it works, waits on a board.wake,
sits on an open board step, is one the chat lists as working or waiting, or saw activity in the last 24 h. Every other one goes
through the chat service's archive route with `by: "idle_job_end"`, which archives it with Prime's own `archive_saved_session` and
records the archive as the service's, so no reader takes it for the owner's. Nothing here deletes or moves a session file.

Each run appends one line of counts to ~/.prime/agent/session-archive/runs.jsonl and one line per archive to archived.jsonl.
A second run archives nothing new: an archived session is not live, so it is never picked again.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

AGENT = Path(os.environ.get("PRIME_AGENT_DIR", Path.home() / ".prime/agent"))
CHAT_DIRS = (AGENT / "browser-chat", AGENT / "browser-chat-pi")
ARTIFACTS = AGENT / "session-artifacts"
LOG_DIR = AGENT / "session-archive"
REASON = "idle_job_end"
OPEN_STEP = {"todo", "doing", "blocked"}
CHAT_FILES = ("chats.json", "threads.json", "archived-chats.json", "own-chats.json", "clean-room-chats.json")
# A session kept for one of these reasons keeps every session above it too, because Prime's archive of a session cancels the
# scheduled jobs and handed-off services of its whole tree (archiveSavedSession in daemon-supervisor.ts).
LIVE = {"live_job", "pending_wake", "chat_lists_live", "open_step", "idle_under_24h"}


def load(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def stamp(value) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() if isinstance(value, str) and value else 0.0


def walk(items):
    for item in items:
        yield item
        yield from walk(item.get("children") or [])


class Context:
    """What the chat service knows about chats, jobs, boards and wakes, read from its data folders and its agents route."""

    def __init__(self, chat_ids=(), job_ids=(), job_names=(), open_ids=(), open_names=(), wake_ids=(), chat_live=()):
        self.chat_ids, self.job_ids, self.job_names = set(chat_ids), set(job_ids), set(job_names)
        self.open_ids, self.open_names, self.wake_ids, self.chat_live = set(open_ids), set(open_names), set(wake_ids), set(chat_live)

    @classmethod
    def read(cls, agents: dict[str, list[dict]]) -> "Context":
        ctx = cls()
        for folder in CHAT_DIRS:
            for name in CHAT_FILES:
                ids = load(folder / name, {})
                if isinstance(ids, dict) and isinstance(ids.get("ids"), list):
                    ctx.chat_ids.update(ids["ids"])
            for key in load(folder / "chat-jobs.json", {}).get("jobs", {}):
                (ctx.job_ids if len(key) == 36 else ctx.job_names).add(key)
            for path in (folder / "boards").glob("*.json"):
                for item in walk(load(path, {}).get("plan") or []):
                    if item.get("status") not in OPEN_STEP:
                        continue
                    if item.get("sessionId"):
                        ctx.open_ids.add(str(item["sessionId"]).removeprefix("thread:"))
                    job = str(item.get("job") or "").strip()
                    if job.startswith("thread:"):
                        ctx.open_ids.add(job[7:])
                    elif job:
                        ctx.open_names.add(job)
            for path in (folder / "wakes").glob("*.json"):
                ctx.wake_ids.add(load(path, {}).get("session") or path.name[:36])
        for rows in agents.values():
            for agent in rows:
                sid = agent.get("sessionId")
                if sid and agent.get("link") == "root":
                    ctx.job_ids.add(sid)
                if sid and agent.get("state") in ("working", "waiting"):
                    ctx.chat_live.add(sid)
        return ctx


def live_signal(row: dict) -> str | None:
    """Why the daemon's row shows the session at work, or None when it sits idle with nothing pending."""
    if row.get("activity") != "idle":
        return f"activity {row.get('activity')}"
    for key in ("isStreaming", "isRunningTools", "isBashRunning", "isCompacting", "hasRunningRlmChildren", "isQuotaParked"):
        if row.get(key):
            return key
    if row.get("waitingFor") or row.get("credentialPark"):
        return "waitingFor"
    if any((row.get("queuedLanes") or {}).values()) or (row.get("unfinishedActionCount") or 0) > 0:
        return "queued"
    if row.get("taskState") in ("needs_input", "error"):
        return f"taskState {row['taskState']}"
    return None


def parents(rows: list[dict]) -> dict[str, str | None]:
    """Each session's parent id: the daemon's field, else the folder: session-artifacts/<root>/sub-a/sub-b/<id>.jsonl."""
    by_file = {row["sessionFile"]: row["sessionId"] for row in rows if row.get("sessionFile")}
    by_dir = {str(Path(f).parent): sid for f, sid in by_file.items() if Path(f).parent.name.startswith("sub-")}
    out: dict[str, str | None] = {}
    for row in rows:
        parent = row.get("parentSessionId") or by_file.get(row.get("parentSessionPath") or "")
        path = Path(row.get("sessionFile") or "")
        if not parent and str(path).startswith(str(ARTIFACTS) + "/") and path.parent.name.startswith("sub-"):
            above = path.parent.parent
            parent = by_dir.get(str(above)) if above.name.startswith("sub-") else above.name
        out[row["sessionId"]] = parent
    return out


def own_reason(row: dict, ctx: Context, now: float, idle_s: float) -> str | None:
    sid, name = row["sessionId"], (row.get("sessionName") or "").strip()
    if row.get("lifecycle") != "live":
        return "not_live"
    if sid in ctx.chat_ids:
        return "chat_thread"
    if not row.get("rlmDepth") and row.get("runtimeKind") != "subagent" and sid not in ctx.job_ids and name not in ctx.job_names:
        return "top_level_not_a_job"
    if live_signal(row):
        return "live_job"
    if sid in ctx.wake_ids:
        return "pending_wake"
    if sid in ctx.chat_live:
        return "chat_lists_live"
    if sid in ctx.open_ids or (name and name in ctx.open_names):
        return "open_step"
    if now - max(stamp(row.get("lastActivityAt")), stamp(row.get("modified"))) < idle_s:
        return "idle_under_24h"
    return None


def plan(rows: list[dict], ctx: Context, now: float, idle_s: float = 86400) -> tuple[list[dict], Counter]:
    """The rows to archive, deepest first, and the live rows kept by reason."""
    rows = [row for row in rows if row.get("sessionId")]
    reasons = {row["sessionId"]: own_reason(row, ctx, now, idle_s) for row in rows}
    above = parents(rows)
    kept_by_child: set[str] = set()
    for sid, reason in reasons.items():
        seen, at = set(), sid
        while reason in LIVE and above.get(at) and above[at] not in seen:
            at = above[at]
            seen.add(at)
            kept_by_child.add(at)
    kept: Counter = Counter()
    chosen = []
    for row in rows:
        sid = row["sessionId"]
        reason = reasons[sid] or ("live_descendant" if sid in kept_by_child else None)
        if reason is None:
            chosen.append(row)
        elif reason != "not_live":
            kept[reason] += 1
    chosen.sort(key=lambda row: -(row.get("rlmDepth") or 0))
    return chosen, kept


def daemon_rows() -> list[dict]:
    out = subprocess.run(["prime-agent", "sessions", "--all", "--json"], check=True, capture_output=True, text=True).stdout
    return json.loads(out)["sessions"]


def active(rows: list[dict]) -> dict:
    files = [row["sessionFile"] for row in rows if row.get("lifecycle") == "live" and row.get("sessionFile")]
    size = sum(os.path.getsize(f) for f in files if os.path.exists(f))
    return {"sessions": len(files), "bytes": size}


class Chat:
    """The chat service on this box, through the routes its page uses (configuration.json holds the port and write token)."""

    def __init__(self, folder: Path = CHAT_DIRS[0]):
        cfg = json.loads((folder / "configuration.json").read_text())
        self.origin = f"http://127.0.0.1:{cfg['port']}"
        self.base = f"{self.origin}/{cfg['capability']}/"
        self.token = cfg["csrfToken"]
        self.chats = load(folder / "chats.json", {}).get("ids", [])

    def call(self, route: str, body: dict | None = None) -> tuple[int, dict]:
        data = None if body is None else json.dumps(body).encode()
        headers = {"Content-Type": "application/json", "X-Chat-Token": self.token, "Origin": self.origin}
        request = urllib.request.Request(self.base + route, data=data, headers=headers, method="GET" if body is None else "POST")
        try:
            with urllib.request.urlopen(request) as answer:
                return answer.status, json.loads(answer.read() or b"{}")
        except urllib.error.HTTPError as error:
            text = error.read().decode(errors="replace")
            try:
                return error.code, json.loads(text)
            except json.JSONDecodeError:
                return error.code, {"error": text[:300]}

    def agents(self) -> dict[str, list[dict]]:
        out = {}
        for chat in self.chats:
            status, body = self.call(f"api/threads/{chat}/agents")
            if status == 200:
                out[chat] = body.get("agents") or []
        return out

    def archive(self, sid: str) -> tuple[int, dict]:
        return self.call(f"api/threads/{sid}/archive", {"by": REASON})


def append(name: str, record: dict) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOG_DIR / name, "a") as out:
        out.write(json.dumps(record) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="count and list, archive nothing")
    parser.add_argument("--limit", type=int, default=0, help="archive at most N sessions (0: all)")
    parser.add_argument("--idle-hours", type=float, default=24)
    args = parser.parse_args(argv)
    started = time.time()
    chat = Chat()
    rows = daemon_rows()
    before = active(rows)
    chosen, kept = plan(rows, Context.read(chat.agents()), started, args.idle_hours * 3600)
    if args.limit:
        chosen = chosen[: args.limit]
    run = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "dryRun": args.dry_run, "before": before,
           "candidates": len(chosen), "kept": dict(sorted(kept.items()))}
    print(f"session-archive: {before['sessions']} live sessions, {before['bytes'] / 1e9:.2f} GB; {len(chosen)} to archive; kept {run['kept']}", flush=True)
    archived, failed = 0, Counter()
    if not args.dry_run:
        for row in chosen:
            status, body = chat.archive(row["sessionId"])
            ok = status == 200
            archived += ok
            if not ok:
                failed[str(status)] += 1
            append("archived.jsonl", {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "session": row["sessionId"],
                                      "name": row.get("sessionName"), "depth": row.get("rlmDepth"), "status": status,
                                      **({"notice": body["notice"]} if body.get("notice") else {}),
                                      **({} if ok else {"error": str(body.get("error"))[:300]})})
        rows = daemon_rows()
    run.update(archived=archived, failed=dict(failed), after=active(rows), seconds=round(time.time() - started))
    append("runs.jsonl", run)
    print(f"session-archive: archived {archived}, failed {dict(failed)}; {run['after']['sessions']} live sessions, "
          f"{run['after']['bytes'] / 1e9:.2f} GB after; {run['seconds']} s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
