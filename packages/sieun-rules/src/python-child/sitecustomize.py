"""Installs the global-rules send guard (c37), transcript guard and write journal in a Python process started from a guarded Prime kernel, then runs the next sitecustomize.

kernel-guard.py puts this folder first on PYTHONPATH, so a helper script or a `uv run` command checks its own sends at run time.
A run passes with OWNER_OK=<chat id>/<todo id> in its environment when that todo is the owner's approved For you todo.
"""

import os
import sys

_here = os.path.dirname(os.path.realpath(__file__))


def _code(path):
    """A guard file's code from its __pycache__ .pyc while that is fresh, else compiled from source. Compiling the three files took
    7 to 27 ms per file on each Python start on us-metal02 on 10-29, while loading the .pyc took under 1 ms."""
    try:
        from importlib.machinery import SourceFileLoader

        return SourceFileLoader(os.path.basename(path), path).get_code(os.path.basename(path))
    except Exception:
        with open(path, encoding="utf-8") as handle:
            return compile(handle.read(), path, "exec")


_guard = os.path.join(os.path.dirname(_here), "kernel-guard.py")
if not getattr(sys, "global_rules_send_guard", False):
    try:
        exec(_code(_guard), {"__name__": "global_rules_send_guard", "__file__": _guard})
    except Exception as _error:
        sys.global_rules_send_guard = "failed"
        print(f"global-rules: the send guard did not load in this Python process: {_error}", file=sys.stderr)

_read = os.path.join(os.path.dirname(_here), "kernel-read.py")
if not getattr(sys, "global_rules_kernel_read", False):
    sys.global_rules_kernel_read = True
    try:
        exec(_code(_read), {"__name__": "global_rules_kernel_read", "__file__": _read})
    except Exception as _error:
        print(f"global-rules: the transcript guard did not load in this Python process: {_error}", file=sys.stderr)

_journal = os.path.join(os.path.dirname(_here), "kernel-journal.py")
if not getattr(sys, "global_rules_kernel_journal", False):
    sys.global_rules_kernel_journal = True
    try:
        exec(_code(_journal), {"__name__": "global_rules_kernel_journal", "__file__": _journal})
    except Exception as _error:
        print(f"global-rules: the write journal did not load in this Python process: {_error}", file=sys.stderr)

for _entry in sys.path:
    _next = os.path.join(_entry, "sitecustomize.py")
    if _entry and os.path.realpath(_entry) != _here and os.path.isfile(_next):
        with open(_next, encoding="utf-8") as _handle:
            exec(compile(_handle.read(), _next, "exec"), {"__name__": "sitecustomize", "__file__": _next})
        break
