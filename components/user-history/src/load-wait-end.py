"""Ends a load-wait loop's wait after its first check, in a chat's or a job's Python kernel, installed by load-wait.ts.

A tool call returns its result only when the cell ends, so a note on a cell that loops on the Mac's load or free memory reached the agent only
after the loop ended (on 10-13 such loops held 8 jobs 2 min to 1 h 51 min). load-wait.ts puts one prelude line in front of such a cell, which
runs this file once per kernel and file version and then arms the cell. While the armed cell runs:

1. Its first `time.sleep` or `asyncio.sleep` raises LoadWaitEnded, so the loop ends after its first check. Sleeps in other threads and in
   tasks the cell did not await run as before.
2. Each shell command it starts through bash() gets a shell `sleep` function that ends the shell with exit 75, and each Python process those
   commands start gets the sitecustomize.py in load-wait-shim/, which ends the process at its first sleep the same way. That covers the
   `bash('python3 -u gate.py')` form and the shell `until ...; do sleep 60; done` form.

When the cell ends, the environment it changed goes back, and later cells sleep as before. The cell's tool result carries LOAD_WAIT_NOTE.
"""

import asyncio
import os
import sys
import time

VERSION = 1
SHIM = os.path.join(os.path.dirname(os.path.realpath(__file__)), "load-wait-shim")
MESSAGE = "the load wait ended after its first check (c47); run the check now"
SHELL = "sleep() { printf '%s\\n' 'user-history: " + MESSAGE + "' >&2; exit 75; }"
PREFIX = "PRIME_AGENT_BASH_COMMAND_PREFIX"


class LoadWaitEnded(BaseException):
    """Raised at the armed cell's first sleep. A BaseException, so an `except Exception` around the check does not turn it into a hot loop."""


_armed = set()


def _in_armed_cell():
    try:
        task = asyncio.current_task()
    except RuntimeError:
        return False
    return task is not None and task in _armed and not task.done()


_time_sleep = time.sleep
_asyncio_sleep = asyncio.sleep


def sleep(seconds):
    if _in_armed_cell():
        raise LoadWaitEnded(MESSAGE)
    return _time_sleep(seconds)


async def asleep(delay, result=None):
    if _in_armed_cell():
        raise LoadWaitEnded(MESSAGE)
    return await _asyncio_sleep(delay, result)


time.sleep = sleep
asyncio.sleep = asleep


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
    task = asyncio.current_task()
    if task is None or task in _armed:
        return
    _armed.add(task)
    prefix = os.environ.get(PREFIX)
    python_path = os.environ.get("PYTHONPATH")
    restore = _set({
        PREFIX: f"{prefix}\n{SHELL}" if prefix else SHELL,
        "PYTHONPATH": f"{SHIM}{os.pathsep}{python_path}" if python_path else SHIM,
    })

    def done(_task):
        _armed.discard(task)
        restore()
    task.add_done_callback(done)


sys.user_history_load_wait_arm = arm
sys.user_history_load_wait_end = VERSION
