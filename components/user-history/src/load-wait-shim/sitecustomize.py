"""Ends a Python process at its first sleep after a load read. Python finds this file through PYTHONPATH in commands a load-wait cell or
command started (load-wait-end.py, load-wait.ts).

A load read is os.getloadavg or a child process that runs sysctl vm.loadavg, uptime or memory_pressure. A process that sleeps without one
runs as before, since a cell that only quotes a load wait starts its commands with this file too. A read also leaves the marker file of the
shell that started the process (load-wait.sh), so a shell loop that tests a Python reading ends at its own next sleep.
Then it runs the next sitecustomize on the path. The global-rules one runs the next one in turn, which is this file again, so it loads once.
"""

import sys

if not getattr(sys, "user_history_load_wait_shim", False):
    sys.user_history_load_wait_shim = True

    import asyncio
    import importlib.machinery
    import importlib.util
    import os
    import re
    import subprocess
    import time

    MESSAGE = "user-history: the load wait ended after its first check (c47); run the check now"
    LOAD = re.compile(r"\bvm\.loadavg\b|\bmemory_pressure\b|\buptime\b")
    _state = {"read": False}

    def _mark():
        _state["read"] = True
        marker = os.environ.get("USER_HISTORY_LOAD_READ")
        if marker:
            try:
                open(marker, "w").close()
            except OSError:
                pass

    def _end():
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.flush()
            except Exception:
                pass
        os.write(2, (MESSAGE + "\n").encode())
        os._exit(75)

    _getloadavg = os.getloadavg
    _popen_init = subprocess.Popen.__init__
    _sleep = time.sleep
    _asleep = asyncio.sleep

    def getloadavg():
        _mark()
        return _getloadavg()

    def popen_init(self, args, *rest, **options):
        if LOAD.search(str(args)):
            _mark()
        _popen_init(self, args, *rest, **options)

    def sleep(seconds):
        if _state["read"]:
            _end()
        return _sleep(seconds)

    async def asleep(delay, result=None):
        if _state["read"]:
            _end()
        return await _asleep(delay, result)

    os.getloadavg = getloadavg
    subprocess.Popen.__init__ = popen_init
    time.sleep = sleep
    asyncio.sleep = asleep

    _rest = [entry for entry in sys.path if os.path.basename(os.path.realpath(entry or ".")) != "load-wait-shim"]
    _spec = importlib.machinery.PathFinder.find_spec("sitecustomize", _rest)
    if _spec is not None and _spec.loader is not None:
        _spec.loader.exec_module(importlib.util.module_from_spec(_spec))
