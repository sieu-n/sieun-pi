import argparse
import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("resume_paused", REPO / "skills/resume-paused-sessions/scripts/resume_paused.py")
resume_paused = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(resume_paused)

NOW = dt.datetime(2026, 10, 5, 20, 0, tzinfo=dt.timezone.utc)


def at(minutes_ago):
    return (NOW - dt.timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z")


def assistant(minutes_ago, stop, error=None):
    message = {"role": "assistant", "stopReason": stop, "content": []}
    if error:
        message["errorMessage"] = error
    return {"type": "message", "timestamp": at(minutes_ago), "message": message}


def role(minutes_ago, name):
    return {"type": "message", "timestamp": at(minutes_ago), "message": {"role": name, "content": "x"}}


class ResumePausedTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.sessions = []
        self.sent = []

    def session(self, sid, entries, parent=None, activity="idle", **flags):
        path = self.root / f"{sid}.jsonl"
        path.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n")
        row = {"id": "0" * 24 + sid, "lifecycle": "live", "activity": activity, "sessionFile": str(path),
               "sessionName": sid, "runtimeKind": "subagent" if parent else "top-level", "lastActivityAt": at(1), **flags}
        if parent:
            row["parentActiveSessionId"] = parent
        self.sessions.append(row)

    def run_resume(self, dry_run=False, include_children=False):
        args = argparse.Namespace(message="continue", since_minutes=1440, dry_run=dry_run,
                                  include_children=include_children, state=str(self.root / "state.json"))
        with patch.object(resume_paused, "send", side_effect=lambda target, text: self.sent.append((target, text)) or {"deliveryStatus": "delivered"}):
            return resume_paused.resume(self.sessions, args, NOW)

    def test_network_and_sign_in_errors_count_other_errors_do_not(self):
        self.session("aaaaaaaaaaaa", [assistant(30, "error", "Connection error.")])
        self.session("bbbbbbbbbbbb", [assistant(30, "error", 'Failed to resolve API key for provider "anthropic" from shell command: pi-pool-token')])
        self.session("cccccccccccc", [assistant(30, "error", "Provider rejected the request (invalid_request_error, 400)")])
        self.session("dddddddddddd", [assistant(30, "aborted")])
        self.session("eeeeeeeeeeee", [assistant(30, "stop")])
        report = self.run_resume(dry_run=True)
        self.assertEqual(sorted(p["id"] for p in report["paused"]), ["aaaaaaaaaaaa", "bbbbbbbbbbbb"])
        self.assertEqual(self.sent, [])

    def test_cut_off_turn_counts_after_the_grace_period(self):
        self.session("aaaaaaaaaaaa", [assistant(40, "toolUse"), role(40, "toolResult")])
        self.session("bbbbbbbbbbbb", [assistant(1, "toolUse"), role(0.5, "toolResult")])
        self.session("cccccccccccc", [role(20, "user")], activity="working")
        report = self.run_resume(dry_run=True)
        self.assertEqual([(p["id"], p["reason"]) for p in report["paused"]], [("aaaaaaaaaaaa", "cut_off")])

    def test_idle_head_gets_continue_with_the_stopped_children(self):
        self.session("headheadhead", [assistant(5, "stop")])
        self.session("childchild01", [assistant(30, "error", "fetch failed")], parent="headheadhead")
        report = self.run_resume()
        self.assertEqual(report["heads"][0]["id"], "headheadhead")
        self.assertEqual(len(self.sent), 1)
        target, text = self.sent[0]
        self.assertEqual(target, "headheadhead")
        self.assertTrue(text.startswith("continue\n\n"))
        self.assertIn("childchild01 (childchild01)", text)

    def test_working_head_gets_a_note_and_a_working_head_alone_is_skipped(self):
        self.session("headheadhead", [assistant(5, "toolUse")], activity="working")
        self.session("childchild01", [assistant(30, "error", "WebSocket closed 1006 Connection ended")], parent="headheadhead")
        self.run_resume()
        self.assertEqual(len(self.sent), 1)
        self.assertTrue(self.sent[0][1].startswith("Note while you work:"))

    def test_resumed_or_redriven_runs_stop_counting(self):
        self.session("headheadhead", [assistant(50, "stop"), role(10, "user"), assistant(9, "stop")])
        self.session("childchild01", [assistant(30, "error", "Connection error.")], parent="headheadhead")
        self.session("loneloneone1", [assistant(30, "error", "Connection error.")])
        report = self.run_resume()
        self.assertEqual([p["id"] for p in report["paused"]], ["loneloneone1"])
        self.assertEqual([target for target, _ in self.sent], ["loneloneone1"])
        again = self.run_resume(dry_run=True)
        self.assertEqual(again["paused"], [])

    def test_old_interruptions_are_ignored(self):
        self.session("aaaaaaaaaaaa", [assistant(3000, "error", "Connection error.")], lastActivityAt=at(3000))
        self.assertEqual(self.run_resume(dry_run=True)["paused"], [])


if __name__ == "__main__":
    unittest.main()
