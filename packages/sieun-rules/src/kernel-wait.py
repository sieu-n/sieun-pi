"""Hands a long bash() await back to the agent and caps sleeps in a cell, so a turn that only waits ends and frees its pi-pool slot.

On 2026-11-03, 2,259 single tool calls over 2 min held 172.6 of 664.9 pi-pool slot-hours. 125.8 slot-h of that was a cell awaiting a
bash() handle, and 9.5 slot-h was sleep or poll loops in a cell. A turn that waits on a tool spends no tokens, but it holds the kernel,
the worker and one of the pool's working slots while other turns queue. LIMIT is 120 s, the cut that report measured these waits at
(tool-wait-defaults/grouping-2026-11-03.md). GLOBAL_RULES_KERNEL_WAIT_S sets another limit, which the tests use.

1. An `await` on a rlm BashHandle written in a cell (a frame whose file is "<cell-N>", which covers helpers a cell defines) waits at
   most LIMIT. If the command is still running then, the await raises StillRunning and the command keeps running as a background
   handle in the cell's bash_handoffs[pid]. Prime's bash completion follow-up wakes the session when it ends, and its command text
   carries the exit code, the output tail and a file with the whole output. Cancelling the cell inside LIMIT still kills a one-shot
   `await bash(cmd)`, as rlm does. An await from a skill module, rlm or a gather wrapper waits as before.
2. time.sleep and asyncio.sleep called from cell code in the cell's own task add up per cell. Once a cell's sleeps reach LIMIT, the
   next one raises SleepBudgetSpent, which points at board.wake. Sleeps in background tasks, threads and library code do not count.

The prelude in kernel-guard.ts runs this file once per kernel. Running it again installs over the original rlm methods, and a Python with no rlm
package skips the install.
"""

import asyncio
import importlib
import os
import re
import sys
import tempfile
import time
import weakref

try:
    rlm_bash = importlib.import_module("rlm.bash")
    repl = importlib.import_module("rlm.repl")
except ImportError:
    rlm_bash = repl = None

LIMIT = float(os.environ.get("GLOBAL_RULES_KERNEL_WAIT_S") or 120)
CELL = re.compile(r"<cell-\d+>\Z")
HANDOFFS = "bash_handoffs"


class StillRunning(Exception):
    def __init__(self, handle):
        self.handle = handle
        self.pid = handle._pid
        head = handle.command if len(handle.command) <= 80 else handle.command[:77] + "..."
        super().__init__(
            f"bash() pid {self.pid} `{head}` is still running after {LIMIT:g} s, so this await handed it off. The command keeps running. "
            "Prime's bash completion follow-up wakes this session when it ends, with the exit code and the output tail. "
            f"Read the whole result then with {HANDOFFS}[{self.pid}].poll() or .output(). "
            "End the turn now, because a wait inside a turn holds the kernel, the worker and a pool slot while other turns queue. "
            "For a wait of hours, start the command with systemd-run and set board.wake."
        )


class SleepBudgetSpent(Exception):
    pass


def from_cell(frame) -> bool:
    return frame is not None and CELL.match(frame.f_code.co_filename) is not None


def current_task():
    try:
        return asyncio.current_task()
    except RuntimeError:
        return None


def full_output_path(pid: int) -> str:
    folder = os.path.join(os.environ.get("RLM_SESSION_DIR") or tempfile.gettempdir(), "bash-handoffs")
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, f"{pid}-{int(time.time())}.log")


def handoff_text(handle) -> str:
    """The command text Prime's follow-up shows for a handed-off handle: the command, the exit code, the output tail and the full output file."""
    result = handle._result
    try:
        path = full_output_path(handle._pid)
        with open(path, "w", encoding="utf-8") as out:
            out.write(result.output)
    except OSError as error:
        path = f"(not saved: {error})"
    head = handle.command if len(handle.command) <= 200 else handle.command[:197] + "..."
    note = f"\n\n[handed off after {LIMIT:g} s; exit {result.exit_code}; full output in {path} and {HANDOFFS}[{handle._pid}].output(); output tail:]\n"
    room = max(0, rlm_bash._COMPLETION_NOTICE_COMMAND_CAP - len(head) - len(note))
    return head + note + result.output[-room:] if room else head + note


async def wait_bounded(handle, owned):
    try:
        async with asyncio.timeout(LIMIT):
            return await handle._wait()
    except TimeoutError:
        handle._kernel_wait_handoff = True
        if handle._done.is_set():
            handle._kernel_wait_handoff = False
            return handle._result
        raise StillRunning(handle) from None
    except asyncio.CancelledError:
        if owned:
            # rlm's _wait_owned: TERM now, then a shielded wait for the group to die before the cancel goes on.
            handle.kill(grace=rlm_bash._CANCEL_TERM_GRACE)
            confirm = asyncio.ensure_future(handle._confirm_group_exit())
            while not confirm.done():
                try:
                    await asyncio.shield(confirm)
                except asyncio.CancelledError:
                    continue
        raise


def bounded(handle, namespace):
    """rlm's BashHandle.__await__ with wait_bounded in place of _wait_owned and _wait. A handoff leaves _awaited_by_creating_cell unset, so the follow-up fires."""
    task = current_task()
    creating_cell_waited = rlm_bash._creating_cell_waits_for(handle._creating_cell_task, task)
    owned = not handle._released
    handle._released = True
    completed = handed_off = False
    try:
        result = yield from wait_bounded(handle, owned).__await__()
        completed = True
        return result
    except StillRunning:
        handed_off = True
        namespace.setdefault(HANDOFFS, {})[handle._pid] = handle
        raise
    finally:
        if not handed_off and (completed or owned) and (
            creating_cell_waited or rlm_bash._creating_cell_waits_for(handle._creating_cell_task, task)
        ):
            handle._awaited_by_creating_cell = True
            if handle._creating_cell_awaited is not None:
                handle._creating_cell_awaited.set()
        if completed:
            handle._note_result_consumed(task)


def handle_await(self):
    caller = sys._getframe(1)
    if self._done.is_set() or not from_cell(caller):
        return ORIGINAL["await"](self)
    return bounded(self, caller.f_globals)


async def notify(self, cell_finished, activity):
    """rlm's completion notice, which first puts the output tail into the command text of a handed-off handle."""
    inner = ORIGINAL["notify"](self, cell_finished, activity)
    try:
        await self._wait()
    except asyncio.CancelledError:
        inner.close()
        try:
            repl.emit({rlm_bash._BASH_ACTIVITY_MIME: {**activity, "active": False}})
        except Exception:
            pass
        raise
    if getattr(self, "_kernel_wait_handoff", False):
        self.command = handoff_text(self)
    await inner


spent = {"cell": None, "seconds": 0.0}


def charge(seconds, frame) -> None:
    """Adds a sleep a cell's own task makes to that cell's total, and raises once the total has reached LIMIT."""
    if not from_cell(frame) or not repl.is_active():
        return
    cell = repl.active_cell_task()
    if cell is None or current_task() is not cell:
        return
    if spent["cell"] is None or spent["cell"]() is not cell:
        spent["cell"], spent["seconds"] = weakref.ref(cell), 0.0
    if spent["seconds"] >= LIMIT:
        raise SleepBudgetSpent(
            f"This cell already slept {spent['seconds']:g} s, the {LIMIT:g} s a cell may sleep. A wait inside a turn holds the kernel, the worker "
            "and a pool slot while other turns queue. Set board.wake(at=...) for a time or board.wake(check=...) for a condition, then end the turn."
        )
    try:
        spent["seconds"] += max(0.0, float(seconds))
    except (TypeError, ValueError):
        pass


def time_sleep(seconds):
    charge(seconds, sys._getframe(1))
    return ORIGINAL["time.sleep"](seconds)


def asyncio_sleep(delay, result=None):
    charge(delay, sys._getframe(1))
    return ORIGINAL["asyncio.sleep"](delay, result)


def install() -> None:
    """Puts the bounded await, the notice and the sleeps in place, over the originals a first install kept on BashHandle."""
    global ORIGINAL
    Handle = rlm_bash.BashHandle
    ORIGINAL = getattr(Handle, "_kernel_wait_original", None) or {
        "await": Handle.__await__,
        "notify": Handle._notify_background_completion,
        "time.sleep": time.sleep,
        "asyncio.sleep": asyncio.sleep,
    }
    Handle._kernel_wait_original = ORIGINAL
    Handle.__await__ = handle_await
    Handle._notify_background_completion = notify
    time.sleep = time_sleep
    asyncio.sleep = asyncio_sleep


# A Python with no Prime runtime, such as a test's plain python3, has no bash() to bound.
if rlm_bash is not None:
    install()
sys.global_rules_kernel_wait = True
