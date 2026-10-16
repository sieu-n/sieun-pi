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

    def owners(self, *ids):
        resume_paused.OWNERS.update(ids)
        self.addCleanup(resume_paused.OWNERS.clear)

    def test_a_step_owner_whose_worker_stopped_before_its_first_task_gets_that_task(self):
        # frontend bro 10-15: watchlist viewers and scroll was spawned at 15:37:14Z, its task waited behind the chat's worker, and the
        # worker stop at 16:07:02Z lost it. Its file held only the header and two worker recovery notices, rlm-subagent.json kept the
        # task, nothing resumed it, and p157 read job_ended for 3 h until the chat sent "continue" at 18:57Z.
        recovery = {"type": "custom_message", "customType": "prime-agent.worker_recovery", "timestamp": at(113),
                    "content": "<prime_agent_worker_interrupted>The isolated session worker stopped during in-flight work."}
        header = [{"type": "session", "timestamp": at(143)}, {"type": "model_change", "timestamp": at(143)}]
        self.session("watchlistvie", [*header, recovery, {**recovery, "timestamp": at(112)}], parent="frontendbro0")
        (self.root / "rlm-subagent.json").write_text(json.dumps({"childId": "sub-1ae59fb8", "status": "running", "prompt": "Owner's words: watchlist, load on scroll."}))
        self.assertEqual(self.run_direct(dry_run=True)["paused"], [], "a job no open step names is left alone")
        self.owners("0" * 24 + "watchlistvie")
        report = self.run_direct()
        self.assertEqual([(p["id"], p["reason"], p["errored_at"]) for p in report["paused"]], [("watchlistvie", "never_started", at(112))])
        self.assertEqual(self.sent, [("watchlistvie", resume_paused.NEVER_STARTED_INTRO + "Owner's words: watchlist, load on scroll.")])
        self.assertEqual(self.run_direct(dry_run=True)["paused"], [], "the task is sent once")

    def test_a_job_that_got_its_task_is_not_never_started(self):
        recovery = {"type": "custom_message", "customType": "prime-agent.worker_recovery", "timestamp": at(30), "content": "x"}
        self.session("startedjob01", [role(40, "user"), assistant(39, "stop"), recovery])
        (self.root / "rlm-subagent.json").write_text(json.dumps({"prompt": "task"}))
        self.owners("0" * 24 + "startedjob01")
        self.assertEqual(self.run_direct(dry_run=True)["paused"], [])

    def test_a_step_owner_aborted_and_archived_with_no_worker_is_resumed_by_its_full_id(self):
        # frontend bro 10-15: stuck steps root cause waited 103rd in pi-pool's queue; the workers' SIGTERM at 17:43:22Z aborted it, the
        # daemon restarted, and it no longer showed in `prime-agent list`. At 18:25Z the owner's stop archived it with another empty abort,
        # and the lift at 19:13Z resumed nothing, so p158 read stuck.
        queued = {"type": "custom", "customType": "pi-pool-queue", "timestamp": at(31), "data": {"position": 103}}
        archived = {"type": "session_state", "timestamp": at(30.1), "state": {"status": "archived"}}
        aborted = {"type": "message", "timestamp": at(30), "message": {"role": "assistant", "stopReason": "aborted", "errorMessage": "Request was aborted",
                                                                       "content": [{"type": "text", "text": ""}]}}
        full = "01a14075-ec87-74e6-a080-109665a0941d"
        saved = [{"id": full, "sessionId": full, "lifecycle": "archived", "activity": "idle", "sessionName": "stuck steps root cause",
                  "lastActivityAt": at(30)}]
        path = self.root / "root.jsonl"
        path.write_text("\n".join(json.dumps(entry) for entry in [role(32, "user"), queued, archived, aborted]) + "\n")
        saved[0]["sessionFile"] = str(path)
        self.assertEqual(resume_paused.with_saved_owners(self.sessions, saved, set()), [])
        self.sessions = resume_paused.with_saved_owners(self.sessions, saved, {full})
        with patch.object(resume_paused, "worker_shutdowns", return_value=[]):
            self.owners(full)
            report = self.run_direct()
        self.assertEqual([(p["reason"], p["target"]) for p in report["paused"]], [("aborted", full)])
        self.assertEqual(self.sent, [(full, "continue")])

    def test_an_empty_abort_of_a_job_that_owns_no_open_step_still_does_not_count(self):
        self.session("ownerstopped", [role(21, "toolResult"), assistant(20, "aborted", "Request was aborted")])
        self.session("stepownerjob", [role(21, "toolResult"), assistant(20, "aborted", "Request was aborted")])
        self.owners("0" * 24 + "stepownerjob")
        with patch.object(resume_paused, "worker_shutdowns", return_value=[]):
            report = self.run_direct(dry_run=True)
        self.assertEqual([(p["id"], p["reason"]) for p in report["paused"]], [("stepownerjob", "aborted")])

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


    def test_a_job_archived_and_aborted_by_a_daemon_restart_is_resumed(self):
        # 10-16 00:19:58Z: the daemon supervisor stopped and a new one listened at 00:20:13Z. daily code health report (no open step) was
        # archived at 00:19:58.026Z with an empty abort 1 ms later; the default list then showed it archived and no sweep continued it.
        archived = {"type": "session_state", "timestamp": at(30.01), "state": {"status": "archived"}}
        aborted = {"type": "message", "timestamp": at(30), "message": {"role": "assistant", "stopReason": "aborted", "content": []}}
        self.session("restartcut00", [role(31, "toolResult"), archived, aborted], lifecycle="archived")
        self.session("ownerstop000", [role(21, "toolResult"), {**archived, "timestamp": at(20.01)}, {**aborted, "timestamp": at(20)}],
                     lifecycle="archived")
        window = (NOW - dt.timedelta(minutes=30, seconds=5), NOW - dt.timedelta(minutes=29, seconds=45))
        with patch.object(resume_paused, "daemon_restarts", return_value=[window]), \
                patch.object(resume_paused, "worker_shutdowns", return_value=[]):
            report = self.run_direct()
        self.assertEqual([(p["id"], p["reason"]) for p in report["paused"]], [("restartcut00", "daemon_restart")])
        self.assertEqual(self.sent, [("0" * 24 + "restartcut00", "continue")])

    def test_an_archived_owner_in_the_default_list_counts_as_saved(self):
        full = "01a141b8-c786-723a-baec-b975a1a24279"
        listed = [{"id": full, "sessionId": full, "lifecycle": "archived"}, {"id": "other", "lifecycle": "archived"}]
        rows = resume_paused.with_saved_owners(listed, [], {full})
        self.assertEqual([row.get("saved") for row in rows], [True, None])

    def test_daemon_restarts_reads_each_supervisor_restart_from_the_logs(self):
        logs = self.root / "logs"
        logs.mkdir()
        (logs / "daemon.sock.abc.log").write_text(
            "[2026-10-16T00:19:58.036Z] supervisor: Session worker 4b76cc9a9a2a stderr: shutting down (exit 0); closing 0 active session(s)\n"
            "[2026-10-16T00:20:13.549Z] supervisor: Prime Agent daemon supervisor 2b6f listening on /tmp/daemon.sock\n")
        with patch.object(resume_paused, "LOG_DIR", logs):
            found = resume_paused.daemon_restarts()
        self.assertEqual([(a.isoformat(), b.isoformat()) for a, b in found],
                         [("2026-10-16T00:19:53.036000+00:00", "2026-10-16T00:20:13.549000+00:00")])

if __name__ == "__main__":
    unittest.main()
