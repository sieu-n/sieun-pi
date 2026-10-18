"""pi-pool's account admin commands: off, on, limited, refused, rm and login. The
admin commands run as the real CLI against an isolated PI_POOL_DIR and HOME; the
sign-in runs in this process with its HTTP calls faked. No network, no keychain.
"""
import base64, http.client, json, math, os, shutil, subprocess, tempfile, threading, time, unittest, unittest.mock, urllib.parse

from fixture_isolation import isolate_test_module
import test_core  # noqa: F401  (loads vend.py with an isolated pool folder)
from vend.pool import base, remote, signin, usage


def setUpModule():
    isolate_test_module()


PI_POOL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "pi-pool")
CLAUDE_INDEX = {"version": 1, "accounts": [
    {"id": "aaaa1111-0000-0000-0000-000000000000", "email": "a@x", "label": "a@x", "windows": []},
    {"id": "bbbb2222-0000-0000-0000-000000000000", "email": "b@x", "label": "b@x", "windows": []}]}
CODEX_INDEX = {"version": 1, "accounts": [
    {"id": "cccc3333-0000-0000-0000-000000000000", "email": "c@x", "label": "c@x", "tier": "plus", "windows": []}]}
A, B = CLAUDE_INDEX["accounts"][0]["id"], CLAUDE_INDEX["accounts"][1]["id"]


class PoolFixture(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="pi-pool-admin-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.pool = os.path.join(self.root, "pool")
        self.accounts = os.path.join(self.pool, "accounts")
        os.makedirs(self.accounts)
        self.write_index("anthropic", CLAUDE_INDEX)
        self.write_index("openai-codex", CODEX_INDEX)
        self.env = dict(os.environ, HOME=self.root, PI_POOL_DIR=self.pool, PI_POOL_SECRETS="file")
        for name in ("PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID", "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL"):
            self.env.pop(name, None)

    def write_index(self, provider, index):
        with open(os.path.join(self.accounts, f"{provider}.json"), "w") as f:
            json.dump(index, f)

    def index(self, provider="anthropic"):
        with open(os.path.join(self.accounts, f"{provider}.json")) as f:
            return json.load(f)["accounts"]

    def cli(self, *args):
        done = subprocess.run([PI_POOL, *args], env=self.env, capture_output=True, text=True, timeout=30)
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


class LimitedSurvivesARestart(PoolFixture):
    """`pi-pool limited` writes the 429 to state.json; a later process, which is
    what the next request's hook is, reads it back and moves the session."""
    C, D = "cccc3333-0000-0000-0000-000000000000", "dddd4444-0000-0000-0000-000000000000"
    SESSION = "01a1-limited-session"

    def setUp(self):
        super().setUp()
        self.write_index("openai-codex", {"version": 1, "accounts": CODEX_INDEX["accounts"] + [
            {"id": self.D, "email": "d@x", "label": "d@x", "tier": "plus", "windows": []}]})
        now = time.time()
        self.write_state({"version": 2, "providers": {
            "anthropic": {"pin": None, "cooldowns": {}, "disabled": {}},
            "openai-codex": {"pin": self.C, "cooldowns": {}, "disabled": {}}},
            "sessions": {self.SESSION: {"uuid": self.SESSION, "active_id": None, "last_seen": now, "pins": {},
                                        "vends": {"openai-codex": {"account_id": self.C, "email": "c@x", "at": now, "n": 3}}}}})

    def test_a_429_moves_the_pool_pin_until_the_reset_and_a_new_process_still_sees_it(self):
        until = time.time() + 3600
        code, out = self.cli("limited", "--provider", "openai-codex", "--session", self.SESSION, "--until", str(until))
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads(out), {"account": "c@x", "until": round(until), "next": "d@x", "retry_at": None})
        self.assertEqual(self.state()["providers"]["openai-codex"]["limits"][self.C]["session"], self.SESSION)
        code, out = self.cli("who", "--json", "--session", self.SESSION)
        self.assertEqual(code, 0, out)
        who = json.loads(out)["providers"]["openai-codex"]
        self.assertEqual((who["email"], who["reason"], who["shadowed"]), ("d@x", "switch", [self.C, "limited"]))
        row = self.rows("openai-codex")["c@x"]
        self.assertEqual((row["usable"], row["limited_until"]), (False, round(until)))
        self.assertTrue(row["reason"].startswith("limited "), row["reason"])
        with open(os.path.join(self.pool, "pi-pool.log")) as f:
            events = [json.loads(line) for line in f]
        self.assertEqual([(e["event"], e["account"], e["next"]) for e in events if e["event"] == "limited"],
                         [("limited", "c@x", "d@x")])

    def test_unlimited_drops_a_false_limit_and_leaves_the_others(self):
        until = time.time() + 3600
        self.cli("limited", "--provider", "openai-codex", "--session", self.SESSION, "--until", str(until))
        self.assertEqual(set(self.state()["providers"]["openai-codex"]["limits"]), {self.C})
        code, out = self.cli("unlimited", "c@x", "--provider", "openai-codex")
        self.assertEqual(code, 0, out)
        self.assertTrue(out.startswith("c@x is no longer limited (was until "), out)
        self.assertEqual(self.state()["providers"]["openai-codex"]["limits"], {})
        self.assertTrue(self.rows("openai-codex")["c@x"]["usable"])
        self.assertEqual(self.cli("unlimited", "c@x", "--provider", "openai-codex"), (0, "c@x has no limit on file"))

    def test_a_429_from_a_request_sent_before_the_session_moved_marks_nothing(self):
        until = time.time() + 3600
        code, out = self.cli("limited", "--provider", "openai-codex", "--session", self.SESSION, "--until", str(until),
                             "--since", str(time.time()))
        self.assertEqual(json.loads(out), {"account": "c@x", "until": round(until), "next": "d@x", "retry_at": None}, out)
        moved = time.time()
        state = self.state()
        state["sessions"][self.SESSION]["vends"]["openai-codex"] = {"account_id": self.D, "email": "d@x", "at": moved, "from": moved, "n": 1}
        self.write_state(state)
        code, out = self.cli("limited", "--provider", "openai-codex", "--session", self.SESSION, "--until", str(until),
                             "--since", str(moved - 5))
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads(out), {"account": None, "until": round(until), "next": "d@x", "retry_at": None, "stale": True})
        self.assertEqual(set(self.state()["providers"]["openai-codex"]["limits"]), {self.C}, "d@x is not marked with c@x's reset")
        code, out = self.cli("limited", "--provider", "openai-codex", "--session", self.SESSION, "--until", str(until),
                             "--since", str(moved + 1))
        self.assertEqual(json.loads(out)["account"], "d@x", "a request sent on d@x marks d@x")

    def test_with_no_other_account_next_is_null(self):
        until = time.time() + 3600
        state = self.state()
        state["providers"]["openai-codex"]["limits"] = {self.D: {"until": until, "at": time.time(), "session": None}}
        self.write_state(state)
        code, out = self.cli("limited", "--provider", "openai-codex", "--session", self.SESSION, "--until", str(until))
        self.assertEqual(code, 0, out)
        self.assertIsNone(json.loads(out)["next"])

    def test_with_only_a_depleted_account_left_the_session_waits_for_the_first_account_back(self):
        reset_ms = (time.time() + 7200) * 1000
        self.write_index("openai-codex", {"version": 1, "accounts": CODEX_INDEX["accounts"] + [
            {"id": self.D, "email": "d@x", "label": "d@x", "tier": "plus",
             "windows": [{"windowSeconds": 18000, "usedPercentage": 97, "resetsAt": reset_ms}]}]})
        until = time.time() + 3600
        start = time.time()
        code, out = self.cli("limited", "--provider", "openai-codex", "--session", self.SESSION, "--until", str(until))
        self.assertEqual(code, 0, out)
        reply = json.loads(out)
        self.assertIsNone(reply["next"])
        self.assertTrue(start <= reply["retry_at"] <= time.time() + base.DEFAULTS["depleted_backoff_max_sec"] + 1, reply)
        wait = self.state()["sessions"][self.SESSION]["wait"]["openai-codex"]
        self.assertEqual((wait["account"], math.ceil(wait["slot_at"]), wait["backoff"]), (self.C, reply["retry_at"], True))

    def test_a_session_with_no_vend_is_refused(self):
        code, out = self.cli("limited", "--provider", "anthropic", "--session", self.SESSION, "--until", str(time.time() + 60))
        self.assertEqual(code, 2)
        self.assertIn("no anthropic vend", json.loads(out)["error"])


class TermsRefusalTakesTheAccountOut(PoolFixture):
    """`pi-pool refused` with the 400 a turn got while the account's Consumer
    Terms were pending (2026-10-08) cools that account down; the next request
    of the tree, a later process, gets the other account."""
    SESSION = "01a1-terms-session"
    TERMS = "Provider rejected the request (invalid_request_error, 400): We've updated our Consumer Terms and Privacy Policy. You'll need to accept them in claude.ai with the email in /status to continue. [request_id: req_011Cfpei9Q2FndKLU23sLdgU]"

    def setUp(self):
        super().setUp()
        now = time.time()
        self.write_state({"version": 2, "providers": {
            "anthropic": {"pin": None, "cooldowns": {}, "disabled": {}},
            "openai-codex": {"pin": None, "cooldowns": {}, "disabled": {}}},
            "sessions": {self.SESSION: {"uuid": self.SESSION, "active_id": None, "last_seen": now, "pins": {},
                                        "vends": {"anthropic": {"account_id": A, "email": "a@x", "at": now, "n": 3}}}}})

    def test_the_account_leaves_the_pool_and_the_session_moves(self):
        code, out = self.cli("refused", "--provider", "anthropic", "--session", self.SESSION, self.TERMS)
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads(out), {"account": "a@x", "reason": "needs terms", "next": "b@x", "retry_at": None})
        code, out = self.cli("who", "--json", "--session", self.SESSION)
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads(out)["providers"]["anthropic"]["email"], "b@x")
        row = self.rows()["a@x"]
        self.assertEqual((row["usable"], row["cooldown_reason"]), (False, "needs terms"))
        with open(os.path.join(self.pool, "pi-pool.log")) as f:
            events = [json.loads(line) for line in f]
        self.assertEqual([(e["account"], e["reason"], e["next"]) for e in events if e["event"] == "refused"],
                         [("a@x", "needs terms", "b@x")])

    def test_with_no_other_account_next_is_null_and_the_account_is_still_out(self):
        state = self.state()
        state["providers"]["anthropic"]["disabled"] = {B: time.time()}
        self.write_state(state)
        code, out = self.cli("refused", "--provider", "anthropic", "--session", self.SESSION, self.TERMS)
        self.assertEqual(code, 0, out)
        self.assertIsNone(json.loads(out)["next"])
        self.assertIn(A, self.state()["providers"]["anthropic"]["cooldowns"])

    def test_any_other_400_changes_nothing(self):
        before = self.state()
        code, out = self.cli("refused", "--provider", "anthropic", "--session", self.SESSION,
                             "Provider rejected the request (invalid_request_error, 400): prompt is too long")
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads(out), {"reason": None})
        self.assertEqual(self.state(), before)


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
    def secret(self, name):
        return os.path.join(self.accounts, "secrets", name)

    def test_rm_deletes_the_credential_and_record_and_forgets_every_intent(self):
        os.makedirs(os.path.join(self.accounts, "secrets"))
        for account in (A, B):
            with open(self.secret("pi-pool.anthropic." + account), "w") as f:
                f.write("{}")
        self.cli("off", "a@x")
        state = self.state()
        prov = state["providers"]["anthropic"]
        prov.update(pin=A, cooldowns={A: 9e12, B: 9e12})
        at = time.time()
        state["sessions"]["s1"] = {"uuid": "s1", "active_id": "s1", "pins": {"anthropic": {"account_id": A, "at": at}, "openai-codex": {"account_id": "cccc", "at": at}}, "vends": {}, "last_seen": at}
        self.write_state(state)

        self.assertEqual(self.cli("rm", "a@x"), (0, "removed a@x from the anthropic pool"))

        self.assertEqual([r["id"] for r in self.index()], [B])
        self.assertEqual(sorted(os.listdir(os.path.join(self.accounts, "secrets"))), ["pi-pool.anthropic." + B])
        prov = self.state()["providers"]["anthropic"]
        self.assertEqual((prov["pin"], prov["disabled"], prov["cooldowns"]), (None, {}, {B: 9e12}))
        self.assertEqual(self.state()["sessions"]["s1"]["pins"], {"openai-codex": {"account_id": "cccc", "at": at}})

    def test_rm_deletes_a_codex_auth_file(self):
        c = CODEX_INDEX["accounts"][0]["id"]
        os.makedirs(os.path.join(self.accounts, "openai-codex"))
        with open(os.path.join(self.accounts, "openai-codex", c + ".json"), "w") as f:
            f.write("{}")
        self.assertEqual(self.cli("rm", "c@x", "--provider", "openai-codex")[0], 0)
        self.assertEqual(self.index("openai-codex"), [])
        self.assertEqual(os.listdir(os.path.join(self.accounts, "openai-codex")), [])

    def test_an_unknown_account_changes_nothing(self):
        code, out = self.cli("rm", "z@x")
        self.assertNotEqual(code, 0)
        self.assertIn("z@x is not in the anthropic pool", out)
        self.assertEqual(len(self.index()), 2)


def harvest(login, org, email, org_name=None, tier="max 20x"):
    """What a Claude sign-in hands to file_login."""
    return {"record": {"id": login, "email": email, "tier": tier,
                       "oauthAccount": {"accountUuid": login, "emailAddress": email, "organizationUuid": org,
                                        "organizationName": org_name or f"{email}'s Organization"}},
            "secret": {"accessToken": "at-" + org, "refreshToken": "rt-" + org, "expiresAt": 9e12}}


class InProcessStore(PoolFixture):
    """The pool's module paths pointed at this test's folder, with Keychain items as files."""

    def setUp(self):
        super().setUp()
        lock = lambda p: os.path.join(self.accounts, p + ".lock")
        for patch in (
                unittest.mock.patch.dict(base.INDEX, {p: os.path.join(self.accounts, p + ".json") for p in base.PROVIDERS}),
                unittest.mock.patch.dict(base.INDEX_LOCK, {p: lock(p) for p in base.PROVIDERS}),
                unittest.mock.patch.multiple(base, ACCOUNTS=self.accounts, SECRETS=os.path.join(self.accounts, "secrets"),
                                             CODEX_SECRETS=os.path.join(self.accounts, "openai-codex"), FILE_SECRETS=True,
                                             STATE=os.path.join(self.pool, "state.json"), LOCK=os.path.join(self.pool, "lock"),
                                             log=lambda *a, **k: None),
                unittest.mock.patch.object(usage, "read_account", lambda *a: {"ok": True}),
                unittest.mock.patch.object(remote, "client", lambda: None)):
            patch.start()
            self.addCleanup(patch.stop)

    def secrets(self):
        folder = os.path.join(self.accounts, "secrets")
        out = {}
        for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
            with open(os.path.join(folder, name)) as f:
                out[name] = json.load(f)["claudeAiOauth"]["refreshToken"]
        return out


class FakeInput:
    """Input.lines() from a script: each call returns the next batch; a batch may be a
    callable that gets the events emitted so far. An exhausted script waits."""

    def __init__(self, *batches):
        self.batches, self.events = list(batches), []

    def lines(self, wait):
        if not self.batches:
            time.sleep(min(wait, 0.05))
            return []
        batch = self.batches.pop(0)
        if batch == "close":
            raise signin.LoginFailed("cancelled")
        return batch(self.events) if callable(batch) else batch


TOKENS = {"access_token": "at", "refresh_token": "rt", "expires_in": 28800, "scope": "user:inference user:profile",
          "account": {"uuid": "dddd4444-0000-0000-0000-000000000000", "email_address": "d@x"}}
PROFILE = {"account": {"uuid": "dddd4444-0000-0000-0000-000000000000", "email": "d@x"},
           "organization": {"uuid": "org-d", "name": "d@x's Organization", "organization_type": "claude_max",
                            "rate_limit_tier": "default_claude_max_20x"}}


def state_of(event):
    return urllib.parse.parse_qs(urllib.parse.urlparse(event["url"]).query)["state"][0]


class ClaudeSignIn(InProcessStore):
    def run_login(self, stdin, accept=("good",)):
        sent = []

        def post(url, body, form=False):
            sent.append(body)
            return (200, TOKENS) if body.get("code") in accept else (400, {"error": "invalid_grant"})
        with unittest.mock.patch.object(signin, "post", post), \
             unittest.mock.patch.object(signin, "claude_profile", lambda token: PROFILE):
            harvest = signin.claude_login(stdin.events.append, stdin, time.time() + 10)
        return harvest, sent

    def test_a_pasted_code_signs_in_and_a_refused_one_is_retried(self):
        stdin = FakeInput(["bad"], lambda events: ["good#" + state_of(events[0])])
        harvest, sent = self.run_login(stdin)
        first = stdin.events[0]
        self.assertEqual((first["event"], first["paste"], first["code"]), ("url", True, None))
        self.assertTrue(first["url"].startswith(signin.CLAUDE_AUTHORIZE_URL + "?code=true&client_id=" + base.CLIENT_ID))
        self.assertIn("redirect_uri=http%3A%2F%2Flocalhost%3A", first["url"])
        self.assertIn("redirect_uri=" + urllib.parse.quote(signin.CLAUDE_MANUAL_REDIRECT, safe=""), first["manual_url"])
        self.assertEqual(stdin.events[1]["event"], "retry")
        self.assertEqual(sent[-1]["redirect_uri"], signin.CLAUDE_MANUAL_REDIRECT)
        self.assertEqual(harvest["record"], {"id": PROFILE["account"]["uuid"], "email": "d@x", "tier": "max 20x", "oauthAccount": {
            "accountUuid": PROFILE["account"]["uuid"], "emailAddress": "d@x", "organizationUuid": "org-d",
            "organizationName": "d@x's Organization"}})
        self.assertEqual((harvest["secret"]["refreshToken"], harvest["secret"]["subscriptionType"],
                          harvest["secret"]["rateLimitTier"], harvest["secret"]["scopes"]),
                         ("rt", "max", "default_claude_max_20x", ["user:inference", "user:profile"]))

    def test_the_localhost_callback_signs_in_and_sends_the_browser_on(self):
        answers = []

        def visit(events):
            url = urllib.parse.urlparse(urllib.parse.parse_qs(urllib.parse.urlparse(events[0]["url"]).query)["redirect_uri"][0])
            conn = http.client.HTTPConnection("127.0.0.1", url.port, timeout=5)
            conn.request("GET", f"/callback?code=good&state={state_of(events[0])}")
            answer = conn.getresponse()
            answers.append((answer.status, answer.getheader("Location")))
            return []
        with unittest.mock.patch.dict(os.environ, {"PI_POOL_TEST_ALLOW_LOOPBACK": "1"}):
            harvest, sent = self.run_login(FakeInput(visit))
        self.assertEqual(answers, [(302, signin.CLAUDE_SUCCESS_URL)])
        self.assertTrue(sent[-1]["redirect_uri"].startswith("http://localhost:"))
        self.assertEqual(harvest["secret"]["accessToken"], "at")

    def test_a_code_from_another_sign_in_is_not_sent(self):
        stdin = FakeInput(["good#not-this-state"], lambda events: ["good#" + state_of(events[0])])
        harvest, sent = self.run_login(stdin)
        self.assertEqual(len(sent), 1)
        self.assertEqual(stdin.events[1]["event"], "retry")

    def test_three_refused_codes_end_the_sign_in(self):
        with self.assertRaisesRegex(signin.LoginFailed, "three times"):
            self.run_login(FakeInput(["bad"], ["bad"], ["bad"]))

    def test_closing_stdin_cancels(self):
        with self.assertRaisesRegex(signin.LoginFailed, "cancelled"):
            self.run_login(FakeInput("close"))

    def test_the_deadline_ends_a_sign_in_that_never_finishes(self):
        with unittest.mock.patch.object(signin, "post", lambda *a, **k: (400, None)):
            with self.assertRaisesRegex(signin.LoginFailed, "did not finish in time"):
                signin.claude_login(lambda e: None, FakeInput(), time.time() + 0.3)


def jwt(claims):
    return "x." + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=") + ".y"


class CodexSignIn(InProcessStore):
    def test_the_device_code_is_shown_and_the_grant_becomes_a_harvest(self):
        id_token = jwt({"email": "c2@x", "https://api.openai.com/auth": {"chatgpt_account_id": "acct-2", "chatgpt_plan_type": "plus"}})
        answers = iter([(200, {"device_auth_id": "dev-1", "user_code": "ABCD-12345", "interval": "0"}),
                        (403, None),
                        (200, {"authorization_code": "auth-code", "code_verifier": "ver"}),
                        (200, {"id_token": id_token, "access_token": "at", "refresh_token": "rt"})])
        sent = []
        stdin = FakeInput([], [], [])
        with unittest.mock.patch.object(signin, "post", lambda url, body, form=False: (sent.append((url, body, form)), next(answers))[1]):
            harvest = signin.codex_login(stdin.events.append, stdin, time.time() + 10)
        self.assertEqual(stdin.events, [{"event": "url", "url": "https://auth.openai.com/codex/device", "manual_url": None,
                                         "code": "ABCD-12345", "paste": False}])
        self.assertEqual(sent[-1], (base.CODEX_TOKEN_URL, {"grant_type": "authorization_code", "code": "auth-code",
                                                           "client_id": base.CODEX_CLIENT_ID, "code_verifier": "ver",
                                                           "redirect_uri": "https://auth.openai.com/deviceauth/callback"}, True))
        self.assertEqual(harvest["record"], {"id": "acct-2", "email": "c2@x", "tier": "plus"})
        self.assertEqual(harvest["secret"]["tokens"]["account_id"], "acct-2")

    def test_filing_a_codex_login_writes_its_auth_file_and_record(self):
        secret = {"tokens": {"access_token": "at", "refresh_token": "rt", "account_id": "acct-2"}}
        said, account_id = signin.file_login("openai-codex", {"record": {"id": "acct-2", "email": "c2@x", "tier": "plus"}, "secret": secret})
        self.assertEqual(said, "added c2@x (plus) \u2192 pool now has 2 accounts")
        with open(os.path.join(self.accounts, "openai-codex", "acct-2.json")) as f:
            self.assertEqual(json.load(f), secret)
        self.assertEqual(oct(os.stat(os.path.join(self.accounts, "openai-codex", "acct-2.json")).st_mode & 0o777), "0o600")


class Filing(InProcessStore):
    def test_a_new_login_is_added_and_its_credential_filed(self):
        said, account_id = signin.file_login("anthropic", harvest("dddd4444-0000-0000-0000-000000000000", "org-d", "d@x"))
        self.assertEqual(said, "added d@x (max 20x) \u2192 pool now has 3 accounts")
        self.assertEqual(self.secrets(), {"pi-pool.anthropic." + account_id: "rt-org-d"})

    def test_sign_in_again_replaces_that_accounts_credential(self):
        self.assertEqual(signin.file_login("anthropic", harvest(B, "org-b", "b@x"), "b@x")[0], "reauthed b@x (max 20x)")
        self.assertEqual(self.secrets(), {"pi-pool.anthropic." + B: "rt-org-b"})

    def test_sign_in_again_as_another_account_changes_nothing(self):
        with self.assertRaisesRegex(signin.LoginRefused, "nothing changed"):
            signin.file_login("anthropic", harvest(A, "org-a", "a@x"), "b@x")
        self.assertEqual(self.secrets(), {})

    def test_an_unknown_target_is_refused(self):
        with self.assertRaisesRegex(signin.LoginRefused, "z@x is not in the anthropic pool"):
            signin.file_login("anthropic", harvest(A, "org-a", "a@x"), "z@x")

    def test_a_new_sign_in_drops_that_accounts_limit_and_terms_or_revoked_cooldown_only(self):
        until = time.time() + 3600
        self.write_state({"version": 2, "providers": {
            "anthropic": {"pin": None, "disabled": {}, "cooldowns": {A: until, B: until},
                          "cooldown_reasons": {A: "oauth not allowed for organization", B: "token rejected (401)"},
                          "limits": {A: {"until": until, "at": 1, "session": None}, B: {"until": until, "at": 1, "session": None}}},
            "openai-codex": {"pin": None, "cooldowns": {}, "disabled": {}}}, "sessions": {}})
        signin.file_login("anthropic", harvest(B, "org-b", "b@x"), "b@x")
        prov = self.state()["providers"]["anthropic"]
        self.assertEqual((list(prov["limits"]), list(prov["cooldowns"]), list(prov["cooldown_reasons"])), ([A], [A], [A]))

    def test_a_client_files_its_login_with_the_holder(self):
        asked = []
        with unittest.mock.patch.object(remote, "client", lambda: {"url": "http://holder", "secret": "s"}), \
             unittest.mock.patch.object(remote, "ask", lambda cfg, argv, stdin=None: (asked.append((argv, json.loads(stdin))), (0, '{"message": "reauthed b@x", "id": "x"}\n', ""))[1]):
            said = signin.file_anywhere("anthropic", harvest(B, "org-b", "b@x"), "b@x")
        self.assertEqual(said, "reauthed b@x")
        self.assertEqual(asked[0][0], ["--cli", "file-login"])
        self.assertEqual((asked[0][1]["provider"], asked[0][1]["target"], asked[0][1]["secret"]["refreshToken"]),
                         ("anthropic", "b@x", "rt-org-b"))
        self.assertEqual(self.secrets(), {})


class SecondOrganization(InProcessStore):
    """One login in two organizations is two accounts, each with its own
    credential, usage and limits."""
    TEAM = "eeee5555-0000-0000-0000-000000000000"

    def setUp(self):
        super().setUp()
        index = json.loads(json.dumps(CLAUDE_INDEX))
        index["accounts"][0]["oauthAccount"] = harvest(A, "org-a", "a@x")["record"]["oauthAccount"]
        self.write_index("anthropic", index)

    def team_id(self):
        return next(r["id"] for r in self.index() if r.get("oauthAccount", {}).get("organizationUuid") == self.TEAM)

    def test_the_second_organization_becomes_its_own_account(self):
        said, team = signin.file_login("anthropic", harvest(A, self.TEAM, "a@x", "Team", tier="team 5x"))
        self.assertEqual(said, "added a@x (Team) (team 5x) \u2192 pool now has 3 accounts")
        self.assertNotIn(team, (A, B))
        rows = {row["id"]: row for row in json.loads(self.cli("ls", "--json")[1])["rows"]}
        self.assertEqual((rows[A]["label"], rows[A]["email"]), ("a@x (personal)", "a@x"))
        self.assertEqual((rows[team]["label"], rows[team]["email"], rows[team]["tier"]), ("a@x (Team)", "a@x", "team 5x"))

    def test_the_same_organization_again_signs_in_in_place(self):
        signin.file_login("anthropic", harvest(A, self.TEAM, "a@x", "Team"))
        team = self.team_id()
        self.assertEqual(signin.file_login("anthropic", harvest(A, self.TEAM, "a@x", "Team"))[0], "reauthed a@x (Team) (max 20x)")
        self.assertEqual(signin.file_login("anthropic", harvest(A, self.TEAM, "a@x", "Team"), team)[1], team)
        self.assertEqual(len(self.index()), 3)

    def test_sign_in_again_with_the_other_organization_changes_nothing(self):
        before = self.index()
        with self.assertRaisesRegex(signin.LoginRefused, "nothing changed"):
            signin.file_login("anthropic", harvest(A, self.TEAM, "a@x", "Team"), A)
        self.assertEqual(self.index(), before)

    def test_a_shared_email_names_no_account_but_a_label_or_id_does(self):
        signin.file_login("anthropic", harvest(A, self.TEAM, "a@x", "Team"))
        code, out = self.cli("off", "a@x")
        self.assertNotEqual(code, 0)
        self.assertIn("a@x names 2 accounts", out)
        self.assertEqual(self.cli("off", "a@x (Team)"), (0, "a@x (Team) is off; the pool never picks it until pi-pool on"))
        self.assertEqual(list(self.state()["providers"]["anthropic"]["disabled"]), [self.team_id()])
        self.assertEqual(self.cli("on", A)[0], 0)


class UseNewSession(PoolFixture):
    NEW = "01a0cc8e-07c6-718d-9108-26f3983e1e1f"

    def test_an_unknown_session_is_still_refused_without_the_flag(self):
        code, out = self.cli("use", "a@x", "--session", self.NEW)
        self.assertEqual((code, out), (2, f"--session {self.NEW} matches no known session"))

    def test_new_session_pins_a_fresh_uuid_before_its_first_request(self):
        code, out = self.cli("use", "a@x", "--session", self.NEW, "--new-session")
        self.assertEqual(code, 0, out)
        rec = self.state()["sessions"][self.NEW]
        self.assertEqual((rec["uuid"], rec["pins"]["anthropic"]["account_id"]), (self.NEW, A))
        code, out = self.cli("who", "--json", "--session", self.NEW)
        self.assertEqual(code, 0, out)
        self.assertEqual(json.loads(out)["providers"]["anthropic"]["email"], "a@x")

    def test_new_session_needs_a_full_uuid(self):
        code, out = self.cli("use", "a@x", "--session", "01a0cc8e", "--new-session")
        self.assertEqual(code, 2)
        self.assertFalse(os.path.exists(os.path.join(self.pool, "state.json")), "a refused pin writes nothing")


if __name__ == "__main__":
    unittest.main()
