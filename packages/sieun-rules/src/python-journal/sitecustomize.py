"""Installs only the global-rules write journal (kernel-journal.py) in a Python process, then runs the next sitecustomize.

pi-host puts this folder first on PYTHONPATH for a durable thread's kernel, so the kernel and every Python it starts journal their writes into
a shared auto-sns-agent checkout, as python-child/sitecustomize.py does for a Prime kernel, without that folder's send and transcript guards.
"""

import os
import sys

_here = os.path.dirname(os.path.realpath(__file__))
_rules = os.path.dirname(_here)

_journal = os.path.join(_rules, "kernel-journal.py")
if not getattr(sys, "global_rules_kernel_journal", False):
    sys.global_rules_kernel_journal = True
    try:
        from importlib.machinery import SourceFileLoader

        exec(SourceFileLoader("kernel-journal.py", _journal).get_code("kernel-journal.py"), {"__name__": "global_rules_kernel_journal", "__file__": _journal})
    except Exception as _error:
        print(f"global-rules: the write journal did not load in this Python process: {_error}", file=sys.stderr)

for _entry in sys.path:
    _next = os.path.join(_entry, "sitecustomize.py")
    if _entry and os.path.dirname(os.path.realpath(_entry)) != _rules and os.path.isfile(_next):
        with open(_next, encoding="utf-8") as _handle:
            exec(compile(_handle.read(), _next, "exec"), {"__name__": "sitecustomize", "__file__": _next})
        break
