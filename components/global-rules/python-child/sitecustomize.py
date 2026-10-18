"""Installs the global-rules send guard (c37) in a Python process started from a guarded Prime kernel, then runs the next sitecustomize.

kernel-guard.py puts this folder first on PYTHONPATH, so a helper script or a `uv run` command checks its own sends at run time.
A run passes with OWNER_OK=<chat id>/<todo id> in its environment when that todo is the owner's approved For you todo.
"""

import os
import sys

_here = os.path.dirname(os.path.realpath(__file__))
_guard = os.path.join(os.path.dirname(_here), "kernel-guard.py")
if not getattr(sys, "global_rules_send_guard", False):
    try:
        with open(_guard, encoding="utf-8") as _handle:
            exec(compile(_handle.read(), _guard, "exec"), {"__name__": "global_rules_send_guard", "__file__": _guard})
    except Exception as _error:
        sys.global_rules_send_guard = "failed"
        print(f"global-rules: the send guard did not load in this Python process: {_error}", file=sys.stderr)

for _entry in sys.path:
    _next = os.path.join(_entry, "sitecustomize.py")
    if _entry and os.path.realpath(_entry) != _here and os.path.isfile(_next):
        with open(_next, encoding="utf-8") as _handle:
            exec(compile(_handle.read(), _next, "exec"), {"__name__": "sitecustomize", "__file__": _next})
        break
