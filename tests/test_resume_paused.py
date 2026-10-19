import argparse
import collections
import datetime as dt
import importlib.util
import http.server
import itertools
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("resume_paused", REPO / "skills/resume-paused-sessions/scripts/resume_paused.py")
resume_paused = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(resume_paused)

NOW = dt.datetime(2026, 10, 5, 20, 0, tzinfo=dt.timezone.utc)


def at(minutes_ago):
    return (NOW - dt.timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z")


class PassClock(dt.datetime):
    """A wall clock stopped at 10-18 04:25Z, for a fixture taken from that morning's Mac pass."""

    @classmethod
    def now(cls, tz=None):
        return cls(2026, 10, 18, 4, 25, tzinfo=dt.timezone.utc).astimezone(tz)


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
        for found in (resume_paused.INCOMPLETE, resume_paused.UNRESOLVED, resume_paused.STOPPED, resume_paused.HELD):
            found.clear()
            self.addCleanup(found.clear)
        for name, value in (("TAIL_CACHE", self.root / "tails"), ("COPY_DIR", self.root / "copies")):
            kept = patch.object(resume_paused, name, value)
            kept.start()
            self.addCleanup(kept.stop)
        self.served = []

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

    def test_a_worker_the_idle_reaper_killed_is_judged_by_its_last_turn(self):
        # 10-19: the Mac's idle-reaper SIGTERMed idle workers every 5 minutes, and each of their finished jobs read worker_failed.
        self.session("reapedclean1", [assistant(30, "stop")], workerState="failed", lastActivityAt=at(30))
        self.session("reapederror1", [assistant(30, "error", "Connection error.")], workerState="failed", lastActivityAt=at(30))
        self.session("workedafter1", [assistant(30, "stop")], workerState="failed", lastActivityAt=at(30))
        reaped = {"0" * 24 + "reapedclean1": NOW - dt.timedelta(minutes=20), "0" * 24 + "reapederror1": NOW - dt.timedelta(minutes=20),
                  "0" * 24 + "workedafter1": NOW - dt.timedelta(minutes=40)}
        with patch.dict(resume_paused.REAPED, reaped, clear=True):
            report = self.run_resume(dry_run=True)
        self.assertEqual(sorted((p["id"], p["reason"]) for p in report["paused"]), [("reapederror1", "error"), ("workedafter1", "worker_failed")])

    def test_load_reaped_reads_the_reaper_record(self):
        path = self.root / "reaped.json"
        path.write_text(json.dumps({"01a1-x": "2026-10-19T16:35:44Z", "bad": 3}))
        self.assertEqual(resume_paused.load_reaped(path), {"01a1-x": dt.datetime(2026, 10, 19, 16, 35, 44, tzinfo=dt.timezone.utc)})
        self.assertEqual(resume_paused.load_reaped(self.root / "missing.json"), {})

    def test_cut_off_turn_counts_after_the_grace_period(self):
        self.session("aaaaaaaaaaaa", [assistant(40, "toolUse"), role(40, "toolResult")])
        self.session("bbbbbbbbbbbb", [assistant(1, "toolUse"), role(0.5, "toolResult")])
        self.session("cccccccccccc", [role(20, "user")], activity="working")
        report = self.run_resume(dry_run=True)
        self.assertEqual([(p["id"], p["reason"]) for p in report["paused"]], [("aaaaaaaaaaaa", "cut_off")])

    def test_a_cut_turn_with_the_worker_recovery_notice_after_it_counts_inside_the_grace_period(self):
        recovery = {"type": "custom_message", "customType": "prime-agent.worker_recovery", "timestamp": at(0.9), "content": "x"}
        call = assistant(1, "toolUse")
        call["message"]["content"] = [{"type": "toolCall", "name": "ipython"}]
        self.session("aaaaaaaaaaaa", [role(1.2, "toolResult"), call, recovery])
        self.session("bbbbbbbbbbbb", [call, role(0.5, "toolResult")])
        self.session("cccccccccccc", [dict(recovery, timestamp=at(1.5)), call])
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
        with patch.object(resume_paused, "account_blocker", return_value=("claude3@slack.green is depleted", None)):
            self.assertEqual(self.run_resume(dry_run=True)["paused"], [])
        with patch.object(resume_paused, "account_blocker", return_value=(None, None)):
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


    def test_a_job_archived_and_aborted_inside_a_daemon_restart_is_reported_unresolved_and_not_resumed(self):
        # 10-16 00:19:58Z: the daemon supervisor stopped and a new one listened at 00:20:13Z. daily code health report (no open step) was
        # archived at 00:19:58.026Z with an empty abort 1 ms later. The archive line has no cause and an owner Stop writes the same line, so the
        # restart window's timing does not prove the restart wrote it (chat-057a, 10-18): the run is listed as unresolved and gets nothing.
        archived = {"type": "session_state", "timestamp": at(30.01), "state": {"status": "archived"}}
        aborted = {"type": "message", "timestamp": at(30), "message": {"role": "assistant", "stopReason": "aborted", "content": []}}
        self.session("restartcut00", [role(31, "toolResult"), archived, aborted], lifecycle="archived")
        self.session("ownerstop000", [role(21, "toolResult"), {**archived, "timestamp": at(20.01)}, {**aborted, "timestamp": at(20)}],
                     lifecycle="archived")
        window = (NOW - dt.timedelta(minutes=30, seconds=5), NOW - dt.timedelta(minutes=29, seconds=45))
        with patch.object(resume_paused, "daemon_restarts", return_value=[window]), \
                patch.object(resume_paused, "worker_shutdowns", return_value=[]):
            report = self.run_direct()
        self.assertEqual((report["paused"], self.sent), ([], []))
        self.assertEqual([(entry["id"], entry["archived_at"]) for entry in resume_paused.UNRESOLVED], [("restartcut00", at(30.01))])

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
        self.assertEqual((report["paused"], [(entry["name"], entry["session_id"]) for entry in resume_paused.UNRESOLVED]), ([], [("sub-aaaa0001", sid)]))
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
        with patch.object(resume_paused, "SESSIONS_DIR", self.root / "sessions"):
            ledger = resume_paused.rlm_ledger_path()
        ledger.parent.mkdir(parents=True)
        ledger.write_text(json.dumps({"v": 1, "op": "delete", "at": at(30.02), "childId": "sub-6430b61d", "child": str(folder / f"{child}.jsonl"),
                                      "reason": "user"}) + "\n")
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
        self.assertEqual((report["paused"], resume_paused.UNRESOLVED), ([], []))
        self.assertEqual(sorted((entry["session_id"], entry["stopped_by"]) for entry in resume_paused.STOPPED),
                         [(child, f"its parent deleted it (rlm ledger delete, reason user, at {at(30.02)})"), (parked, "deleted on purpose")])

    def test_an_unresolved_run_does_not_hold_back_a_proven_cut_in_the_same_pass(self):
        archived = {"type": "session_state", "timestamp": at(30.01), "state": {"status": "archived"}}
        aborted = {"type": "message", "timestamp": at(30), "message": {"role": "assistant", "stopReason": "aborted", "content": []}}
        self.session("restartcut00", [role(31, "toolResult"), archived, aborted], lifecycle="archived")
        self.session("provencut000", [assistant(41, "toolUse"), role(40, "toolResult")])
        window = (NOW - dt.timedelta(minutes=30, seconds=5), NOW - dt.timedelta(minutes=29, seconds=45))
        with patch.object(resume_paused, "daemon_restarts", return_value=[window]), patch.object(resume_paused, "worker_shutdowns", return_value=[]):
            report = self.run_direct()
        self.assertEqual(([p["id"] for p in report["paused"]], self.sent), (["provencut000"], [("provencut000", "continue")]))
        self.assertEqual([entry["id"] for entry in resume_paused.UNRESOLVED], ["restartcut00"])

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
                                          only=sid, state=str(self.root / "state.json"))
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

    def test_a_turn_the_update_stopped_after_more_tool_steps_still_counts(self):
        # probe queue trust, 10-18: the mem.3 update wrote its notice at 06:46:02.996Z, the turn ran three more tool steps, and its tool call
        # ended on "Request was aborted" at 06:46:40.193Z when the old daemon stopped its worker. No pass counted it as cut.
        notice = {"type": "custom_message", "customType": "prime-agent.update_restart", "timestamp": at(30.62)}
        aborted_tool = {"type": "message", "timestamp": at(30), "message": {"role": "toolResult", "content": [{"type": "text", "text": "Request was aborted"}]}}
        steps = [assistant(30.45, "toolUse"), role(30.44, "toolResult"), assistant(30.3, "toolUse")]
        message = {"type": "custom_message", "customType": "agent_message", "timestamp": at(30.5)}
        self.session("probequeue01", [assistant(31, "toolUse"), notice, *steps, aborted_tool])
        self.session("newuserturn0", [assistant(31, "toolUse"), notice, role(30.5, "user"), *steps, aborted_tool])
        self.session("newmessage00", [assistant(31, "toolUse"), notice, message, *steps, aborted_tool])
        self.session("longafter000", [assistant(33, "toolUse"), {**notice, "timestamp": at(32)}, *steps, aborted_tool])
        with patch.object(resume_paused, "worker_shutdowns", return_value=[]), patch.object(resume_paused, "daemon_restarts", return_value=[]):
            report = self.run_direct(dry_run=True)
        self.assertEqual([(p["id"], p["reason"]) for p in report["paused"]], [("probequeue01", "cut_off")])

    AIR_REBOOT = "01a14d56-4447-714c-beb1-7aa8a2c9c09b"

    def air_reboot(self, *after, between=(), notice=True):
        # air reboot proof 2, 10-18: the idle unload archived it at 06:22:28.102Z (unloaded.json 06:22:28.949Z), its parent woke it at 06:40:24Z,
        # and the mem.3 update stopped its tool call at 06:46:11Z. The update's restore failed, so list showed it archived from the 06:22 line.
        folder = self.root / "artifacts" / "01a11af8-962e-773d-a19a-ee4104011987" / "sub-e40ffbe0"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "rlm-subagent.json").write_text(json.dumps({"sessionName": "air reboot proof 2"}))
        entries = [{"type": "message", "timestamp": "2026-10-18T06:22:20.000Z", "message": {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": "waiting"}]}},
                   {"type": "session_state", "timestamp": "2026-10-18T06:22:28.102Z", "state": {"status": "archived"}},
                   {"type": "custom_message", "customType": "agent_message", "timestamp": "2026-10-18T06:40:24.444Z"},
                   {"type": "message", "timestamp": "2026-10-18T06:40:40.506Z", "message": {"role": "assistant", "stopReason": "toolUse", "content": [{"type": "toolCall", "name": "bash"}]}},
                   *([{"type": "custom_message", "customType": "prime-agent.update_restart", "timestamp": "2026-10-18T06:46:02.956Z"}] if notice else []),
                   *between,
                   {"type": "message", "timestamp": "2026-10-18T06:46:11.042Z", "message": {"role": "toolResult", "content": [{"type": "text", "text": "Request was aborted"}]}},
                   *after]
        (folder / f"{self.AIR_REBOOT}.jsonl").write_text("\n".join(json.dumps(entry) for entry in entries) + "\n")

    def run_air_reboot(self, unloaded_at="2026-10-18T06:22:28.949Z", restarts=()):
        now = dt.datetime(2026, 10, 18, 6, 58, tzinfo=dt.timezone.utc)
        args = argparse.Namespace(message="continue", since_minutes=1440, dry_run=True, include_children=False, direct=True, only="", state=str(self.root / "state.json"))
        with patch.object(resume_paused, "SESSIONS_DIR", self.root / "sessions"), patch.object(resume_paused, "ARTIFACTS_DIR", self.root / "artifacts"), \
                patch.object(resume_paused, "DELETED_JOBS", self.root / "deleted-jobs.json"), patch.object(resume_paused, "pool_bin", return_value=None), \
                patch.object(resume_paused, "ARCHIVED_CHATS", self.root / "archived-chats.json"), \
                patch.object(resume_paused, "daemon_restarts", return_value=list(restarts)), patch.object(resume_paused, "worker_shutdowns", return_value=[]), \
                patch.dict(resume_paused.UNLOADED, {self.AIR_REBOOT: resume_paused.parse_ts(unloaded_at)}, clear=True):
            rows = resume_paused.with_saved_owners([], resume_paused.saved_rows({self.AIR_REBOOT}), {self.AIR_REBOOT})
            return resume_paused.resume(rows, args, now)

    def test_an_unload_before_the_cut_turn_does_not_hide_the_updates_cut(self):
        self.air_reboot()
        self.assertEqual([(p["name"], p["reason"], p["target"], p["errored_at"]) for p in self.run_air_reboot()["paused"]],
                         [("air reboot proof 2", "cut_off", self.AIR_REBOOT, "2026-10-18T06:46:11.042Z")])

    def test_an_unload_before_the_cut_turn_does_not_hide_an_update_cut_after_more_steps(self):
        steps = [{"type": "message", "timestamp": "2026-10-18T06:46:05.000Z", "message": {"role": "toolResult", "content": "x"}},
                 {"type": "message", "timestamp": "2026-10-18T06:46:06.000Z", "message": {"role": "assistant", "stopReason": "toolUse", "content": [{"type": "toolCall", "name": "bash"}]}}]
        self.air_reboot(between=steps)
        self.assertEqual([p["reason"] for p in self.run_air_reboot()["paused"]], ["cut_off"])

    def test_an_owner_archive_inside_a_restart_window_wins(self):
        # The owner archived the run-3 test chat at 06:52:53Z on 10-18 (archived-chats.json). An archive line that falls in a restart window
        # reads as the restart's, so only the owner's record tells them apart.
        archived = {"type": "session_state", "timestamp": "2026-10-18T06:52:53.805Z", "state": {"status": "archived"}}
        self.air_reboot(archived, notice=False)
        window = (resume_paused.parse_ts("2026-10-18T06:52:50Z"), resume_paused.parse_ts("2026-10-18T06:53:30Z"))
        (self.root / "archived-chats.json").write_text(json.dumps({"ids": ["01a14db9-c12c-72fa-ad78-02fecd442f20"]}))
        unresolved = lambda: [entry["session_id"] for entry in resume_paused.UNRESOLVED]
        self.assertEqual((self.run_air_reboot(restarts=[window])["paused"], unresolved()), ([], [self.AIR_REBOOT]),
                         "with no record the archive's cause is unknown: not resumed, reported")
        for ids, why in ((["01a11af8-962e-773d-a19a-ee4104011987"], "the owner archived the job's chat"), ([self.AIR_REBOOT], "the owner archived the session itself")):
            resume_paused.UNRESOLVED.clear()
            (self.root / "archived-chats.json").write_text(json.dumps({"ids": ids}))
            self.assertEqual((self.run_air_reboot(restarts=[window])["paused"], unresolved()), ([], []), why)

    def test_a_stop_after_the_updates_cut_still_wins(self):
        archived = {"type": "session_state", "timestamp": "2026-10-18T06:52:53.805Z", "state": {"status": "archived"}}
        self.air_reboot(archived)
        self.assertEqual(self.run_air_reboot()["paused"], [], "a parent or the owner archived it after the cut")
        self.assertEqual(self.run_air_reboot(unloaded_at="2026-10-18T06:52:54.100Z")["paused"], [], "the unload stopped it after the cut")
        window = (resume_paused.parse_ts("2026-10-18T06:52:50Z"), resume_paused.parse_ts("2026-10-18T06:53:30Z"))
        self.assertEqual(self.run_air_reboot(restarts=[window])["paused"], [],
                         "an update archives no session it keeps, so an archive after its notice is an unattributed stop, even in a restart window")
        (self.root / "deleted-jobs.json").write_text(json.dumps({"01a11af8-962e-773d-a19a-ee4104011987": {"sub-e40ffbe0": 1}}))
        self.assertEqual(self.run_air_reboot(restarts=[window])["paused"], [], "a recorded delete wins")

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

    def test_a_run_the_idle_unload_stopped_asleep_on_a_429_is_resumed_once_pi_pool_lets_its_tree_in(self):
        # new pages indexing (01a14d4b), a subagent under VP 01a11a24 on 10-19: its retry slept on this 429 from 00:46:55Z with a slot at 02:11:32Z,
        # one of the 176 runs asleep in their provider retry at 01:11Z. The idle unload stops such a run; the kill writes only the archive.
        sid, root = "01a14d4b-0dac-76cc-a069-bf3df2e441bc", "01a11a24-a46e-77ff-adf7-671d01d462e2"
        limited = ("Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit. Please try again later. "
                   "[request_id: req_011CgAg29pGniWPK9QDpcW7a] pi-pool: claude11@slack.green is limited until 2026-10-19T03:00:00.000Z; "
                   "this session waits for its slot at 2026-10-19T02:11:32.000Z. Try again in 85 minutes.")
        sessions = self.root / "sessions"
        sessions.mkdir(exist_ok=True)
        entries = [{"type": "message", "timestamp": "2026-10-19T00:40:02.000Z", "message": {"role": "user", "content": [{"type": "text", "text": "index the new pages"}]}},
                   {"type": "message", "timestamp": "2026-10-19T00:46:55.774Z", "message": {"role": "assistant", "stopReason": "error", "provider": "anthropic",
                                                                                           "content": [], "errorMessage": limited}},
                   {"type": "session_state", "timestamp": "2026-10-19T01:21:40.100Z", "state": {"status": "archived"}},
                   {"type": "session_state", "timestamp": "2026-10-19T01:21:40.300Z", "state": {"status": "active"}}]
        (sessions / f"{sid}.jsonl").write_text("\n".join(json.dumps(entry) for entry in entries) + "\n")
        unloaded = {sid: resume_paused.parse_ts("2026-10-19T01:21:40.200Z")}
        args = argparse.Namespace(message="continue", since_minutes=1440, dry_run=False, include_children=False, direct=True, only="", state=str(self.root / "state.json"))

        def run(slot_at, now):
            def pool(cmd, **kwargs):
                body = {"provider": "anthropic", "rows": [{"id": "claude7", "usable": True}]} if cmd[1] == "ls" else \
                    {"providers": {"anthropic": {"account": None if slot_at else "claude7", "wait": {"account": "claude11", "slot_at": slot_at} if slot_at else None}}}
                self.assertIn(sid if cmd[1] == "who" else "--provider", cmd)
                return resume_paused.subprocess.CompletedProcess(cmd, 0, json.dumps(body), "")
            with patch.object(resume_paused, "SESSIONS_DIR", sessions), patch.object(resume_paused, "ARTIFACTS_DIR", self.root / "artifacts"), \
                    patch.dict(resume_paused.UNLOADED, unloaded, clear=True), patch.object(resume_paused, "pool_bin", return_value="pi-pool"), \
                    patch.object(resume_paused.subprocess, "run", side_effect=pool), patch.object(resume_paused.time, "time", return_value=now.timestamp()), \
                    patch.object(resume_paused, "send", side_effect=lambda target, text: self.sent.append((target, text)) or {"deliveryStatus": "delivered"}):
                rows = resume_paused.with_saved_owners([], resume_paused.saved_rows({sid}), {sid})
                return resume_paused.resume(rows, args, now)

        held = run(dt.datetime(2026, 10, 19, 2, 11, 32, tzinfo=dt.timezone.utc).timestamp(), dt.datetime(2026, 10, 19, 1, 31, tzinfo=dt.timezone.utc))
        self.assertEqual((held["paused"], held.get("stopped"), self.sent), ([], None, []), "the pool still holds the tree")
        report = run(None, dt.datetime(2026, 10, 19, 2, 12, tzinfo=dt.timezone.utc))
        self.assertEqual([(p["reason"], p["target"], p["errored_at"]) for p in report["paused"]], [("error", sid, "2026-10-19T00:46:55.774Z")])
        self.assertEqual(self.sent, [(sid, "continue")])
        self.assertTrue(resume_paused.unload_stop_holds({"lifecycle": "archived"}, ("error", "Connection error.")), "a network error the unload met stays stopped")

    def test_a_job_whose_chat_is_archived_asks_pi_pool_for_its_chats_tree_and_stays_held(self):
        # scratch deletion (01a151ed), a job of chat-057a (01a14210) on 10-19: claude7 hit its 5h cap at 02:29:12Z, and the tree's waits ran
        # to an R5 backoff. The idle unload stopped the job at 02:45:25Z on this 429. The job sweep held it at 02:56Z and 03:05Z, while the
        # chat's live row (aa7d4447f2b5) matched the job's parentActiveSessionId. The chat was archived from 03:09:29Z to 03:13:47Z. The 03:13Z
        # pass then asked `pi-pool who --session` for the job's own id, read "matches no known session" as no hold, and sent continue. The tree
        # was in a backoff to 03:48:04Z, so the job met another 429 at 03:13:50Z, and five jobs beside it did the same.
        chat, job = "01a14210-4e7d-72c3-aa67-e3d476f4e728", "01a151ed-902d-76f8-b557-01b17eef435f"
        limited = ("Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit. Please try again later. "
                   "[request_id: req_011CgApuNeo5FoYbNkkDXnA6] pi-pool: claude7@slack.green is limited until 2026-10-19T05:59:59.000Z; "
                   "this session waits for its slot at 2026-10-19T03:02:00.000Z. Try again in 19 minutes.")
        path = self.root / "artifacts" / chat / "sub-033898b9" / f"{job}.jsonl"
        path.parent.mkdir(parents=True)
        entries = [{"type": "message", "timestamp": "2026-10-19T02:11:25.900Z", "message": {"role": "user", "content": [{"type": "text", "text": "find what deleted the scratch trees"}]}},
                   {"type": "message", "timestamp": "2026-10-19T02:43:25.274Z", "message": {"role": "assistant", "stopReason": "error", "provider": "anthropic",
                                                                                           "content": [], "errorMessage": limited}},
                   {"type": "session_state", "timestamp": "2026-10-19T02:45:25.805Z", "state": {"status": "archived"}},
                   {"type": "session_state", "timestamp": "2026-10-19T02:45:26.346Z", "state": {"status": "active"}}]
        path.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n")
        rows = [{"id": chat, "sessionId": chat, "lifecycle": "archived", "activity": "idle", "sessionName": "chat-057a", "runtimeKind": "top-level",
                 "sessionFile": str(self.root / "sessions" / f"{chat}.jsonl"), "lastActivityAt": "2026-10-19T03:09:29.880Z"},
                {"id": job, "sessionId": job, "lifecycle": "live", "activity": "idle", "sessionName": "scratch deletion", "runtimeKind": "subagent",
                 "sessionFile": str(path), "lastActivityAt": "2026-10-19T02:45:26.346Z", "parentActiveSessionId": "aa7d4447f2b5", "parentSessionId": chat}]
        args = argparse.Namespace(message="continue", since_minutes=1440, dry_run=False, include_children=False, direct=True, only="", state=str(self.root / "state.json"))
        asked = []

        def run(wait, now):
            def pool(cmd, **kwargs):
                if cmd[1] == "ls":
                    return resume_paused.subprocess.CompletedProcess(cmd, 0, json.dumps({"rows": [{"id": "claude7", "usable": wait is None}]}), "")
                asked.append(cmd[cmd.index("--session") + 1])
                if asked[-1] != chat:
                    # The answer pi-pool gave for the job's id on us-metal02 at 06:12Z on 10-19: it keys a tree by its root session.
                    return resume_paused.subprocess.CompletedProcess(cmd, 0, json.dumps({"error": f"--session {asked[-1]} matches no known session"}), "")
                body = {"providers": {"anthropic": {"account": None if wait else "claude7", "wait": wait}}}
                return resume_paused.subprocess.CompletedProcess(cmd, 0, json.dumps(body), "")
            with patch.dict(resume_paused.UNLOADED, {job: resume_paused.parse_ts("2026-10-19T02:45:26.100Z")}, clear=True), \
                    patch.object(resume_paused, "SESSIONS_DIR", self.root / "sessions"), patch.object(resume_paused, "ARTIFACTS_DIR", self.root / "artifacts"), \
                    patch.object(resume_paused, "DELETED_JOBS", self.root / "deleted-jobs.json"), patch.object(resume_paused, "ARCHIVED_CHATS", self.root / "archived-chats.json"), \
                    patch.object(resume_paused, "pool_bin", return_value="pi-pool"), patch.object(resume_paused.subprocess, "run", side_effect=pool), \
                    patch.object(resume_paused.time, "time", return_value=now.timestamp()), \
                    patch.object(resume_paused, "send", side_effect=lambda target, text: self.sent.append((target, text)) or {"deliveryStatus": "delivered"}):
                return resume_paused.resume(rows, args, now)

        # pi-pool.log, 03:13:48Z: "wait ... session 01a14210-... account claude7@slack.green slot_at 2026-10-19T03:48:03 ... backoff true".
        held = run({"account": "claude7", "slot_at": 1792381684}, dt.datetime(2026, 10, 19, 3, 13, 40, tzinfo=dt.timezone.utc))
        self.assertEqual((held["paused"], self.sent, asked), ([], [], [chat]), "the pool holds the chat's tree")
        report = run(None, dt.datetime(2026, 10, 19, 6, 24, tzinfo=dt.timezone.utc))
        self.assertEqual([(p["reason"], p["errored_at"]) for p in report["paused"]], [("error", "2026-10-19T02:43:25.274Z")])
        self.assertEqual(self.sent, [(job[-12:], "continue")])

    def test_the_sweep_reports_a_job_the_pool_holds_with_its_pool_time_and_resumes_it_once_who_admits_it(self):
        chat, job = "01a151ca-2bab-71ee-a334-bfae1773e0a0", "01a151d3-6973-70f1-ba91-bebde466d3af"
        limited = ("Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit. Please try again later. "
                   "[request_id: req_011CgAp1VZL8PUdAYKX5k9Xa] pi-pool: claude7@slack.green is limited until 2026-10-19T05:59:59.000Z; "
                   "this session waits for its slot at 2026-10-19T02:48:11.000Z. Try again in 16 minutes.")
        path = self.root / "artifacts" / chat / "sub-92bb92ab" / f"{job}.jsonl"
        path.parent.mkdir(parents=True)
        entries = [{"type": "message", "timestamp": "2026-10-19T01:44:20.000Z", "message": {"role": "user", "content": [{"type": "text", "text": "research the Twitch index gaps"}]}},
                   {"type": "message", "timestamp": "2026-10-19T02:31:41.345Z", "message": {"role": "assistant", "stopReason": "error", "provider": "anthropic",
                                                                                           "content": [], "errorMessage": limited}},
                   {"type": "session_state", "timestamp": "2026-10-19T02:34:39.567Z", "state": {"status": "archived"}},
                   {"type": "session_state", "timestamp": "2026-10-19T02:34:39.992Z", "state": {"status": "active"}}]
        path.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n")
        rows = [{"id": chat, "sessionId": chat, "lifecycle": "live", "activity": "idle", "sessionName": "Twitch gaps", "runtimeKind": "top-level",
                 "sessionFile": str(self.root / "sessions" / f"{chat}.jsonl"), "lastActivityAt": "2026-10-19T02:42:26.038Z"},
                {"id": job, "sessionId": job, "lifecycle": "live", "activity": "idle", "sessionName": "twitch index gaps", "runtimeKind": "subagent",
                 "sessionFile": str(path), "lastActivityAt": "2026-10-19T02:34:39.992Z", "parentSessionId": chat}]
        args = argparse.Namespace(message="continue", since_minutes=1440, dry_run=False, include_children=False, direct=True, only="", state=str(self.root / "state.json"))
        asked = []

        def run(usable, now):
            def pool(cmd, **kwargs):
                if cmd[1] == "ls":
                    row = {"id": "claude7", "email": "claude7@slack.green", "usable": usable, "reason": None if usable else "limited",
                           "limited_until": None if usable else 1792389599, "cooldown_until": None}
                    return resume_paused.subprocess.CompletedProcess(cmd, 0, json.dumps({"rows": [row]}), "")
                asked.append(cmd[cmd.index("--session") + 1])
                return resume_paused.subprocess.CompletedProcess(cmd, 0, json.dumps({"providers": {"anthropic": {"account": "claude7", "wait": None}}}), "")
            with patch.dict(resume_paused.UNLOADED, {job: resume_paused.parse_ts("2026-10-19T02:34:40.384Z")}, clear=True), \
                    patch.object(resume_paused, "SESSIONS_DIR", self.root / "sessions"), patch.object(resume_paused, "ARTIFACTS_DIR", self.root / "artifacts"), \
                    patch.object(resume_paused, "DELETED_JOBS", self.root / "deleted-jobs.json"), patch.object(resume_paused, "ARCHIVED_CHATS", self.root / "archived-chats.json"), \
                    patch.object(resume_paused, "pool_bin", return_value="pi-pool"), patch.object(resume_paused.subprocess, "run", side_effect=pool), \
                    patch.object(resume_paused.time, "time", return_value=now.timestamp()), \
                    patch.object(resume_paused, "send", side_effect=lambda target, text: self.sent.append((target, text)) or {"deliveryStatus": "delivered"}):
                return resume_paused.resume(rows, args, now)

        held = run(False, dt.datetime(2026, 10, 19, 5, 55, 37, tzinfo=dt.timezone.utc))
        self.assertEqual((held["paused"], self.sent, asked), ([], [], [chat]), "pi-pool holds the chat's tree while claude7 is limited")
        self.assertEqual([(entry["session_id"], entry["tree"], entry["provider"], entry["errored_at"], entry["held_by"], entry["pool_at"]) for entry in resume_paused.HELD],
                         [(job, chat, "anthropic", "2026-10-19T02:31:41.345Z", "claude7@slack.green is limited", "2026-10-19T05:59:59+00:00")])
        resume_paused.HELD.clear()
        report = run(True, dt.datetime(2026, 10, 19, 6, 0, 30, tzinfo=dt.timezone.utc))
        self.assertEqual(([(p["reason"], p["errored_at"]) for p in report["paused"]], resume_paused.HELD), ([("error", "2026-10-19T02:31:41.345Z")], []))
        self.assertEqual(self.sent, [(job[-12:], "continue")])

    def test_the_sweep_takes_a_held_runs_pool_time_from_the_wait_slot_the_account_hold_or_the_error(self):
        now = dt.datetime(2026, 10, 19, 5, 55, 37, tzinfo=dt.timezone.utc).timestamp()
        limited = {"claude7": {"limited_until": now + 264, "cooldown_until": None, "windows": []},
                   "claude9": {"limited_until": None, "cooldown_until": None, "windows": [{"pct": 100, "resets_at": now + 600}, {"pct": 40, "resets_at": now + 60}]},
                   "claude1": {"disabled": True, "limited_until": now + 30}}
        self.assertEqual(resume_paused.pool_free_at({"account": None, "wait": {"slot_at": now + 90}}, limited, now), now + 90)
        self.assertEqual(resume_paused.pool_free_at({"account": "claude7", "wait": None}, limited, now), now + 264)
        self.assertEqual(resume_paused.pool_free_at({"account": None, "wait": None}, limited, now), now + 264, "the earliest account that frees up")
        self.assertIsNone(resume_paused.pool_free_at({"account": "claude9", "wait": None}, limited, now))
        error = ("pi-pool: claude7@slack.green is limited until 2026-10-19T05:59:59.000Z; this session waits for its slot at 2026-10-19T02:48:11.000Z.")
        self.assertEqual(resume_paused.error_free_at(error, now), now + 262)
        self.assertIsNone(resume_paused.error_free_at(error, now + 3600))

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

    def test_the_send_pass_runs_the_token_hooks_of_its_runs_at_once(self):
        """On 10-19 the send pass ran the hook for 239 runs one at a time, 333 s of a 365 s pass, and chat restarts killed it before its sends."""
        log = self.root / "hook-log"
        hook = self.root / "pi-pool-token"
        hook.write_text("#!/bin/sh\n" f'echo "start $(date +%s.%N)" >> "{log}"\nsleep 0.4\n' f'echo "end $(date +%s.%N)" >> "{log}"\nprintf sk-ant-oat01-secret\n')
        hook.chmod(0o755)
        names = [f"{index:012x}" for index in range(8)]
        for name in names:
            self.session(name, [{**assistant(30, "error", self.HOOK_ERROR), "message": {**assistant(30, "error", self.HOOK_ERROR)["message"], "provider": "anthropic"}}])
        args = argparse.Namespace(message="continue", since_minutes=1440, dry_run=False, include_children=False, direct=True,
                                  only=",".join("0" * 24 + name for name in names), state=str(self.root / "state.json"))
        with patch.object(resume_paused, "TOKEN_HOOK", hook), patch.object(resume_paused, "pool_bin", return_value=None), \
                patch.object(resume_paused, "send", side_effect=lambda target, text: self.sent.append((target, text)) or {"deliveryStatus": "delivered"}):
            resume_paused.resume(self.sessions, args, NOW)
        running, most = 0, 0
        for _, kind in sorted((float(stamp), kind) for kind, stamp in (line.split() for line in log.read_text().splitlines())):
            running += 1 if kind == "start" else -1
            most = max(most, running)
        self.assertEqual(sorted(self.sent), sorted((name, "continue") for name in names))
        self.assertEqual(log.read_text().count("start"), 8)
        self.assertGreater(most, 1, "the hooks ran one at a time")

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

    def fake_relay(self, files, errors=None):
        """A relay on localhost that serves `files` ({path: bytes}) the way prime-relay's GET /v1/file does: a Range from an offset, 416 with the
        size past the end, a folder as its entries, and 404 "no such file" for anything else. `errors` ({path: status}) fails those reads."""
        errors = errors or {}
        import http.server
        import threading
        import urllib.parse as parse

        served = self.served

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def reply(self, status, body=b"", **headers):
                self.send_response(status)
                for name, value in {**headers, "Content-Length": len(body)}.items():
                    self.send_header(name.replace("_", "-"), str(value))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.headers.get("Authorization") != "Bearer t0ken":
                    return self.reply(401)
                path = parse.parse_qs(parse.urlparse(self.path).query)["path"][0]
                if path in errors:
                    return self.reply(errors[path], b'{"error":"relay failed"}')
                if path in files:
                    body = files[path]
                    start = int(self.headers.get("Range", "bytes=0-")[6:-1] or 0)
                    if start >= len(body) and start:
                        return self.reply(416, X_File_Size=len(body))
                    served.append(len(body) - start)
                    return self.reply(206 if start else 200, body[start:], X_File_Size=len(body))
                entries = [{"name": name[len(path) + 1:], "type": "file", "size": len(body), "mtimeMs": 1792296000000}
                           for name, body in files.items() if name.startswith(path + "/") and "/" not in name[len(path) + 1:]]
                if not entries:
                    return self.reply(404, b'{"error":"no such file"}')
                self.reply(200, json.dumps({"entries": entries}).encode())

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

    def test_a_hung_run_asleep_in_its_retry_is_marked_only_when_its_continue_can_go_through(self):
        # ssh tailnet only, 10-18: hung 146 min on its 08:20:32Z 429. The job sweep aborts a marked run, so the mark needs no stop record,
        # an account pi-pool can serve the tree from, and no pi-pool wait or 0 to 120 min backoff (30f44c22b) on the tree.
        self.session("asleepasleep", [assistant(81, "toolUse"), role(80, "toolResult"),
                                      assistant(80, "error", "429 This request would exceed your account's rate limit. Please try again later.")],
                     activity="working", isStreaming=True, lastActivityAt=at(80))
        os.utime(self.sessions[0]["sessionFile"], (NOW.timestamp() - 80 * 60,) * 2)

        def marked(blocker=None, record=None):
            with patch.object(resume_paused, "account_blocker", return_value=(blocker, None)), patch.object(resume_paused, "stop_record", return_value=record):
                report = self.run_resume(dry_run=True)
            self.assertEqual([p["reason"] for p in report["paused"]], ["hung"])
            return "retry_error" in report["paused"][0]

        self.assertTrue(marked())
        self.assertFalse(marked(blocker="pi-pool holds the tree until 2026-10-18T12:40:00+00:00"))
        self.assertFalse(marked(record="deleted on purpose"))

    def test_an_unknown_pool_answer_blocks_the_retry_abort_and_a_non_pooled_provider_does_not(self):
        # chat-057a's review of 19fde4349 (10-18): a pool read that failed returned None, which read as "this account can serve".
        def strict(ls=None, who=None, tool="pi-pool", provider="anthropic", error=None):
            def run(cmd, **kwargs):
                if error:
                    raise error
                body = ls if cmd[1] == "ls" else who
                return resume_paused.subprocess.CompletedProcess(cmd, 0 if body is not None else 1, json.dumps(body or {}), "")
            with patch.object(resume_paused, "pool_bin", return_value=tool), patch.object(resume_paused.subprocess, "run", side_effect=run), \
                    patch.object(resume_paused.time, "time", return_value=NOW.timestamp()):
                return (resume_paused.account_blocker("root", provider, {}, strict=True)[0], resume_paused.account_blocker("root", provider, {})[0])

        rows = {"rows": [{"id": "acct1", "usable": True}]}
        good = {"providers": {"anthropic": {"account": "acct1", "wait": None}}}
        self.assertEqual(strict(rows, good), (None, None))
        self.assertTrue(strict(None, good)[0].startswith("unknown: pi-pool ls"))
        self.assertTrue(strict(rows, None)[0].startswith("unknown: pi-pool who"))
        self.assertTrue(strict(rows, good, tool=None)[0].startswith("unknown: no pi-pool"))
        self.assertTrue(strict(error=resume_paused.subprocess.TimeoutExpired("pi-pool", 30))[0].startswith("unknown: pi-pool did not answer"))
        self.assertTrue(strict({"rows": []}, good)[0].startswith("unknown: pi-pool ls does not list"))
        self.assertTrue(strict(rows, good, provider=None)[0].startswith("unknown:"))
        self.assertIsNone(strict(None, None, provider="openrouter")[0], "a provider pi-pool does not pool has no pool answer to wait for")
        self.assertIsNone(strict(None, good)[1], "an ordinary continue keeps its old answer")

    def test_a_stop_record_that_does_not_read_blocks_the_retry_abort_and_shows(self):
        self.session("asleepasleep", [assistant(81, "toolUse"), role(80, "toolResult"),
                                      assistant(80, "error", "429 This request would exceed your account's rate limit.")],
                     activity="working", isStreaming=True, lastActivityAt=at(80))
        os.utime(self.sessions[0]["sessionFile"], (NOW.timestamp() - 80 * 60,) * 2)
        with patch.object(resume_paused, "account_blocker", return_value=(None, None)), \
                patch.object(resume_paused, "stop_record", side_effect=resume_paused.RecordError("deleted-jobs.json is not JSON")):
            report = self.run_resume(dry_run=True)
        run = report["paused"][0]
        self.assertNotIn("retry_error", run)
        self.assertIn("did not read", run["retry_blocked"])
        self.assertTrue(any("deleted-jobs.json" in item["error"] for item in resume_paused.INCOMPLETE))

    def test_a_tree_pi_pool_holds_in_a_wait_or_backoff_has_a_blocker(self):
        later = NOW.timestamp() + 3600

        def who(wait, account="acct1"):
            def run(cmd, **kwargs):
                body = {"rows": [{"id": "acct1", "usable": True}]} if cmd[1] == "ls" else \
                    {"providers": {"anthropic": {"account": account, "wait": wait}}}
                return resume_paused.subprocess.CompletedProcess(cmd, 0, json.dumps(body), "")
            with patch.object(resume_paused, "pool_bin", return_value="pi-pool"), patch.object(resume_paused.subprocess, "run", side_effect=run), \
                    patch.object(resume_paused.time, "time", return_value=NOW.timestamp()):
                return resume_paused.account_blocker("root", "anthropic", {})[0]

        self.assertIsNone(who(None))
        self.assertIn("holds the tree", who({"account": "acct1", "slot_at": later}))
        self.assertIsNone(who({"account": "acct1", "slot_at": NOW.timestamp() - 60}))
        self.assertIn("no anthropic account", who({"account": "acct1", "slot_at": NOW.timestamp() - 60}, account=None))

    def test_retry_wait_names_the_error_a_hung_run_sleeps_on(self):
        # ssh tailnet only, 10-18: its last entry is the 08:20:32Z 429, and it showed working for 146 min after it.
        rate = {"type": "message", "timestamp": "2026-10-18T08:20:32Z", "message": {"role": "assistant", "stopReason": "error", "content": [],
                "errorMessage": "429 This request would exceed your account's rate limit. Please try again later."}}
        call = {"type": "message", "timestamp": "2026-10-18T08:20:22Z", "message": {"role": "toolResult", "content": []}}
        self.assertIn("rate limit", resume_paused.retry_wait([call, rate])["retry_error"])
        self.assertEqual(resume_paused.retry_wait([rate, call]), {})
        # pi-pool's hold is no stuck retry: run-8's root failed on it from 08:23 to 10:39Z on 10-18 while the pool pushed its slot back.
        hold = {"type": "message", "timestamp": "2026-10-18T10:24:40Z", "message": {"role": "assistant", "stopReason": "error", "content": [],
                "errorMessage": 'Failed to resolve API key for provider "anthropic" from shell command: /home/sieun/.config/pi-pool/bin/pi-pool-token '
                                "pi-pool: this session waits for its slot at 2026-10-18T10:45:00.000Z. Try again in 15 minutes."}}
        self.assertEqual(resume_paused.retry_wait([call, hold]), {})
        # A provider 429 the extension gave a pool hold is marked: account_blocker's live `pi-pool who` decides whether the hold still stands.
        held = {**hold, "message": {**hold["message"], "errorMessage": "429 rate limit: this session waits for its slot at 2026-10-18T10:45:00Z"}}
        self.assertIn("waits for its slot", resume_paused.retry_wait([call, held])["retry_error"])

    def test_a_run_asleep_on_a_pool_hold_is_aborted_once_pi_pool_lets_its_tree_in(self):
        # guard-fix (01a15032), 10-18: its 18:20:18Z wake met a 429 on claude12, and the extension gave each retry the tree's R5 backoff draw.
        # The last one, at 19:48:50Z, said 85 min. claude7 served other trees from 20:00Z and this tree moved to it at 20:38Z, yet the run slept
        # to 21:13:34Z. Its tail, from its session file:
        wake = {"type": "custom_message", "customType": "agent_message", "timestamp": "2026-10-18T18:20:20.100Z",
                "content": "[agent-message from 4dd1b45991e7]\n\n[wake] It is 2026-10-18T18:20:18.902Z, the time you set with board.wake"}
        limited = ("Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit. Please try again later. "
                   "[request_id: req_011CgAHHmXLz9jduu3ajAHGJ] pi-pool: claude12@slack.green is limited until 2026-10-24T01:00:00.000Z; "
                   "this session waits for its slot at 2026-10-18T21:13:34.000Z. Try again in 85 minutes.")
        tail = [wake] + [{"type": "message", "timestamp": stamp, "message": {"role": "assistant", "stopReason": "error", "content": [],
                                                                              "provider": "anthropic", "errorMessage": limited}}
                         for stamp in ("2026-10-18T18:20:20.500Z", "2026-10-18T19:10:38.200Z", "2026-10-18T19:48:50.300Z")]
        self.assertIn("claude12", resume_paused.retry_wait(tail)["retry_error"])
        now = dt.datetime(2026, 10, 18, 20, 40, tzinfo=dt.timezone.utc).timestamp()

        def blocker(wait):
            # `pi-pool who` for the tree: at 19:48:50Z a backoff on claude7 to 21:13:33Z; at 20:38Z the switch to claude7 and no wait.
            def run(cmd, **kwargs):
                body = {"rows": [{"id": "claude7", "usable": True}]} if cmd[1] == "ls" else \
                    {"providers": {"anthropic": {"account": None if wait else "claude7", "wait": wait}}}
                return resume_paused.subprocess.CompletedProcess(cmd, 0, json.dumps(body), "")
            with patch.object(resume_paused, "pool_bin", return_value="pi-pool"), patch.object(resume_paused.subprocess, "run", side_effect=run), \
                    patch.object(resume_paused.time, "time", return_value=now):
                return resume_paused.account_blocker("01a1164b-4a2d-742d-b27a-82f086ed0200", "anthropic", {}, strict=True)[0]

        self.assertIn("holds the tree until", blocker({"account": "claude7", "slot_at": 1792358013}))
        self.assertIsNone(blocker(None))

    def test_a_prime_update_notice_that_ends_the_file_counts_as_a_restart_archive(self):
        # run-6's job, 10-18: its last turn failed on the token hook at 06:45:54Z, Prime's update stopped it with this notice at 06:46:02Z,
        # and the daemon logged its restart window from 06:46:44Z, so the window alone did not cover the stop.
        error = {"type": "message", "timestamp": "2026-10-18T06:45:54.754Z", "message": {"role": "assistant", "stopReason": "error", "content": [],
                                                                                       "errorMessage": self.HOOK_ERROR}}
        notice = {"type": "custom_message", "timestamp": "2026-10-18T06:46:02.955Z", "customType": "prime-agent.update_restart", "content": "updated"}
        window = [(resume_paused.parse_ts("2026-10-18T06:46:44.186Z"), resume_paused.parse_ts("2026-10-18T06:47:22.452Z"))]
        self.assertTrue(resume_paused.archived_by_restart([error, notice], window))
        self.assertFalse(resume_paused.archived_by_restart([notice, error], window))

    # census writer speed (01a14d5d-b858, a Crawler VP job), 10-18: the idle unload archived it at 05:33:23Z, a wake reopened it, and Prime's
    # update cut its tool call at 06:46:02Z. The daemon listed it archived, and the old unload archive hid it from every pass until 07:15Z.
    CENSUS = "01a14d5d-b858-751f-81d4-4dde95370f8c"

    def census_writer(self, *later):
        entries = [{"type": "session_state", "timestamp": "2026-10-18T05:33:22.910Z", "state": {"status": "archived"}},
                   {"type": "message", "timestamp": "2026-10-18T05:45:36.900Z", "message": {"role": "user", "content": [{"type": "text", "text": "wake"}]}},
                   {"type": "message", "timestamp": "2026-10-18T05:46:13.122Z", "message": {"role": "assistant", "stopReason": "toolUse",
                                                                                          "content": [{"type": "toolCall", "name": "ipython"}]}},
                   {"type": "custom_message", "timestamp": "2026-10-18T06:46:02.957Z", "customType": "prime-agent.update_restart", "content": "updated"},
                   {"type": "message", "timestamp": "2026-10-18T06:46:13.981Z", "message": {"role": "toolResult", "isError": True,
                                                                                          "content": [{"type": "text", "text": "Request was aborted"}]}},
                   {"type": "git_state", "timestamp": "2026-10-18T06:46:13.989Z"}, *later]
        sessions = self.root / "sessions"
        sessions.mkdir(exist_ok=True)
        (sessions / f"{self.CENSUS}.jsonl").write_text("\n".join(json.dumps(entry) for entry in entries) + "\n")
        args = argparse.Namespace(message="continue", since_minutes=0, dry_run=True, include_children=False, direct=True, only="", state=str(self.root / "state.json"))
        now = dt.datetime(2026, 10, 18, 6, 49, tzinfo=dt.timezone.utc)
        with patch.object(resume_paused, "SESSIONS_DIR", sessions), patch.object(resume_paused, "ARTIFACTS_DIR", self.root / "artifacts"), \
                patch.dict(resume_paused.UNLOADED, {self.CENSUS: resume_paused.parse_ts("2026-10-18T05:33:23.940Z")}, clear=True), \
                patch.object(resume_paused, "OWNERS", {self.CENSUS}):
            rows = resume_paused.with_saved_owners([], resume_paused.saved_rows({self.CENSUS}), {self.CENSUS})
            return [(p["reason"], p["errored_at"]) for p in resume_paused.resume(rows, args, now)["paused"]]

    def test_a_job_an_update_cut_after_an_older_unload_archive_is_resumed(self):
        self.assertEqual(self.census_writer(), [("cut_off", "2026-10-18T06:46:13.981Z")])

    def test_a_job_stopped_again_after_the_update_stays_stopped(self):
        resumed = [{"type": "message", "timestamp": "2026-10-18T06:47:00.000Z", "message": {"role": "user", "content": [{"type": "text", "text": "continue"}]}},
                   {"type": "message", "timestamp": "2026-10-18T06:47:05.000Z", "message": {"role": "assistant", "stopReason": "toolUse", "content": [{"type": "toolCall"}]}},
                   {"type": "message", "timestamp": "2026-10-18T06:47:30.000Z", "message": {"role": "toolResult", "content": [{"type": "text", "text": "Request was aborted"}]}}]
        self.assertEqual(self.census_writer(*resumed), [])

    def test_another_boxs_job_record_that_fails_to_read_gets_nothing_and_is_reported(self):
        # The relay's 404 "no such file" proves the record is missing; any other failure, or a record that is not a JSON object, leaves the
        # delete unknown, so that job gets nothing and the pass lists it as incomplete.
        record = self.MAC_JOB.rsplit("/", 1)[0] + "/rlm-subagent.json"
        full = "01a14d38-d851-77a8-969c-29b2acca24f6"
        cases = (("missing", {}, {}, ["continue"], None),
                 ("deleted", {record: b'{"status": "deleted"}'}, {}, [], None),
                 ("live", {record: b'{"status": "running"}'}, {}, ["continue"], None),
                 ("relay error", {}, {record: 500}, [], "could not be read (relay mac: " + record + ": 500)"),
                 ("other 404", {}, {record: 404}, [], "could not be read (relay mac: " + record + ": 404)"),
                 ("not json", {record: b"{"}, {}, [], "is not valid JSON (1 bytes)"),
                 ("not an object", {record: b"[]"}, {}, [], "does not have the expected shape"))
        for name, extra, errors, expected, cause in cases:
            with self.subTest(name):
                self.addCleanup(resume_paused.INCOMPLETE.clear)
                resume_paused.INCOMPLETE.clear()
                (self.root / "state.json").unlink(missing_ok=True)
                box = self.fake_relay({self.MAC_JOB: self.mac_job(), **extra}, errors)
                rows = [{"id": full[-12:], "sessionId": full, "lifecycle": "archived", "activity": "idle", "sessionFile": self.MAC_JOB,
                         "sessionName": "components test count", "runtimeKind": "subagent", "lastActivityAt": "2026-10-18T04:21:36.659Z"}]
                sent = []
                box.list = lambda all_rows=False: rows if all_rows else []
                box.send = lambda target, text: sent.append(text) or '{"deliveryStatus": "delivered"}'
                args = argparse.Namespace(message="continue", since_minutes=0, dry_run=False, include_children=False, direct=True, only="", state=str(self.root / "state.json"))
                with patch.dict(resume_paused.UNLOADED, {full: resume_paused.parse_ts("2026-10-18T04:21:40Z")}, clear=True), \
                        patch.object(resume_paused, "DELETED_JOBS", self.root / "deleted-jobs.json"), patch.object(resume_paused, "ARCHIVED_CHATS", self.root / "archived-chats.json"):
                    resume_paused.resume_box(box, args)
                self.assertEqual(sent, expected)
                self.assertEqual((self.root / "state.json").exists(), bool(expected))
                self.assertEqual(resume_paused.INCOMPLETE, [{"host": "mac", "error": f"not checked {full[-12:]}: sub-df01e456/rlm-subagent.json on mac {cause}"}] if cause else [])

    def test_another_boxs_failed_worker_is_left_to_that_box(self):
        # After the chats moved to us-metal02 at 05:30Z on 10-18 the Mac listed 17 of their old root jobs with failed workers, already replaced.
        box = self.fake_relay({self.MAC_JOB: self.mac_job()})
        full = "01a14d66-0000-7000-8000-000000000001"
        rows = [{"id": full[-12:], "sessionId": full, "lifecycle": "live", "activity": "idle", "workerState": "failed", "sessionFile": self.MAC_JOB,
                 "sessionName": "relay keep moved-to-us-metal02", "runtimeKind": "top-level", "lastActivityAt": "2026-10-18T05:05:39.702Z"}]
        box.list = lambda all_rows=False: rows
        args = argparse.Namespace(message="continue", since_minutes=0, dry_run=True, include_children=False, direct=True, only="", state=str(self.root / "state.json"))
        self.assertEqual(resume_paused.resume_box(box, args)["paused"], [])

    def test_a_second_pass_reads_only_the_bytes_a_mac_tail_grew_by(self):
        # us-metal02 to the Mac, 07:52 to 07:57Z on 10-18: five dry-run passes read about 265 tails of 256 KB whole and listed the Mac whole
        # (38.6 MB) each, 72 MB a pass, while frontend bro's 10 MB attach snapshot timed out at 30 s on the same link.
        seam = resume_paused.RECHECK_BYTES
        body = self.mac_job()
        files = {self.MAC_JOB: body}
        box = self.fake_relay(files)
        with patch.object(resume_paused, "BOX", box):
            self.assertEqual(len(resume_paused.tail_entries(self.MAC_JOB)), 3)
            self.assertEqual(self.served, [len(body)])
            line = (json.dumps(role(1, "user")) + "\n").encode()
            files[self.MAC_JOB] = body + line
            self.assertEqual([e["type"] for e in resume_paused.tail_entries(self.MAC_JOB)], ["message", "message", "session_state", "message"])
            self.assertEqual(resume_paused.tail_entries(self.MAC_JOB, 200)[-1]["message"]["role"], "user")
            self.assertEqual(self.served, [len(body), seam + len(line), seam])
            files[self.MAC_JOB] = line
            self.assertEqual(len(resume_paused.tail_entries(self.MAC_JOB)), 1)
        self.assertEqual(self.served, [len(body), seam + len(line), seam, len(line)])
        log = "/Users/sieunpark/.prime/agent/logs/daemon.sock.bab13329.log"
        files[log] = b"[2026-10-18T07:41:30.962Z] supervisor: listening\n"
        box.home = Path("/Users/sieunpark")
        first = box.logs()
        box.log_texts = None
        self.assertEqual(box.logs(), first)
        grew = len(files[log])
        files[log] += b"[2026-10-18T07:42:02.894Z] supervisor: attach failed\n"
        box.log_texts = None
        self.assertEqual(box.logs()[0].count("supervisor"), 2)
        self.assertEqual(self.served[4:], [grew, min(seam, grew), min(seam, grew) + len(files[log]) - grew])
        full = "01a14d38-d851-77a8-969c-29b2acca24f6"
        resume_paused.COPY_DIR.mkdir()
        (resume_paused.COPY_DIR / "mac.sessions.json").write_text(json.dumps({"version": 1, "fullAt": 0, "rows": [{"id": full, "sessionId": full}, {"id": "other"}]}))
        box.list = lambda all_rows=False: self.fail("listed the Mac whole")
        self.assertEqual(box.saved({full}), [{"id": full, "sessionId": full, "lifecycle": "archived", "activity": "idle"}])

    def test_a_kept_tail_or_log_of_a_rewritten_file_is_read_again_whole(self):
        body = self.mac_job()
        files = {self.MAC_JOB: body}
        box = self.fake_relay(files)
        with patch.object(resume_paused, "BOX", box):
            resume_paused.tail_entries(self.MAC_JOB)
            rewritten = ("\n".join(json.dumps(role(minutes, "user")) for minutes in (9, 8, 7, 6, 5, 4)) + "\n").encode()
            self.assertGreater(len(rewritten), len(body))
            files[self.MAC_JOB] = rewritten
            self.assertEqual([e["message"]["role"] for e in resume_paused.tail_entries(self.MAC_JOB)], ["user"] * 6)
            files[self.MAC_JOB] = rewritten[:len(rewritten) - 1] + b"\n"
            self.assertEqual(len(resume_paused.tail_entries(self.MAC_JOB)), 6)
        log = "/Users/sieunpark/.prime/agent/logs/daemon.sock.bab13329.log"
        files[log] = b"[2026-10-18T07:41:30.962Z] supervisor: listening\n"
        box.home = Path("/Users/sieunpark")
        box.logs()
        files[log] = b"[2026-10-18T08:41:30.962Z] supervisor: started again after the log was cut, and wrote more than before\n"
        box.log_texts = None
        self.assertEqual(box.logs(), [files[log].decode()])

    def test_a_stale_copy_row_never_decides_that_a_mac_job_is_live_busy_or_failed(self):
        full = Path(self.MAC_JOB).stem
        cut = [role(60, "user"), {"type": "message", "timestamp": "2026-10-18T04:18:25.152Z", "message": {"role": "toolResult", "content": "x"}},
               {"type": "session_state", "timestamp": "2026-10-18T04:21:36.659Z", "state": {"status": "archived"}}]
        bodies = {"cut": ("\n".join(json.dumps(entry) for entry in cut) + "\n").encode(), "token hook": self.mac_job()}
        stale = {"live": {"lifecycle": "live", "activity": "idle"},
                 "working": {"lifecycle": "live", "activity": "working", "isStreaming": True, "isRunningTools": True},
                 "failed worker": {"lifecycle": "live", "activity": "idle", "workerState": "failed"}}
        resume_paused.COPY_DIR.mkdir()
        for (job, body), (shape, fields) in itertools.product(bodies.items(), stale.items()):
            with self.subTest(job=job, stale=shape):
                (self.root / "state.json").unlink(missing_ok=True)
                row = {"id": full[-12:], "sessionId": full, "sessionFile": self.MAC_JOB, "sessionName": "components test count", "runtimeKind": "subagent",
                       "lastActivityAt": "2026-10-18T04:21:36.659Z", "activeSessionId": full, **fields}
                (resume_paused.COPY_DIR / "mac.sessions.json").write_text(json.dumps({"version": 1, "fullAt": 0, "rows": [row]}))
                box = self.fake_relay({self.MAC_JOB: body})
                box.list = lambda all_rows=False: self.fail("listed the Mac whole") if all_rows else []
                box.send = lambda target, text: '{"deliveryStatus": "delivered"}'
                args = argparse.Namespace(message="continue", since_minutes=0, dry_run=True, include_children=False, direct=True, only="", state=str(self.root / "state.json"))
                with patch.dict(resume_paused.UNLOADED, {full: resume_paused.parse_ts("2026-10-18T04:21:40Z")}, clear=True):
                    report = resume_paused.resume_box(box, args)
                self.assertEqual([(p["reason"], p["errored_at"]) for p in report["paused"]], [("error", "2026-10-18T04:18:25.152Z")] if job == "token hook" else [])

    def test_a_mac_job_stopped_after_a_warm_pass_found_it_gets_no_continue(self):
        # The pass runs at 04:25Z on 10-18, a few minutes after the stop, since save_state drops a send older than a day: on the wall clock
        # this test lost its record from 10-19 04:18Z.
        second_job = self.MAC_JOB.replace("sub-df01e456/01a14d38-d851-77a8-969c-29b2acca24f6", "sub-5e1f0a77/01a14d39-0000-77a8-969c-29b2acca2500")
        record = second_job.rsplit("/", 1)[0] + "/rlm-subagent.json"
        chat = self.MAC_JOB.split("/session-artifacts/")[1].split("/")[0]
        rows = [{"id": Path(job).stem[-12:], "sessionId": Path(job).stem, "lifecycle": "archived", "activity": "idle", "sessionFile": job,
                 "sessionName": Path(job).parent.name, "runtimeKind": "subagent", "lastActivityAt": "2026-10-18T04:21:36.659Z"} for job in (self.MAC_JOB, second_job)]
        unloaded = {row["sessionId"]: resume_paused.parse_ts("2026-10-18T04:21:40Z") for row in rows}
        stops = (("deleted", lambda files: files.__setitem__(record, b'{"status": "deleted"}'), "its parent deleted it (rlm-subagent.json status deleted)"),
                 ("archived", lambda files: (self.root / "archived-chats.json").write_text(json.dumps({"ids": [chat]})), "archived by the owner"))
        for name, stop, why in stops:
            with self.subTest(name):
                (self.root / "state.json").unlink(missing_ok=True)
                (self.root / "archived-chats.json").unlink(missing_ok=True)
                files = {self.MAC_JOB: self.mac_job(), second_job: self.mac_job(), record: b'{"status": "running"}'}
                box = self.fake_relay(files)
                box.list = lambda all_rows=False: rows if all_rows else []
                sent = []
                box.send = lambda target, text: (sent.append(target), stop(files), '{"deliveryStatus": "delivered"}')[-1]
                with patch.dict(resume_paused.UNLOADED, unloaded, clear=True), patch.object(resume_paused, "DELETED_JOBS", self.root / "deleted-jobs.json"), \
                        patch.object(resume_paused, "ARCHIVED_CHATS", self.root / "archived-chats.json"), \
                        patch.object(resume_paused.dt, "datetime", PassClock):
                    for dry_run in (True, False):
                        args = argparse.Namespace(message="continue", since_minutes=0, dry_run=dry_run, include_children=False, direct=True, only="",
                                                  state=str(self.root / "state.json"))
                        self.served.clear()
                        report = resume_paused.resume_box(box, args)
                self.assertNotIn(len(files[self.MAC_JOB]), self.served)
                self.assertEqual(len(report["paused"]), 2)
                self.assertEqual(sent, [rows[0]["sessionId"]])
                self.assertEqual(list(json.loads((self.root / "state.json").read_text())), [rows[0]["sessionId"]])
                results = {row["id"]: row["result"] for row in report["heads"] + report["children"]}
                self.assertEqual(results[rows[1]["id"]], f"skipped: {why} after the pass found it")
                self.assertEqual(resume_paused.INCOMPLETE, [])

    def test_a_malformed_answer_from_another_box_keeps_this_boxs_report(self):
        # The overrun test's first fake printed a list with no "sessions" key, and the KeyError ended the whole pass after this box's sends.
        class Broken:
            remote = True
            name = "mac"

            def list(self, all_rows=False):
                raise KeyError("sessions")

        with patch.object(resume_paused.LocalBox, "list", return_value=[]), patch.object(resume_paused, "other_boxes", return_value=[Broken()]), \
                patch.object(resume_paused, "UNLOADED_FILE", self.root / "unloaded.json"), patch.dict(resume_paused.UNLOADED, {}, clear=True), \
                patch("sys.argv", ["x", "--json", "--dry-run", "--direct", "--state", str(self.root / "state.json")]), patch("sys.stderr"), \
                patch("builtins.print") as printed:
            resume_paused.main()
        report = json.loads(printed.call_args.args[0])
        self.assertEqual((report["paused"], report["incomplete"]), ([], [{"host": "mac", "error": "'sessions'"}]))

    CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200"

    def two_cut_jobs(self, **row):
        """Two jobs under one chat whose turns were cut 11 min ago, as rows the daemon lists, and the send loop's sub-folder of each."""
        rows, subs = [], {}
        for sid, sub in (("01a14da8-6bca-76b3-9db8-85ef9cec80b3", "sub-8b9d12da"), ("01a14dc0-465e-7639-84ec-601805c6e474", "sub-3075f485")):
            folder = self.root / "artifacts" / self.CHAT / sub
            folder.mkdir(parents=True)
            (folder / "rlm-subagent.json").write_text(json.dumps({"sessionName": sub}))
            (folder / f"{sid}.jsonl").write_text("\n".join(json.dumps(entry) for entry in [assistant(12, "toolUse"), role(11, "toolResult")]) + "\n")
            rows.append({"id": sid, "sessionId": sid, "lifecycle": "live", "activity": "idle", "sessionFile": str(folder / f"{sid}.jsonl"),
                         "sessionName": sub, "runtimeKind": "subagent", "lastActivityAt": at(11), "parentSessionId": self.CHAT, **row})
            subs[sid] = sub
        return rows, subs

    def run_stopped_mid_pass(self, rows, on_first_send, only=(), fail_first=None):
        """A --direct pass over `rows` whose first send runs `on_first_send` before it answers (or fails with `fail_first`)."""
        sent = []

        def fake_send(target, text):
            sent.append(target)
            if len(sent) == 1:
                on_first_send()
                if fail_first:
                    raise resume_paused.CommandError(fail_first)
            return {"deliveryStatus": "delivered"}

        args = argparse.Namespace(message="continue", since_minutes=1440, dry_run=False, include_children=False, direct=True,
                                  only=",".join(only), state=str(self.root / "state.json"))
        self.addCleanup(resume_paused.INCOMPLETE.clear)
        with patch.object(resume_paused, "ARTIFACTS_DIR", self.root / "artifacts"), patch.object(resume_paused, "SESSIONS_DIR", self.root / "sessions"), \
                patch.object(resume_paused, "DELETED_JOBS", self.root / "deleted-jobs.json"), patch.object(resume_paused, "ARCHIVED_CHATS", self.root / "archived-chats.json"), \
                patch.object(resume_paused, "daemon_restarts", return_value=[]), patch.object(resume_paused, "worker_shutdowns", return_value=[]), \
                patch.object(resume_paused, "pool_bin", return_value=None), patch.object(resume_paused, "send", side_effect=fake_send), \
                patch.object(resume_paused, "live_id", return_value=None), patch.dict(resume_paused.UNLOADED, {}, clear=True):
            report = resume_paused.resume(rows, args, NOW)
        state = json.loads((self.root / "state.json").read_text()) if (self.root / "state.json").exists() else {}
        return report, sent, state

    def test_a_run_deleted_or_archived_after_the_pass_found_it_gets_no_continue(self):
        for record, body in (("deleted-jobs.json", lambda first, second, sub: {self.CHAT: {sub: 1}}),
                             ("archived-chats.json", lambda first, second, sub: {"ids": [second]}),
                             ("archived-chats.json", lambda first, second, sub: {"ids": [self.CHAT]})):
            with self.subTest(record=record, body=body):
                for path in self.root.iterdir():
                    shutil.rmtree(path) if path.is_dir() else path.unlink()
                rows, subs = self.two_cut_jobs()
                first, second = (row["sessionId"] for row in rows)
                report, sent, state = self.run_stopped_mid_pass(rows, lambda: (self.root / record).write_text(json.dumps(body(first, second, subs[second]))))
                self.assertEqual(sent, [first[-12:]])
                self.assertEqual(list(state), [first])
                results = {child["id"]: child["result"] for child in report["children"]}
                self.assertRegex(results[second[-12:]], r"^skipped: (deleted on purpose|archived by the owner) after the pass found it$")
                self.assertEqual(resume_paused.INCOMPLETE, [])

    def test_a_run_deleted_after_its_send_failed_is_never_relayed(self):
        rows, subs = self.two_cut_jobs(lifecycle="archived", saved=True)
        first = rows[0]["sessionId"]
        relayed = []
        with patch.object(resume_paused, "relay", side_effect=lambda *a: relayed.append(a) or {"deliveryStatus": "delivered"}):
            report, sent, state = self.run_stopped_mid_pass(rows[:1], lambda: (self.root / "deleted-jobs.json").write_text(json.dumps({self.CHAT: {subs[first]: 1}})),
                                                            only=[first], fail_first=f"prime-agent send failed (1): Error: Unknown active session: {first}")
        self.assertEqual((sent, relayed, state), ([first], [], {}))
        self.assertEqual(report["children"][0]["result"], "skipped: deleted on purpose after the pass found it")

    def test_an_unreadable_stop_record_during_the_sends_stops_the_rest_and_is_reported(self):
        rows, _ = self.two_cut_jobs()
        first, second = (row["sessionId"] for row in rows)
        report, sent, state = self.run_stopped_mid_pass(rows, lambda: (self.root / "archived-chats.json").write_text(""))
        self.assertEqual((sent, list(state)), ([first[-12:]], [first]))
        self.assertEqual({child["id"]: child["result"] for child in report["children"]}[second[-12:]], {"error": "not sent: archived-chats.json is not valid JSON (0 bytes)"})
        self.assertEqual(resume_paused.INCOMPLETE, [{"host": None, "error": f"not sent to {second[-12:]}: archived-chats.json is not valid JSON (0 bytes)"}])

    def test_a_missing_stop_record_is_empty_and_a_malformed_one_makes_the_box_incomplete(self):
        rows, _ = self.two_cut_jobs()
        self.addCleanup(resume_paused.INCOMPLETE.clear)

        def pass_with(record):
            path = self.root / "deleted-jobs.json"
            path.unlink(missing_ok=True)
            if record is not None:
                path.write_text(record)
            with patch.object(resume_paused.LocalBox, "list", return_value=rows), patch.object(resume_paused, "other_boxes", return_value=[]), \
                    patch.object(resume_paused, "ARTIFACTS_DIR", self.root / "artifacts"), patch.object(resume_paused, "SESSIONS_DIR", self.root / "sessions"), \
                    patch.object(resume_paused, "DELETED_JOBS", path), patch.object(resume_paused, "ARCHIVED_CHATS", self.root / "missing.json"), \
                    patch.object(resume_paused, "UNLOADED_FILE", self.root / "unloaded.json"), patch.dict(resume_paused.UNLOADED, {}, clear=True), \
                    patch.object(resume_paused, "daemon_restarts", return_value=[]), patch.object(resume_paused, "worker_shutdowns", return_value=[]), \
                    patch.object(resume_paused, "pool_bin", return_value=None), patch.object(resume_paused, "send", side_effect=AssertionError("dry run")), \
                    patch("sys.argv", ["x", "--json", "--dry-run", "--direct", "--since-minutes", "0", "--state", str(self.root / "state.json")]), patch("sys.stderr"), \
                    patch("builtins.print") as printed:
                resume_paused.main()
            return json.loads(printed.call_args.args[0])

        self.assertEqual((len(pass_with(None)["paused"]), pass_with(None).get("incomplete")), (2, None))
        for record, cause in (("{", "is not valid JSON (1 bytes)"), ('{"chat": [1]}', "does not have the expected shape")):
            report = pass_with(record)
            self.assertEqual((report["paused"], report["incomplete"]), ([], [{"host": None, "error": f"sent nothing: deleted-jobs.json {cause}"}]))

    def pass_stopped_by_sigterm(self, ids, send_seconds, wait_for):
        """Runs the script on a private HOME with a fake prime-agent whose sends take `send_seconds`, and a slowbox in hosts.json whose
        daemon list never answers. Sends SIGTERM once the file named by `wait_for` ("sending" or "reading") appears."""
        import signal
        import subprocess
        import sys
        import time
        home, bin_dir = self.root / "home", self.root / "bin"
        sessions = home / ".prime" / "agent" / "sessions"
        sessions.mkdir(parents=True)
        bin_dir.mkdir()
        ago = lambda minutes: (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")
        rows = []
        for sid in ids:
            (sessions / f"{sid}.jsonl").write_text("\n".join(json.dumps(entry) for entry in [
                {"type": "message", "timestamp": ago(12), "message": {"role": "assistant", "stopReason": "toolUse", "content": [{"type": "toolCall", "name": "bash"}]}},
                {"type": "message", "timestamp": ago(11), "message": {"role": "toolResult", "content": "x"}}]) + "\n")
            rows.append({"id": sid, "sessionId": sid, "lifecycle": "live", "activity": "idle", "sessionFile": str(sessions / f"{sid}.jsonl"),
                         "sessionName": sid, "runtimeKind": "top-level", "lastActivityAt": ago(11)})
        sends, sending, reading = self.root / "sends.txt", self.root / "sending", self.root / "reading"
        agent = bin_dir / "prime-agent"
        agent.write_text(f"#!{sys.executable}\nimport json, sys, time\n"
                         f"if sys.argv[1] == 'list': print(json.dumps({{'sessions': {rows!r}}}))\n"
                         f"else: open({str(sending)!r}, 'w').close(); time.sleep({send_seconds}); open({str(sends)!r}, 'a').write(sys.argv[3] + '\\n'); "
                         "print(json.dumps({'deliveryStatus': 'delivered'}))\n")
        node = bin_dir / "node"
        node.write_text(f"#!/bin/sh\necho \"$@\" > {reading}\nexec sleep 600\n")
        for tool in (agent, node):
            tool.chmod(0o755)
        (self.root / "token").write_text("t0ken")
        hosts = self.root / "hosts.json"
        hosts.write_text(json.dumps({"hosts": [{"name": "slowbox", "hostname": "slowbox-host", "address": "127.0.0.1", "relayPort": 9, "token": "file:token"}]}))
        env = {"HOME": str(home), "PATH": f"{bin_dir}:/usr/bin:/bin", "TMPDIR": str(self.root), "PRIME_AGENT_BIN": str(agent), "SIEUN_PI_HOSTS": str(hosts)}
        started = time.monotonic()
        with subprocess.Popen([sys.executable, "-B", str(REPO / "skills/resume-paused-sessions/scripts/resume_paused.py"), "--json", "--direct"],
                              env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as run:
            while not (self.root / wait_for).exists() and time.monotonic() - started < 30:
                time.sleep(0.05)
            run.send_signal(signal.SIGTERM)
            stdout, stderr = run.communicate(timeout=30)
        self.assertNotIn("t0ken", stdout + stderr)
        self.assertEqual(run.returncode, 128 + signal.SIGTERM, stderr)
        state = json.loads((home / ".prime" / "agent" / "resume-paused-sessions.json").read_text())
        return json.loads(stdout), sends.read_text().split(), sorted(state)

    def test_a_sigterm_while_another_box_reads_keeps_this_boxs_sends_and_names_the_stop(self):
        # 06:57Z on 10-18: the pass sent 8 continues on us-metal02 by 06:56:06.9Z (its state file), then read the Mac through its relay until
        # the chat service's 90 s execFile timeout sent SIGTERM. It died with no output, and the service logged "Command failed" with no cause.
        sid = "01a14da6-e39d-72c5-82d8-5882bce4a3a2"
        report, sent, state = self.pass_stopped_by_sigterm([sid], 0, "reading")
        self.assertEqual((sent, state), ([sid[-12:]], [sid]))
        self.assertEqual([(child["id"], child["result"]) for child in report["children"]], [(sid[-12:], {"deliveryStatus": "delivered", "deliveryMode": None})])
        self.assertEqual([entry["host"] for entry in report["incomplete"]], ["slowbox"])
        self.assertRegex(report["incomplete"][0]["error"], r"^stopped by SIGTERM after \d+\.\d s while it checked slowbox, last step: node hosts-cli\.mjs daemon slowbox list$")

    def test_a_sigterm_during_a_send_lets_that_send_finish_and_be_recorded_and_sends_no_more(self):
        first, second = "01a14d9a-e19c-7168-926d-af8264556278", "01a14db7-b96a-77ba-84b3-3baf2a4f874e"
        report, sent, state = self.pass_stopped_by_sigterm([first, second], 1, "sending")
        self.assertEqual(len(sent), 1)
        self.assertEqual(state, [next(sid for sid in (first, second) if sid.endswith(sent[0]))])
        self.assertEqual([child["id"] for child in report["children"]], sent)
        self.assertEqual([entry["host"] for entry in report["incomplete"]], [None])
        self.assertRegex(report["incomplete"][0]["error"], r"^stopped by SIGTERM after \d+\.\d s during the sends on this box, last step: prime-agent send --json ")

class ChatHostStopRecords(unittest.TestCase):
    # On 10-18 the chat moved to us-metal02 at 04:19Z and the Mac's browser-chat files stopped there, so a pass on the Mac that read its own
    # deleted-jobs.json would resume a job deleted after the move. The stop records come from the chat host of hosts.json now.
    CHAT = "01a11b0b-7c15-73da-9481-8de15903eab4"

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        files = {"/cap/api/agent/deleted-jobs": json.dumps({self.CHAT: {"sub-deleted-after-move": "2026-10-18T09:00:00Z"}})}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = files.get(self.path)
                self.send_response(200 if body else 404)
                self.end_headers()
                self.wfile.write((body or '{"error": "Not found."}').encode())

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        port = self.server.server_address[1]
        hosts = self.root / "hosts.json"
        hosts.write_text(json.dumps({"version": 1, "hosts": [{"name": "chat-box", "hostname": "chat-box-not-this-one", "address": "127.0.0.1",
                                                               "roles": {"chat": {"port": port, "url": f"http://127.0.0.1:{port}"}}}]}))
        (self.root / "chat-access.json").write_text(json.dumps({"capability": "cap", "csrfToken": "token"}))
        (self.root / "deleted-jobs.json").write_text(json.dumps({self.CHAT: {}}))
        self.job = self.root / "session-artifacts" / self.CHAT / "sub-deleted-after-move" / "01a14ecc-624e-73df-851a-fc973da7fa4e.jsonl"
        for name, value in (("HOSTS_FILE", hosts), ("DELETED_JOBS", self.root / "deleted-jobs.json"), ("ARCHIVED_CHATS", self.root / "archived-chats.json"),
                            ("ARTIFACTS_DIR", self.root / "session-artifacts")):
            kept = patch.object(resume_paused, name, value)
            kept.start()
            self.addCleanup(kept.stop)
        resume_paused.CHAT_HOST_TEXT.clear()
        self.addCleanup(resume_paused.CHAT_HOST_TEXT.clear)

    def test_a_deletion_only_the_chat_host_holds_stops_the_resume(self):
        with patch("sys.stderr") as stderr:
            self.assertEqual(resume_paused.stop_record(str(self.job)), "deleted on purpose")
        said = "".join(call.args[0] for call in stderr.write.call_args_list)
        self.assertIn("read deleted-jobs.json from the chat host http://127.0.0.1:", said)

    def test_an_unreachable_chat_host_falls_back_to_this_box_and_says_so(self):
        self.server.shutdown()
        self.server.server_close()
        with patch("sys.stderr") as stderr:
            self.assertIsNone(resume_paused.stop_record(str(self.job)))
        said = "".join(call.args[0] for call in stderr.write.call_args_list)
        self.assertIn("read deleted-jobs.json from the local file", said)
        self.assertIn("could not be reached", said)


Held = collections.namedtuple("Held", "chat folder session last_at last_role deleted_at")


class RecordedStops(unittest.TestCase):
    NOW = dt.datetime(2026, 10, 18, 11, 4, tzinfo=dt.timezone.utc)
    SIX = [Held("01a14dd5-e9d3-705d-bd63-245c21b2eee2", "sub-9e9f4273", "01a14ddc-06ee-724b-9147-6de2eff81ca8", "2026-10-18T09:09:54.047Z", "error", "2026-10-18T10:40:44.763Z"),
           Held("01a14d31-6ec0-7005-bbe8-c38b7ae73cfb", "sub-85dca0ef", "01a14e29-cd19-75fc-8560-8d4b98b4fad0", "2026-10-18T08:51:18.992Z", "error", "2026-10-18T10:42:11.396Z"),
           Held("01a14e13-6a5e-757f-8dcb-dc1284beed19", "sub-37b806e7", "01a14e18-f089-7390-aee2-16f7f55c2ce5", "2026-10-18T08:35:43.544Z", "error", "2026-10-18T10:42:29.977Z"),
           Held("01a115e2-9544-7204-b8db-8ce4d5319048", "sub-4893ed85", "01a14d39-07b1-777b-a221-73482afa2fb1", "2026-10-18T04:46:01.899Z", "toolResult", "2026-10-18T06:57:48.843Z"),
           Held("01a115e2-9544-7204-b8db-8ce4d5319048", "sub-2620f44a", "01a14d30-5d3a-707c-8fc6-3c5ac8991ab2", "2026-10-18T04:46:00.695Z", "toolResult", "2026-10-18T06:57:48.732Z"),
           Held("01a1164b-4a2d-742d-b27a-82f086ed0200", "sub-38405c9a", "01a14d0e-be34-7066-9fdf-f3d91cc5d25a", "2026-10-18T05:41:27.311Z", "toolResult", "2026-10-18T05:41:27.291Z")]
    HOOK_ERROR = 'Failed to resolve API key for provider "anthropic" from shell command: pi-pool-token: the token hook gave no token'

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.agent = self.root / "agent"
        (self.agent / "sessions").mkdir(parents=True)
        self.sent = []
        for name, value in (("SESSIONS_DIR", self.agent / "sessions"), ("ARTIFACTS_DIR", self.agent / "session-artifacts"),
                            ("DELETED_JOBS", self.agent / "browser-chat" / "deleted-jobs.json"), ("ARCHIVED_CHATS", self.agent / "browser-chat" / "archived-chats.json"),
                            ("UPDATE_RESTARTS_DIR", self.agent / "update-restarts"), ("LOG_DIR", self.agent / "logs"), ("TOKEN_HOOK", self.root / "no-hook"),
                            ("HOSTS_FILE", self.root / "no-hosts.json"), ("TAIL_CACHE", self.root / "tails"), ("COPY_DIR", self.root / "copies")):
            kept = patch.object(resume_paused, name, value, create=True)
            kept.start()
            self.addCleanup(kept.stop)
        for found in (resume_paused.INCOMPLETE, resume_paused.UNRESOLVED, resume_paused.STOPPED, resume_paused.OWNERS):
            found.clear()
            self.addCleanup(found.clear)
        resume_paused.read_update_records.cache_clear()
        self.addCleanup(resume_paused.read_update_records.cache_clear)
        for name, value in (("daemon_restarts", []), ("worker_shutdowns", []), ("pool_bin", None)):
            kept = patch.object(resume_paused, name, return_value=value)
            kept.start()
            self.addCleanup(kept.stop)
        unloaded = patch.dict(resume_paused.UNLOADED, {}, clear=True)
        unloaded.start()
        self.addCleanup(unloaded.stop)

    def ledger(self, *records, tail=""):
        path = resume_paused.rlm_ledger_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = [{"v": 1, "op": "meta", "at": "2026-10-17T23:43:23.077Z", "sessionsDir": str(self.agent / "sessions")}, *records]
        path.write_text("".join(json.dumps(line) + "\n" for line in lines) + tail)
        return path

    def job(self, chat, sub, sid, entries, registry=None):
        folder = self.agent / "session-artifacts" / chat / sub
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "rlm-subagent.json").write_text(json.dumps({"type": "rlm_subagent", "childId": sub, "sessionName": sub, **(registry or {})}))
        path = folder / f"{sid}.jsonl"
        path.write_text("".join(json.dumps(entry) + "\n" for entry in entries))
        return path

    @staticmethod
    def spawn(chat_dir, path, at):
        return {"v": 1, "op": "spawn", "at": at, "childId": path.parent.name, "parent": str(chat_dir), "child": str(path), "depth": 1, "name": path.parent.name}

    @staticmethod
    def delete(path, at, reason="user"):
        return {"v": 1, "op": "delete", "at": at, "childId": path.parent.name, "child": str(path), "reason": reason}

    @staticmethod
    def message(stamp, role_name, **extra):
        return {"type": "message", "timestamp": stamp, "message": {"role": role_name, "content": [{"type": "text", "text": "x"}], **extra}}

    @staticmethod
    def archive(stamp, reason=None):
        return {"type": "session_state", "timestamp": stamp, "state": {"status": "archived", **({"reason": reason} if reason else {})}}

    @staticmethod
    def later(stamp, seconds):
        return (resume_paused.parse_ts(stamp) + dt.timedelta(seconds=seconds)).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def run_owners(self, sids, dry_run=True):
        args = argparse.Namespace(message="continue", since_minutes=1440, dry_run=dry_run, include_children=False, direct=True, only="",
                                  state=str(self.root / "state.json"))
        resume_paused.OWNERS.update(sids)
        with patch.object(resume_paused, "send", side_effect=lambda target, text: self.sent.append((target, text)) or {"deliveryStatus": "delivered"}):
            rows = resume_paused.with_saved_owners([], resume_paused.saved_rows(set(sids)), set(sids))
            return resume_paused.resume(rows, args, self.NOW)

    def six(self):
        records, sids = [], []
        for chat, sub, sid, last_at, last_role, deleted_at in self.SIX:
            last = (self.message(last_at, "assistant", stopReason="error", errorMessage="429 rate_limit_error: This request would exceed your account's rate limit")
                    if last_role == "error" else self.message(last_at, "toolResult"))
            archived_at = self.later(deleted_at, 0.004 if last_at > deleted_at else 0.05)
            entries = [self.message(self.later(last_at, -60), "user"), last, self.archive(archived_at)] if last_at < deleted_at else \
                [self.message(self.later(last_at, -60), "user"), self.archive(archived_at), last]
            path = self.job(chat, sub, sid, entries)
            records += [self.spawn(self.agent / "sessions" / f"{chat}.jsonl", path, "2026-10-18T05:35:51.027Z"), self.delete(path, deleted_at)]
            sids.append(sid)
        self.ledger(*records)
        return sids

    def test_the_six_held_back_jobs_are_reported_as_deleted_by_their_parents_ledger_records(self):
        sids = self.six()
        report = self.run_owners(sids)
        self.assertEqual((report["paused"], resume_paused.UNRESOLVED), ([], []))
        self.assertEqual(sorted(entry["session_id"] for entry in resume_paused.STOPPED), sorted(sids))
        stopped = {entry["session_id"]: entry["stopped_by"] for entry in resume_paused.STOPPED}
        self.assertEqual(stopped["01a14ddc-06ee-724b-9147-6de2eff81ca8"],
                         "its parent deleted it (rlm ledger delete, reason user, at 2026-10-18T10:40:44.763Z)")

    def test_a_ledger_delete_holds_after_any_later_message_and_only_a_later_spawn_undoes_it(self):
        chat = "01a14dd5-e9d3-705d-bd63-245c21b2eee2"
        cut = "2026-10-18T10:50:00.000Z"
        resume_continue = {"type": "message", "timestamp": "2026-10-18T10:45:00.000Z",
                           "message": {"role": "user", "content": [{"type": "text", "text": "continue"}], "timestamp": 1792320300000}}
        agent_message = {"type": "custom_message", "customType": "agent_message", "content": "[agent-message from parent]\n\ncarry on",
                         "display": True, "timestamp": "2026-10-18T10:46:00.000Z"}
        path = self.job(chat, "sub-9e9f4273", "01a14ddc-06ee-724b-9147-6de2eff81ca8",
                        [self.message("2026-10-18T10:40:00.000Z", "user"), self.archive("2026-10-18T10:40:44.800Z"), resume_continue, agent_message,
                         self.message(self.later(cut, -1), "assistant", stopReason="toolUse"), self.message(cut, "toolResult")])
        parent = self.agent / "sessions" / f"{chat}.jsonl"
        deleted = "its parent deleted it (rlm ledger delete, reason user, at 2026-10-18T10:40:44.763Z)"
        self.ledger(self.spawn(parent, path, "2026-10-18T07:13:48.723Z"), self.delete(path, "2026-10-18T10:40:44.763Z"))
        self.assertEqual(resume_paused.stop_record(str(path)), deleted,
                         "a resume pass's continue is the same plain user message as an owner prompt, and an agent message proves no reopen")
        self.assertEqual((self.run_owners([path.stem])["paused"], [entry["stopped_by"] for entry in resume_paused.STOPPED]), ([], [deleted]))
        self.ledger(self.delete(path, "2026-10-18T10:40:44.763Z"), self.spawn(parent, path, "2026-10-18T10:44:00.000Z"))
        self.assertIsNone(resume_paused.stop_record(str(path)), "a spawn after the delete revived the edge, as the runtime's replay does")
        (path.parent / "rlm-subagent.json").write_text(json.dumps({"status": "deleted", "updatedAt": "2026-10-18T10:40:44.762Z"}))
        self.assertEqual(resume_paused.stop_record(str(path)), "its parent deleted it (rlm-subagent.json status deleted, at 2026-10-18T10:40:44.762Z)",
                         "the runtime never writes rlm-subagent.json back from deleted")


    def test_a_job_under_a_deleted_job_is_stopped_by_the_ancestors_ledger_delete(self):
        chat = "01a14d31-6ec0-7005-bbe8-c38b7ae73cfb"
        above = self.job(chat, "sub-85dca0ef", "01a14e29-cd19-75fc-8560-8d4b98b4fad0", [self.message("2026-10-18T08:00:00.000Z", "user")])
        below = self.job(f"{chat}/sub-85dca0ef", "sub-12345678", "01a14e30-0000-7000-8000-000000000001",
                         [self.message("2026-10-18T08:10:00.000Z", "user"), self.message("2026-10-18T08:51:00.000Z", "toolResult")])
        self.ledger(self.delete(above, "2026-10-18T10:42:11.396Z"))
        self.assertEqual(resume_paused.stop_record(str(below)), "a job above it was deleted (sub-85dca0ef, rlm ledger delete, reason user, at 2026-10-18T10:42:11.396Z)")

    def test_the_registry_status_deleted_counts_on_this_box_too(self):
        path = self.job("01a14e13-6a5e-757f-8dcb-dc1284beed19", "sub-37b806e7", "01a14e18-f089-7390-aee2-16f7f55c2ce5",
                        [self.message("2026-10-18T08:30:00.000Z", "user"), self.message("2026-10-18T08:35:43.544Z", "toolResult")],
                        registry={"status": "deleted", "updatedAt": "2026-10-18T10:42:29.976Z"})
        self.assertEqual(resume_paused.stop_record(str(path)), "its parent deleted it (rlm-subagent.json status deleted, at 2026-10-18T10:42:29.976Z)")

    def test_an_unreadable_ledger_line_stops_the_box_and_a_torn_last_line_is_skipped(self):
        path = self.job("01a14dd5-e9d3-705d-bd63-245c21b2eee2", "sub-9e9f4273", "01a14ddc-06ee-724b-9147-6de2eff81ca8", [self.message("2026-10-18T09:00:00.000Z", "user")])
        self.ledger(self.delete(path, "2026-10-18T10:40:44.763Z"), tail='{"v": 1, "op": "delete", "at": "2026-10-18T10:41')
        self.assertTrue(resume_paused.stop_record(str(path)), "a line still being appended is the runtime's torn final line")
        self.ledger(tail='{"v": 1, "op": "delete"\n')
        with self.assertRaisesRegex(resume_paused.RecordError, r"rlm ledger line 2 is not valid JSON"):
            resume_paused.stop_record(str(path))
        self.ledger({"v": 2, "op": "delete", "at": "2026-10-18T10:41:00.000Z"})
        with self.assertRaisesRegex(resume_paused.RecordError, r"rlm ledger line 2 has version 2"):
            resume_paused.stop_record(str(path))

    def reasoned(self, reason, last=None, sid="01a14eaa-0000-7000-8000-00000000000a"):
        last = last or self.message("2026-10-18T10:20:00.000Z", "toolResult")
        return self.job("01a14210-4e7d-72c3-aa67-e3d476f4e728", f"sub-{sid[-8:]}", sid,
                        [self.message("2026-10-18T10:19:00.000Z", "user"), last, self.archive("2026-10-18T10:20:30.000Z", reason)])

    def test_each_archive_reason_decides_by_its_contract(self):
        cases = {"owner_stop": "stopped", "owner_archive": "stopped", "subagent_deleted": "stopped", "completed": "stopped", "replaced": "stopped",
                 "subagent_cancelled": "stopped", "spawn_failed": "stopped", "draft_discarded": "stopped",
                 "daemon_shutdown": "unresolved", "a_future_reason": "unresolved", None: "unresolved", "idle_unload": "stopped"}
        sids = {}
        for index, reason in enumerate(cases):
            sids[self.reasoned(reason, sid=f"01a14eaa-0000-7000-8000-0000000000{index:02d}").stem] = reason
        report = self.run_owners(list(sids))
        self.assertEqual(report["paused"], [])
        got = {**{entry["session_id"]: "stopped" for entry in resume_paused.STOPPED}, **{entry["session_id"]: "unresolved" for entry in resume_paused.UNRESOLVED}}
        self.assertEqual({sids[sid]: kind for sid, kind in got.items()}, cases)
        said = {sids[entry["session_id"]]: entry["error"] for entry in resume_paused.UNRESOLVED}
        self.assertIn("daemon_shutdown", said["daemon_shutdown"])
        self.assertIn("'a_future_reason'", said["a_future_reason"])
        self.assertEqual(said[None], "An archive with no recorded cause stopped its turn, so it is not resumed.")

    def test_an_idle_unload_reason_follows_the_token_hook_rule_without_the_chats_record(self):
        hook = self.reasoned("idle_unload", self.message("2026-10-18T10:20:00.000Z", "assistant", stopReason="error", provider="anthropic", errorMessage=self.HOOK_ERROR))
        report = self.run_owners([hook.stem])
        self.assertEqual([(p["session_id"], p["reason"]) for p in report["paused"]], [(hook.stem, "error")])

    def update_record(self, name, **fields):
        folder = self.agent / "update-restarts"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"ee92e1d8c39e1961-{name}.json").write_text(json.dumps({"version": 1, "requestId": name, "phase": "complete", **fields}))

    def test_an_update_discard_names_its_cause_only_when_one_record_alone_can_match(self):
        resident = self.reasoned("update_discarded", sid="01a14eaa-0000-7000-8000-0000000000d1")
        draft = self.reasoned("update_discarded", sid="01a14eaa-0000-7000-8000-0000000000d2")
        other_update = self.reasoned("update_discarded", sid="01a14eaa-0000-7000-8000-0000000000d3")
        bare = self.reasoned("update_discarded", sid="01a14eaa-0000-7000-8000-0000000000d4")
        twice = self.reasoned("update_discarded", sid="01a14eaa-0000-7000-8000-0000000000d5")

        def discard(path, cause, at="2026-10-18T10:20:29.990Z"):
            return {"activeSessionId": path.stem[-12:], "sessionId": path.stem, "sessionFile": str(path), "reason": "update_discarded", "cause": cause, "at": at}

        self.update_record("now", discarded=[discard(resident, "resident_after_prepare"), discard(draft, "empty_draft"), discard(twice, "empty_draft")])
        self.update_record("earlier", discarded=[discard(other_update, "empty_draft", at="2026-10-18T10:19:59.000Z"),
                                                 discard(twice, "empty_draft", at="2026-10-18T10:20:10.000Z")])
        report = self.run_owners([resident.stem, draft.stem, other_update.stem, bare.stem, twice.stem])
        self.assertEqual(report["paused"], [])
        self.assertEqual([entry["session_id"] for entry in resume_paused.STOPPED], [draft.stem])
        said = {entry["session_id"]: entry["error"] for entry in resume_paused.UNRESOLVED}
        self.assertEqual(set(said), {resident.stem, other_update.stem, bare.stem, twice.stem})
        self.assertIn("resident_after_prepare", said[resident.stem])
        self.assertIn("no discard record matches it", said[other_update.stem], "a discard written before the turn's last line closed an older run")
        self.assertIn("no discard record matches it", said[bare.stem])
        self.assertIn("2 discard records could match it", said[twice.stem], "two updates that both fit leave the cause unknown")

    def test_two_records_that_list_one_archive_under_stopped_before_restore_leave_it_unresolved(self):
        stopped = self.reasoned(None)
        held = {"sessionId": stopped.stem, "sessionFile": str(stopped), "reason": "owner_stop", "at": "2026-10-18T10:20:30.000Z"}
        self.update_record("now", stoppedBeforeRestore=[held])
        self.run_owners([stopped.stem])
        self.assertEqual([entry["session_id"] for entry in resume_paused.STOPPED], [stopped.stem])
        resume_paused.STOPPED.clear()
        resume_paused.read_update_records.cache_clear()
        self.update_record("again", stoppedBeforeRestore=[{**held, "reason": "unknown"}])
        self.assertEqual(self.run_owners([stopped.stem])["paused"], [])
        self.assertEqual((resume_paused.STOPPED, [entry["error"] for entry in resume_paused.UNRESOLVED]),
                         ([], ["2 update records list its archive at 2026-10-18T10:20:30.000Z under stoppedBeforeRestore, so it is not resumed."]))

    def test_a_session_the_update_did_not_restore_is_never_resumed_by_the_unload_rule(self):
        hook = self.reasoned(None, self.message("2026-10-18T10:20:00.000Z", "assistant", stopReason="error", provider="anthropic", errorMessage=self.HOOK_ERROR))
        resume_paused.UNLOADED[hook.stem] = resume_paused.parse_ts("2026-10-18T10:20:31.000Z")
        self.assertEqual([p["session_id"] for p in self.run_owners([hook.stem])["paused"]], [hook.stem], "the unload record alone resumes a hook failure")
        self.update_record("now", stoppedBeforeRestore=[{"sessionId": hook.stem, "sessionFile": str(hook), "reason": "unknown", "at": "2026-10-18T10:20:30.000Z"}])
        resume_paused.UNRESOLVED.clear()
        resume_paused.read_update_records.cache_clear()
        self.assertEqual(self.run_owners([hook.stem])["paused"], [])
        self.assertEqual([entry["session_id"] for entry in resume_paused.UNRESOLVED], [hook.stem])
        self.assertIn("stoppedBeforeRestore", resume_paused.UNRESOLVED[0]["error"])

    def test_the_send_rechecks_the_ledger_and_a_new_owner_stop_right_before_it_goes(self):
        chat = "01a14dd5-e9d3-705d-bd63-245c21b2eee2"
        path = self.job(chat, "sub-9e9f4273", "01a14ddc-06ee-724b-9147-6de2eff81ca8",
                        [self.message("2026-10-18T10:00:00.000Z", "user"), self.message("2026-10-18T10:40:00.000Z", "toolResult")])
        self.ledger()
        found = self.run_owners([path.stem])["paused"]
        self.assertEqual([p["reason"] for p in found], ["cut_off"])
        self.ledger(self.delete(path, "2026-10-18T11:03:59.000Z"))
        self.assertEqual(resume_paused.send_guard(found[0], self.NOW), "skipped: its parent deleted it (rlm ledger delete, reason user, at 2026-10-18T11:03:59.000Z) after the pass found it")
        self.ledger()
        with path.open("a") as fh:
            fh.write(json.dumps(self.archive("2026-10-18T11:04:00.500Z", "owner_stop")) + "\n")
        self.assertEqual(resume_paused.send_guard(found[0], self.NOW), "skipped: the owner stopped it (archive reason owner_stop, at 2026-10-18T11:04:00.500Z) after the pass found it")


if __name__ == "__main__":
    unittest.main()

