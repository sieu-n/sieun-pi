"""pi-pool's account admin commands: off, on, rm and login, run as the real
CLI against an isolated PI_POOL_DIR, HOME and TOKENMAXXING_HOME. A fake
`tokenmaxxing` stands in for the real one: it records its arguments and, for
login, draws the screens claude and codex show. No network, no keychain.
"""
import json, os, select, shutil, signal, subprocess, sys, tempfile, textwrap, time, unittest

from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()


PI_POOL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "pi-pool")
CLAUDE_INDEX = {"version": 2, "accounts": [
    {"id": "aaaa1111-0000-0000-0000-000000000000", "email": "a@x", "label": "a@x", "windows": []},
    {"id": "bbbb2222-0000-0000-0000-000000000000", "email": "b@x", "label": "b@x", "windows": []}]}
CODEX_INDEX = {"version": 2, "accounts": [
    {"id": "cccc3333-0000-0000-0000-000000000000", "email": "c@x", "label": "c@x", "tier": "plus", "windows": []}]}
A, B = CLAUDE_INDEX["accounts"][0]["id"], CLAUDE_INDEX["accounts"][1]["id"]

# The screens a fake login draws. FAKE_LOGIN picks the flow; every run writes
# its argv and pid next to itself so a test can check what ran and that it ended.
FAKE_TOKENMAXXING = textwrap.dedent("""\
    #!/usr/bin/python3 -B
    import os, subprocess, sys, time
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "argv.txt"), "a") as f:
        f.write(" ".join(sys.argv[1:]) + "\\n")
    with open(os.path.join(here, "pid.txt"), "w") as f:
        f.write(str(os.getpid()))
    mode = os.environ.get("FAKE_LOGIN", "")
    say = lambda text: (sys.stdout.write(text + "\\n"), sys.stdout.flush())
    if sys.argv[1] == "rm":
        if mode == "rm-fails":
            say("no account matches that selector")
            sys.exit(1)
        say("removed")
        sys.exit(0)
    if mode == "codex":
        say("Follow these steps to sign in with ChatGPT using device code authorization:")
        say("1. Open this link in your browser and sign in to your account")
        say("   https://auth.openai.com/codex/device")
        say("2. Enter this one-time code (expires in 15 minutes)")
        say("   ABCD-12345")
        time.sleep(1)
        say("added c2@x (plus)")
        sys.exit(0)
    if mode == "hang":
        say("Choose the text style that looks best with your terminal")
        time.sleep(600)
        sys.exit(0)
    if mode == "claude":
        say("Choose the text style that looks best with your terminal")
        sys.stdin.readline()
        attempt = 0
        while True:
            attempt += 1
            say("Select login method:")
            sys.stdin.readline()
            subprocess.run([os.environ["BROWSER"], f"https://claude.ai/oauth/authorize?state=cb{attempt}&redirect_uri=http://localhost:1/callback"])
            link = f"https://claude.ai/oauth/authorize?code=true&state=s{attempt}&code_challenge=c{attempt}"
            sys.stdout.write(f"\\x1b]8;;{link}\\x07Sign in\\x1b]8;;\\x07\\n")
            say("Paste code here if prompted >")
            code = sys.stdin.readline().strip()
            if code == "good":
                break
            say("OAuth error: Invalid code")
            sys.stdin.readline()
        say("Login successful. Press Enter to continue")
        sys.stdin.readline()
        say(("reauthed " if sys.argv[1] == "auth" else "added ") + "a2@x")
        sys.exit(0)
    sys.exit(3)
""")


class PoolFixture(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="pi-pool-admin-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.tm, self.pool = os.path.join(self.root, "tm"), os.path.join(self.root, "pool")
        os.makedirs(os.path.join(self.tm, "bin"))
        os.makedirs(self.pool)
        for name, index in (("accounts.json", CLAUDE_INDEX), ("codex-accounts.json", CODEX_INDEX)):
            with open(os.path.join(self.tm, name), "w") as f:
                json.dump(index, f)
        self.exe = os.path.join(self.tm, "bin", "tokenmaxxing")
        with open(self.exe, "w") as f:
            f.write(FAKE_TOKENMAXXING)
        os.chmod(self.exe, 0o755)
        self.env = dict(os.environ, HOME=self.root, PI_POOL_DIR=self.pool, TOKENMAXXING_HOME=self.tm)
        for name in ("PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID", "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL"):
            self.env.pop(name, None)

    def cli(self, *args, fake=""):
        done = subprocess.run([PI_POOL, *args], env=dict(self.env, FAKE_LOGIN=fake), capture_output=True, text=True, timeout=30)
        return done.returncode, (done.stdout + done.stderr).strip()

    def rows(self, provider="anthropic"):
        code, out = self.cli("ls", "--json", "--provider", provider)
        self.assertEqual(code, 0, out)
        return {row["email"]: row for row in json.loads(out)["rows"]}

    def state(self):
        with open(os.path.join(self.pool, "state.json")) as f:
            return json.load(f)

    def write_state(self, state):
        with open(os.path.join(self.pool, "state.json"), "w") as f:
            json.dump(state, f)

    def ran(self):
        path = os.path.join(self.tm, "bin", "argv.txt")
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return f.read().splitlines()


class OffAndOn(PoolFixture):
    def test_off_keeps_the_account_listed_but_never_usable(self):
        self.assertEqual(self.cli("off", "a@x"), (0, "a@x is off; the pool never picks it until pi-pool on"))
        row = self.rows()["a@x"]
        self.assertEqual((row["disabled"], row["usable"], row["reason"]), (True, False, "disabled"))
        self.assertFalse(self.rows()["b@x"]["disabled"])
        self.assertIn(A, self.state()["providers"]["anthropic"]["disabled"])

    def test_off_twice_and_on_twice_are_no_ops(self):
        self.cli("off", "a@x")
        self.assertEqual(self.cli("off", "a@x"), (0, "a@x is already off"))
        self.assertEqual(self.cli("on", "a@x"), (0, "a@x is on; the pool can pick it again"))
        self.assertEqual(self.cli("on", "a@x"), (0, "a@x is already on"))
        row = self.rows()["a@x"]
        self.assertEqual((row["disabled"], row["usable"]), (False, True))

    def test_off_is_per_provider(self):
        self.assertEqual(self.cli("off", "c@x", "--provider", "openai-codex")[0], 0)
        self.assertTrue(self.rows("openai-codex")["c@x"]["disabled"])
        self.assertEqual(self.state()["providers"]["anthropic"].get("disabled"), {})

    def test_an_off_account_cannot_be_pinned(self):
        self.cli("off", "a@x")
        code, out = self.cli("pin", "a@x")
        self.assertNotEqual(code, 0)
        self.assertIn("a@x is off", out)

    def test_an_unknown_account_is_an_error(self):
        code, out = self.cli("off", "z@x")
        self.assertNotEqual(code, 0)
        self.assertIn("z@x is not in the anthropic pool", out)


class Remove(PoolFixture):
    def test_rm_runs_tokenmaxxing_rm_and_forgets_every_intent(self):
        self.cli("off", "a@x")
        state = self.state()
        prov = state["providers"]["anthropic"]
        prov.update(pin=A, seat={"account_id": A, "since": 1}, cooldowns={A: 9e12, B: 9e12})
        state["sessions"]["s1"] = {"uuid": "s1", "active_id": "s1", "pins": {"anthropic": {"account_id": A}, "openai-codex": {"account_id": "cccc"}}, "vends": {}, "last_seen": 1}
        self.write_state(state)

        self.assertEqual(self.cli("rm", "a@x"), (0, "removed a@x from the anthropic pool"))

        self.assertEqual(self.ran(), ["rm " + A])
        prov = self.state()["providers"]["anthropic"]
        self.assertEqual((prov["pin"], prov["seat"], prov["disabled"], prov["cooldowns"]), (None, None, {}, {B: 9e12}))
        self.assertEqual(self.state()["sessions"]["s1"]["pins"], {"openai-codex": {"account_id": "cccc"}})

    def test_rm_passes_the_codex_flag(self):
        self.assertEqual(self.cli("rm", "c@x", "--provider", "openai-codex")[0], 0)
        self.assertEqual(self.ran(), ["rm --codex " + CODEX_INDEX["accounts"][0]["id"]])

    def test_a_failed_rm_changes_nothing_here(self):
        self.cli("off", "a@x")
        before = self.state()
        code, out = self.cli("rm", "a@x", fake="rm-fails")
        self.assertNotEqual(code, 0)
        self.assertIn("no account matches that selector", out)
        self.assertEqual(self.state(), before)


class LoginRun:
    """One `pi-pool login` with a pipe on stdin and every stdout line parsed.
    Every read has a deadline and the process is killed on the way out."""

    def __init__(self, test, args, fake):
        self.proc = subprocess.Popen([PI_POOL, "login", *args], env=dict(test.env, FAKE_LOGIN=fake),
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        test.addCleanup(self.kill)
        self.buffer = b""

    def kill(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(5)
        for pipe in (self.proc.stdin, self.proc.stdout):
            try:
                pipe.close()
            except OSError:
                pass

    def event(self, timeout=20):
        deadline = time.time() + timeout
        while b"\n" not in self.buffer:
            left = deadline - time.time()
            if left <= 0:
                raise AssertionError("no event from pi-pool login in %ss" % timeout)
            if select.select([self.proc.stdout], [], [], left)[0]:
                chunk = os.read(self.proc.stdout.fileno(), 65536)
                if not chunk:
                    raise AssertionError("pi-pool login closed stdout; last output %r" % self.buffer)
                self.buffer += chunk
        line, self.buffer = self.buffer.split(b"\n", 1)
        return json.loads(line)

    def send(self, text):
        self.proc.stdin.write(text.encode())
        self.proc.stdin.flush()

    def exit_code(self):
        return self.proc.wait(15)


class Login(PoolFixture):
    def fake_ended(self):
        with open(os.path.join(self.tm, "bin", "pid.txt")) as f:
            pid = int(f.read())
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return True
            time.sleep(0.1)
        return False

    def test_codex_reports_the_device_code_then_done(self):
        run = LoginRun(self, ["--provider", "openai-codex"], "codex")
        self.assertEqual(run.event(), {"event": "url", "url": "https://auth.openai.com/codex/device", "manual_url": None, "code": "ABCD-12345", "paste": False})
        self.assertEqual(run.event(), {"event": "done", "ok": True, "message": "added c2@x (plus)"})
        self.assertEqual(run.exit_code(), 0)
        self.assertEqual(self.ran(), ["add --codex"])

    def test_claude_takes_a_pasted_code_and_retries_a_refused_one(self):
        run = LoginRun(self, ["--provider", "anthropic"], "claude")
        first = run.event()
        self.assertEqual((first["event"], first["paste"], first["code"]), ("url", True, None))
        self.assertIn("state=cb1", first["url"])
        self.assertIn("state=s1", first["manual_url"])
        run.send("bad")
        run.send("\n")
        self.assertEqual(run.event()["event"], "retry")
        second = run.event()
        self.assertEqual((second["event"], "state=s2" in second["manual_url"]), ("url", True))
        run.send("good\n")
        self.assertEqual(run.event(), {"event": "done", "ok": True, "message": "added a2@x"})
        self.assertEqual(run.exit_code(), 0)

    def test_sign_in_again_runs_tokenmaxxing_auth_for_that_account(self):
        run = LoginRun(self, ["b@x"], "claude")
        self.assertEqual(run.event()["event"], "url")
        run.send("good\n")
        self.assertEqual(run.event(), {"event": "done", "ok": True, "message": "reauthed a2@x"})
        self.assertEqual(self.ran(), ["auth " + B])

    def test_an_unknown_account_fails_without_running_tokenmaxxing(self):
        run = LoginRun(self, ["z@x"], "claude")
        self.assertEqual(run.event(), {"event": "done", "ok": False, "message": "z@x is not in the anthropic pool"})
        self.assertEqual(run.exit_code(), 1)
        self.assertEqual(self.ran(), [])

    def test_closing_stdin_cancels_and_ends_the_login(self):
        run = LoginRun(self, ["--provider", "anthropic"], "claude")
        self.assertEqual(run.event()["event"], "url")
        run.proc.stdin.close()
        self.assertEqual(run.event(), {"event": "done", "ok": False, "message": "cancelled"})
        self.assertEqual(run.exit_code(), 1)
        self.assertTrue(self.fake_ended())
        self.assertEqual([name for name in os.listdir(self.pool) if name.endswith(".urls")], [])

    def test_sigterm_stops_the_login_cleanly(self):
        run = LoginRun(self, ["--provider", "anthropic"], "claude")
        self.assertEqual(run.event()["event"], "url")
        run.proc.send_signal(signal.SIGTERM)
        self.assertEqual(run.event(), {"event": "done", "ok": False, "message": "the sign-in was stopped"})
        self.assertTrue(self.fake_ended())

    def test_the_deadline_ends_a_login_that_never_finishes(self):
        run = LoginRun(self, ["--provider", "anthropic", "--timeout", "2"], "hang")
        self.assertEqual(run.event(), {"event": "done", "ok": False, "message": "the sign-in did not finish in 1 min"})
        self.assertTrue(self.fake_ended())


if __name__ == "__main__":
    unittest.main()
