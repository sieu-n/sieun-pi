"""pi-pool command tests: banked resets, `use` idempotence, the fallback login and
adopt-logins. The fixtures and
the loaded vend.py come from test_core.py.
"""
import base64, contextlib, io, json, os, shutil, tempfile, time, types, unittest, unittest.mock

from fixture_isolation import isolate_test_module
from test_core import ALL, CFG, KEY
from vend.pool import base, commands, limit_resets, registry, vending


def setUpModule():
    isolate_test_module()


GRANT = {"id": "opus55-launch", "label": "Launch reset", "resets_total": 1, "resets_left": 1, "starts_at": "2026-09-22T16:00:00+00:00",
         "ends_at": "2999-10-22T16:00:00+00:00", "clears": ["five_hour", "seven_day", "bogus"], "paused": False, "usable_now": True,
         "use_requires_limit": False, "percent_used": {"five_hour": 3, "seven_day": 98}}
BLOCK = {"eligible": True, "ineligible_reason": None, "at_limit": False, "grants": [GRANT], "next_grant_id": "opus55-launch",
         "weekly_resets_at": "2026-10-10T13:00:00+00:00", "cooldown_until": None}


class ResetGrants(unittest.TestCase):
    """The cedar_ember block parses strictly, and a grant is spent only when nothing blocks it."""

    def test_block_parses_and_drops_unknown_windows(self):
        status = limit_resets.parse_grant_status(BLOCK)
        self.assertEqual(status["grants"][0]["clears"], ["five_hour", "seven_day"])
        self.assertEqual(status["next_grant_id"], "opus55-launch")
        self.assertIsNone(limit_resets.grant_blocker(status, "opus55-launch", time.time()))
        self.assertEqual(limit_resets.pick_grant(status, time.time())["id"], "opus55-launch")

    def test_one_bad_grant_rejects_the_block(self):
        for bad in ({"resets_left": 2}, {"id": "Bad Id"}, {"ends_at": "soon"}, {"usable_now": "yes"}):
            self.assertIsNone(limit_resets.parse_grant_status({**BLOCK, "grants": [{**GRANT, **bad}]}), bad)
        self.assertIsNone(limit_resets.parse_grant_status({**BLOCK, "grants": [GRANT, GRANT]}))
        self.assertIsNone(limit_resets.parse_grant_status({"grants": []}))

    def test_missing_flags_default_to_refusing(self):
        grant = {k: v for k, v in GRANT.items() if k not in ("usable_now", "use_requires_limit")}
        status = limit_resets.parse_grant_status({**BLOCK, "grants": [grant]})
        self.assertEqual(limit_resets.grant_blocker(status, "opus55-launch", time.time()), "not_usable")
        status["grants"][0]["usable_now"] = True
        self.assertEqual(limit_resets.grant_blocker(status, "opus55-launch", time.time()), "not_limited")

    def test_blockers(self):
        now = time.time()
        cases = {"exhausted": {"grants": [{**GRANT, "resets_left": 0}]}, "ineligible": {"eligible": False},
                 "cooldown": {"cooldown_until": "2999-01-01T00:00:00+00:00"}, "ended": {"grants": [{**GRANT, "ends_at": "2000-01-01T00:00:00Z"}]},
                 "paused": {"grants": [{**GRANT, "paused": True}]}}
        for blocker, change in cases.items():
            status = limit_resets.parse_grant_status({**BLOCK, **change})
            self.assertEqual(limit_resets.grant_blocker(status, "opus55-launch", now), blocker)
            self.assertIsNone(limit_resets.pick_grant(status, now))


class ResetClaims(unittest.TestCase):
    """`pi-pool reset` journals the request id before the POST and reuses it after an unknown outcome."""

    ORG = "11111111-2222-3333-4444-555555555555"

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.account = types.SimpleNamespace(id="acc-1", email="a@x", label="a@x", needs_reauth=False)
        self.left, self.posts, self.answers = 1, [], []
        patches = [unittest.mock.patch.object(module, name, os.path.join(self.tmp, file)) for module, name, file in
                   ((limit_resets, "RESETS", "resets.json"), (limit_resets, "RESET_CLAIMS", "claims.json"),
                    (limit_resets, "RESET_LOCK", "reset.lock"), (base, "LOCK", "lock"))]
        patches += [unittest.mock.patch.object(base, "log", lambda *a, **k: None),
                    unittest.mock.patch.object(registry, "load_index", lambda provider: [self.account]),
                    unittest.mock.patch.object(base, "config", lambda: {}),
                    unittest.mock.patch.object(vending, "credential_for", lambda a, cfg: ("tok", "store")),
                    unittest.mock.patch.object(limit_resets, "anthropic_call", self.call)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def call(self, url, token, payload=None, timeout=12.0):
        if url == limit_resets.PROFILE_URL:
            return 200, {"organization": {"uuid": self.ORG}}
        if url == limit_resets.GRANT_STATUS_URL:
            return 200, {"cedar_ember": {**BLOCK, "grants": [{**GRANT, "resets_left": self.left}]}}
        self.posts.append(payload)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        if answer == (200, {"result": "reset"}):
            self.left = 0
        return answer

    def reset(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = limit_resets.cmd_reset(["a@x", "--json", *args])
        return code, json.loads(out.getvalue())

    def claims(self):
        return base.load_json(limit_resets.RESET_CLAIMS, {})

    def test_a_claim_spends_one_reset(self):
        self.answers = [(200, {"result": "reset"})]
        code, out = self.reset()
        self.assertEqual((code, out["result"]), (0, "reset"))
        self.assertEqual(self.posts[0]["program"], "cedar_ember")
        self.assertEqual(self.posts[0]["grant_id"], "opus55-launch")
        self.assertEqual(self.claims()["acc-1"]["code"], "reset")

    def test_an_unknown_outcome_is_retried_with_the_same_request_id(self):
        self.answers = [TimeoutError(), (200, {"result": "reset"})]
        code, out = self.reset()
        self.assertEqual((code, out["result"]), (3, "unknown"))
        self.assertIsNone(self.claims()["acc-1"]["code"])
        code, out = self.reset()
        self.assertEqual((code, out["result"]), (0, "reset"))
        self.assertEqual(self.posts[0]["request_id"], self.posts[1]["request_id"])

    def test_a_refusal_on_a_retry_does_not_settle_the_claim(self):
        self.answers = [TimeoutError(), (200, {"result": "not_limited"})]
        self.reset()
        code, out = self.reset()
        self.assertEqual(out["result"], "unknown")
        self.assertIsNone(self.claims()["acc-1"]["code"])

    def test_after_the_retry_window_the_grant_count_settles_the_claim(self):
        self.answers = [TimeoutError()]
        self.reset()
        claims = self.claims()
        claims["acc-1"]["created_at"] -= limit_resets.RESET_RETRY_SEC + 1
        base.save_json(limit_resets.RESET_CLAIMS, claims)
        self.left = 0
        code, out = self.reset()
        self.assertEqual((code, out["result"], len(self.posts)), (0, "reset", 1))

    def test_an_unspent_expired_claim_allows_a_new_claim(self):
        self.answers = [TimeoutError(), (200, {"result": "reset"})]
        self.reset()
        claims = self.claims()
        claims["acc-1"]["created_at"] -= limit_resets.RESET_RETRY_SEC + 1
        base.save_json(limit_resets.RESET_CLAIMS, claims)
        code, out = self.reset()
        self.assertEqual((code, out["result"]), (0, "reset"))
        self.assertNotEqual(self.posts[0]["request_id"], self.posts[1]["request_id"])

    def test_a_blocked_grant_sends_nothing(self):
        self.left = 0
        code, out = self.reset()
        self.assertEqual((code, out["result"], out["blocker"], self.posts), (1, "blocked", "exhausted", []))
        self.assertEqual(self.claims(), {})


class UseIdempotence(unittest.TestCase):
    """cmd_use never writes when the requested state already holds."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.state_path = os.path.join(self.tmp, "state.json")
        self.saves = []
        self._patches = [
            unittest.mock.patch.object(base, "STATE", self.state_path),
            unittest.mock.patch.object(base, "LOCK", os.path.join(self.tmp, "lock")),
            unittest.mock.patch.object(registry, "session_key", lambda: KEY),
            unittest.mock.patch.object(registry, "load_index", lambda provider: ALL),
        ]
        for p in self._patches:
            p.start()
        real_save_json = base.save_json

        def spy_save_json(path, data):
            self.saves.append(path)
            real_save_json(path, data)
        self._save_patch = unittest.mock.patch.object(base, "save_json", spy_save_json)
        self._save_patch.start()

    def tearDown(self):
        self._save_patch.stop()
        for p in self._patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _use(self, *args):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = commands.cmd_use(list(args))
        return rc, buf.getvalue().strip()

    def test_pinning_writes_once(self):
        rc, out = self._use("a@x")
        self.assertEqual(rc, 0)
        self.assertIn("a@x selected", out)
        self.assertEqual(len(self.saves), 1)

    def test_pinning_the_same_account_again_does_not_write(self):
        self._use("a@x")
        self.saves.clear()
        rc, out = self._use("a@x")
        self.assertEqual((rc, out), (0, "already on a@x"))
        self.assertEqual(self.saves, [])

    def test_follow_with_nothing_pinned_does_not_write(self):
        rc, out = self._use("--follow")
        self.assertEqual((rc, out), (0, "already following the pool"))
        self.assertEqual(self.saves, [])

    def test_follow_after_a_pin_clears_it_and_writes_once(self):
        self._use("a@x")
        self.saves.clear()
        rc, out = self._use("--follow")
        self.assertEqual(rc, 0)
        self.assertEqual(len(self.saves), 1)
        with open(self.state_path) as fh:
            state = json.load(fh)
        self.assertNotIn("anthropic", state["sessions"][KEY.key].get("pins", {}))



class FallbackKeepsSiblingProviders(unittest.TestCase):
    def test_refresh_preserves_openai_codex_entry(self):
        fb_path = os.path.join(os.environ["PI_POOL_DIR"], "fallback-test.json")
        base.save_json(fb_path, {
            "anthropic": {"type": "oauth", "access": "old", "refresh": "r", "expires": 0},
            "openai-codex": {"type": "oauth", "access": "c", "refresh": "cr", "expires": 1},
        })
        fresh = {"accessToken": "new", "refreshToken": "r2", "expiresAt": 9e12}
        with unittest.mock.patch.object(base, "FALLBACK", fb_path), \
             unittest.mock.patch.object(base, "refresh_token", lambda creds: fresh):
            self.assertEqual(vending.fallback_token("anthropic", CFG), "new")
        after = base.load_json(fb_path)
        self.assertEqual(after["anthropic"]["access"], "new")
        self.assertEqual(after["openai-codex"]["access"], "c")

    def test_codex_fallback_refreshes_and_keeps_its_account_id(self):
        fb_path = os.path.join(os.environ["PI_POOL_DIR"], "fallback-codex.json")
        base.save_json(fb_path, {"openai-codex": {"type": "oauth", "access": "old", "refresh": "cr",
                                                  "expires": 0, "accountId": "acc"}})
        payload = base64.urlsafe_b64encode(json.dumps({"exp": 2000000000}).encode()).rstrip(b"=").decode()
        fresh = {"access_token": f"h.{payload}.s", "refresh_token": "cr2"}
        with unittest.mock.patch.object(base, "FALLBACK", fb_path), \
             unittest.mock.patch.object(base, "refresh_codex_token", lambda r: fresh):
            self.assertEqual(vending.fallback_token("openai-codex", CFG), fresh["access_token"])
        after = base.load_json(fb_path)["openai-codex"]
        self.assertEqual((after["refresh"], after["expires"], after["accountId"]), ("cr2", 2000000000000, "acc"))


class AdoptLogins(unittest.TestCase):
    def test_a_login_for_a_pooled_provider_moves_to_the_fallback(self):
        with tempfile.TemporaryDirectory() as agent:
            base.save_json(os.path.join(agent, "models.json"), {"providers": {
                "anthropic": {"apiKey": "!/x/pi-pool-token"},
                "openai-codex": {"apiKey": "!/x/pi-pool-token --provider openai-codex"}}})
            login = {"type": "oauth", "access": "a", "refresh": "r", "expires": 1, "accountId": "acc"}
            base.save_json(os.path.join(agent, "auth.json"), {"openai-codex": login, "virev": {"type": "api_key"}})
            fb_path = os.path.join(agent, "fallback.json")
            with unittest.mock.patch.dict(os.environ, {"PRIME_AGENT_CODING_AGENT_DIR": agent}), \
                 unittest.mock.patch.object(base, "FALLBACK", fb_path), \
                 contextlib.redirect_stdout(io.StringIO()):
                vending.cmd_adopt_logins()
            self.assertEqual(base.load_json(os.path.join(agent, "auth.json")), {"virev": {"type": "api_key"}})
            self.assertEqual(base.load_json(fb_path)["openai-codex"], login)
            self.assertFalse(os.path.exists(os.path.join(agent, "auth.json.lock")))

    def test_a_provider_outside_the_pool_keeps_its_login(self):
        with tempfile.TemporaryDirectory() as agent:
            base.save_json(os.path.join(agent, "models.json"), {"providers": {"anthropic": {"apiKey": "sk-x"}}})
            base.save_json(os.path.join(agent, "auth.json"), {"anthropic": {"type": "oauth"}})
            with unittest.mock.patch.dict(os.environ, {"PRIME_AGENT_CODING_AGENT_DIR": agent}):
                vending.cmd_adopt_logins()
            self.assertIn("anthropic", base.load_json(os.path.join(agent, "auth.json")))


if __name__ == "__main__":
    unittest.main()
