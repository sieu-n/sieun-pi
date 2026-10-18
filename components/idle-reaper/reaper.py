#!/usr/bin/env python3
"""Stop idle prime-agent workers and hung `prime-agent --version` processes.

usage: python3 -B reaper.py [--dry-run] [--idle-minutes 10] [--version-minutes 2]

One run reads `prime-agent sessions --json` and the process table, then:
  1. sends SIGTERM to a daemon worker when every session on it is idle with no busy flag set
     and the newest lastActivityAt on it is older than --idle-minutes;
  2. kills a `prime-agent --version` process older than --version-minutes.
It never signals the daemon, a worker with a busy session, or a process on a tty.
Each kill adds one line to ~/.local/share/idle-reaper/reaper.log, and each run rewrites status.json there.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
STATE = Path(os.environ.get("IDLE_REAPER_STATE", HOME / ".local/share/idle-reaper"))
LOG = STATE / "reaper.log"
STATUS = STATE / "status.json"
PRIME_BIN = HOME / ".local/share/prime-agent/bin/prime-agent"
BUSY_FLAGS = ("isBashRunning", "isRunningTools", "hasRunningRlmChildren", "hasActiveHeartbeat",
              "hasRegisteredHeartbeat", "isCompacting", "isStreaming", "isSessionActive")
WORKER_MIN_AGE_S = 120  # a worker this young may sit between the turns of a new session


def now() -> datetime:
    return datetime.now(timezone.utc)


def stamp() -> str:
    return now().isoformat(timespec="seconds").replace("+00:00", "Z")


def prime_binary() -> str:
    """The current release, the way components/user-history/src/chat-skills.ts resolves it."""
    return os.path.realpath(PRIME_BIN)


def etime_seconds(text: str) -> int:
    days, _, rest = text.strip().rpartition("-")
    parts = [int(part) for part in rest.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    hours, minutes, seconds = parts
    return (int(days) if days else 0) * 86400 + hours * 3600 + minutes * 60 + seconds


def process_table() -> dict[int, dict]:
    out = subprocess.run(["/bin/ps", "-axww", "-o", "pid=,ppid=,etime=,rss=,tty=,args="],
                         capture_output=True, text=True, check=True).stdout
    table = {}
    for line in out.splitlines():
        fields = line.split(None, 5)
        if len(fields) < 6:
            continue
        pid, ppid, etime, rss, tty, args = fields
        table[int(pid)] = {"pid": int(pid), "ppid": int(ppid), "age": etime_seconds(etime),
                           "rss_kb": int(rss), "tty": tty, "args": args}
    return table


def descendants(table: dict[int, dict], pid: int) -> list[dict]:
    children: dict[int, list[int]] = {}
    for proc in table.values():
        children.setdefault(proc["ppid"], []).append(proc["pid"])
    found, stack = [], list(children.get(pid, []))
    while stack:
        child = stack.pop()
        found.append(table[child])
        stack.extend(children.get(child, []))
    return found


def tree_mb(table: dict[int, dict], pid: int) -> int:
    return round((table[pid]["rss_kb"] + sum(p["rss_kb"] for p in descendants(table, pid))) / 1024)


def is_prime(proc: dict) -> bool:
    return "/prime-agent/releases/" in proc["args"].split(" ", 1)[0] or proc["args"].split(" ", 1)[0].endswith("/prime-agent")


def find_daemon(table: dict[int, dict]) -> dict | None:
    for proc in table.values():
        if is_prime(proc) and "--mode daemon" in proc["args"] and proc["args"].rstrip().endswith("/daemon.sock"):
            return proc
    return None


def read_sessions(binary: str) -> list[dict]:
    result = subprocess.run([binary, "sessions", "--json"], capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise RuntimeError(f"prime-agent sessions --json exited {result.returncode}: {result.stderr.strip()[:300]}")
    data = json.loads(result.stdout)
    return data["sessions"] if isinstance(data, dict) else data


def parse_time(text: str | None) -> datetime | None:
    if not text:
        return None
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def session_busy(session: dict) -> str | None:
    if session.get("activity") != "idle":
        return f"activity={session.get('activity')}"
    for flag in BUSY_FLAGS:
        if session.get(flag):
            return flag
    if session.get("attachedClients"):
        return "attachedClients"
    return None


def plan(table: dict[int, dict], sessions: list[dict], idle_minutes: float, version_minutes: float) -> dict:
    daemon = find_daemon(table)
    if daemon is None:
        return {"daemon": None, "kill": [], "keep": [], "note": "no prime-agent daemon on daemon.sock"}
    by_worker: dict[int, list[dict]] = {}
    for session in sessions:
        if isinstance(session.get("workerPid"), int):
            by_worker.setdefault(session["workerPid"], []).append(session)
    cutoff = now().timestamp() - idle_minutes * 60
    kill, keep = [], []
    for proc in sorted(table.values(), key=lambda p: p["pid"]):
        if proc["ppid"] != daemon["pid"] or not is_prime(proc) or proc["tty"] not in ("??", "-"):
            continue
        args = proc["args"]
        base = {"pid": proc["pid"], "mb": tree_mb(table, proc["pid"]), "age_s": proc["age"]}
        if args.rstrip().endswith(" --version"):
            if proc["age"] > version_minutes * 60:
                kill.append({**base, "kind": "version", "sessions": [], "signal": "TERM then KILL"})
            continue
        if "--mode daemon" not in args or "/worker-" not in args:
            continue
        mine = by_worker.get(proc["pid"], [])
        names = [s.get("sessionName") or s.get("id", "?")[:8] for s in mine]
        reason = None
        if not mine:
            reason = "no session lists this worker"
        elif proc["age"] < WORKER_MIN_AGE_S:
            reason = f"worker started {proc['age']} s ago"
        else:
            for session in mine:
                busy = session_busy(session)
                if busy:
                    reason = f"{session.get('sessionName') or session.get('id', '?')[:8]} has {busy}"
                    break
        if reason is None:
            shells = [p for p in descendants(table, proc["pid"]) if "_prime_agent_gate" in p["args"]]
            if shells:
                reason = f"bash pid {shells[0]['pid']} still runs under it"
        if reason is None:
            times = [parse_time(s.get("lastActivityAt")) for s in mine]
            newest = max((t for t in times if t), default=None)
            if newest is None:
                reason = "no lastActivityAt"
            elif newest.timestamp() > cutoff:
                reason = f"last activity {round((now().timestamp() - newest.timestamp()) / 60, 1)} min ago"
        entry = {**base, "kind": "worker", "sessions": names}
        if reason is None:
            kill.append({**entry, "signal": "TERM"})
        else:
            keep.append({**entry, "reason": reason})
    return {"daemon": daemon["pid"], "kill": kill, "keep": keep}


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def log(line: str) -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    with LOG.open("a") as handle:
        handle.write(line + "\n")


def execute(binary: str, first: dict, idle_minutes: float, version_minutes: float) -> list[dict]:
    """Recheck each kill against a fresh read, then signal it."""
    table = process_table()
    fresh = plan(table, read_sessions(binary), idle_minutes, version_minutes)
    still = {item["pid"] for item in fresh["kill"]}
    done = []
    for item in first["kill"]:
        if item["pid"] not in still:
            continue
        pid = item["pid"]
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            continue
        if item["kind"] == "version":
            for _ in range(30):
                if not alive(pid):
                    break
                time.sleep(0.1)
            if alive(pid):
                os.kill(pid, signal.SIGKILL)
        names = ",".join(item["sessions"]) or "-"
        log(f"{stamp()} kill kind={item['kind']} pid={pid} mb={item['mb']} age_s={item['age_s']} sessions={names}")
        done.append(item)
    return done


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="print the plan and signal nothing")
    parser.add_argument("--idle-minutes", type=float, default=10)
    parser.add_argument("--version-minutes", type=float, default=2)
    args = parser.parse_args()
    STATE.mkdir(parents=True, exist_ok=True)
    if (STATE / "disabled").exists() and not args.dry_run:
        return 0
    binary = prime_binary()
    try:
        result = plan(process_table(), read_sessions(binary), args.idle_minutes, args.version_minutes)
        killed = [] if args.dry_run or result["daemon"] is None else execute(binary, result, args.idle_minutes, args.version_minutes)
    except Exception as error:  # one bad read must not stop the next run
        log(f"{stamp()} error {type(error).__name__}: {error}")
        print(f"error {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    report = {"at": stamp(), "dryRun": args.dry_run, "binary": binary, **result,
              "killed": [item["pid"] for item in killed], "freedMb": sum(item["mb"] for item in killed)}
    if not args.dry_run:
        tmp = STATUS.with_name("status.json.tmp")
        tmp.write_text(json.dumps(report, indent=2) + "\n")
        os.replace(tmp, STATUS)
    label = "would kill" if args.dry_run else "killed"
    for item in result["kill"]:
        if args.dry_run or item["pid"] in report["killed"]:
            print(f"{label} {item['kind']} pid={item['pid']} mb={item['mb']} age_s={item['age_s']} sessions={','.join(item['sessions']) or '-'}")
    for item in result["keep"]:
        print(f"keep worker pid={item['pid']} mb={item['mb']} because {item['reason']}")
    total = sum(item["mb"] for item in result["kill"]) if args.dry_run else report["freedMb"]
    print(f"{label} {len(result['kill']) if args.dry_run else len(killed)} processes, {total} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
