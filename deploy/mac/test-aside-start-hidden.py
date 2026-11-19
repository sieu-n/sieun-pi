#!/usr/bin/python3
"""Tests for aside-start-hidden. Run: python3 -B deploy/mac/test-aside-start-hidden.py
Fakes stand in for pgrep, open, the hide and the Aside CLI, so it runs on any box."""
import os, subprocess, tempfile, unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "aside-start-hidden")
NOT_RUNNING = "Failed to request daemon auth challenge: fetch failed\nAside isn't running on this machine."


class AsideStartHidden(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.cli = os.path.join(self.dir, "aside")

    def tearDown(self):
        subprocess.run(["rm", "-rf", self.dir])

    def start(self, running, down_answers, wait="5"):
        """Run the script with Aside running or not, and a CLI that says 'isn't running' for its first down_answers calls."""
        with open(self.cli, "w") as f:
            f.write(f"""#!/bin/sh
n=$(cat {self.dir}/calls 2>/dev/null || echo 0); n=$((n+1)); echo $n > {self.dir}/calls
[ $n -le {down_answers} ] && {{ printf '%s\\n' "{NOT_RUNNING}"; exit 1; }}
echo '* u0  sieunpark77@gmail.com  signed in'
""")
        os.chmod(self.cli, 0o755)
        env = {**os.environ, "ASIDE_CLI": self.cli, "ASIDE_START_WAIT_S": wait,
               "ASIDE_START_PGREP": "true" if running else "false",
               "ASIDE_START_OPEN": f"touch {self.dir}/opened", "ASIDE_START_HIDE": f"touch {self.dir}/hid"}
        return subprocess.run(["/bin/sh", SCRIPT], env=env, capture_output=True, text=True)

    def made(self, name):
        return os.path.exists(os.path.join(self.dir, name))

    def test_a_stopped_aside_opens_hidden_and_waits_for_its_daemon(self):
        result = self.start(running=False, down_answers=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("started hidden", result.stdout)
        self.assertTrue(self.made("opened") and self.made("hid"))

    def test_a_running_aside_is_left_as_it_is(self):
        result = self.start(running=True, down_answers=0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("it was running", result.stdout)
        self.assertFalse(self.made("opened") or self.made("hid"))

    def test_no_answer_in_the_wait_fails(self):
        result = self.start(running=False, down_answers=99, wait="1")
        self.assertEqual(result.returncode, 1)
        self.assertIn("gave no answer in 1 s", result.stderr)


if __name__ == "__main__":
    unittest.main()
