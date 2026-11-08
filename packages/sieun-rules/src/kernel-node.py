"""Puts node-child/epipe.cjs in NODE_OPTIONS of the Prime kernel, so each Node process the kernel starts exits once its stdout reader leaves.

On 2026-11-08 at 10:08Z a sep launch!! job's `npx convex data searchCampaigns --limit 5 --format jsonLines 2>&1 | head -c 3000` grew to
4.36 GB on the owner's Mac within 27 s, while swap rose from 17.4 to 18.4 GB. After head closed the pipe, the Convex CLI's Sentry
uncaughtException handler logged each EPIPE to the same closed pipe and raised the next one, until V8's heap limit aborted it. The same
command peaked at 128 MB on us-metal02, whose pipe writes are synchronous. A `vercel inspect` piped into head reached 4.41 GB the same way
on 11-06. An existing NODE_OPTIONS keeps its options, and a command that sets its own NODE_OPTIONS runs without the preload.
"""

import os

PRELOAD = os.path.join(os.path.dirname(os.path.realpath(__file__)), "node-child", "epipe.cjs")


def install() -> None:
    current = os.environ.get("NODE_OPTIONS", "")
    if PRELOAD in current or not os.path.isfile(PRELOAD):
        return
    os.environ["NODE_OPTIONS"] = f'{current} --require "{PRELOAD}"'.strip()


install()
