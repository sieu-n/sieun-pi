"""Kernel wait default (packages/sieun-rules/src/kernel-wait.py): a cell's bash() await hands off after LIMIT, and a cell's sleeps stop at LIMIT.

Each case drives a real `python -m rlm.repl` from Prime's kernel-venv over its JSON-lines protocol, with GLOBAL_RULES_KERNEL_WAIT_S set
short, and plays the host by answering its bash.completed request. Without kernel-wait.py every case fails.
"""

import json
import os
import queue
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
WAIT = REPO / "packages" / "sieun-rules" / "src" / "kernel-wait.py"
PYTHON = Path(os.environ.get("PRIME_KERNEL_PYTHON") or Path.home() / ".prime/agent/kernel-venv/bin/python")
LOAD = f"exec(compile(open({str(WAIT)!r}).read(), {str(WAIT)!r}, 'exec'), {{'__name__': 'global_rules_kernel_wait', '__file__': {str(WAIT)!r}}})"


class Repl:
    def __init__(self, limit: float, tmp: str, before: str = "") -> None:
        env = {**os.environ, "GLOBAL_RULES_KERNEL_WAIT_S": str(limit), "RLM_SESSION_DIR": tmp, "PYTHONPATH": tmp}
        for name in ("PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL", "PRIME_AGENT_KERNEL_OWNER_PID"):
            env.pop(name, None)
        self.proc = subprocess.Popen([str(PYTHON), "-m", "rlm.repl"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, env=env, cwd=tmp)
        self.lines: queue.Queue = queue.Queue()
        threading.Thread(target=self.read, daemon=True).start()
        assert self.event()["event"] == "ready"
        self.run("load", "from rlm import bash\n" + before + LOAD)

    def read(self) -> None:
        for line in self.proc.stdout:
            self.lines.put(json.loads(line))
        self.lines.put(None)

    def event(self, timeout: float = 30.0):
        event = self.lines.get(timeout=timeout)
        if event is None:
            raise EOFError("the kernel closed its protocol stream")
        return event

    def send(self, request: dict) -> None:
        self.proc.stdin.write(json.dumps(request) + "\n")
        self.proc.stdin.flush()

    def until_done(self, rid: str) -> list:
        events = []
        while True:
            events.append(self.event())
            if events[-1].get("event") == "done" and events[-1].get("id") == rid:
                return events

    def run(self, rid: str, code: str) -> list:
        self.send({"type": "execute", "id": rid, "code": code})
        return self.until_done(rid)

    def completed(self, events: list, timeout: float):
        """The first bash.completed host request in events or within timeout, answered as the host answers it."""
        deadline = time.monotonic() + timeout
        found = [e for e in events if e.get("event") == "host_request" and e["data"].get("type") == "bash.completed"]
        while not found:
            left = deadline - time.monotonic()
            if left <= 0:
                return None
            try:
                event = self.event(left)
            except queue.Empty:
                return None
            if event.get("event") == "host_request" and event["data"].get("type") == "bash.completed":
                found.append(event)
        self.send({"type": "host_reply", "id": found[0]["id"], "data": {"status": "ok", "result": {}}})
        return found[0]["data"]

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(timeout=10)
        self.proc.stdin.close()
        self.proc.stdout.close()


def kind(events: list, name: str):
    return next((e for e in events if e.get("event") == name), None)


def result(events: list):
    found = kind(events, "result")
    return found and found["text"]


@unittest.skipUnless(PYTHON.exists(), f"no Prime kernel-venv at {PYTHON}")
class KernelWait(unittest.TestCase):
    def start(self, limit: float, before: str = "") -> Repl:
        tmp = tempfile.mkdtemp(prefix="kernel-wait-")
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", tmp]))
        repl = Repl(limit, tmp, before)
        self.addCleanup(repl.close)
        self.tmp = tmp
        return repl

    def test_a_long_await_hands_off_and_the_follow_up_carries_exit_code_and_output(self):
        repl = self.start(1)
        began = time.monotonic()
        events = repl.run("long", "r = await bash('sleep 3; echo done-xyz; exit 3')")
        took = time.monotonic() - began
        error = kind(events, "error")
        self.assertEqual(error and error["ename"], "StillRunning", events)
        self.assertLess(took, 2.5)
        self.assertIn("keeps running", error["evalue"])
        self.assertIn("End the turn now", error["evalue"])
        pid = int(error["evalue"].split("pid ")[1].split()[0])
        notice = repl.completed(events, timeout=10)
        self.assertIsNotNone(notice, "no bash completion follow-up after the handoff")
        self.assertEqual((notice["pid"], notice["exitCode"]), (pid, 3))
        self.assertTrue(notice["command"].startswith("sleep 3; echo done-xyz; exit 3\n"))
        self.assertIn("exit 3;", notice["command"])
        self.assertTrue(notice["command"].endswith("done-xyz\n"), notice["command"])
        saved = notice["command"].split("full output in ")[1].split(" and ")[0]
        self.assertEqual(Path(saved).read_text(), "done-xyz\n")
        read = repl.run("read", f"bash_handoffs[{pid}].poll().exit_code, bash_handoffs[{pid}].output()")
        self.assertEqual(result(read), "(3, 'done-xyz\\n')")

    def test_cancelling_the_cell_inside_the_limit_kills_a_one_shot_command(self):
        repl = self.start(5)
        marker = os.path.join(self.tmp, "marker")
        repl.send({"type": "execute", "id": "cancel", "code": f"r = await bash('sleep 1.5 && touch {marker}')"})
        time.sleep(0.5)
        repl.send({"type": "interrupt"})
        events = repl.until_done("cancel")
        self.assertEqual(kind(events, "error")["ename"], "KeyboardInterrupt")
        self.assertIsNone(repl.completed(events, timeout=2.5))
        self.assertFalse(os.path.exists(marker))

    def test_a_finished_handle_returns_its_result_after_the_limit(self):
        repl = self.start(0.2)
        events = repl.run("done", "import time\nh = bash('echo hi')\ntime.sleep(0.5)\n(await h).output")
        self.assertEqual(result(events), "'hi\\n'", events)
        self.assertIsNone(repl.completed(events, timeout=1))

    def test_an_await_outside_cell_code_waits_as_before(self):
        repl = self.start(0.5)
        Path(self.tmp, "helper.py").write_text("async def wait(handle):\n    return await handle\n")
        events = repl.run("helper", "import helper\n(await helper.wait(bash('sleep 1.5; echo slow'))).output")
        self.assertEqual(result(events), "'slow\\n'", events)

    def test_a_cell_helper_counts_as_cell_code(self):
        repl = self.start(0.5)
        events = repl.run("cellhelper", "async def wait(handle):\n    return await handle\nawait wait(bash('sleep 2'))")
        self.assertEqual(kind(events, "error")["ename"], "StillRunning", events)
        self.assertIsNotNone(repl.completed(events, timeout=5))

    def test_wait_for_with_a_long_timeout_hands_off(self):
        repl = self.start(1)
        began = time.monotonic()
        events = repl.run("waitfor", "import asyncio\nawait asyncio.wait_for(bash('sleep 3; echo wf-xyz; exit 4'), 60)")
        error = kind(events, "error")
        self.assertEqual(error and error["ename"], "StillRunning", events)
        self.assertLess(time.monotonic() - began, 2.5)
        pid = int(error["evalue"].split("pid ")[1].split()[0])
        notice = repl.completed(events, timeout=10)
        self.assertIsNotNone(notice, "no bash completion follow-up after the handoff")
        self.assertEqual((notice["pid"], notice["exitCode"]), (pid, 4))
        self.assertTrue(notice["command"].endswith("wf-xyz\n"), notice["command"])
        self.assertEqual(result(repl.run("read", f"bash_handoffs[{pid}].poll().exit_code")), "4")

    def test_gather_of_two_handles_hands_off_and_both_follow_ups_arrive(self):
        repl = self.start(1)
        began = time.monotonic()
        events = repl.run("gather", "import asyncio\nawait asyncio.gather(bash('sleep 3; echo ga'), bash('sleep 3.5; echo gb; exit 2'))")
        self.assertEqual(kind(events, "error")["ename"], "StillRunning", events)
        self.assertLess(time.monotonic() - began, 2.5)
        first, second = repl.completed(events, timeout=10), repl.completed([], timeout=10)
        self.assertIsNotNone(first, "no follow-up for the first handle")
        self.assertIsNotNone(second, "no follow-up for the second handle")
        notices = sorted((n["exitCode"], n["command"].rsplit("\n", 2)[-2]) for n in (first, second))
        self.assertEqual(notices, [(0, "ga"), (2, "gb")])
        pids = sorted([first["pid"], second["pid"]])
        self.assertEqual(result(repl.run("read", "sorted(bash_handoffs)")), str(pids))

    def test_ensure_future_and_wait_hand_off(self):
        repl = self.start(1)
        events = repl.run("wait", "import asyncio\nt = asyncio.ensure_future(bash('sleep 3'))\nawait asyncio.wait([t])\nt.result()")
        self.assertEqual(kind(events, "error")["ename"], "StillRunning", events)
        self.assertIsNotNone(repl.completed(events, timeout=10))

    def test_wait_for_with_a_short_timeout_still_times_out_and_kills(self):
        repl = self.start(5)
        marker = os.path.join(self.tmp, "marker")
        events = repl.run("short", f"import asyncio\nawait asyncio.wait_for(bash('sleep 1.5 && touch {marker}'), 0.5)")
        self.assertEqual(kind(events, "error")["ename"], "TimeoutError", events)
        self.assertIsNone(repl.completed(events, timeout=2.5))
        self.assertFalse(os.path.exists(marker))

    def test_a_gather_outside_cell_code_waits_as_before(self):
        repl = self.start(0.5)
        Path(self.tmp, "helper.py").write_text("import asyncio\n\nasync def both(a, b):\n    return await asyncio.gather(a, b)\n")
        events = repl.run("helper", "import helper\n[r.output for r in await helper.both(bash('sleep 1.5; echo s1'), bash('sleep 1; echo s2'))]")
        self.assertEqual(result(events), "['s1\\n', 's2\\n']", events)

    def test_a_python_without_wrap_awaitable_still_bounds_a_direct_await(self):
        """Python 3.12 dropped asyncio.tasks._wrap_awaitable, and a failed install would drop the whole default (11-04)."""
        repl = self.start(1, "import asyncio.tasks\ndel asyncio.tasks._wrap_awaitable\n")
        events = repl.run("long", "await bash('sleep 3')")
        self.assertEqual(kind(events, "error")["ename"], "StillRunning", events)

    def test_sleeps_stop_once_a_cell_has_slept_the_limit(self):
        repl = self.start(1)
        events = repl.run("sleeps", "import asyncio, time\ntime.sleep(0.6)\nawait asyncio.sleep(0.6)\nprint('third')\ntime.sleep(0.1)\nprint('fourth')")
        error = kind(events, "error")
        self.assertEqual(error and error["ename"], "SleepBudgetSpent", events)
        self.assertIn("board.wake", error["evalue"])
        out = "".join(e["text"] for e in events if e.get("event") == "stdout")
        self.assertIn("third", out)
        self.assertNotIn("fourth", out)
        self.assertEqual(kind(repl.run("next", "time.sleep(0.6)\n'ok'"), "result")["text"], "'ok'")
        background = (
            "async def bg():\n    for _ in range(3):\n        await asyncio.sleep(0.5)\n    return 'bg'\n"
            "t = asyncio.create_task(bg())\nawait asyncio.to_thread(time.sleep, 1.2)\nawait t"
        )
        self.assertEqual(result(repl.run("background", background)), "'bg'")


if __name__ == "__main__":
    unittest.main()
