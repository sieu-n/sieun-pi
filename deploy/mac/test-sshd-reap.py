#!/usr/bin/python3
"""Tests for sshd-reap.py: when a run is due, and ending many sessions at once. Run: python3 -B deploy/mac/test-sshd-reap.py"""
import importlib.util
import os
import subprocess
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
