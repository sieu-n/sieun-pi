"""Reports the Prime kernel's cwd to the tool_call guard (kernel-cwd.ts), which judges a cell before it runs and gets only the session's start cwd from Prime.

The prelude in kernel-guard.ts runs this file once per kernel, never in a child Python. It writes {"pid", "host", "cwd"} to
$RLM_SESSION_DIR/kernel-cwd.json at load and after each os.chdir or os.fchdir, so the guard judges the next cell from where its commands run.
"""

import json
import os
import socket

PATH = os.path.join(os.environ["RLM_SESSION_DIR"], "kernel-cwd.json") if os.environ.get("RLM_SESSION_DIR") else None
KERNEL = os.getpid()


def report() -> None:
    """Writes the kernel's cwd; a forked child, a missing session dir or a cwd that is gone writes nothing."""
    if PATH is None or os.getpid() != KERNEL:
        return
    try:
        tmp = f"{PATH}.{KERNEL}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump({"pid": KERNEL, "host": socket.gethostname(), "cwd": os.getcwd()}, handle)
        os.replace(tmp, PATH)
    except OSError:
        pass


def reporting(original):
    def change(*args, **kwargs):
        try:
            return original(*args, **kwargs)
        finally:
            report()

    change.reports_cwd = True
    change.__doc__ = original.__doc__
    return change


for name in ("chdir", "fchdir"):
    function = getattr(os, name, None)
    if function is not None and not getattr(function, "reports_cwd", False):
        setattr(os, name, reporting(function))
report()
