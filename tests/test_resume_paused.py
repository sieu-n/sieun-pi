import argparse
import datetime as dt
import importlib.util
import json
import os
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
        logs = patch.object(resume_paused, "LOG_DIR", self.root / "no-logs", create=True)
        logs.start()
        self.addCleanup(logs.stop)

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
        with patch.object(resume_paused, "send", side_effect=lambda target, text: self.sent.append((target, text)) or {"deliveryStatus": "delivered"}), \
                patch.object(resume_paused, "pool_bin", return_value=None):
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
        # A reload gives the run a new short id; the record still matches by the full session id.
        lone = next(row for row in self.sessions if row["sessionName"] == "loneloneone1")
        lone["sessionId"], lone["id"] = lone["id"], "1" * 24 + "newshortid01"
        self.assertEqual(self.run_resume(dry_run=True)["paused"], [])

    def test_aborted_or_archived_runs_do_not_count(self):
        aborted = {"type": "message", "timestamp": at(20), "message": {"role": "toolResult", "isError": True,
                                                                       "content": [{"type": "text", "text": "Request was aborted"}]}}
        self.session("aaaaaaaaaaaa", [assistant(21, "toolUse"), aborted])
        self.session("bbbbbbbbbbbb", [assistant(21, "toolUse"), role(20, "toolResult"),
                                      {"type": "session_state", "timestamp": at(20), "state": {"status": "archived"}}])
        self.assertEqual(self.run_resume(dry_run=True)["paused"], [])

    def test_empty_model_reply_counts_and_full_parent_ids_find_the_head(self):
        self.session("headheadhead", [assistant(5, "stop")])
        self.session("childchild01", [role(31, "toolResult"), assistant(30, "toolUse")],
                     parent="01a0edbc-9c2c-76a3-9e56-f1e8headheadhead"[-36:].replace("f1e8headheadhead", "") + "headheadhead")
        report = self.run_resume(dry_run=True)
        self.assertEqual([(p["id"], p["reason"], p["head"]) for p in report["paused"]], [("childchild01", "empty_reply", "headheadhead")])

    def test_rate_limits_count_only_once_the_account_can_serve(self):
        self.session("aaaaaaaaaaaa", [assistant(30, "error", "Provider rate limit exceeded (rate_limit_error, 429): would exceed")])
        with patch.object(resume_paused, "account_blocker", return_value="claude3@slack.green is depleted"):
            self.assertEqual(self.run_resume(dry_run=True)["paused"], [])
        with patch.object(resume_paused, "account_blocker", return_value=None):
            self.assertEqual([p["id"] for p in self.run_resume(dry_run=True)["paused"]], ["aaaaaaaaaaaa"])

    def test_hung_working_session_counts_only_with_nothing_long_running(self):
        self.session("hunghunghung", [assistant(80, "toolUse"), role(79, "toolResult")], activity="working", isStreaming=True, lastActivityAt=at(79))
        self.session("toolstoolsto", [assistant(50, "toolUse")], activity="working", isRunningTools=True, lastActivityAt=at(50))
        self.session("childchildch", [assistant(80, "toolUse")], activity="working", hasRunningRlmChildren=True, lastActivityAt=at(80))
        self.session("freshfreshfr", [assistant(5, "toolUse")], activity="working", isStreaming=True, lastActivityAt=at(5))
        for row in self.sessions:
            os.utime(row["sessionFile"], (NOW.timestamp() - 79 * 60,) * 2)
        report = self.run_resume()
        self.assertEqual([(p["id"], p["reason"]) for p in report["paused"]], [("hunghunghung", "hung")])
        self.assertEqual(self.sent, [])  # a hung head is aborted by the chat first, never messaged while hung
        self.assertIn("hung", report["heads"][0]["result"])

    def test_tool_call_stuck_for_two_hours_counts_a_long_poll_does_not(self):
        self.session("stucktoolcal", [assistant(125, "toolUse")], activity="working", isStreaming=True, isRunningTools=True, lastActivityAt=at(125))
        self.session("longpolllong", [assistant(95, "toolUse")], activity="working", isStreaming=True, isRunningTools=True, lastActivityAt=at(95))
        os.utime(self.sessions[0]["sessionFile"], (NOW.timestamp() - 125 * 60,) * 2)
        os.utime(self.sessions[1]["sessionFile"], (NOW.timestamp() - 95 * 60,) * 2)
        report = self.run_resume(dry_run=True)
        self.assertEqual([(p["id"], p["reason"]) for p in report["paused"]], [("stucktoolcal", "hung")])
        self.assertIn("tool call", report["paused"][0]["error"])

    def test_retry_loop_and_finished_turn_are_not_hung(self):
        self.session("retryretryre", [assistant(3, "error", "undefined is not an object")], activity="working", isSessionActive=True, lastActivityAt=at(60))
        self.session("finishedfini", [assistant(60, "stop")], activity="working", isSessionActive=True, lastActivityAt=at(60))
        for row in self.sessions:
            os.utime(row["sessionFile"], (NOW.timestamp() - 3600,) * 2)
        self.assertEqual(self.run_resume(dry_run=True)["paused"], [])

    def test_unstuck_run_is_resumed_after_its_abort(self):
        aborted = {"type": "message", "timestamp": at(0.5), "message": {"role": "assistant", "stopReason": "aborted", "errorMessage": "Request was aborted", "content": []}}
        self.session("hunghunghung", [role(79, "toolResult"), aborted])
        resume_paused.UNSTUCK.add("0" * 24 + "hunghunghung")
        self.addCleanup(resume_paused.UNSTUCK.clear)
        self.run_resume()
        self.assertEqual([target for target, _ in self.sent], ["hunghunghung"])

    def test_model_refusal_counts(self):
        self.session("refusedrefus", [assistant(30, "error", "Model refused to respond (refusal) [request_id: req_1]")])
        self.assertEqual([p["id"] for p in self.run_resume(dry_run=True)["paused"]], ["refusedrefus"])

    def test_runs_in_a_failed_worker_are_listed_and_their_head_is_never_messaged(self):
        # 10-12: a Prime worker died under swap; its head and 22 children kept reading "working", and every abort and send
        # answered "Session worker is failed", so Resume could never bring them back.
        self.session("headheadhead", [assistant(80, "toolUse")], activity="working", isStreaming=True, hasRunningRlmChildren=True,
                     lastActivityAt=at(80), workerState="failed")
        self.session("childchild01", [assistant(175, "toolUse")], parent="headheadhead", activity="working", isStreaming=True,
                     isRunningTools=True, lastActivityAt=at(175), workerState="failed")
        for row in self.sessions:
            os.utime(row["sessionFile"], (NOW.timestamp() - 175 * 60,) * 2)
        report = self.run_resume()
        self.assertEqual([(p["id"], p["reason"], p["head_session_id"]) for p in report["paused"]],
                         [("headheadhead", "worker_failed", "0" * 24 + "headheadhead"), ("childchild01", "worker_failed", "0" * 24 + "headheadhead")])
        self.assertEqual(self.sent, [])
        self.assertIn("worker failed", report["heads"][0]["result"])

    def test_one_failed_send_does_not_stop_the_other_heads(self):
        self.session("deaddeaddead", [assistant(30, "error", "Connection error.")])
        self.session("liveliveliv1", [assistant(30, "error", "Connection error.")])
        sent = []

        def send(target, text):
            if target == "deaddeaddead":
                raise resume_paused.CommandError("prime-agent send failed (1): Session worker is stopping")
            sent.append(target)
            return {"deliveryStatus": "delivered"}

        args = argparse.Namespace(message="continue", since_minutes=1440, dry_run=False, include_children=False, state=str(self.root / "state.json"))
        with patch.object(resume_paused, "send", side_effect=send), patch.object(resume_paused, "pool_bin", return_value=None):
            report = resume_paused.resume(self.sessions, args, NOW)
        self.assertEqual(sent, ["liveliveliv1"])
        self.assertIn("Session worker is stopping", report["heads"][0]["result"]["error"])
        again = self.run_resume(dry_run=True)
        self.assertEqual([p["id"] for p in again["paused"]], ["deaddeaddead"], "the run whose send failed still shows")

    def test_old_interruptions_are_ignored(self):
        self.session("aaaaaaaaaaaa", [assistant(3000, "error", "Connection error.")], lastActivityAt=at(3000))
        self.assertEqual(self.run_resume(dry_run=True)["paused"], [])

    def run_direct(self, only=None, dry_run=False):
        args = argparse.Namespace(message="continue", since_minutes=1440, dry_run=dry_run, include_children=False, direct=True,
                                  only=",".join(only) if only else "", state=str(self.root / "state.json"))
        with patch.object(resume_paused, "send", side_effect=lambda target, text: self.sent.append((target, text)) or {"deliveryStatus": "delivered"}), \
                patch.object(resume_paused, "pool_bin", return_value=None):
            return resume_paused.resume(self.sessions, args, NOW)

    def test_direct_messages_each_stopped_job_itself_even_after_its_chat_got_a_message(self):
        # Crawler VP 10-15: alert follow through stopped mid-tool at 13:29Z and curl-multi-gate, a job two levels down, on a token hook
        # failure at 13:48Z. The chat took check-in and alert messages after both, so neither counted, and both sat until a check-in found them.
        self.session("chatchatchat", [assistant(50, "stop"), role(10, "user"), assistant(9, "stop")])
        self.session("alertfollowt", [assistant(41, "toolUse"), role(40, "toolResult")], parent="chatchatchat")
        self.session("tunnelbudget", [assistant(31, "toolUse")], parent="chatchatchat", activity="working", hasRunningRlmChildren=True)
        self.session("curlmultigat", [assistant(30, "error", 'Failed to resolve API key for provider "anthropic" from shell command: pi-pool-token')],
                     parent="tunnelbudget")
        report = self.run_direct()
        self.assertEqual(sorted((p["id"], p["reason"], p["head_session_id"]) for p in report["paused"]),
                         [("alertfollowt", "cut_off", "0" * 24 + "chatchatchat"), ("curlmultigat", "error", "0" * 24 + "chatchatchat")])
        self.assertEqual(sorted(self.sent), [("alertfollowt", "continue"), ("curlmultigat", "continue")])
        self.assertEqual(report["heads"], [])
        self.assertEqual(self.run_direct(dry_run=True)["paused"], [], "each interruption is resumed once")

    def test_direct_only_acts_on_the_runs_it_names(self):
        self.session("chatchatchat", [assistant(30, "error", "Connection error.")])
        self.session("jobjobjobjob", [assistant(30, "error", "Connection error.")], parent="chatchatchat")
        report = self.run_direct(only=["0" * 24 + "jobjobjobjob"])
        self.assertEqual([p["id"] for p in report["paused"]], ["jobjobjobjob"])
        self.assertEqual(self.sent, [("jobjobjobjob", "continue")])

    def test_direct_never_messages_a_hung_or_dead_worker_run(self):
        self.session("hunghunghung", [assistant(80, "toolUse"), role(79, "toolResult")], activity="working", isStreaming=True, lastActivityAt=at(79))
        self.session("deaddeaddead", [assistant(80, "toolUse")], workerState="failed")
        os.utime(self.sessions[0]["sessionFile"], (NOW.timestamp() - 79 * 60,) * 2)
        report = self.run_direct()
        self.assertEqual(sorted(p["reason"] for p in report["paused"]), ["hung", "worker_failed"])
        self.assertEqual(self.sent, [])

    def test_an_abort_that_ended_a_retry_of_an_interruption_counts_as_that_interruption(self):
        # 10-15: checkin job end handoff failed on the token hook at 13:48:20Z and its retry was aborted at 13:48:36Z; it sat on the abort.
        error = 'Failed to resolve API key for provider "anthropic" from shell command: pi-pool-token pi-pool: the token hook gave no token'
        self.session("retryaborted", [assistant(31, "error", error), assistant(30, "aborted", "Request was aborted")])
        self.session("ownerstopped", [role(31, "toolResult"), assistant(30, "aborted", "Request was aborted")])
        with patch.object(resume_paused, "worker_shutdowns", return_value=[]):
            report = self.run_resume(dry_run=True)
        self.assertEqual([(p["id"], p["reason"], p["error"]) for p in report["paused"]], [("retryaborted", "error", error)])

    def test_an_abort_written_when_the_daemon_shut_its_worker_down_counts(self):
        # 10-15 16:06:56Z: the daemon sent SIGTERM to 92 session workers; ops land follow through and posts-release-requeue-r2 got
        # "Request was aborted" within 0.05 s of their worker's SIGTERM and sat on it.
        self.session("workerkilled", [role(31, "toolResult"), assistant(30, "aborted", "Request was aborted")])
        self.session("ownerstopped", [role(21, "toolResult"), assistant(20, "aborted", "Request was aborted")])
        shutdown = NOW - dt.timedelta(minutes=30, seconds=-0.05)
        with patch.object(resume_paused, "worker_shutdowns", return_value=[shutdown]):
            report = self.run_resume(dry_run=True)
        self.assertEqual([(p["id"], p["reason"]) for p in report["paused"]], [("workerkilled", "worker_stopped")])

    def test_worker_shutdowns_reads_the_sigterm_lines_of_the_daemon_logs(self):
        logs = self.root / "logs"
        logs.mkdir()
        (logs / "daemon.sock.abc.log.old").write_text(
            "[2026-10-15T14:35:39.152Z] supervisor: Session worker 5ede7cd5adb3 stderr: received SIGTERM; shutting down\n"
            "[2026-10-15T14:35:39.200Z] supervisor: Session worker 5ede7cd5adb3 stderr: shutting down (exit 143); closing 1 active session(s)\n")
        (logs / "daemon.sock.abc.log").write_text(
            "[2026-10-15T16:06:56.136Z] supervisor: Session worker c43b4216dc75 stderr: received SIGTERM; shutting down\n"
            "[2026-10-15T16:07:43.843Z] supervisor: Prime Agent daemon supervisor 748e listening on /tmp/daemon.sock\n")
        with patch.object(resume_paused, "LOG_DIR", logs):
            found = resume_paused.worker_shutdowns()
        self.assertEqual([stamp.isoformat() for stamp in found], ["2026-10-15T14:35:39.152000+00:00", "2026-10-15T16:06:56.136000+00:00"])


if __name__ == "__main__":
    unittest.main()
