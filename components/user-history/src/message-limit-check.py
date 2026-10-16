"""The wrapper around agent_message.send in the Python kernel of a chat or a job of a chat, installed by message-limit-check.ts.

agent_message.send reaches the host through rlm.host_request. This wraps host_request in rlm and in the agent_message module, which imported
its own reference. It does three things.

1. The c47 hold check. Before an "agent_message.send" request goes out, message-limit-check.ts checks a message to a job (receiver_role
   "child"): one that holds the job for another thread's go or word raises LimitRefused, and nothing is sent (steer-wait.ts). A failure to
   run the check lets the message through, like the send guard, so a broken check never cuts a chat off from its jobs.
2. A daemon timeout on a send is no failure (p334). The supervisor gives the target's worker 30 s to confirm (WORKER_REQUEST_TIMEOUT_MS in
   prime-agent 0.9.8) and raises when a busy worker answers later, but the worker still queues the message. On 10-12 the two sends that timed
   out at 17:08Z reached Crawler VP at 17:16:20Z and frontend bro at 17:10:13Z, when their running ipython calls (758 s and 459 s) ended. The
   senders read the error as a failure and sent again, so frontend bro got one ask 7 times. The wrapper returns an "unconfirmed" receipt
   instead and prints that a resend arrives as a second copy.
3. The brief record. When an "rlm.run" (rlm.spawn) or "rlm.create_session" request returns, it writes the brief with the new child's or
   root's ids to DATA_DIR/spawn-briefs/, where the chat service's brief keeper (src/brief-keeper.ts) sends it again if the session never gets
   its first prompt after a supervisor restart. Prime holds a new session's state in its worker's memory and writes the file late: at 23:43
   to 00:04Z on 10-15/16 ten children showed no first prompt for 17 to 37 min and the supervisor restart at 00:20:13Z dropped them. The
   record names the daemon that took the spawn, so the keeper knows when that copy is gone. The request itself goes out as
   it came, at once, and a failed write never fails the spawn.
"""

import json
import os
import re
import subprocess
import sys
import time

CHECK = os.path.join(os.path.dirname(os.path.realpath(__file__)), "message-limit-check.ts")
VERSION = 9
BRIEFS = "spawn-briefs"
SAFE_ID = re.compile(r"^[\w-]{1,128}$")
SEND_TIMEOUT = 'waiting for the Prime Agent daemon response to "send_message"'
UNCONFIRMED_NOTE = (
    "agent_message: Prime Agent did not confirm this send within 30 s because {target} is busy. The daemon still holds it and delivers it "
    "when {target}'s running tool call ends (on 10-12 two such sends landed 2 and 8 minutes later). Do not send it again: a resend arrives "
    "as a second copy. To check, read {target}'s transcript after its current tool call."
)


class LimitRefused(Exception):
    """An agent message that holds a job for another thread's go (c47)."""


def refusal(text: str, role=None):
    try:
        proc = subprocess.run(["node", CHECK], input=json.dumps({"message": text, "dataDir": globals().get("DATA_DIR"), "role": role}), capture_output=True, text=True)
        return json.loads(proc.stdout.strip().splitlines()[-1]).get("refusal")
    except (OSError, subprocess.SubprocessError, ValueError, IndexError, AttributeError):
        return None


def unconfirmed(payload: dict, error: Exception) -> dict:
    target = payload.get("receiver_name") or payload.get("receiver_role") or "the target"
    note = UNCONFIRMED_NOTE.format(target=target)
    print(note)
    return {
        "deliveryStatus": "unconfirmed",
        "message": payload.get("message"),
        "receiverRole": payload.get("receiver_role"),
        "receiverName": payload.get("receiver_name"),
        "error": str(error),
        "note": note,
    }


def tree_root(path):
    """The root session id in a session-artifacts path (.../session-artifacts/<root>/sub-...), or None."""
    parts = str(path or "").split(os.sep)
    return next((parts[i + 1] for i, part in enumerate(parts[:-1]) if part == "session-artifacts"), None)


def daemon_epoch():
    """The supervisor socket's inode and birth time in ms, as the chat service's socketEpoch reads them, or None."""
    try:
        info = os.stat(os.environ["PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET"])
        return f"{info.st_ino}:{round(info.st_birthtime * 1000)}"
    except (KeyError, OSError, AttributeError):
        return None


def record_brief(request_type, payload, reply):
    data_dir = globals().get("DATA_DIR")
    if not isinstance(data_dir, str) or not isinstance(reply, dict) or not isinstance(payload.get("prompt"), str):
        return
    kw = payload.get("kwargs") if isinstance(payload.get("kwargs"), dict) else {}
    if request_type == "rlm.run":
        kind, ident, root, where = "child", reply.get("rlm_child_id"), tree_root(reply.get("session_dir")), {"sessionDir": reply.get("session_dir")}
    else:
        kind, ident, where = "root", reply.get("session_id"), {"sessionFile": reply.get("session_file")}
        root = ident
    if not all(isinstance(value, str) and SAFE_ID.match(value) for value in (ident, root)):
        return
    record = {"kind": kind, "id": ident, "name": kw.get("name") or reply.get("name") or "", "prompt": payload["prompt"], "root": root,
              "at": int(time.time() * 1000), **{key: str(value) for key, value in where.items() if value}}
    daemon = daemon_epoch()
    if daemon:
        record["daemon"] = daemon
    folder = os.path.join(data_dir, BRIEFS)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    path = os.path.join(folder, f"{kind}-{ident}.json")
    with open(path + ".tmp", "w") as f:
        json.dump(record, f)
    os.replace(path + ".tmp", path)


async def request(request_type, payload=None, *args, **kwargs):
    send = request_type == "agent_message.send" and isinstance(payload, dict)
    if send:
        text = payload.get("message")
        reason = refusal(text, payload.get("receiver_role")) if isinstance(text, str) else None
        if reason:
            raise LimitRefused(reason)
    # Look the real function up in the live rlm module at call time. A kernel revive restores this function with a copy of host_request
    # whose globals lost __package__, so its `from . import repl` fails (launch VP, 2026-10-13).
    real = getattr(sys.modules.get("rlm"), "unchecked_host_request", None)
    try:
        reply = await real(request_type, payload, *args, **kwargs)
        if request_type in ("rlm.run", "rlm.create_session") and isinstance(payload, dict):
            try:
                record_brief(request_type, payload, reply)
            except Exception as error:
                print(f"user-history: the brief of this start was not recorded: {error}", file=sys.stderr)
        return reply
    except Exception as error:
        if send and payload.get("target") != "all" and SEND_TIMEOUT in str(error):
            return unconfirmed(payload, error)
        raise


request.limit_checked = True


def install() -> None:
    try:
        import rlm
    except ImportError:
        return
    if not getattr(rlm.host_request, "limit_checked", False):
        rlm.unchecked_host_request = rlm.host_request
    request.__doc__ = rlm.unchecked_host_request.__doc__
    for name in ("rlm", "agent_message"):
        module = sys.modules.get(name)
        if module is None:
            try:
                module = __import__(name)
            except ImportError:
                continue
        if getattr(module, "host_request", None) is not None:
            module.host_request = request


if getattr(sys, "user_history_message_check", None) != VERSION:
    install()
    sys.user_history_message_check = VERSION
