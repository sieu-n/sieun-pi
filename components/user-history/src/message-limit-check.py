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
   instead and remembers the send. A later send of the same text to the same agent looks for the first copy first (src/send-once.ts): when it
   landed in the target's session file the wrapper returns a "delivered" receipt and sends nothing, when the target still has messages
   queued, is busy or the roster does not answer it returns "unconfirmed" again and sends nothing, and only when the target is idle and the
   copy is in neither place does it go out.
   On 10-16 the 5180 SSR hang fix job sent one report 4 times between 05:03 and 05:44Z, each after a timeout.
3. The brief record. When an "rlm.run" (rlm.spawn) or "rlm.create_session" request returns, it writes the brief with the new child's or
   root's ids to DATA_DIR/spawn-briefs/, where the chat service's brief keeper (src/brief-keeper.ts) sends it again if the session never gets
   its first prompt. Prime holds a new session's state in its worker's memory and writes the file late: at 23:43 to 00:04Z on 10-15/16 ten
   children showed no first prompt for 17 to 37 min and the supervisor restart at 00:20:13Z dropped them. The request itself goes out as
   it came, at once, and a failed write never fails the spawn.
"""

import json
import os
import re
import subprocess
import sys
import time

CHECK = os.path.join(os.path.dirname(os.path.realpath(__file__)), "message-limit-check.ts")
SEND_ONCE = os.path.join(os.path.dirname(os.path.realpath(__file__)), "send-once.ts")
VERSION = 13
BRIEFS = "spawn-briefs"
SAFE_ID = re.compile(r"^[\w-]{1,128}$")
SEND_TIMEOUT = 'waiting for the Prime Agent daemon response to "send_message"'
UNCONFIRMED_NOTE = (
    "agent_message: Prime Agent did not confirm this send within 30 s because {target} is busy. The daemon still holds it and delivers it "
    "when {target}'s running tool call ends (on 10-12 two such sends landed 2 and 8 minutes later). Do not send it again: a resend arrives "
    "as a second copy. If you send the same text again, this wrapper first looks for the first copy and sends only when it is gone."
)
HELD_NOTE = (
    "agent_message: not sent again. The send of this text to {target} that timed out at {since} {where}, and a second send would arrive as a "
    "second copy."
)
# (receiver_role, receiver_name, key) -> {"since": epoch s, "texts": [...]} for each send the daemon timed out on.
UNCONFIRMED = {}
ISO = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z")


def data_dir():
    """The chat server's directory the latest cell's prelude named (None outside the chats), else the one this file was installed with."""
    return getattr(sys, "user_history_data_dir", globals().get("DATA_DIR"))


class LimitRefused(Exception):
    """An agent message that holds a job for another thread's go (c47)."""


def refusal(text: str, role=None):
    try:
        proc = subprocess.run(["node", CHECK], input=json.dumps({"message": text, "dataDir": data_dir(), "role": role}), capture_output=True, text=True)
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


def record_brief(request_type, payload, reply):
    chat_dir = data_dir()
    if not isinstance(chat_dir, str) or not isinstance(reply, dict) or not isinstance(payload.get("prompt"), str):
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
    folder = os.path.join(chat_dir, BRIEFS)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    path = os.path.join(folder, f"{kind}-{ident}.json")
    with open(path + ".tmp", "w") as f:
        json.dump(record, f)
    os.replace(path + ".tmp", path)


def send_key(payload):
    """The same send: one receiver and one text, without its ISO times and a "(possible duplicate)" opener."""
    text = str(payload.get("message") or "").strip()
    text = re.sub(r"^\(possible duplicate\)\s*", "", text, flags=re.I)
    return (payload.get("receiver_role"), payload.get("receiver_name"), " ".join(ISO.sub("", text).split()))


def landed_at(session_id, texts, since):
    """When one of texts landed in the session's file at or after since (epoch s), via send-once.ts; None when not found or not readable."""
    folder = data_dir()
    agent_dir = os.path.dirname(folder) if isinstance(folder, str) else os.path.expanduser("~/.prime/agent")
    try:
        proc = subprocess.run(["node", SEND_ONCE], input=json.dumps({"sessionId": session_id, "texts": texts, "since": int(since * 1000), "agentDir": agent_dir}),
                              capture_output=True, text=True)
        return json.loads(proc.stdout.strip().splitlines()[-1]).get("landedAt")
    except (OSError, subprocess.SubprocessError, ValueError, IndexError, AttributeError):
        return None


async def copy_state(real, payload, earlier):
    """Where the earlier copy is: "landed", "queued" (the target has queued messages), "busy" (it runs a turn), "absent", or "unknown"."""
    try:
        roster = await real("agent_observe.list")
    except Exception:
        return "unknown", None
    role, name = payload.get("receiver_role"), payload.get("receiver_name")
    agents = roster.get("agents", []) if isinstance(roster, dict) else []
    target = next((agent for agent in agents if isinstance(agent, dict) and agent.get("relationship") == role and
                   (role == "parent" or name in (agent.get("sessionName"), agent.get("sessionId"), agent.get("activeSessionId")))), None)
    if not target or not isinstance(target.get("sessionId"), str):
        return "unknown", None
    at = landed_at(target["sessionId"], earlier["texts"], earlier["since"])
    if at:
        return "landed", at
    if (target.get("queuedCount") or 0) > 0:
        return "queued", None
    # A busy target may still get the copy from the supervisor (10-16 10:16Z and 22:53Z), so it is sent again only once the target is idle.
    busy = target.get("status") == "running" or target.get("isStreaming") or target.get("isCompacting")
    return ("busy" if busy else "absent"), None


def held(payload, earlier, state, at):
    target = payload.get("receiver_name") or payload.get("receiver_role") or "the target"
    since = time.strftime("%H:%M:%SZ", time.gmtime(earlier["since"]))
    where = {"landed": "landed at " + time.strftime("%H:%M:%SZ", time.gmtime(at / 1000)) if at else "landed",
             "queued": f"is not in its transcript yet and {target} has messages queued, so the daemon still holds it",
             "busy": f"is not in its transcript yet and {target} is busy, so the daemon may still hold it",
             "unknown": "could not be looked for now (the agent roster did not answer)"}[state]
    note = HELD_NOTE.format(target=target, since=since, where=where)
    print(note)
    return {
        "deliveryStatus": "delivered" if state == "landed" else "unconfirmed",
        "message": payload.get("message"),
        "receiverRole": payload.get("receiver_role"),
        "receiverName": payload.get("receiver_name"),
        "sentAgain": False,
        "note": note,
    }


def plain_request():
    """Prime's own host_request: the one install saved, else rlm's when it is not this wrapper, else one built on rlm.repl."""
    rlm = sys.modules.get("rlm")
    for found in (getattr(rlm, "unchecked_host_request", None), getattr(rlm, "host_request", None)):
        mine = getattr(getattr(found, "__code__", None), "co_filename", "").endswith("message-limit-check.py")
        if callable(found) and not getattr(found, "limit_checked", False) and not mine:
            return found
    from rlm import repl, _parse_host_reply

    async def bare(request_type, payload=None):
        return _parse_host_reply(request_type, await repl.host_request({**(payload or {}), "type": request_type}))
    return bare


async def request(request_type, payload=None, *args, **kwargs):
    # A kernel whose rlm module was reloaded or revived lost unchecked_host_request: on 10-17 agent_message.send then raised "'NoneType'
    # object is not callable" here in 01a141b8 and a job of "grafana done properly". So the checks never block a send: if one fails, the
    # request goes out through Prime's own host_request as it came.
    real = plain_request()
    send = request_type == "agent_message.send" and isinstance(payload, dict)
    try:
        if send:
            text = payload.get("message")
            reason = refusal(text, payload.get("receiver_role")) if isinstance(text, str) else None
            if reason:
                raise LimitRefused(reason)
        direct = send and payload.get("target") != "all"
        key = send_key(payload) if direct else None
        earlier = UNCONFIRMED.get(key) if direct else None
        if earlier:
            state, at = await copy_state(real, payload, earlier)
            if state == "landed":
                UNCONFIRMED.pop(key, None)
            if state != "absent":
                return held(payload, earlier, state, at)
    except LimitRefused:
        raise
    except Exception as error:
        print(f"user-history: the message check failed ({error}); sent as it came", file=sys.stderr)
        return await real(request_type, payload, *args, **kwargs)
    started = earlier["since"] if earlier else time.time()
    try:
        reply = await real(request_type, payload, *args, **kwargs)
        if direct:
            UNCONFIRMED.pop(key, None)
        if request_type in ("rlm.run", "rlm.create_session") and isinstance(payload, dict):
            try:
                record_brief(request_type, payload, reply)
            except Exception as error:
                print(f"user-history: the brief of this start was not recorded: {error}", file=sys.stderr)
        return reply
    except Exception as error:
        if direct and SEND_TIMEOUT in str(error):
            texts = (earlier or {}).get("texts", [])
            UNCONFIRMED[key] = {"since": started, "texts": list(dict.fromkeys(texts + [str(payload.get("message") or "").strip()]))}
            return unconfirmed(payload, error)
        raise


request.limit_checked = True
# A kernel snapshot pickles a skill module by value, and dill pickles a function in it by reference only when its __module__ and
# __qualname__ find that same function. So the wrapper names itself rlm.host_request, and install points every module that held rlm's own
# host_request at it. A revive then binds whatever rlm.host_request is live, and never a copy of rlm's function without rlm's __package__,
# whose `from . import repl` raised "attempted relative import with no known parent package" in chat 01a14210 on 10-16. Install also
# points at it every such copy that a snapshot from before VERSION 10 brings back, since that copy names itself rlm.host_request too.
request.__module__, request.__qualname__ = "rlm", "host_request"


def name_of(function):
    return getattr(function, "__module__", None), getattr(function, "__qualname__", None)


def install() -> None:
    try:
        import rlm
    except ImportError:
        return
    if not getattr(rlm.host_request, "limit_checked", False):
        rlm.unchecked_host_request = rlm.host_request
    request.__doc__ = getattr(getattr(rlm, "unchecked_host_request", None), "__doc__", None)
    try:
        __import__("agent_message")
    except ImportError:
        pass
    for module in list(sys.modules.values()):
        found = getattr(module, "__dict__", {}).get("host_request")
        if getattr(found, "limit_checked", False) or name_of(found) == ("rlm", "host_request"):
            module.host_request = request


if getattr(sys, "user_history_message_check", None) != VERSION:
    install()
    sys.user_history_message_check = VERSION
