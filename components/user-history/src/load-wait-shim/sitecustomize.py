"""Ends a Python process at its first sleep. Python finds this file through PYTHONPATH in commands a load-wait cell started (load-wait-end.py).

It patches time.sleep and asyncio.sleep, then hands off to the sitecustomize that would load without this folder on the path.
"""

import asyncio
import importlib.machinery
import importlib.util
import os
import sys
import time

MESSAGE = "user-history: the load wait ended after its first check (c47); run the check now"


def _end(*_args, **_kwargs):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:
            pass
    os.write(2, (MESSAGE + "\n").encode())
    os._exit(75)


async def _aend(*args, **kwargs):
    _end()


time.sleep = _end
asyncio.sleep = _aend

# Every load-wait-shim folder is skipped by name: the release's and the checkout's may both be on the path, and each would load the other.
_rest = [entry for entry in sys.path if os.path.basename(os.path.realpath(entry or ".")) != "load-wait-shim"]
_spec = importlib.machinery.PathFinder.find_spec("sitecustomize", _rest)
if _spec is not None and _spec.loader is not None:
    _spec.loader.exec_module(importlib.util.module_from_spec(_spec))
