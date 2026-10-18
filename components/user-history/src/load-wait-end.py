"""Ends a load-wait loop's wait after its first check, in a chat's or a job's Python kernel, installed by load-wait.ts.

A tool call returns its result only when the cell ends, so a note on a cell that loops on the Mac's load or free memory reached the agent only
after the loop ended (on 10-13 such loops held 8 jobs 2 min to 1 h 51 min). load-wait.ts puts one prelude line in front of such a cell, which
runs this file once per kernel and file version and then arms the cell. A cell that only quotes a load wait in a string is armed too, so the
wait ends only at the first sleep after a load read, and everything else runs as before. While the armed cell runs:

1. A load read in it marks it: os.getloadavg, a child process that runs sysctl vm.loadavg, uptime or memory_pressure, or a bash() command
   that names one. Its next `time.sleep` or `asyncio.sleep` called from the cell's own code ("<cell-N>") raises LoadWaitEnded, so the loop
   ends after its first check. Sleeps inside library calls (rlm.delete_subagent waits with asyncio.sleep) and in other threads run as before.
2. Each shell command it starts through bash() sources load-wait-shim/load-wait.sh, and each Python process those commands start gets
   load-wait-shim/sitecustomize.py. Each ends at its own first sleep after a load read, with exit 75. That covers the
   `bash('python3 -u gate.py')` form and the shell `until ...; do sleep 60; done` form.

When the cell ends, the environment it changed goes back. The cell's tool result carries LOAD_WAIT_NOTE.
"""

import asyncio
import os
import re
import subprocess
import sys
import time

VERSION = 3
SHIM = os.path.join(os.path.dirname(os.path.realpath(__file__)), "load-wait-shim")
SHELL = ". '" + os.path.join(SHIM, "load-wait.sh").replace("'", "'\\''") + "'"
MESSAGE = "the load wait ended after its first check (c47); run the check now"
PREFIX = "PRIME_AGENT_BASH_COMMAND_PREFIX"
LOAD = re.compile(r"\bvm\.loadavg\b|\bmemory_pressure\b|\buptime\b")
CELL = "<cell"


class LoadWaitEnded(BaseException):
    """Raised at the armed cell's first sleep after a load read. A BaseException, so an `except Exception` around the check cannot loop."""


_armed = set()
_read = set()


def _task():
    try:
        return asyncio.current_task()
    except RuntimeError:
        return None


def _mark():
    task = _task()
    if task in _armed:
        _read.add(task)


def _ends(caller):
    return caller.f_code.co_filename.startswith(CELL) and _task() in _read


_getloadavg = os.getloadavg
_popen_init = subprocess.Popen.__init__
_time_sleep = time.sleep
_asyncio_sleep = asyncio.sleep


def getloadavg():
    _mark()
    return _getloadavg()


def popen_init(self, args, *rest, **options):
    if LOAD.search(str(args)):
        _mark()
    _popen_init(self, args, *rest, **options)


def sleep(seconds):
    if _ends(sys._getframe(1)):
        raise LoadWaitEnded(MESSAGE)
    return _time_sleep(seconds)


async def asleep(delay, result=None):
    if _ends(sys._getframe(1)):
        raise LoadWaitEnded(MESSAGE)
    return await _asyncio_sleep(delay, result)


os.getloadavg = getloadavg
subprocess.Popen.__init__ = popen_init
time.sleep = sleep
asyncio.sleep = asleep

try:
    from rlm import bash as _rlm_bash

    _handle_init = _rlm_bash.BashHandle.__init__

    def handle_init(self, command, *rest, **options):
        if isinstance(command, str) and LOAD.search(command):
            _mark()
        _handle_init(self, command, *rest, **options)

    _rlm_bash.BashHandle.__init__ = handle_init
except Exception:
    pass


def _set(changes):
    """Sets environment keys and returns a function that puts back each one the cell did not change since."""
    before = {key: os.environ.get(key) for key in changes}
    for key, value in changes.items():
        os.environ[key] = value

    def restore():
        for key, value in changes.items():
            if os.environ.get(key) != value:
                continue
            if before[key] is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = before[key]
    return restore


def arm():
    task = _task()
    if task is None or task in _armed:
        return
    _armed.add(task)
    prefix = os.environ.get(PREFIX)
    python_path = os.environ.get("PYTHONPATH")
    restore = _set({
        PREFIX: f"{prefix}\n{SHELL}" if prefix else SHELL,
        "PYTHONPATH": f"{SHIM}{os.pathsep}{python_path}" if python_path else SHIM,
    })

    def done(_done):
        _armed.discard(task)
        _read.discard(task)
        restore()
    task.add_done_callback(done)


sys.user_history_load_wait_arm = arm
sys.user_history_load_wait_end = VERSION
