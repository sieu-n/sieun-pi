"""Puts node-child/epipe.cjs in NODE_OPTIONS of the Prime kernel, so each Node process the kernel starts exits once its stdout reader leaves.

On 2026-11-08 at 10:08Z a sep launch!! job's `npx convex data searchCampaigns --limit 5 --format jsonLines 2>&1 | head -c 3000` grew to
4.36 GB on the owner's Mac within 27 s, while swap rose from 17.4 to 18.4 GB. After head closed the pipe, the Convex CLI's Sentry
uncaughtException handler logged each EPIPE to the same closed pipe and raised the next one, until V8's heap limit aborted it. The same
command peaked at 128 MB on us-metal02, whose pipe writes are synchronous. A `vercel inspect` piped into head reached 4.41 GB the same way
on 11-06. An existing NODE_OPTIONS keeps its options, and a command that sets its own NODE_OPTIONS runs without the preload.
"""

import os


def stable(path: str) -> str:
    """A release path as the same file under its install's `current` link, when that file exists. A Node process the kernel starts keeps
    its NODE_OPTIONS for life, and a release prune deletes the old folder: on the Mac pm2's Vent, started from a kernel, died at preload
    with MODULE_NOT_FOUND from 11-21 to 11-26 after its sieun-pi-runtime release was pruned. On 11-26 every pi-host kernel's send-check
    judge on the Mac and us-metal02 named pi-host/release-e7e0a88's epipe.cjs. Both installs swap current by rename, so the path stays valid.

    <runtime>/sieun-pi-runtime/releases/<sha>/<rest> maps to <runtime>/sieun-pi-runtime/current/<rest>, and
    <share>/pi-host/release-<sha>/<rest> maps to <share>/pi-host/current/<rest>."""
    parts = path.split(os.sep)
    for i in range(len(parts) - 1):
        if parts[i] == "sieun-pi-runtime" and parts[i + 1] == "releases":
            root, rest = parts[: i + 1], parts[i + 3 :]
        elif parts[i] == "pi-host" and parts[i + 1].startswith("release-"):
            root, rest = parts[: i + 1], parts[i + 2 :]
        else:
            continue
        moved = os.sep.join(root + ["current"] + rest)
        return moved if rest and os.path.isfile(moved) else path
    return path


PRELOAD = stable(os.path.join(os.path.dirname(os.path.realpath(__file__)), "node-child", "epipe.cjs"))


def install() -> None:
    current = os.environ.get("NODE_OPTIONS", "")
    if PRELOAD in current or not os.path.isfile(PRELOAD):
        return
    os.environ["NODE_OPTIONS"] = f'{current} --require "{PRELOAD}"'.strip()


install()
