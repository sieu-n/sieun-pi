"""The Python daemon callers (idle-reaper, prime-sync, resume_paused.py) wait past prime-agent's fixed 3 s hello and try a missed hello once more.
On 10-22 65 of 108 probes on us-metal02 got the daemon's hello after 3 to 7 s, and from 10-21 136 resume passes failed on it."""
import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
MISS = "Error: Timed out after 3000ms waiting for the Prime Agent daemon handshake. Socket: /tmp/prime-agent-1001/daemon.sock."


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, REPO / rel)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


reaper = load("reaper_hello", "components/idle-reaper/reaper.py")
sync = load("sync_hello", "components/prime-sync/sync.py")
resume_paused = load("resume_paused_hello", "skills/resume-paused-sessions/scripts/resume_paused.py")


def answers(*results):
    """A subprocess.run stand-in that records each command and gives `results` in turn as (code, stdout, stderr)."""
    calls = []

    def run(cmd, **kwargs):
        calls.append((list(cmd), kwargs.get("timeout")))
        code, out, err = results[len(calls) - 1]
        binary = not kwargs.get("text")
        return subprocess.CompletedProcess(cmd, code, out.encode() if binary else out, err.encode() if binary else err)
    return run, calls


class IdleReaperHello(unittest.TestCase):
    def test_the_cli_read_tries_a_missed_hello_once_more(self):
        run, calls = answers((1, "", MISS), (0, '{"sessions": [{"sessionId": "s1"}]}', ""))
        with patch.object(reaper, "daemon_reader", return_value=None), patch.object(reaper.subprocess, "run", run):
            self.assertEqual(reaper.read_sessions("/bin/prime-agent"), [{"sessionId": "s1"}])
        self.assertEqual([cmd for cmd, _ in calls], [["/bin/prime-agent", "sessions", "--json"]] * 2)

    def test_another_cli_failure_is_not_tried_again(self):
        run, calls = answers((1, "", "Error: something else"))
        with patch.object(reaper, "daemon_reader", return_value=None), patch.object(reaper.subprocess, "run", run):
            self.assertRaises(RuntimeError, reaper.read_sessions, "/bin/prime-agent")
        self.assertEqual(len(calls), 1)

    def test_the_reader_lists_with_its_own_longer_limit(self):
        run, calls = answers((0, '{"sessions": []}', ""))
        with patch.object(reaper, "daemon_reader", return_value=["node", "daemon-cli.mjs"]), patch.object(reaper.subprocess, "run", run):
            self.assertEqual(reaper.read_sessions("/bin/prime-agent"), [])
        self.assertEqual(calls, [(["node", "daemon-cli.mjs", "list"], reaper.READER_S)])


class PrimeSyncHello(unittest.TestCase):
    def test_a_send_tries_a_missed_hello_once_more(self):
        run, calls = answers((1, "", MISS), (0, "{}", ""))
        with patch.object(sync, "daemon_reader", return_value=None), patch.object(sync.subprocess, "run", run):
            self.assertTrue(sync.send("s1", "hi"))
        self.assertEqual([cmd for cmd, _ in calls], [[sync.PRIME_BIN, "send", "s1", "hi"]] * 2)

    def test_the_reader_sends_once(self):
        run, calls = answers((1, "", "daemon-cli: Session not found"))
        with patch.object(sync, "daemon_reader", return_value=["node", "daemon-cli.mjs"]), patch.object(sync.subprocess, "run", run):
            self.assertFalse(sync.send("s1", "hi"))
        self.assertEqual(calls, [(["node", "daemon-cli.mjs", "send", "s1", "hi"], sync.READER_S)])


class ResumePausedHello(unittest.TestCase):
    def test_the_cli_list_tries_a_missed_hello_once_more(self):
        run, calls = answers((1, "", MISS), (0, '{"sessions": [{"sessionId": "s1"}]}', ""))
        with patch.dict("os.environ", {"PRIME_AGENT_BIN": "/bin/prime-agent"}), patch.object(resume_paused.subprocess, "run", run):
            self.assertEqual(resume_paused.LocalBox().list(all_rows=True), [{"sessionId": "s1"}])
        self.assertEqual([cmd for cmd, _ in calls], [["/bin/prime-agent", "list", "--json", "--all"]] * 2)

    def test_a_cli_send_goes_once_unless_the_hello_was_missed(self):
        run, calls = answers((1, "", "Error: Session not found"))
        with patch.dict("os.environ", {"PRIME_AGENT_BIN": "/bin/prime-agent"}), patch.object(resume_paused.subprocess, "run", run):
            self.assertRaises(resume_paused.CommandError, resume_paused.LocalBox().send, "s1", "continue")
        self.assertEqual([cmd for cmd, _ in calls], [["/bin/prime-agent", "send", "--json", "s1", "continue"]])

    def test_without_a_named_binary_the_pass_uses_the_reader(self):
        run, calls = answers((0, '{"sessions": []}', ""))
        with patch.dict("os.environ", {}, clear=False), patch.object(resume_paused.subprocess, "run", run), \
                patch.object(resume_paused.shutil, "which", return_value="/usr/bin/node"):
            import os
            os.environ.pop("PRIME_AGENT_BIN", None)
            self.assertEqual(resume_paused.LocalBox().list(), [])
        self.assertEqual(calls, [(["/usr/bin/node", str(resume_paused.DAEMON_CLI), "list"], resume_paused.DAEMON_CLI_S)])


if __name__ == "__main__":
    unittest.main()
