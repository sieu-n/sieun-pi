#!/usr/bin/python3
"""Tests for aside-remote. Run: python3 -B deploy/linux/aside-remote.test.py
A fake ssh plays the Mac: each call appends its remote command to a log and answers from a list of scripted replies."""
import json, os, subprocess, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "aside-remote")
# Live text from 11-18 01:15Z to 02:37Z, when the owner's MacBook ran no Aside after a reboot.
NOT_RUNNING = "Failed to request daemon auth challenge: fetch failed\nAside isn't running on this machine.\n  - Start Aside Browser and retry, or\n"
# Live text from a REPL call that ran past Aside's 120 s limit on 10-28 while Aside was up.
PAST_LIMIT = "fetch failed: other side closed\nAside isn't running on this machine.\n  - Start Aside Browser and retry, or\n"
SIGNED_IN = "* u0  sieunpark77@gmail.com  signed in  profiles: Profile 0\n"

FAKE_SSH = """#!/usr/bin/python3
import json, os, sys
d = os.environ["FAKE_DIR"]
with open(os.path.join(d, "log"), "a") as f:
    f.write(sys.argv[-1] + "\\n")
replies = json.load(open(os.path.join(d, "replies")))
code, out, err = replies.pop(0)
json.dump(replies, open(os.path.join(d, "replies"), "w"))
sys.stdout.write(out); sys.stderr.write(err); sys.exit(code)
"""


class AsideRemote(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        ssh = os.path.join(self.dir, "ssh")
        with open(ssh, "w") as f:
            f.write(FAKE_SSH)
        os.chmod(ssh, 0o755)
        self.env = {**os.environ, "ASIDE_REMOTE_SSH": ssh, "ASIDE_REMOTE": "mac", "FAKE_DIR": self.dir, "HOME": self.dir}

    def tearDown(self):
        subprocess.run(["rm", "-rf", self.dir])

    def run_wrapper(self, replies, *args):
        with open(os.path.join(self.dir, "replies"), "w") as f:
            json.dump(replies, f)
        result = subprocess.run([SCRIPT, *args], env=self.env, stdin=subprocess.DEVNULL, capture_output=True, text=True)
        with open(os.path.join(self.dir, "log")) as f:
            return result, f.read().splitlines()

    def test_aside_not_running_starts_it_hidden_and_repeats_the_call(self):
        result, calls = self.run_wrapper([[1, "", NOT_RUNNING], [0, "aside-start-hidden: Aside answers\n", ""], [0, SIGNED_IN, ""]], "account", "status")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, SIGNED_IN)
        self.assertEqual(len(calls), 3)
        self.assertIn("aside-start-hidden", calls[1])
        self.assertEqual(calls[0], calls[2])

    def test_a_call_past_the_120_s_limit_is_not_repeated(self):
        result, calls = self.run_wrapper([[1, "", PAST_LIMIT]], "repl", "await sleep(125000)")
        self.assertEqual(result.returncode, 1)
        self.assertIn("other side closed", result.stderr)
        self.assertEqual(len(calls), 1)

    def test_a_failed_start_keeps_the_first_answer(self):
        result, calls = self.run_wrapper([[1, "", NOT_RUNNING], [1, "", "aside-start-hidden: Aside gave no answer in 60 s\n"]], "account", "status")
        self.assertEqual(result.returncode, 1)
        self.assertIn("isn't running on this machine", result.stderr)
        self.assertIn("gave no answer", result.stderr)
        self.assertEqual(len(calls), 2)

    def test_other_failures_pass_through_once(self):
        result, calls = self.run_wrapper([[3, "partial\n", "Error: boom\n"]], "repl", "x")
        self.assertEqual((result.returncode, result.stdout, result.stderr), (3, "partial\n", "Error: boom\n"))
        self.assertEqual(len(calls), 1)

    def test_start_hidden_runs_only_the_start(self):
        result, calls = self.run_wrapper([[0, "aside-start-hidden: Aside answers (it was running)\n", ""]], "--start-hidden")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(calls, ["exec /bin/sh /Users/sieunpark/.local/bin/aside-start-hidden"])


if __name__ == "__main__":
    unittest.main()
