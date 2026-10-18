"""Fleet health for prime-agent sessions.

One pass that classifies every live session, unwedges what is stuck, and converges.
Encodes the four misclassifications paid for in the 2026-08-26 resume audit.

    await fleet_health()                    # classify + fix, report changes
    await fleet_health(fix=False)           # classify only
    await fleet_health(session_ids=[...])   # scope to specific sessions
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import socket
import subprocess
import time
import uuid
from typing import Any

FOLLOW_COMMANDS = (
    "dev:logs", "dev-servers.mjs logs", "docker logs -f",
    "tail -f", "journalctl -f", "logs --follow",
)
SESSIONS_DIR = os.path.expanduser("~/.prime/agent/sessions")
ARTIFACTS_DIR = os.path.expanduser("~/.prime/agent/session-artifacts")


def _run(cmd: list[str], timeout: int = 120) -> tuple[int, str]:
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    out = "\n".join(
        l for l in (p.stdout + p.stderr).splitlines()
        if "Warning" not in l and "trace-warnings" not in l
    )
    return p.returncode, out


def list_sessions() -> dict[str, dict]:
    """Enumerate with --all. Plain `list` omits daemon-evicted sessions and
    produces false PARKED verdicts on finished work."""
    _, out = _run(["prime-agent", "list", "--all", "--json"])
    return {s["sessionId"]: s for s in json.loads(out)["sessions"]}


def _load(session_file: str) -> list[dict]:
    with open(session_file, errors="ignore") as fh:
        return [json.loads(l) for l in fh if l.strip()]


def _text(msg: dict) -> str:
    content = msg.get("content") or []
    if not isinstance(content, list):
        return str(content)
    return " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")


def _tool_args(msg: dict) -> str:
    out = []
    for b in msg.get("content") or []:
        if isinstance(b, dict) and b.get("type") in ("toolCall", "tool_use"):
            out.append(json.dumps(b.get("arguments") or b.get("input")))
    return "\n".join(out)


def read_progress(session_file: str) -> dict:
    """Last assistant message is the only proof of progress. Message counts are
    restore bookkeeping and inflate without any model output."""
    records = _load(session_file)
    messages = [r for r in records if r.get("type") == "message"]
    assistants = [m for m in messages if m["message"].get("role") == "assistant"]
    results = [m for m in messages if m["message"].get("role") == "toolResult"]
    last = assistants[-1]["message"] if assistants else {}
    stamp = assistants[-1].get("timestamp") if assistants else None
    age = None
    if stamp:
        when = _dt.datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%S.%fZ")
        age = round((_dt.datetime.utcnow() - when).total_seconds() / 60, 1)
    return {
        "model": last.get("model"),
        "stop": last.get("stopReason"),
        "error": last.get("errorMessage"),
        "at": stamp,
        "age_min": age,
        "has_content": bool(last.get("content")),
        "killed_tool": bool(results) and "Request was aborted" in _text(results[-1]["message"])[:60],
        "tool_args": _tool_args(last),
    }


def subtree(session_id: str, sessions: dict[str, dict]) -> list[dict]:
    found, stack = [], [session_id]
    while stack:
        parent = stack.pop()
        for s in sessions.values():
            if (s.get("parentSessionId") or s.get("parentId")) == parent:
                found.append(s)
                stack.append(s["sessionId"])
    return found


def classify(session_id: str, sessions: dict[str, dict], idle_threshold_min: float = 12) -> dict:
    s = sessions.get(session_id)
    if s is None:
        return {"session": session_id, "verdict": "GONE",
                "detail": "absent even from `list --all`; report, do not resume blind"}
    p = read_progress(s["sessionFile"])
    verdict, detail = "MOVING", ""
    if (p["age_min"] or 0) > idle_threshold_min:
        if p["stop"] == "stop" and s.get("activity") == "idle":
            verdict, detail = "DONE", "completion report written, waiting on the user"
        elif s.get("isRunningTools"):
            hits = [c for c in FOLLOW_COMMANDS if c in p["tool_args"]]
            if hits:
                verdict, detail = "WEDGED", f"follow command never returns: {', '.join(hits)}"
            elif "timeout" not in p["tool_args"]:
                verdict, detail = "SUSPECT", "shell call with no timeout"
            else:
                verdict, detail = "BUSY", "bounded commands in flight"
        elif s.get("hasRunningRlmChildren"):
            kids = subtree(session_id, sessions)
            live = [k for k in kids if k["isStreaming"] or k["isRunningTools"]]
            if live:
                verdict = "BUSY"
                detail = f"waiting on a live subtree, {len(live)}/{len(kids)} descendants working"
            else:
                verdict = "DEADLOCK"
                detail = f"all {len(kids)} descendants idle; a child ended its turn without messaging its parent"
        elif s.get("isStreaming"):
            verdict, detail = "BUSY", "streaming"
        elif s.get("activity") != "idle":
            verdict, detail = "PARKED", "no turn, no tools, no children"
        else:
            verdict, detail = "DONE", "idle"
    if p["stop"] in ("error", "aborted"):
        verdict, detail = "FAULT", f"last turn ended {p['stop']}: {p['error']}"
    return {"session": session_id, "short": s["id"], "verdict": verdict, "detail": detail,
            "model": p["model"], "age_min": p["age_min"], "stop": p["stop"],
            "killed_tool": p["killed_tool"], "activity": s.get("activity"),
            "session_file": s["sessionFile"]}


class DaemonClient:
    """Protocol-7 JSONL client. Unwedge in place; never stop the worker."""

    def __init__(self, socket_path: str | None = None, timeout: int = 60):
        self.path = socket_path or self._discover()
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(timeout)
        self.sock.connect(self.path)
        self.buf = b""
        self.client_id = "fleet-" + uuid.uuid4().hex[:10]
        self._readline()

    @staticmethod
    def _discover() -> str:
        _, out = _run(["prime-agent", "status"])
        for line in out.splitlines():
            for token in line.split():
                if token.endswith("daemon.sock"):
                    return token
        raise RuntimeError("no daemon socket found in `prime-agent status`")

    def _readline(self, timeout: int = 60) -> dict:
        self.sock.settimeout(timeout)
        start = time.time()
        while b"\n" not in self.buf:
            if time.time() - start > timeout:
                raise TimeoutError("daemon sent no line")
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError("daemon closed the socket")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return json.loads(line.decode())

    def request(self, command: dict, timeout: int = 60) -> dict:
        rid = uuid.uuid4().hex[:12]
        envelope = {"type": "command", "id": rid,
                    "protocol": {"name": "prime-agent.daemon", "version": 7},
                    "clientId": self.client_id, "command": command}
        self.sock.sendall((json.dumps(envelope) + "\n").encode())
        start = time.time()
        while time.time() - start < timeout:
            msg = self._readline(timeout=timeout)
            if msg.get("id") == rid and msg.get("type") == "response":
                return msg
        raise TimeoutError(command["type"])

    def attach(self, active_id: str) -> dict:
        return self.request({"type": "attach", "activeSessionId": active_id,
                             "clientId": self.client_id, "supportsExtensionUi": False,
                             "capabilities": ["slim_attach", "event_sequence"]})

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


def unwedge(active_id: str, session_id: str, reason: str) -> dict:
    """abort -> resume_queue -> send. requestAbort leaves the input pump
    suspended, so resume_queue is mandatory before any message is admitted."""
    client = DaemonClient()
    try:
        client.attach(active_id)
        client.request({"type": "abort", "activeSessionId": active_id})
        time.sleep(2)
        client.request({"type": "resume_queue", "activeSessionId": active_id})
    finally:
        client.close()
    code, out = _run(["prime-agent", "send", session_id, reason, "--json"], timeout=180)
    return {"aborted": True, "send_rc": code, "send": out[:200]}


def set_model(active_id: str, model_id: str, provider: str = "anthropic") -> dict:
    """Flip a live session's model without restarting it. Abort only when the
    model actually changed, so a rerun is a no-op instead of killing live work."""
    client = DaemonClient()
    try:
        attached = client.attach(active_id)
        state = (attached["data"]["snapshot"].get("state") or {})
        before = (state.get("model") or {}).get("id")
        reply = client.request({"type": "set_model", "activeSessionId": active_id,
                                "provider": provider, "modelId": model_id})
        if not reply.get("success"):
            return {"ok": False, "error": str(reply.get("error"))[:200]}
        if before != model_id and state.get("isStreaming"):
            client.request({"type": "abort", "activeSessionId": active_id})
            time.sleep(2)
        client.request({"type": "resume_queue", "activeSessionId": active_id})
        after = client.request({"type": "get_state", "activeSessionId": active_id})["data"]
        return {"ok": True, "was": before, "now": (after.get("model") or {}).get("id")}
    finally:
        client.close()


def monitor_health(session_id: str) -> list[dict]:
    """A perpetual heartbeat is healthy when its run timestamps advance. runCount
    is the wrong signal: follow_up jobs skip while their session is busy."""
    path = os.path.join(ARTIFACTS_DIR, session_id, "scheduled-jobs.json")
    if not os.path.exists(path):
        return []
    with open(path) as fh:
        jobs = json.load(fh).get("jobs", [])
    return [{"label": j["label"], "status": j["status"], "runs": j.get("runCount"),
             "last": j.get("lastRunAt"), "skipped": j.get("lastSkippedAt"),
             "next": j.get("nextRunAt"), "error": j.get("lastError")}
            for j in jobs if j["status"] == "active"]


UNWEDGE_NOTE = (
    "[unwedged] Your turn was stuck and I aborted it. You did not fail.\n\n"
    "Cause: {cause}\n\n"
    "Rules for the rest of your run:\n"
    "- Never run a follow or stream command (pnpm dev:logs, docker logs -f, tail -f, journalctl -f).\n"
    "- Give every shell call an explicit numeric timeout. curl always needs --max-time.\n"
    "- To read logs, read the log FILE instead of following it.\n\n"
    "Re-check real state before trusting your last step, then continue."
)
RESUME_NOTE = (
    "[resume] Your turn was killed mid-flight {mins} minutes ago and never restarted. "
    "The machine slept and the daemon recovered your worker without replaying uncertain operations, "
    "so your last tool call may or may not have landed. This was not a user stop and not a failure of your work.\n\n"
    "1. Do not trust your last step. Re-check real state first (git log/status, files, services, deploys).\n"
    "2. If the user's last request is still unanswered, answer it.\n"
    "3. Finish the task, then commit your own work.\n"
    "If it was already finished, say so in one or two lines and stop."
)
NUDGE_NOTE = (
    "[nudge] Your session has no running turn, no tools and no live children, but it is not idle. "
    "Re-check real state (git log/status, files, services), then either continue your task or "
    "say plainly that it is finished."
)


async def fleet_health(session_ids: list[str] | None = None, idle_threshold_min: float = 12,
                       fix: bool = True, streak_path: str = "/tmp/resume-audit-streak.json",
                       monitors: list[str] | None = None) -> dict:
    sessions = list_sessions()
    targets = session_ids or [s["sessionId"] for s in sessions.values()
                              if s.get("lifecycle") == "live" and s.get("messageCount")]
    resolved = []
    for t in targets:
        if t in sessions:
            resolved.append(t)
            continue
        match = [s["sessionId"] for s in sessions.values() if s["id"] == t or s["sessionId"].startswith(t)]
        resolved.append(match[0] if match else t)

    report = [classify(sid, sessions, idle_threshold_min) for sid in resolved]
    actions = []
    if fix:
        for row in report:
            if row["verdict"] == "WEDGED":
                s = sessions[row["session"]]
                actions.append({"session": row["short"], "did": "unwedge",
                                **unwedge(s["id"], row["session"],
                                          UNWEDGE_NOTE.format(cause=row["detail"]))})
            elif row["verdict"] == "PARKED":
                code, out = _run(["prime-agent", "send", row["session"], NUDGE_NOTE, "--json"], timeout=180)
                actions.append({"session": row["short"], "did": "nudge", "rc": code})
            elif row["verdict"] == "FAULT" and row["stop"] == "aborted":
                s = sessions[row["session"]]
                note = RESUME_NOTE.format(mins=int(row["age_min"] or 0))
                if s.get("activity") == "working":
                    actions.append({"session": row["short"], "did": "clear phantom turn + resume",
                                    **unwedge(s["id"], row["session"], note)})
                else:
                    code, _ = _run(["prime-agent", "send", row["session"], note, "--json"], timeout=180)
                    actions.append({"session": row["short"], "did": "resume", "rc": code})
            elif row["verdict"] == "DEADLOCK":
                actions.append({"session": row["short"], "did": "report only",
                                "note": "nudge the deepest finished child to message its parent"})

    monitors = monitors or []
    faults = [r for r in report if r["verdict"] in ("WEDGED", "PARKED", "DEADLOCK", "FAULT", "GONE")]
    clean = not faults
    streak = 0
    if streak_path:
        state = {}
        if os.path.exists(streak_path):
            with open(streak_path) as fh:
                state = json.load(fh)
        streak = state.get("checks_clean", 0) + 1 if clean else 0
        state.update({"checks_clean": streak, "at": _dt.datetime.utcnow().isoformat()})
        with open(streak_path, "w") as fh:
            json.dump(state, fh)

    return {
        "checked": len(report),
        "by_verdict": {v: [r["short"] for r in report if r["verdict"] == v]
                       for v in sorted({r["verdict"] for r in report})},
        "faults": faults,
        "actions": actions,
        "monitors": {m: monitor_health(m) for m in monitors},
        "clean": clean,
        "streak": streak,
        "steady_state": streak >= 3,
        "report": report,
    }
