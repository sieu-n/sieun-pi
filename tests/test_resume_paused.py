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
        hook = patch.object(resume_paused, "TOKEN_HOOK", self.root / "no-hook")
        hook.start()
        self.addCleanup(hook.stop)
        hosts = patch.object(resume_paused, "HOSTS_FILE", self.root / "no-hosts.json")
        hosts.start()
        self.addCleanup(hosts.stop)

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
        stop = (NOW - dt.timedelta(minutes=30, seconds=10), NOW - dt.timedelta(minutes=29))
        with patch.object(resume_paused, "worker_shutdowns", return_value=[]), patch.object(resume_paused, "daemon_restarts", return_value=[stop]):
            self.owners(full)
            report = self.run_direct()
        self.assertEqual([(p["reason"], p["target"]) for p in report["paused"]], [("daemon_restart", full)])
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

    def deleted_owner(self, chat, sub, sid, archived_at, aborted_at):
        folder = self.root / "artifacts" / chat / sub
        folder.mkdir(parents=True)
        (folder / "rlm-subagent.json").write_text(json.dumps({"sessionName": sub}))
        archived = {"type": "session_state", "timestamp": at(archived_at), "state": {"status": "archived"}}
        aborted = {"type": "message", "timestamp": at(aborted_at), "message": {"role": "assistant", "stopReason": "aborted", "content": []}}
        (folder / f"{sid}.jsonl").write_text("\n".join(json.dumps(entry) for entry in [role(40, "user"), archived, aborted]) + "\n")
        return folder

    def run_saved_owners(self, owners, restarts=(), shutdowns=()):
        with patch.object(resume_paused, "ARTIFACTS_DIR", self.root / "artifacts"), patch.object(resume_paused, "SESSIONS_DIR", self.root / "sessions"), \
                patch.object(resume_paused, "DELETED_JOBS", self.root / "deleted-jobs.json"), \
                patch.object(resume_paused, "daemon_restarts", return_value=list(restarts)), \
                patch.object(resume_paused, "worker_shutdowns", return_value=list(shutdowns)):
            self.sessions = resume_paused.with_saved_owners(self.sessions, resume_paused.saved_rows(set(owners)), set(owners))
            self.owners(*owners)
            return self.run_direct()

    def test_saved_owners_come_from_their_files_and_never_from_list_all(self):
        # 10-16 04:20Z on: `prime-agent list --json --all` took 30.9 s against its 30 s timeout, so every resume pass that named an owner failed.
        sid = "01a14075-ec87-74e6-a080-109665a0941d"
        self.deleted_owner("01a1164b-chat", "sub-aaaa0001", sid, 30.01, 30)
        stop = (NOW - dt.timedelta(minutes=30, seconds=10), NOW - dt.timedelta(minutes=29))
        report = self.run_saved_owners([sid], restarts=[stop])
        self.assertEqual([(p["name"], p["reason"], p["target"]) for p in report["paused"]], [("sub-aaaa0001", "daemon_restart", sid)])
        calls = []
        self.addCleanup(resume_paused.OWNERS.clear)
        with patch.object(resume_paused, "run", side_effect=lambda cmd: calls.append(cmd) or '{"sessions": []}'), \
                patch.object(resume_paused, "saved_rows", return_value=[]), patch("sys.argv", ["x", "--json", "--dry-run", "--owners", sid]), \
                patch("builtins.print"):
            resume_paused.main()
        self.assertEqual([cmd[1:] for cmd in calls], [["list", "--json"]])

    def test_an_archive_right_before_the_abort_outside_a_restart_is_a_delete_even_next_to_a_sigterm(self):
        # 10-15/16: rlm.delete_subagent (ci train, new ci server, fair-self-heal, spec-junit) and the parker (checkin pushes goals) each archived
        # a job and aborted its queued turn within milliseconds, with no daemon restart; a continue would have revived all six.
        sid = "01a13a70-b2fc-7191-a914-3d3058bea249"
        self.deleted_owner("01a1180e-chat", "sub-46ce81aa", sid, 30.01, 30)
        report = self.run_saved_owners([sid], shutdowns=[NOW - dt.timedelta(minutes=30)])
        self.assertEqual(report["paused"], [])
        self.assertEqual(self.sent, [])

    def test_a_recorded_delete_wins_inside_a_restart_window(self):
        chat = "01a11bd7-chat"
        deleted = self.deleted_owner(chat, "sub-47607c8a", "01a140fc-ba32-7228-99c6-b12621a32ffc", 50, 49.99)
        child = "01a14103-72eb-7349-b56f-93fc7ba3684b"
        folder = deleted / "sub-6430b61d"
        folder.mkdir()
        call = {"type": "message", "timestamp": at(30.02), "message": {"role": "assistant", "content": [
            {"type": "toolCall", "name": "ipython", "arguments": {"code": "await rlm.delete_subagent(h1)"}}]}}
        result = {"type": "message", "timestamp": at(30.01), "message": {"role": "toolResult", "content": [
            {"type": "text", "text": "RLMSubagent(rlm_child_id='sub-6430b61d', session_name='fair-self-heal')"}]}}
        parent = deleted / "01a140fc-ba32-7228-99c6-b12621a32ffc.jsonl"
        parent.write_text(parent.read_text() + json.dumps(call) + "\n" + json.dumps(result) + "\n")
        archived = {"type": "session_state", "timestamp": at(30.01), "state": {"status": "archived"}}
        aborted = {"type": "message", "timestamp": at(30), "message": {"role": "assistant", "stopReason": "aborted", "content": []}}
        (folder / f"{child}.jsonl").write_text("\n".join(json.dumps(entry) for entry in [role(40, "user"), archived, aborted]) + "\n")
        parked = "01a14193-47fd-711a-838f-16ebb93f7fc5"
        self.deleted_owner(chat, "sub-7d295f61", "01a1418c-420e-748c-a38f-cc0b2693c6e1", 50, 49.99)
        (self.root / "artifacts" / chat / "sub-7d295f61" / "sub-86a1a030").mkdir()
        (self.root / "artifacts" / chat / "sub-7d295f61" / "sub-86a1a030" / f"{parked}.jsonl").write_text(
            "\n".join(json.dumps(entry) for entry in [role(40, "user"), archived, aborted]) + "\n")
        (self.root / "deleted-jobs.json").write_text(json.dumps({chat: {"sub-7d295f61": 1}}))
        window = (NOW - dt.timedelta(minutes=30, seconds=10), NOW - dt.timedelta(minutes=29))
        report = self.run_saved_owners([child, parked], restarts=[window])
        self.assertEqual(report["paused"], [])

    def test_a_reopened_job_that_refuses_its_full_id_gets_the_continue_on_its_live_id(self):
        # 10-17 19:51Z: the chat service reopened six archived jobs and each ran again, but the send to the full id answered
        # "Unknown active session", so the pass logged six failed continues.
        sid = "01a14123-ebe5-76a4-9e23-97a3fa6d9b40"
        self.deleted_owner("01a1180e-chat", "sub-bbbb0001", sid, 30.01, 30)
        stop = (NOW - dt.timedelta(minutes=30, seconds=10), NOW - dt.timedelta(minutes=29))

        def send(target, text):
            if target == sid:
                raise resume_paused.CommandError(f"prime-agent send --json {sid} continue failed (1): Error: Unknown active session: {sid}")
            self.sent.append((target, text))
            return {"deliveryStatus": "delivered"}

        with patch.object(resume_paused, "list_sessions", return_value=[{"id": "56018fdc0c63", "sessionId": sid, "lifecycle": "live"}]):
            with patch.object(resume_paused, "ARTIFACTS_DIR", self.root / "artifacts"), patch.object(resume_paused, "SESSIONS_DIR", self.root / "sessions"), \
                    patch.object(resume_paused, "DELETED_JOBS", self.root / "deleted-jobs.json"), \
                    patch.object(resume_paused, "daemon_restarts", return_value=[stop]), patch.object(resume_paused, "worker_shutdowns", return_value=[]):
                self.sessions = resume_paused.with_saved_owners(self.sessions, resume_paused.saved_rows({sid}), {sid})
                self.owners(sid)
                args = argparse.Namespace(message="continue", since_minutes=1440, dry_run=False, include_children=False, direct=True,
                                          only="", state=str(self.root / "state.json"))
                with patch.object(resume_paused, "send", side_effect=send), patch.object(resume_paused, "pool_bin", return_value=None):
                    report = resume_paused.resume(self.sessions, args, NOW)
        self.assertEqual([child["result"] for child in report["children"]], [{"deliveryStatus": "delivered"}])
        self.assertEqual(self.sent, [("56018fdc0c63", "continue")])

    def test_a_live_job_its_root_shadows_is_never_relayed_to_its_parent(self):
        chat = "01a14d7b-8a50-70eb-acee-f9dee8fd65d3"
        shadowed, unroutable, holder = "ca0b85d07bae", "21d9a875c833", "4ac980f7fd82"
        (self.root / "sessions").mkdir()
        (self.root / "sessions" / f"{chat}.jsonl").write_text(json.dumps(role(60, "user")) + "\n")
        call = {"type": "message", "timestamp": at(30), "message": {"role": "assistant", "stopReason": "toolUse", "content": [
            {"type": "toolCall", "name": "ipython", "arguments": {"code": "r = await bash('sleep 1500')"}}]}}
        rows = {}
        for sub, sid, short in (("sub-2bee831a", "01a14d7b-a53c-757a-bd91-ca0b85d07bae", shadowed),
                                ("sub-3cff942b", "01a14d7c-b64d-768b-ce02-db1c96e18cbf", unroutable)):
            folder = self.root / "artifacts" / chat / sub
            folder.mkdir(parents=True)
            (folder / "rlm-subagent.json").write_text(json.dumps({"sessionName": sub}))
            (folder / f"{sid}.jsonl").write_text(json.dumps(call) + "\n")
            rows[short] = str(folder / f"{sid}.jsonl")
            self.sessions.append({"id": sid if short == shadowed else short, "sessionId": sid, "lifecycle": "live", "activity": "idle",
                                  "sessionFile": rows[short], "sessionName": sub, "runtimeKind": "subagent", "lastActivityAt": at(1),
                                  "parentActiveSessionId": "4ebe1d14227f"})

        def send(target, text):
            if target == shadowed:
                raise resume_paused.CommandError(f"prime-agent send --json {shadowed} continue failed (1): "
                                                 f"Error: Session is already active in {holder}: {rows[shadowed]}")
            if target == unroutable:
                raise resume_paused.CommandError(f"prime-agent send --json {unroutable} continue failed (1): Error: Unknown active session: {unroutable}")
            self.sent.append((target, text))
            return {"deliveryStatus": "delivered"}

        args = argparse.Namespace(message="continue", since_minutes=1440, dry_run=False, include_children=False, direct=True,
                                  only="", state=str(self.root / "state.json"))
        with patch.object(resume_paused, "ARTIFACTS_DIR", self.root / "artifacts"), patch.object(resume_paused, "SESSIONS_DIR", self.root / "sessions"), \
                patch.object(resume_paused, "DELETED_JOBS", self.root / "deleted-jobs.json"), \
                patch.object(resume_paused, "send", side_effect=send), patch.object(resume_paused, "pool_bin", return_value=None):
            report = resume_paused.resume(self.sessions, args, NOW)
        results = {child["id"]: child["result"] for child in report["children"]}
        self.assertEqual([target for target, _ in self.sent], [], "the root that shadows a live job never gets its continue")
        self.assertIn(f"Session is already active in {holder}", results[shadowed]["error"])
        self.assertIn(f"Unknown active session: {unroutable}", results[unroutable]["error"])
        self.assertFalse((self.root / "state.json").exists(), "the next pass sends the continue again")

    def test_a_named_subagent_the_daemon_dropped_mid_tool_gets_its_continue_through_its_parent(self):
        # 10-18 04:45:48Z: census writer speed, a Crawler VP subagent, was archived mid tool call; the daemon no longer held it, so a send to
        # it answered "Unknown active session", and `prime-agent send` could not resume it. Its parent's rlm handle reopens it.
        chat = "01a115e2-9544-7204-b8db-8ce4d5319048"
        sid = "01a14ceb-1e15-745d-a4cd-3f29b6766d94"
        (self.root / "sessions").mkdir()
        (self.root / "sessions" / f"{chat}.jsonl").write_text(json.dumps(role(60, "user")) + "\n")
        folder = self.root / "artifacts" / chat / "sub-ec6414ff"
        folder.mkdir(parents=True)
        (folder / "rlm-subagent.json").write_text(json.dumps({"sessionName": "census writer speed"}))
        call = {"type": "message", "timestamp": at(31), "message": {"role": "assistant", "stopReason": "toolUse", "content": [
            {"type": "toolCall", "name": "ipython", "arguments": {"code": "print(sampler.tail(5))"}}]}}
        archived = {"type": "session_state", "timestamp": at(30.01), "state": {"status": "archived"}}
        aborted = {"type": "message", "timestamp": at(30), "message": {"role": "toolResult", "content": [{"type": "text", "text": "Request was aborted"}]}}
        (folder / f"{sid}.jsonl").write_text("\n".join(json.dumps(entry) for entry in [role(40, "user"), call, archived, aborted]) + "\n")

        def send(target, text):
            if target == sid:
                raise resume_paused.CommandError(f"prime-agent send --json {sid} continue failed (1): Error: Unknown active session: {sid}")
            self.sent.append((target, text))
            return {"deliveryStatus": "delivered"}

        with patch.object(resume_paused, "ARTIFACTS_DIR", self.root / "artifacts"), patch.object(resume_paused, "SESSIONS_DIR", self.root / "sessions"), \
                patch.object(resume_paused, "DELETED_JOBS", self.root / "deleted-jobs.json"), \
                patch.object(resume_paused, "daemon_restarts", return_value=[]), patch.object(resume_paused, "worker_shutdowns", return_value=[]), \
                patch.object(resume_paused, "list_sessions", return_value=[]):
            self.sessions = resume_paused.with_saved_owners([], resume_paused.saved_rows({sid}), {sid})
            args = argparse.Namespace(message="continue", since_minutes=1440, dry_run=False, include_children=False, direct=True,
                                      only=sid, state=str(self.root / "state.json"))
            with patch.object(resume_paused, "send", side_effect=send), patch.object(resume_paused, "pool_bin", return_value=None):
                report = resume_paused.resume(self.sessions, args, NOW)
        self.assertEqual([(p["name"], p["reason"]) for p in report["paused"]], [("census writer speed", "cut_off")])
        self.assertEqual([child["result"] for child in report["children"]], [{"deliveryStatus": "delivered", "relayed_through": chat}])
        [(target, note)] = self.sent
        self.assertEqual(target, chat)
        self.assertIn('receiver_name="census writer speed"', note)
        self.assertIn(sid, note)
        self.assertIn('The last thing it did: ipython {"code": "print(sampler.tail(5))"}', note)
        self.assertTrue(note.endswith("\n\ncontinue"))

    def test_a_restart_window_starts_at_the_old_supervisors_last_line_not_at_the_new_ones_start(self):
        # 10-17: the old supervisor's last line came at 19:46:18Z. The new one wrote 40 recovered or not-adopted worker lines at 19:48:47Z
        # to 19:48:48Z and listened at 19:48:48.539Z, so the window was 5 s long and missed every cut at 19:46Z.
        logs = self.root / "logs"
        logs.mkdir()
        (logs / "daemon.sock.abc.log").write_text(
            "[2026-10-17T19:46:18.931Z] supervisor: Idle eviction sweep failed: Error: Timed out draining daemon mutations for idle eviction\n"
            "[2026-10-17T19:48:47.547Z] supervisor: Could not adopt worker b87c5a758ac4: Error: Session worker process is no longer running\n"
            "    at findWorker (/$bunfs/root/prime-agent:2238:72844)\n"
            "[2026-10-17T19:48:48.536Z] supervisor: Recovered worker ebab045b44c4 without replaying uncertain operations: message_end\n"
            "[2026-10-17T19:48:48.539Z] supervisor: Prime Agent daemon supervisor 6876 listening on /tmp/daemon.sock\n")
        with patch.object(resume_paused, "LOG_DIR", logs):
            found = resume_paused.daemon_restarts()
        self.assertEqual([(start.isoformat(), end.isoformat()) for start, end in found],
                         [("2026-10-17T19:46:13.931000+00:00", "2026-10-17T19:48:48.539000+00:00")])

    def test_a_turn_the_update_stopped_counts_as_a_restart_and_a_recorded_delete_still_wins(self):
        # 10-16 08:44:11.97Z: `prime-agent update` wrote its restart notice into each live session, then stopped the workers; 12 tts-gap jobs
        # under one parent ended on "Request was aborted" or an empty abort at 08:44:12Z to 08:44:24Z, and no rule counted them as cut.
        notice = {"type": "custom_message", "customType": "prime-agent.update_restart", "timestamp": at(30.2)}
        aborted_tool = {"type": "message", "timestamp": at(30), "message": {"role": "toolResult", "content": [{"type": "text", "text": "Request was aborted"}]}}
        self.session("updatetool00", [assistant(31, "toolUse"), notice, aborted_tool])
        self.session("updateabort0", [role(31, "toolResult"), notice, assistant(30, "aborted", "Request was aborted")])
        self.session("ownerstopped", [assistant(31, "toolUse"), aborted_tool])
        with patch.object(resume_paused, "worker_shutdowns", return_value=[]), patch.object(resume_paused, "daemon_restarts", return_value=[]):
            report = self.run_direct(dry_run=True)
        self.assertEqual(sorted((p["id"], p["reason"]) for p in report["paused"]),
                         [("updateabort0", "daemon_restart"), ("updatetool00", "cut_off")])
        self.sessions = []
        folder = self.deleted_owner("01a143b3-chat", "sub-ad098135", "01a143dc-aa89-767d-845a-9c39765e9128", 50, 49.99)
        (folder / "01a143dc-aa89-767d-845a-9c39765e9128.jsonl").write_text(
            "\n".join(json.dumps(entry) for entry in [assistant(31, "toolUse"), notice, aborted_tool]) + "\n")
        (self.root / "deleted-jobs.json").write_text(json.dumps({"01a143b3-chat": {"sub-ad098135": 1}}))
        self.assertEqual(self.run_saved_owners(["01a143dc-aa89-767d-845a-9c39765e9128"])["paused"], [])

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

    # ci train (01a14068, a root job of VP of CI): its last turn ran out of retries on the token hook at 10:25:52Z on 10-16, the idle unload
    # stopped it at 10:27:23Z (service.log 10:27:34Z), the daemon no longer listed it, and it got no continue after the hook worked again.
    CI_TRAIN = "01a14068-faa2-7369-a7d0-0389df1d4632"
    HOOK_ERROR = ('Failed to resolve API key for provider "anthropic" from shell command: /Users/sieunpark/.config/pi-pool/bin/pi-pool-token '
                  "pi-pool: the token hook gave no token; the retry uses a new hook run.")

    def ci_train(self):
        def error(stamp):
            return {"type": "message", "timestamp": stamp, "message": {"role": "assistant", "stopReason": "error", "provider": "anthropic",
                                                                       "content": [], "errorMessage": self.HOOK_ERROR}}
        entries = [{"type": "message", "timestamp": "2026-10-16T10:23:08.612Z", "message": {"role": "user", "content": [{"type": "text", "text": "continue"}]}},
                   *map(error, ["2026-10-16T10:23:38.629Z", "2026-10-16T10:24:20.306Z", "2026-10-16T10:25:04.785Z", "2026-10-16T10:25:52.307Z"]),
                   {"type": "agent_status", "timestamp": "2026-10-16T10:26:07.308Z"},
                   {"type": "session_state", "timestamp": "2026-10-16T10:27:23.453Z", "state": {"status": "archived"}}]
        sessions = self.root / "sessions"
        sessions.mkdir(exist_ok=True)
        (sessions / f"{self.CI_TRAIN}.jsonl").write_text("\n".join(json.dumps(entry) for entry in entries) + "\n")

    def run_ci_train(self, unloaded, dry_run=True):
        now = dt.datetime(2026, 10, 17, 19, 55, tzinfo=dt.timezone.utc)
        args = argparse.Namespace(message="continue", since_minutes=0, dry_run=dry_run, include_children=False, direct=True,
                                  only="", state=str(self.root / "state.json"))
        with patch.object(resume_paused, "SESSIONS_DIR", self.root / "sessions"), patch.object(resume_paused, "ARTIFACTS_DIR", self.root / "artifacts"), \
                patch.dict(resume_paused.UNLOADED, unloaded, clear=True), \
                patch.object(resume_paused, "send", side_effect=lambda target, text: self.sent.append((target, text)) or {"deliveryStatus": "delivered"}):
            rows = resume_paused.with_saved_owners([], resume_paused.saved_rows({self.CI_TRAIN}), {self.CI_TRAIN})
            return resume_paused.resume(rows, args, now)

    def test_a_job_the_idle_unload_stopped_after_a_token_hook_failure_is_resumed(self):
        self.ci_train()
        self.assertEqual(self.run_ci_train({})["paused"], [])
        report = self.run_ci_train({self.CI_TRAIN: resume_paused.parse_ts("2026-10-16T10:27:34.023Z")})
        self.assertEqual([(p["reason"], p["target"], p["errored_at"]) for p in report["paused"]],
                         [("error", self.CI_TRAIN, "2026-10-16T10:25:52.307Z")])

    def test_the_unload_stop_counts_only_after_a_token_hook_failure(self):
        sessions = self.root / "sessions"
        sessions.mkdir(exist_ok=True)
        archived = {"type": "session_state", "timestamp": "2026-10-16T10:27:23.453Z", "state": {"status": "archived"}}
        ends = {"01a14068-0000-7000-8000-00000000done": {"type": "message", "timestamp": "2026-10-16T10:25:52.307Z", "message": {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": "done"}]}},
                "01a14068-0000-7000-8000-0000000cut0": {"type": "message", "timestamp": "2026-10-16T10:25:52.307Z", "message": {"role": "toolResult", "content": "x"}},
                "01a14068-0000-7000-8000-000000net00": {"type": "message", "timestamp": "2026-10-16T10:25:52.307Z", "message": {"role": "assistant", "stopReason": "error", "content": [], "errorMessage": "Connection error."}}}
        for sid, end in ends.items():
            (sessions / f"{sid}.jsonl").write_text(json.dumps(end) + "\n" + json.dumps(archived) + "\n")
        now = dt.datetime(2026, 10, 17, 19, 55, tzinfo=dt.timezone.utc)
        args = argparse.Namespace(message="continue", since_minutes=0, dry_run=True, include_children=False, direct=True, only="", state=str(self.root / "state.json"))
        stop = resume_paused.parse_ts("2026-10-16T10:27:34.023Z")
        with patch.object(resume_paused, "SESSIONS_DIR", sessions), patch.object(resume_paused, "ARTIFACTS_DIR", self.root / "artifacts"), \
                patch.dict(resume_paused.UNLOADED, {sid: stop for sid in ends}, clear=True):
            rows = resume_paused.with_saved_owners([], resume_paused.saved_rows(set(ends)), set(ends))
            self.assertEqual(resume_paused.resume(rows, args, now)["paused"], [])

    def fake_hook(self, gives):
        hook = self.root / "pi-pool-token"
        seen = self.root / "hook-session"
        hook.write_text("#!/bin/sh\n" f'printf %s "$PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID" > "{seen}"\n'
                        + ("printf sk-ant-oat01-secret\n" if gives else "echo 'pi-pool: remote pool unreachable' >&2; exit 1\n"))
        hook.chmod(0o755)
        return patch.object(resume_paused, "TOKEN_HOOK", hook), seen

    def test_the_continue_after_a_token_hook_failure_waits_until_the_hook_gives_the_tree_a_token(self):
        self.ci_train()
        unloaded = {self.CI_TRAIN: resume_paused.parse_ts("2026-10-16T10:27:34.023Z")}
        dead, seen = self.fake_hook(gives=False)
        with dead:
            report = self.run_ci_train(unloaded, dry_run=False)
        self.assertEqual((report["paused"], self.sent, seen.read_text()), ([], [], self.CI_TRAIN))
        works, _ = self.fake_hook(gives=True)
        with works, patch("sys.stdout") as stdout:
            report = self.run_ci_train(unloaded, dry_run=False)
        self.assertEqual(self.sent, [(self.CI_TRAIN, "continue")])
        self.assertNotIn("sk-ant", json.dumps(report) + str(stdout.mock_calls))

    def test_a_saved_job_maps_to_the_job_above_it_so_the_hook_check_asks_for_its_tree(self):
        chat = "01a11ba8-9d2c-727c-8ded-38f819ca9f29"
        job = self.root / "artifacts" / chat / "sub-738c756b" / "01a14130-7ba1-71ba-be87-6794d2b743b0.jsonl"
        child = job.parent / "sub-0b3d1659" / "01a14cfe-4ba8-739d-bbcd-10e610c5580e.jsonl"
        child.parent.mkdir(parents=True)
        job.write_text("")
        self.assertEqual([resume_paused.parent_of(path) for path in (job, child, self.root / "sessions" / f"{chat}.jsonl")],
                         [chat, "01a14130-7ba1-71ba-be87-6794d2b743b0", None])

    def test_load_unloaded_reads_the_idle_unload_record(self):
        path = self.root / "unloaded.json"
        path.write_text(json.dumps({self.CI_TRAIN: "2026-10-16T10:27:34.023Z", "bad": 3}))
        self.assertEqual(resume_paused.load_unloaded(path), {self.CI_TRAIN: resume_paused.parse_ts("2026-10-16T10:27:34.023Z")})
        self.assertEqual(resume_paused.load_unloaded(self.root / "missing.json"), {})

    def fake_relay(self, files):
        """A relay on localhost that serves `files` ({path: bytes}) the way prime-relay's GET /v1/file does: a Range from an offset, 416 with the
        size past the end, and a folder as its entries."""
        import http.server
        import threading
        import urllib.parse as parse

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.headers.get("Authorization") != "Bearer t0ken":
                    self.send_response(401), self.end_headers()
                    return
                path = parse.parse_qs(parse.urlparse(self.path).query)["path"][0]
                if path in files:
                    body = files[path]
                    start = int(self.headers.get("Range", "bytes=0-")[6:-1] or 0)
                    if start >= len(body) and start:
                        self.send_response(416), self.send_header("X-File-Size", str(len(body))), self.end_headers()
                        return
                    self.send_response(206 if start else 200), self.send_header("X-File-Size", str(len(body))), self.end_headers()
                    self.wfile.write(body[start:])
                    return
                entries = [{"name": name[len(path) + 1:], "type": "file", "size": len(body), "mtimeMs": 1792296000000}
                           for name, body in files.items() if name.startswith(path + "/") and "/" not in name[len(path) + 1:]]
                if not entries:
                    self.send_response(403), self.end_headers()
                    self.wfile.write(b'{"error":"path is outside the relay roots"}')
                    return
                self.send_response(200), self.end_headers()
                self.wfile.write(json.dumps({"entries": entries}).encode())

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return resume_paused.RelayBox({"name": "mac", "address": "127.0.0.1", "relayPort": server.server_address[1]}, "t0ken")

    MAC_JOB = "/Users/sieunpark/.prime/agent/session-artifacts/01a14d38-3fa3-72cd-a10b-dc0b2fb2e976/sub-df01e456/01a14d38-d851-77a8-969c-29b2acca24f6.jsonl"

    def mac_job(self):
        # run-1 of the token-hook-resume clean room, 10-18: the Mac job's last turn failed on the hook at 04:18:25Z and the unload stopped it.
        error = {"type": "message", "timestamp": "2026-10-18T04:18:25.152Z", "message": {"role": "assistant", "stopReason": "error", "provider": "anthropic",
                                                                                       "content": [], "errorMessage": self.HOOK_ERROR}}
        archived = {"type": "session_state", "timestamp": "2026-10-18T04:21:36.659Z", "state": {"status": "archived"}}
        return ("\n".join(json.dumps(entry) for entry in [role(60, "user"), error, archived]) + "\n").encode()

    def test_a_relay_box_reads_another_boxs_files_through_its_relay(self):
        body = self.mac_job()
        box = self.fake_relay({self.MAC_JOB: body, self.MAC_JOB.replace(".jsonl", "") + "/x": b""})
        self.assertEqual((box.size(self.MAC_JOB), box.read(self.MAC_JOB, 10), box.read(self.MAC_JOB, len(body))), (len(body), body[10:], b""))
        self.assertEqual(box.mtime(self.MAC_JOB), 1792296000.0)
        self.assertEqual(box.logs(), [])
        with patch.object(resume_paused, "BOX", box):
            self.assertEqual([e.get("type") for e in resume_paused.tail_entries(self.MAC_JOB, 200)], ["session_state"])
            self.assertEqual(len(resume_paused.tail_entries(self.MAC_JOB)), 3)

    def test_one_pass_resumes_a_mac_job_through_the_mac_daemon(self):
        box = self.fake_relay({self.MAC_JOB: self.mac_job()})
        full = "01a14d38-d851-77a8-969c-29b2acca24f6"
        rows = [{"id": full[-12:], "sessionId": full, "lifecycle": "archived", "activity": "idle", "sessionFile": self.MAC_JOB, "sessionName": "components test count",
                 "runtimeKind": "subagent", "lastActivityAt": "2026-10-18T04:21:36.659Z"}]
        sent = []
        box.list = lambda all_rows=False: rows if all_rows else []
        box.send = lambda target, text: sent.append((target, text)) or '{"deliveryStatus": "delivered", "deliveryMode": "steer"}'
        args = argparse.Namespace(message="continue", since_minutes=0, dry_run=False, include_children=False, direct=True, only="", state=str(self.root / "state.json"))
        with patch.dict(resume_paused.UNLOADED, {full: resume_paused.parse_ts("2026-10-18T04:21:40Z")}, clear=True):
            report = resume_paused.resume_box(box, args)
        self.assertEqual([(p["host"], p["reason"], p["errored_at"]) for p in report["paused"]], [("mac", "error", "2026-10-18T04:18:25.152Z")])
        self.assertEqual(sent, [(full, "continue")])
        self.assertIsInstance(resume_paused.BOX, resume_paused.LocalBox)

    def test_another_boxs_failed_worker_is_left_to_that_box(self):
        # After the chats moved to us-metal02 at 05:30Z on 10-18 the Mac listed 17 of their old root jobs with failed workers, already replaced.
        box = self.fake_relay({self.MAC_JOB: self.mac_job()})
        full = "01a14d66-0000-7000-8000-000000000001"
        rows = [{"id": full[-12:], "sessionId": full, "lifecycle": "live", "activity": "idle", "workerState": "failed", "sessionFile": self.MAC_JOB,
                 "sessionName": "relay keep moved-to-us-metal02", "runtimeKind": "top-level", "lastActivityAt": "2026-10-18T05:05:39.702Z"}]
        box.list = lambda all_rows=False: rows
        args = argparse.Namespace(message="continue", since_minutes=0, dry_run=True, include_children=False, direct=True, only="", state=str(self.root / "state.json"))
        self.assertEqual(resume_paused.resume_box(box, args)["paused"], [])

if __name__ == "__main__":
    unittest.main()

