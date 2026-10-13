"""pi-pool command tests: the usage refresh, a seat with no weekly window, banked
resets, `use` idempotence, the fallback login and adopt-logins. The fixtures and
the loaded vend.py come from test_core.py.
"""
import base64, contextlib, io, json, os, shutil, subprocess, tempfile, time, types, unittest, unittest.mock

from fixture_isolation import isolate_test_module
from test_core import ALL, CFG, KEY, SOURCE
from vend.pool import base, commands, limit_resets, registry, vending


def setUpModule():
    isolate_test_module()


class RefreshUsage(unittest.TestCase):
    """`refresh` runs usage-read.ts once per provider and passes its events on
    with provider and email. A fake script stands in for bun; no network."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def fake(self, body):
        path = os.path.join(self.tmp, "bun")
        with open(path, "w") as f:
            # argv: --no-env-file <usage-read.ts> <src> <provider> [ids...]
            f.write('#!/bin/sh\nprovider="$4"\n' + body)
        os.chmod(path, 0o755)
        return unittest.mock.patch.object(commands, "tokenmaxxing_runtime", lambda: (path, "src"))

    def run_refresh(self, *args):
        out = io.StringIO()
        with unittest.mock.patch.object(base, "log", lambda *a, **k: None), contextlib.redirect_stdout(out):
            code = commands.cmd_refresh(list(args))
        return code, out.getvalue()

    READS = (
        'if [ "$provider" = anthropic ]; then\n'
        '  echo \'{"event":"accounts","accounts":[{"id":"a","email":"a@x"},{"id":"b","email":"b@x"}]}\'\n'
        '  echo \'{"event":"reading","id":"a"}\'\n'
        '  echo \'{"event":"read","id":"a","ok":true,"usage_at":1790000000}\'\n'
        '  echo \'{"event":"read","id":"b","ok":false,"reason":"rate limited","retry_at":1790000600}\'\n'
        'else\n'
        '  echo \'{"event":"accounts","accounts":[{"id":"c","email":"c@x"}]}\'\n'
        '  echo \'{"event":"read","id":"c","ok":true,"usage_at":1790000001}\'\n'
        'fi\n')

    def test_stream_names_provider_and_email_on_every_read(self):
        with self.fake(self.READS):
            code, out = self.run_refresh("--stream", "--provider", "anthropic")
        events = [json.loads(line) for line in out.splitlines()]
        self.assertEqual(code, 0)
        self.assertEqual([e["event"] for e in events], ["accounts", "reading", "read", "read", "end"])
        self.assertEqual((events[1]["email"], events[2]["email"], events[3]["provider"]), ("a@x", "a@x", "anthropic"))
        self.assertEqual((events[3]["ok"], events[3]["reason"], events[3]["retry_at"]), (False, "rate limited", 1790000600))

    def test_json_reports_every_provider(self):
        with self.fake(self.READS):
            code, out = self.run_refresh("--json")
        report = json.loads(out)["providers"]
        self.assertEqual(code, 0)
        self.assertEqual([r["ok"] for r in report["anthropic"]], [True, False])
        self.assertEqual(report["openai-codex"], [{"id": "c", "email": "c@x", "label": "c@x", "ok": True, "reason": None, "retry_at": None, "usage_at": 1790000001}])

    def test_named_accounts_need_a_provider(self):
        code, out = self.run_refresh("--json", "a@x")
        self.assertEqual(code, 1)
        self.assertIn("--provider", json.loads(out)["error"])

    def test_named_account_is_resolved_to_its_id(self):
        seen = os.path.join(self.tmp, "args")
        account = types.SimpleNamespace(id="abc-123", email="a@x", label="a@x")
        with self.fake(f'echo "$@" > {seen}\necho \'{{"event":"accounts","accounts":[]}}\'\n'), \
             unittest.mock.patch.object(registry, "load_index", lambda provider: [account]):
            code, _ = self.run_refresh("--json", "--provider", "anthropic", "a@x")
        self.assertEqual(code, 0)
        with open(seen) as f:
            self.assertTrue(f.read().split()[-2:] == ["anthropic", "abc-123"])

    def test_a_read_still_running_at_the_deadline_is_reported_unfinished(self):
        events = []
        with self.fake('echo \'{"event":"accounts","accounts":[{"id":"a","email":"a@x"}]}\'\necho \'{"event":"reading","id":"a"}\'\nexec sleep 30\n'):
            errors = commands.read_usage({"anthropic": None}, events.append, timeout=3)
        self.assertEqual(errors, {})
        self.assertEqual(events[-1], {"event": "read", "provider": "anthropic", "id": "a", "email": "a@x", "label": "a@x", "ok": False,
                                      "reason": "the read did not finish in 3s", "retry_at": None})

    def test_a_helper_crash_is_an_error(self):
        with self.fake('echo "boom" >&2\nexit 3\n'):
            code, out = self.run_refresh("--json", "--provider", "openai-codex")
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out)["errors"], {"openai-codex": "boom"})

    def test_runtime_comes_from_the_tokenmaxxing_wrapper(self):
        os.makedirs(os.path.join(self.tmp, "bin"))
        wrapper = os.path.join(self.tmp, "bin", "tokenmaxxing")
        with open(wrapper, "w") as f:
            f.write('#!/bin/sh\nexec "/x/bun" --no-env-file run "/y/tokenmaxxing/src/main.ts" "$@"\n')
        os.chmod(wrapper, 0o755)
        with unittest.mock.patch.object(base, "TM", self.tmp):
            self.assertEqual(commands.tokenmaxxing_runtime(), ("/x/bun", "/y/tokenmaxxing/src"))

    def test_usage_read_loads_against_the_installed_tokenmaxxing(self):
        """Contract check: a tokenmaxxing auto-update that renames a function usage-read.ts calls fails here."""
        try:
            bun, src = commands.tokenmaxxing_runtime()
        except RuntimeError as e:
            self.skipTest(str(e))
        done = subprocess.run([bun, "--no-env-file", commands.USAGE_READ, src, "anthropic", "not-an-account"], capture_output=True, text=True,
                              timeout=60, env=dict(os.environ, TOKENMAXXING_HOME=self.tmp))
        lines = [json.loads(line) for line in done.stdout.splitlines()]
        self.assertEqual((done.returncode, lines[-1]), (0, {"event": "read", "id": "not-an-account", "ok": False, "reason": "not in the pool", "retry_at": None}))


class SeatWithoutAWeeklyWindow(unittest.TestCase):
    """A team seat's usage has a 5h window and no weekly one. tokenmaxxing's
    read rejects that body, so usage-read.ts lands it through app/usage-seat.ts."""

    def windows(self, body):
        try:
            bun, _ = commands.tokenmaxxing_runtime()
        except RuntimeError as e:
            self.skipTest(str(e))
        script = ("import { seatWindows } from %s; console.log(JSON.stringify(seatWindows(%s, 1000)));"
                  % (json.dumps(os.path.join(SOURCE, "app", "usage-seat.ts")), json.dumps(body)))
        done = subprocess.run([bun, "--no-env-file", "-e", script], capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_a_five_hour_only_body_becomes_a_session_window_and_its_model_rows(self):
        body = {"five_hour": {"utilization": 10.0, "resets_at": "2026-10-10T14:59:59.9+00:00"}, "seven_day": None,
                "limits": [{"kind": "weekly_scoped", "percent": 4, "resets_at": "2026-10-10T13:59:59+00:00",
                            "scope": {"model": {"display_name": "Fable"}}}, {"kind": "session", "percent": 10}]}
        self.assertEqual(self.windows(body), [
            {"name": None, "usedPercentage": 10.0, "resetsAt": 1791644399900, "windowSeconds": 18000, "sampledAt": 1000},
            {"name": "Fable", "usedPercentage": 4, "resetsAt": 1791640799000, "windowSeconds": 604800, "sampledAt": 1000}])

    def test_a_body_without_a_five_hour_window_is_not_a_seat(self):
        self.assertIsNone(self.windows({"five_hour": None, "seven_day": None}))
        self.assertIsNone(self.windows({"five_hour": {"utilization": 1}, "seven_day": {"utilization": 2}}))


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

    def test_force_is_refused_and_writes_nothing(self):
        rc, out = self._use("a@x", "--force")
        self.assertEqual(rc, 2)
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

    def test_legacy_bare_shape_is_wrapped(self):
        fb_path = os.path.join(os.environ["PI_POOL_DIR"], "fallback-legacy.json")
        base.save_json(fb_path, {"type": "oauth", "access": "old", "refresh": "r", "expires": 0})
        fresh = {"accessToken": "new", "refreshToken": "r2", "expiresAt": 9e12}
        with unittest.mock.patch.object(base, "FALLBACK", fb_path), \
             unittest.mock.patch.object(base, "refresh_token", lambda creds: fresh):
            self.assertEqual(vending.fallback_token("anthropic", CFG), "new")
        self.assertEqual(base.load_json(fb_path)["anthropic"]["access"], "new")

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
