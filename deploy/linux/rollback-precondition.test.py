#!/usr/bin/python3
"""Tests for rollback-precondition.py. Run: python3 -B deploy/linux/rollback-precondition.test.py
Each case builds a throwaway agent dir with one committed detached-handoff receipt and asks whether a rollback to a target
is safe. The checker is an installed Prime release that carries the target guard (dhx.3 or newer)."""
import glob, hashlib, json, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.environ.get("ROLLBACK_PRECONDITION_HELPER") or os.path.join(HERE, "rollback-precondition.py")
RELEASES = os.path.expanduser("~/.local/share/prime-agent/releases")
DHX3 = "00530952b33cd1212df8d64e2830a178bf5069943c13bcc4933e4c832daf1447"
PCD1 = "27a4a117e95f7c521c8a53fe48b135731184eacddc2d4f62be4bcbf0faa0e46b"
IMI1 = "000d85dfee3de77eb9fdd7c0e7c8a397ca755ab3fc8471222f81607417b61ecb"

def by_hash():
    found = {}
    for exe in glob.glob(f"{RELEASES}/*/prime-agent"):
        with open(exe, "rb") as f:
            found.setdefault(hashlib.sha256(f.read()).hexdigest(), exe)
    return found

EXES = by_hash()
CHECKER = EXES.get(PCD1) or EXES.get(DHX3)

FAKE = """#!/usr/bin/python3
import json, os, socket, sys
caps = json.loads(%r)
path = sys.argv[sys.argv.index("--daemon-socket") + 1]
s = socket.socket(socket.AF_UNIX); s.bind(path); s.listen(4)
while True:
    c, _ = s.accept(); c.sendall((json.dumps({"type": "daemon_hello", "serverCapabilities": caps}) + "\\n").encode()); c.close()
"""

class RollbackPrecondition(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.agent = os.path.join(self.tmp.name, "agent")
        d = os.path.join(self.agent, "daemon-workers", "w1", "detached-handoffs", "01a15a32-5963-7248-a89c-35c59df7f039")
        os.makedirs(d)
        with open(os.path.join(d, "h1.json"), "w") as f:
            json.dump({"state": "committed", "handoffId": "h1", "sessionId": "01a15a32-5963-7248-a89c-35c59df7f039",
                       "groups": [{"leader": {"pid": 2729137}}]}, f)

    def tearDown(self): self.tmp.cleanup()

    def fake(self, caps):
        path = os.path.join(self.tmp.name, f"fake-{len(caps)}")
        with open(path, "w") as f:
            f.write(FAKE % json.dumps(caps))
        os.chmod(path, 0o755)
        return path

    def run_helper(self, target):
        r = subprocess.run([sys.executable, "-B", HELPER, self.agent, "--target", target, "--checker", CHECKER], capture_output=True, text=True)
        return r.returncode, r.stdout

    @unittest.skipUnless(CHECKER, "no installed release with the target guard")
    def test_receipt_allows_a_target_that_serves_detached_handoff(self):
        rc, out = self.run_helper(self.fake(["detached_handoff", "event_sequence"]))
        self.assertEqual(rc, 0, out)

    @unittest.skipUnless(CHECKER, "no installed release with the target guard")
    def test_receipt_blocks_a_target_without_detached_handoff(self):
        rc, out = self.run_helper(self.fake(["event_sequence"]))
        self.assertEqual(rc, 1, out)

    @unittest.skipUnless(CHECKER and DHX3 in EXES, "dhx.3 exe 00530952 not installed")
    def test_receipt_allows_the_real_dhx3_exe(self):
        rc, out = self.run_helper(EXES[DHX3])
        self.assertEqual(rc, 0, out)

    @unittest.skipUnless(CHECKER and IMI1 in EXES, "imi.1 exe 000d85df not installed")
    def test_receipt_blocks_the_real_imi1_exe(self):
        rc, out = self.run_helper(EXES[IMI1])
        self.assertEqual(rc, 1, out)

    def test_no_receipt_is_clean_without_running_the_checker(self):
        for f in glob.glob(f"{self.agent}/daemon-workers/*/detached-handoffs/*/*.json"): os.remove(f)
        r = subprocess.run([sys.executable, "-B", HELPER, self.agent, "--target", "/nonexistent", "--checker", "/nonexistent"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout)

if __name__ == "__main__":
    unittest.main(verbosity=2)
