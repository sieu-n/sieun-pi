"""The wrapper around agent_message.send in the Python kernel of a chat or a job of a chat, installed by message-limit-check.ts.

agent_message.send reaches the host through rlm.host_request. This wraps host_request in rlm and in the agent_message module, which imported
its own reference. It does three things.

1. The c47 hold note. Before an "agent_message.send" request goes out, message-limit-check.ts checks a message to a job (receiver_role
   "child"): one that holds the job for another thread's go or word still goes out, and the receipt carries the note and prints it
   (steer-wait.ts), since the owner made every such limit a soft cap on 10-18. A failure to run the check sends the message with no note.
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
4. Cross-host siblings. Prime's daemon finds a sibling only among the roots it runs, so after the 10-18 move of the chats to us-metal02 a
   send from a box chat to a root on the Mac failed with 'No sibling matches'. In a root's kernel such a send goes to the chat service,
   which delivers it on the other box (src/cross-host-message.ts), and agent_observe.list_agents lists the other boxes' roots as siblings.
5. Failed siblings. A root whose worker died answers every send with "Session worker is failed", and one the daemon dropped with "Unknown
   active session" (10-18: "runner reviewer" on the Mac, about 04:30 to 05:37Z). Such a sibling send asks the chat service to open that root
   from its file (api/agent/reopen) and goes out once more.
"""

import asyncio

import json
import os
import re
import subprocess
import sys
import time

CHECK = os.path.join(os.path.dirname(os.path.realpath(__file__)), "message-limit-check.ts")
SEND_ONCE = os.path.join(os.path.dirname(os.path.realpath(__file__)), "send-once.ts")
VERSION = 18
BRIEFS = "spawn-briefs"
SAFE_ID = re.compile(r"^[\w-]{1,128}$")
SEND_TIMEOUT = 'waiting for the Prime Agent daemon response to "send_message"'
# The daemon may still deliver after its client closes mid-send (10-17 22:11Z: a wake to 01a14be9 landed, and its resend landed again).
CLIENT_CLOSED = "daemon client closed before the operation completed"
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
CROSS_HOST = os.path.join(os.path.dirname(os.path.realpath(__file__)), "cross-host-message.ts")
NO_SIBLING = "No sibling matches"
# A root whose worker died or that the daemon dropped refuses every send until it is opened again from its file (src/reopen-send.ts).
REOPENABLE = re.compile(r"Session worker is failed|Unknown active session")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
ISO = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z")


def data_dir():
    """The chat server's directory the latest cell's prelude named (None outside the chats), else the one this file was installed with."""
    return getattr(sys, "user_history_data_dir", globals().get("DATA_DIR"))


def hold_note(text: str, role=None):
    try:
        proc = subprocess.run(["node", CHECK], input=json.dumps({"message": text, "dataDir": data_dir(), "role": role}), capture_output=True, text=True)
        return json.loads(proc.stdout.strip().splitlines()[-1]).get("note")
    except (OSError, subprocess.SubprocessError, ValueError, IndexError, AttributeError):
        return None


def with_note(reply, note):
    """The receipt with the c47 hold note added, printed so the cell's output shows it too."""
    if not note:
        return reply
    print(note)
    return {**reply, "note": f"{reply['note']} {note}" if reply.get("note") else note} if isinstance(reply, dict) else reply


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


def own_root():
    """This kernel's session id when it is a root, whose RLM_SESSION_DIR is named for it; None in a subagent, which has no sibling on another box."""
    name = os.path.basename(os.environ.get("RLM_SESSION_DIR", "").rstrip(os.sep))
    return name if UUID.match(name) else None


RESTARTING = re.compile(r"Chat service answered 50[234]|fetch failed|ECONNREFUSED|has not listed its sessions yet|No chat service is set up")
# A chat service restart leaves the cross-host routes down or without the other boxes' roots for about 23 s (10-18: stop 05:14:32Z, start
# 05:14:37Z, Mac listed 05:14:55Z); box sessions' sends to Fable and the release owner failed in that gap. A send retries through 60 s. On the
# chat host the service removes instance.json while it restarts, so the helper answers "No chat service is set up" then (VP of CI, 10-18).
RESTART_WAIT = 60
RESTART_STEP = 5


async def cross_host(op, body):
    """The chat service's answer to one cross-host op, through cross-host-message.ts; raises with the service's error, after retrying through
    a restart of the chat service (RESTARTING) for up to RESTART_WAIT s."""
    deadline = time.time() + RESTART_WAIT
    while True:
        try:
            return await cross_host_once(op, body)
        except RuntimeError as error:
            if not RESTARTING.search(str(error)) or time.time() + RESTART_STEP > deadline:
                raise
            await asyncio.sleep(RESTART_STEP)


async def cross_host_once(op, body):
    # tsx, since chat-host.ts imports hosts.ts, whose parameter properties node's own type stripping refuses.
    proc = await asyncio.create_subprocess_exec("node", "--import", "tsx", CROSS_HOST, op, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE, cwd=os.path.dirname(os.path.dirname(CROSS_HOST)))
    out, err = await proc.communicate(json.dumps({**body, "dataDir": data_dir()}).encode())
    try:
        answer = json.loads(out.decode().strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise RuntimeError(f"cross-host message helper failed: {err.decode()[-300:]}") from None
    if isinstance(answer, dict) and "error" in answer:
        raise RuntimeError(answer["error"])
    return answer


async def with_other_boxes(roster):
    """A root's roster with the roots of the other boxes added as siblings; the roster as it came when the chat service does not answer."""
    root = own_root()
    if not root or not isinstance(roster, dict) or not isinstance(roster.get("agents"), list):
        return roster
    try:
        extra = (await cross_host("siblings", {"session": root})).get("agents", [])
    except Exception as error:
        print(f"user-history: other boxes' roots not listed: {error}", file=sys.stderr)
        return roster
    known = {agent.get("sessionId") for agent in roster["agents"] if isinstance(agent, dict)}
    return {**roster, "agents": roster["agents"] + [agent for agent in extra if agent.get("sessionId") not in known]}


OTHER_ROOTS = {"at": 0.0, "root": None, "agents": []}
# A send's other-box roots are read at most this often, since each read starts the node helper (about 1 s); a root moved meanwhile is
# still found by the fallback after the local daemon's 'No sibling matches'.
OTHER_ROOTS_TTL = 30


async def other_roots(root):
    """The roots on other boxes than this root's, as the chat catalog lists them (cross-host-message.ts siblings), read once per OTHER_ROOTS_TTL."""
    if OTHER_ROOTS["root"] != root or time.time() - OTHER_ROOTS["at"] > OTHER_ROOTS_TTL:
        agents = (await cross_host("siblings", {"session": root})).get("agents", [])
        OTHER_ROOTS.update(at=time.time(), root=root, agents=[agent for agent in agents if isinstance(agent, dict)])
    return OTHER_ROOTS["agents"]


def pick_other(agents, to):
    """The one root `to` names among other boxes' roots, the way pickRoot in cross-host-message.ts reads it, with how it matched; else None."""
    wanted = str(to or "").strip()
    exact = [agent for agent in agents if wanted in (agent.get("sessionId"), agent.get("activeSessionId"))]
    if len(exact) == 1:
        return exact[0], "id"
    named = [agent for agent in agents if str(agent.get("sessionName") or "").strip().lower() == wanted.lower() or
             (len(wanted) >= 8 and str(agent.get("sessionId") or "").startswith(wanted))]
    return (named[0], "name") if len(named) == 1 else None


async def other_box_first(real, payload):
    """The other-box root a root's sibling send names when the chat catalog lists it under another box; None to send it here as it came.

    At 05:35Z on 10-18 'metal box owner', a Mac root, sent to 'tiktok shop', which had moved to us-metal02 while its old file still sat in the
    Mac's sessions folder. The Mac daemon matched that copy and reopened it, and it ran tool calls until 05:39Z. So a send goes by the catalog's
    host first. A name that also names a different session here stays here, since then the name means this box's root."""
    root = own_root()
    if not root or payload.get("receiver_role") != "sibling" or not payload.get("receiver_name"):
        return None
    found = pick_other(await other_roots(root), payload.get("receiver_name"))
    if not found:
        return None
    target, how = found
    if how == "name":
        roster = await real("agent_observe.list")
        here = [agent for agent in (roster.get("agents", []) if isinstance(roster, dict) else []) if isinstance(agent, dict) and
                agent.get("relationship") == "sibling" and str(agent.get("sessionName") or "").strip().lower() == str(payload["receiver_name"]).strip().lower()]
        if any(agent.get("sessionId") != target.get("sessionId") for agent in here):
            return None
    return target


async def send_other_box(payload, error, resend):
    """A sibling send the local daemon found no sibling for, delivered by the chat service to a root on another box; a sibling send the local
    daemon refused because the root's worker died or was dropped, sent once more after the chat service opened that root from its file
    (resend); else the daemon's error."""
    root = own_root()
    if not root or payload.get("receiver_role") != "sibling":
        raise error
    if REOPENABLE.search(str(error)):
        try:
            answer = await cross_host("reopen", {"from": root, "to": payload.get("receiver_name")})
        except RuntimeError as other:
            raise RuntimeError(f"{error}; reopen: {other}") from None
        if not isinstance(answer, dict) or not answer.get("reopened"):
            raise error
        return await resend()
    if NO_SIBLING not in str(error):
        raise error
    try:
        reply = await cross_host("send", {"from": root, "to": payload.get("receiver_name"), "message": payload.get("message")})
    except RuntimeError as other:
        if SEND_TIMEOUT in str(other) or CLIENT_CLOSED in str(other):
            raise
        raise RuntimeError(f"{error}; {other}") from None
    return reply


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
    note = None
    try:
        if send:
            text = payload.get("message")
            note = hold_note(text, payload.get("receiver_role")) if isinstance(text, str) else None
        direct = send and payload.get("target") != "all"
        key = send_key(payload) if direct else None
        earlier = UNCONFIRMED.get(key) if direct else None
        if earlier:
            state, at = await copy_state(real, payload, earlier)
            if state == "landed":
                UNCONFIRMED.pop(key, None)
            if state != "absent":
                return with_note(held(payload, earlier, state, at), note)
    except Exception as error:
        print(f"user-history: the message check failed ({error}); sent as it came", file=sys.stderr)
        return with_note(await real(request_type, payload, *args, **kwargs), note)
    started = earlier["since"] if earlier else time.time()
    try:
        target = None
        if direct:
            try:
                target = await other_box_first(real, payload)
            except Exception as error:
                print(f"user-history: the other boxes' roots did not read ({error}); sent here first", file=sys.stderr)
        if target:
            reply = await cross_host("send", {"from": own_root(), "to": target["sessionId"], "message": payload.get("message")})
        else:
            try:
                reply = await real(request_type, payload, *args, **kwargs)
            except Exception as error:
                if not direct:
                    raise
                reply = await send_other_box(payload, error, lambda: real(request_type, payload, *args, **kwargs))
        if request_type == "agent_observe.list":
            reply = await with_other_boxes(reply)
        if direct:
            UNCONFIRMED.pop(key, None)
        if request_type in ("rlm.run", "rlm.create_session") and isinstance(payload, dict):
            try:
                record_brief(request_type, payload, reply)
            except Exception as error:
                print(f"user-history: the brief of this start was not recorded: {error}", file=sys.stderr)
        return with_note(reply, note)
    except Exception as error:
        if direct and (SEND_TIMEOUT in str(error) or CLIENT_CLOSED in str(error)):
            texts = (earlier or {}).get("texts", [])
            UNCONFIRMED[key] = {"since": started, "texts": list(dict.fromkeys(texts + [str(payload.get("message") or "").strip()]))}
            return with_note(unconfirmed(payload, error), note)
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
    for skill in ("agent_message", "agent_observe"):
        try:
            __import__(skill)
        except ImportError:
            pass
    for module in list(sys.modules.values()):
        found = getattr(module, "__dict__", {}).get("host_request")
        if getattr(found, "limit_checked", False) or name_of(found) == ("rlm", "host_request"):
            module.host_request = request


if getattr(sys, "user_history_message_check", None) != VERSION:
    install()
    sys.user_history_message_check = VERSION
