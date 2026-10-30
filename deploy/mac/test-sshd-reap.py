#!/usr/bin/python3
"""Tests for sshd-reap.py: when a run is due, and ending many sessions at once. Run: python3 -B deploy/mac/test-sshd-reap.py"""
import importlib.util
import json
import os
import subprocess
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("sshd_reap", os.path.join(HERE, "sshd-reap.py"))
reap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reap)


def orphan(command):
    """Start `command` detached from this process, so init reaps it and a dead one leaves no zombie; returns its pid."""
    return int(subprocess.run(["sh", "-c", "(%s) </dev/null >/dev/null 2>&1 & echo $!" % command], capture_output=True, text=True).stdout)


class Plan(unittest.TestCase):
    def test_quiet_tick_runs_nothing(self):
        self.assertEqual(reap.plan(0.01, 60, False), (None, False))

    def test_interval_runs(self):
        self.assertEqual(reap.plan(0.01, reap.INTERVAL_S, False), ("interval", False))

    def test_sleep_runs_at_once_and_starts_catch_up(self):
        self.assertEqual(reap.plan(reap.SLEPT_S + 1, 10, False), ("wake", True))

    def test_short_stall_is_no_sleep(self):
        self.assertEqual(reap.plan(reap.SLEPT_S - 1, 10, False), (None, False))

    def test_catch_up_runs_every_tick(self):
        self.assertEqual(reap.plan(0.01, reap.TICK_S, True), ("after wake", True))


class Tick(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        reap.LOG_FILE = os.path.join(self.folder.name, "log.jsonl")
        self.calls = []
        self.unreached = 0

    def tearDown(self):
        self.folder.cleanup()

    def run_fake(self, why):
        self.calls.append(why)
        return self.unreached

    def logged(self):
        with open(reap.LOG_FILE) as fh:
            return [json.loads(line) for line in fh]

    def test_first_tick_runs_then_waits_for_the_interval(self):
        state = {"wall": 1000.0, "mono": 50.0, "run": 0.0, "catching_up": False}
        state = reap.tick(state, 1005.0, 55.0, self.run_fake)
        state = reap.tick(state, 1010.0, 60.0, self.run_fake)
        state = reap.tick(state, 1005.0 + reap.INTERVAL_S, 55.0 + reap.INTERVAL_S, self.run_fake)
        self.assertEqual(self.calls, ["interval", "interval"])
        self.assertFalse(state["catching_up"])

    def test_wake_runs_at_once_and_every_tick_until_the_box_answers(self):
        state = {"wall": 1000.0, "mono": 50.0, "run": 1000.0, "catching_up": False}
        self.unreached = 1
        state = reap.tick(state, 1000.0 + 3600, 55.0, self.run_fake)
        state = reap.tick(state, 1000.0 + 3605, 60.0, self.run_fake)
        self.unreached = 0
        state = reap.tick(state, 1000.0 + 3610, 65.0, self.run_fake)
        state = reap.tick(state, 1000.0 + 3615, 70.0, self.run_fake)
        self.assertEqual(self.calls, ["wake", "after wake", "after wake"])
        self.assertFalse(state["catching_up"])
        self.assertEqual(self.logged(), [{"ts": self.logged()[0]["ts"], "event": "wake", "slept_s": 3595}])

    def test_a_failed_run_is_logged_and_the_loop_goes_on(self):
        def broken(why):
            raise OSError("lsof gone")
        state = {"wall": 1000.0, "mono": 50.0, "run": 0.0, "catching_up": False}
        state = reap.tick(state, 1005.0, 55.0, broken)
        self.assertEqual(state["run"], 1005.0)
        self.assertEqual(self.logged()[0]["event"], "error")


class EndSessions(unittest.TestCase):
    def test_ends_all_and_kills_one_that_ignores_term(self):
        plain = [orphan("sleep 60") for _ in range(3)]
        stubborn = orphan("trap '' TERM; while :; do sleep 1; done")
        time.sleep(0.3)
        started = time.monotonic()
        done = reap.end_sessions(plain + [stubborn])
        self.assertLess(time.monotonic() - started, 7)
        self.assertEqual({pid: done[pid] for pid in plain}, {pid: "SIGTERM" for pid in plain})
        self.assertEqual(done[stubborn], "SIGKILL")
        time.sleep(0.3)
        self.assertFalse(any(reap.alive(pid) for pid in plain + [stubborn]))

    def test_gone_pid(self):
        pid = orphan("true")
        time.sleep(0.3)
        self.assertEqual(reap.end_sessions([pid]), {pid: "gone"})


if __name__ == "__main__":
    unittest.main()
