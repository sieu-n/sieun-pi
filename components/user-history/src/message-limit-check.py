"""The c43 limit check for agent messages a chat sends, installed in the chat's Python kernel by message-limit-check.ts.

agent_message.send reaches the host through rlm.host_request. This wraps host_request in rlm and in the agent_message module, which imported
its own reference. Before an "agent_message.send" request goes out, message-limit-check.ts lints the text with reply-lint.ts's limit rule; a
limit with a rate or size and no measurement, vendor limit or incident in its own sentence raises LimitRefused, and nothing is sent.
A failure to run the check lets the message through, like the send guard, so a broken check never cuts a chat off from its jobs.
"""

import json
import os
import subprocess
import sys

CHECK = os.path.join(os.path.dirname(os.path.realpath(__file__)), "message-limit-check.ts")


class LimitRefused(Exception):
    """An agent message that states a limit with no evidence behind it (c43)."""


def refusal(text: str):
    try:
        proc = subprocess.run(["node", CHECK], input=json.dumps({"message": text}), capture_output=True, text=True)
        return json.loads(proc.stdout.strip().splitlines()[-1]).get("refusal")
    except (OSError, subprocess.SubprocessError, ValueError, IndexError, AttributeError):
        return None


def checked(host_request):
    if getattr(host_request, "limit_checked", False):
        return host_request

    async def request(request_type, payload=None, *args, **kwargs):
        if request_type == "agent_message.send" and isinstance(payload, dict):
            text = payload.get("message")
            reason = refusal(text) if isinstance(text, str) else None
            if reason:
                raise LimitRefused(reason)
        return await host_request(request_type, payload, *args, **kwargs)

    request.limit_checked = True
    request.__doc__ = host_request.__doc__
    return request


def install() -> None:
    for name in ("rlm", "agent_message"):
        module = sys.modules.get(name)
        if module is None:
            try:
                module = __import__(name)
            except ImportError:
                continue
        if getattr(module, "host_request", None) is not None:
            module.host_request = checked(module.host_request)


if not getattr(sys, "user_history_message_check", False):
    install()
    sys.user_history_message_check = True
