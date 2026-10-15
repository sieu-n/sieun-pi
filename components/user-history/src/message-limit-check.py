"""The wrapper around agent_message.send in the Python kernel of a chat or a job of a chat, installed by message-limit-check.ts.

agent_message.send reaches the host through rlm.host_request. This wraps host_request in rlm and in the agent_message module, which imported
its own reference. It does three things.

1. The c43 limit check. Before an "agent_message.send" request goes out, message-limit-check.ts lints the text with reply-lint.ts's limit rule;
   a limit with a rate or size and no measurement, vendor limit or incident in its own sentence raises LimitRefused, and nothing is sent. A
   message to a job (receiver_role "child") that holds it for another thread's go or word raises it too (c47, steer-wait.ts). A failure to
   run the check lets the message through, like the send guard, so a broken check never cuts a chat off from its jobs.
2. A daemon timeout on a send is no failure (p334). The supervisor gives the target's worker 30 s to confirm (WORKER_REQUEST_TIMEOUT_MS in
   prime-agent 0.9.8) and raises when a busy worker answers later, but the worker still queues the message. On 10-12 the two sends that timed
   out at 17:08Z reached Crawler VP at 17:16:20Z and frontend bro at 17:10:13Z, when their running ipython calls (758 s and 459 s) ended. The
   senders read the error as a failure and sent again, so frontend bro got one ask 7 times. The wrapper returns an "unconfirmed" receipt
   instead and prints that a resend arrives as a second copy.
3. The spawn gate. Before an "rlm.run" request (rlm.spawn) goes out, it asks `pi-pool spawn-gate enter` (pi-pool's pool/spawns.py), because a
   child session costs memory in the Prime daemon at once, whatever its turn waits for: from 08:37Z to 09:37Z on 10-15 live sessions went from
   66 to 133, the workers from 17 to 27 GiB, and 21 of 53 minutes were unusable. An answer of go sends the request. An answer of held prints
   one line, returns a handle whose rlm_child_id starts with "queued-", and runs `pi-pool spawn-gate wait` in the background under a bash
   activity mark, so the kernel stays resident; when it prints go the request goes out and rlm.held_spawns[name] gets the real handle or
   the error. A gate that fails or is missing sends the request at once, so the gate never refuses a spawn.
"""

import asyncio
import json
import os
import secrets
import subprocess
import sys

CHECK = os.path.join(os.path.dirname(os.path.realpath(__file__)), "message-limit-check.ts")
VERSION = 4
SEND_TIMEOUT = 'waiting for the Prime Agent daemon response to "send_message"'
UNCONFIRMED_NOTE = (
    "agent_message: Prime Agent did not confirm this send within 30 s because {target} is busy. The daemon still holds it and delivers it "
    "when {target}'s running tool call ends (on 10-12 two such sends landed 2 and 8 minutes later). Do not send it again: a resend arrives "
    "as a second copy. To check, read {target}'s transcript after its current tool call."
)


class LimitRefused(Exception):
    """An agent message that states a limit with no evidence behind it (c43), or one that holds a job for another thread's go (c47)."""


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


POOL = os.path.expanduser("~/.local/bin/pi-pool")
HELD_LINE = ("rlm.spawn: {name} is queued, not started: the Prime daemon and its workers hold {gb} GiB, and new child sessions wait from "
             "{on} GiB until they fall to {off} GiB (0 of the 364 minutes at 16 GiB or less on 10-15 were unusable). It is {position} in line "
             "and starts by itself in order; its report reaches you as usual, so end your turn. rlm.held_spawns[{name!r}] holds its handle once it starts.")


def session_ids():
    """(this session, its tree's root) from RLM_HARNESS_STATE_DIR (.../session-artifacts/<root>[/session-artifacts/<session>]/harness)."""
    parts = os.environ.get("RLM_HARNESS_STATE_DIR", "").split(os.sep)
    ids = [parts[i + 1] for i, part in enumerate(parts[:-1]) if part == "session-artifacts"]
    return (ids[-1], ids[0]) if ids else (None, None)


def gate(name):
    """pi-pool's answer for one spawn, or None when the gate cannot answer."""
    session, _ = session_ids()
    try:
        proc = subprocess.run([POOL, "spawn-gate", "enter", "--parent", session or "?", "--name", str(name), "--pid", str(os.getpid())],
                              capture_output=True, text=True, timeout=20)
        return json.loads(proc.stdout.strip().splitlines()[-1])
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None


async def start_held(real, payload, ticket, name):
    import rlm
    from rlm import repl
    held = getattr(rlm, "held_spawns", None)
    if held is None:
        held = rlm.held_spawns = {}
    held[name] = {"state": "queued", "ticket": ticket}
    activity = None
    try:
        proc = await asyncio.create_subprocess_exec(POOL, "spawn-gate", "wait", ticket, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        activity = {"id": secrets.token_hex(16), "pid": proc.pid, "active": True}
        repl.emit({"application/vnd.prime-agent.bash-activity+json": activity})
        await proc.wait()
    except Exception:
        pass
    try:
        handle = await real("rlm.run", payload)
        held[name] = {"state": "started", "ticket": ticket, "handle": handle}
    except Exception as error:
        held[name] = {"state": "failed", "ticket": ticket, "error": str(error)}
        print(f"rlm.spawn: the queued child {name} did not start: {error}", file=sys.stderr)
    finally:
        if activity:
            repl.emit({"application/vnd.prime-agent.bash-activity+json": {**activity, "active": False}})


async def spawn(real, payload, *args, **kwargs):
    kw = payload.get("kwargs") if isinstance(payload.get("kwargs"), dict) else {}
    name = kw.get("name")
    answer = gate(name) if isinstance(name, str) and name and os.path.exists(POOL) else None
    if not answer or answer.get("state") != "held":
        return await real("rlm.run", payload, *args, **kwargs)
    ticket = answer["ticket"]
    asyncio.get_running_loop().create_task(start_held(real, payload, ticket, name))
    print(HELD_LINE.format(name=name, gb=answer.get("gb"), on=answer.get("hold_on_gb"), off=answer.get("hold_off_gb"), position=answer.get("position")))
    folder = os.environ.get("RLM_SESSION_DIR") or os.path.expanduser("~/.prime/agent/session-artifacts")
    return {"rlm_child_id": f"queued-{ticket}", "name": name, "session_dir": os.path.join(folder, f"queued-{ticket}"),
            "model": kw.get("model") or "queued"}


async def request(request_type, payload=None, *args, **kwargs):
    if request_type == "rlm.run" and isinstance(payload, dict):
        real = getattr(sys.modules.get("rlm"), "unchecked_host_request", None)
        return await spawn(real, payload, *args, **kwargs)
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
        return await real(request_type, payload, *args, **kwargs)
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
