#!/usr/bin/python3
"""Tests for codex-pool-auth. Run: python3 -B deploy/linux/codex-pool-auth.test.py
A fake pi-pool prints a made-up access token, and each case runs the script against a throwaway CODEX_HOME."""
import base64, json, os, stat, subprocess, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "codex-pool-auth")


def jwt(payload):
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
    return f"{enc({'alg': 'none'})}.{enc(payload)}.sig"


TOKEN = jwt({"https://api.openai.com/auth": {"chatgpt_account_id": "acct-1", "chatgpt_plan_type": "free"}, "exp": 2000000000})


class CodexPoolAuth(unittest.TestCase):
    def run_script(self, pool_body, *args):
        self.dir = tempfile.mkdtemp()
        pool = os.path.join(self.dir, "pi-pool")
        with open(pool, "w") as f:
            f.write("#!/bin/sh\n" + pool_body)
        os.chmod(pool, 0o755)
        self.home = os.path.join(self.dir, "codex")
        env = {**os.environ, "PI_POOL_BIN": pool, "CODEX_HOME": self.home}
        return subprocess.run(["/usr/bin/python3", "-B", SCRIPT, *args], env=env, capture_output=True, text=True)

    def tearDown(self):
        subprocess.run(["rm", "-rf", self.dir])

    def test_writes_the_pool_access_token_with_a_refresh_token_codex_cannot_spend(self):
        res = self.run_script(f'[ "$*" = "token a@b.c --provider openai-codex" ] && printf %s "{TOKEN}"', "a@b.c")
        self.assertEqual(res.returncode, 0, res.stderr)
        path = os.path.join(self.home, "auth.json")
        auth = json.load(open(path))
        self.assertEqual(auth["tokens"]["access_token"], TOKEN)
        self.assertEqual(auth["tokens"]["id_token"], TOKEN)
        self.assertEqual(auth["tokens"]["account_id"], "acct-1")
        self.assertEqual(auth["tokens"]["refresh_token"], "pi-pool-owned")
        self.assertIsNone(auth["OPENAI_API_KEY"])
        self.assertRegex(auth["last_refresh"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)

    def test_a_pool_failure_leaves_the_old_login_alone(self):
        res = self.run_script("echo 'no token (needs reauth)' >&2; exit 1", "a@b.c")
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("needs reauth", res.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.home, "auth.json")))


if __name__ == "__main__":
    unittest.main()
