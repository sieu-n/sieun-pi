import json
from pathlib import Path
import subprocess
import unittest

from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()


TESTS = Path(__file__).resolve().parent
EXTENSION = TESTS.parent / "app" / "extension" / "index.ts"
LINE = "account Auto a@x 5h 10% · week 5% · fable 1%"


def drive(*steps):
    """Runs status_driver.mjs: the extension with a fake clock, fake timers and a fake pool CLI."""
    result = subprocess.run(["node", str(TESTS / "status_driver.mjs"), str(EXTENSION), json.dumps(steps)],
                            capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise AssertionError(result.stdout + result.stderr)
    return json.loads(result.stdout.strip().splitlines()[-1])


class StatusLine(unittest.TestCase):
    def test_rlm_child_never_runs_who(self):
        run = drive({"op": "start", "name": "child", "depth": 1},
                    {"op": "turns", "name": "child", "count": 10, "every": 6000},
                    {"op": "advance", "ms": 120_000})
        self.assertEqual(run["who"], 0, run["calls"])
        self.assertIsNone(run["widgets"]["child"])
        self.assertIn("adopt-logins", run["calls"])

    def test_session_without_ui_never_runs_who(self):
        run = drive({"op": "start", "name": "rpc", "hasUI": False},
                    {"op": "turns", "name": "rpc", "count": 10, "every": 6000},
                    {"op": "advance", "ms": 120_000})
        self.assertEqual(run["who"], 0, run["calls"])

    def test_ui_session_runs_who_once_per_minute(self):
        run = drive({"op": "start", "name": "ui"},
                    {"op": "turns", "name": "ui", "count": 10, "every": 6000},
                    {"op": "advance", "ms": 120_000})
        self.assertEqual(run["who"], 4, run["calls"])
        whos = [at for verb, at in zip(run["calls"], run["times"]) if verb == "who"]
        self.assertEqual([at - whos[0] for at in whos], [0, 60_000, 120_000, 180_000])
        self.assertEqual(run["widgets"]["ui"], LINE)

    def test_concurrent_refreshes_share_one_run(self):
        run = drive({"op": "start", "name": "ui"},
                    {"op": "sleep", "ms": 120_000},
                    {"op": "mark", "label": "wake"},
                    {"op": "concurrent", "name": "ui", "count": 5},
                    {"op": "advance", "ms": 1})
        self.assertEqual(run["whoAfterMark"]["wake"], 1, run["calls"])

    def test_sessions_in_one_process_share_runs(self):
        run = drive({"op": "start", "name": "a"}, {"op": "start", "name": "b"},
                    {"op": "turns", "name": "a", "count": 5, "every": 6000},
                    {"op": "turns", "name": "b", "count": 5, "every": 6000},
                    {"op": "advance", "ms": 120_000})
        self.assertEqual(run["who"], 4, run["calls"])
        self.assertEqual(run["widgets"], {"a": LINE, "b": LINE})

    def test_model_and_account_changes_run_who_at_once(self):
        run = drive({"op": "start", "name": "ui"},
                    {"op": "mark", "label": "model"}, {"op": "model", "name": "ui"},
                    {"op": "mark", "label": "account"}, {"op": "account", "name": "ui", "target": "a@x"})
        self.assertEqual(run["whoAfterMark"], {"model": 2, "account": 1}, run["calls"])


def failure(details, text="Provider rate limit exceeded (rate_limit_error, 429): try again later."):
    return {"role": "assistant", "stopReason": "error", "provider": "anthropic", "errorMessage": text,
            "diagnostics": [{"type": "provider_stream_failure", "details": details}]}


NOW_SEC = 1_000_000 / 1000


class WaitForASlot(unittest.TestCase):
    """A 429 with no account left waits for the session's own slot, never the
    provider's reset (2026-10-12 15:04: a 1 h 45 min wait while another account
    came back at 15:30)."""

    def test_a_429_with_no_next_account_waits_until_the_slot(self):
        run = drive({"op": "start", "name": "ui"},
                    {"op": "reply", "verb": "limited",
                     "reply": {"selection": {"mode": "auto"}, "account": "x@x", "until": NOW_SEC + 6339, "next": None, "retry_at": NOW_SEC + 600}},
                    {"op": "message", "name": "ui",
                     "message": failure({"status": 429, "kind": "rate_limit", "retryAfterMs": 6_339_000})})
        [message] = run["messages"]
        [details] = [d["details"] for d in message["diagnostics"] if d["type"] == "provider_stream_failure"]
        self.assertEqual((details["retryAfterMs"], details["kind"], details["status"]), (600_000, "rate_limit", 429))
        self.assertIn("Try again in 10 minutes.", message["errorMessage"])

    def test_a_slot_two_hours_away_is_one_sleep(self):
        """R5 holds a slot at the reset of the account that frees first, often hours away,
        so a recheck before it only adds another failed message to the session."""
        run = drive({"op": "start", "name": "ui"},
                    {"op": "reply", "verb": "limited",
                     "reply": {"selection": {"mode": "auto"}, "account": "x@x", "until": NOW_SEC + 9000, "next": None, "retry_at": NOW_SEC + 7000}},
                    {"op": "message", "name": "ui", "message": failure({"status": 429, "retryAfterMs": 9_000_000})})
        [details] = [d["details"] for d in run["messages"][0]["diagnostics"] if d["type"] == "provider_stream_failure"]
        self.assertEqual(details["retryAfterMs"], 7_000_000)

    def test_a_429_with_a_next_account_retries_at_once(self):
        run = drive({"op": "start", "name": "ui"},
                    {"op": "reply", "verb": "limited", "reply": {"selection": {"mode": "auto"}, "account": "x@x", "until": NOW_SEC + 600, "next": "y@x", "retry_at": None}},
                    {"op": "message", "name": "ui", "message": failure({"status": 429, "retryAfterMs": 600_000})})
        [details] = [d["details"] for d in run["messages"][0]["diagnostics"] if d["type"] == "provider_stream_failure"]
        self.assertNotIn("retryAfterMs", details)

    def test_a_hook_that_gave_no_token_to_a_waiting_session_waits_for_its_slot(self):
        text = 'Failed to resolve API key for provider "anthropic" from shell command: /x/bin/pi-pool-token'
        run = drive({"op": "start", "name": "ui"},
                    {"op": "reply", "verb": "who", "reply": {"providers": {"anthropic": {
                        "selection": {"mode": "auto"}, "current": None, "wait": {"account": "y", "slot_at": NOW_SEC + 300}}}}},
                    {"op": "message", "name": "ui", "message": {
                        "role": "assistant", "stopReason": "error", "provider": "anthropic", "errorMessage": text,
                        "diagnostics": [{"type": "agent_lifecycle_failure"}]}})
        [message] = run["messages"]
        self.assertEqual([d["type"] for d in message["diagnostics"]], ["provider_stream_failure"])
        self.assertEqual(message["diagnostics"][0]["details"]["retryAfterMs"], 300_000)

    def test_the_mac_session_of_10_18_0831z_waits_its_whole_slot_in_one_wait(self):
        """10-18 08:32:37Z: a new Mac session (01a14e22) got no token, its slot on the
        holder was 08:55:30Z, and the 15-min cap made its wait end at 08:47:38Z with a
        second error line. The wait now runs to the slot, with the time in its text."""
        text = 'Failed to resolve API key for provider "anthropic" from shell command: /Users/x/.config/pi-pool/bin/pi-pool-token'
        slot = NOW_SEC + (8 * 3600 + 55 * 60 + 30) - (8 * 3600 + 32 * 60 + 37)
        run = drive({"op": "start", "name": "ui"},
                    {"op": "reply", "verb": "who", "reply": {"providers": {"anthropic": {
                        "selection": {"mode": "auto"}, "current": None, "wait": {"account": "y", "slot_at": slot}}}}},
                    {"op": "message", "name": "ui", "message": {
                        "role": "assistant", "stopReason": "error", "provider": "anthropic", "errorMessage": text,
                        "diagnostics": [{"type": "agent_lifecycle_failure"}]}})
        [message] = run["messages"]
        [details] = [d["details"] for d in message["diagnostics"] if d["type"] == "provider_stream_failure"]
        self.assertEqual((details["retryAfterMs"], details["kind"]), (1_373_000, "rate_limit"))
        self.assertIn("this session waits for its slot at 1970-01-01T00:39:33.000Z", message["errorMessage"])
        self.assertIn("Try again in 23 minutes.", message["errorMessage"])


if __name__ == "__main__":
    unittest.main()
