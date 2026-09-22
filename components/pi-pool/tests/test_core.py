"""Unit tests for the pure core of vend.py: migrate, resolve, prune, codex
index parsing, JWT claim decoding, ls row building, and use idempotence.

Run: python3 -m unittest discover -s tests   (from the pool directory)
"""
import base64, contextlib, importlib.util, io, json, os, shutil, sys, tempfile, unittest, unittest.mock

from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()


SOURCE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Isolate state so tests cannot append to the real pool log or overwrite pins.
os.environ["PI_POOL_DIR"] = tempfile.mkdtemp(prefix="pi-pool-test-")
_spec = importlib.util.spec_from_file_location("vend", os.path.join(SOURCE, "vend.py"))
vend = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = vend
with unittest.mock.patch.dict(os.environ, {"HOME": os.environ["PI_POOL_DIR"]}):
    _spec.loader.exec_module(vend)

CFG = dict(vend.DEFAULTS)
NOW = 1000000.0


def account(id, email, session_pct=0, weekly_pct=0, gated_pct=0, needs_reauth=False, is_live=False):
    return vend.Account(provider="anthropic", id=id, email=email, needs_reauth=needs_reauth,
                        session_pct=session_pct, weekly_pct=weekly_pct, gated_pct=gated_pct,
                        is_live=is_live, cred=vend.Keychain("Claude Code-credentials-" + id, "/dev/null"))


def codex_account(id, email, plan, session_pct=0, weekly_pct=0):
    return vend.Account(provider="openai-codex", id=id, email=email, needs_reauth=False,
                        session_pct=session_pct, weekly_pct=weekly_pct, gated_pct=0,
                        is_live=False, cred=vend.CredFile("/dev/null"), plan=plan)


A = account("a", "a@x", session_pct=10)
B = account("b", "b@x", session_pct=20)
C = account("c", "c@x", session_pct=30)
DEPLETED = account("d", "d@x", session_pct=99)
BROKEN = account("e", "e@x", needs_reauth=True)
ALL = [A, B, C, DEPLETED, BROKEN]
KEY = vend.SessionKey("01a0-uuid", "01a0-uuid", "35abe469e594")


def state_v2(pins=None, pool_pin=None, seat=None, cooldowns=None):
    return {"version": 2,
            "providers": {"anthropic": {"pin": pool_pin,
                                        "seat": {"account_id": seat, "since": NOW} if seat else None,
                                        "cooldowns": cooldowns or {}},
                          "openai-codex": vend.empty_provider_state()},
            "sessions": {KEY.key: {"uuid": KEY.uuid, "active_id": KEY.active_id,
                                   "pins": pins or {}, "vends": {}, "last_seen": NOW}}}


def resolved(state, accounts=ALL, in_use=None):
    intent = vend.intent_for(state, KEY, "anthropic")
    return vend.resolve(intent, accounts, in_use or {},
                        state["providers"]["anthropic"]["cooldowns"], CFG, NOW)


class Precedence(unittest.TestCase):
    """The six cases in the rubric's R4, plus the force flag."""

    def test_never_switched_takes_the_seat(self):
        r = resolved(state_v2(seat="b"))
        self.assertEqual((r.account.id, r.reason, r.shadowed), ("b", "seat", None))

    def test_never_switched_and_no_seat_picks_the_best(self):
        r = resolved(state_v2())
        self.assertEqual((r.account.id, r.reason), ("a", "seat_move"))

    def test_switched_beats_the_seat(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "c", "at": NOW}}, seat="b"))
        self.assertEqual((r.account.id, r.reason), ("c", "session_pin"))

    def test_switched_then_account_unusable_yields_and_reports_why(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "d", "at": NOW}}, seat="b"))
        self.assertEqual((r.account.id, r.reason, r.shadowed), ("b", "seat", ("d", "depleted")))

    def test_a_yielded_pin_is_not_written_away(self):
        state = state_v2(pins={"anthropic": {"account_id": "d", "at": NOW}}, seat="b")
        resolved(state)
        self.assertEqual(state["sessions"][KEY.key]["pins"]["anthropic"]["account_id"], "d")
        healed = [a for a in ALL if a.id != "d"] + [account("d", "d@x", session_pct=0)]
        self.assertEqual(resolved(state, healed).reason, "session_pin")

    def test_switched_then_session_ended_keeps_the_pin_for_the_resumed_session(self):
        state = state_v2(pins={"anthropic": {"account_id": "c", "at": NOW}}, seat="b")
        state["sessions"][KEY.key]["last_seen"] = NOW - 3600
        vend.HookWriter(state).prune(CFG, NOW)
        self.assertIn(KEY.key, state["sessions"])
        self.assertEqual(resolved(state).account.id, "c")

    def test_a_pin_older_than_the_ttl_is_pruned(self):
        state = state_v2(pins={"anthropic": {"account_id": "c", "at": NOW - 8 * 86400}}, seat="b")
        state["sessions"][KEY.key]["last_seen"] = NOW - 8 * 86400
        vend.HookWriter(state).prune(CFG, NOW)
        self.assertEqual(state["sessions"], {})

    def test_switched_to_the_seat_account_is_a_pin_not_a_seat_move(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "b", "at": NOW}}, seat="b"))
        self.assertEqual((r.account.id, r.reason), ("b", "session_pin"))

    def test_a_subagent_inherits_by_construction(self):
        state = state_v2(pins={"anthropic": {"account_id": "c", "at": NOW}}, seat="b")
        child = vend.SessionKey(KEY.key, KEY.uuid, "ffffffffffff")
        intent = vend.intent_for(state, child, "anthropic")
        self.assertEqual(intent.session_pin, "c")

    def test_force_holds_a_depleted_account(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "d", "at": NOW, "force": True}}, seat="b"))
        self.assertEqual((r.account.id, r.reason), ("d", "session_pin"))

    def test_force_still_yields_on_needs_reauth(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "e", "at": NOW, "force": True}}, seat="b"))
        self.assertEqual((r.account.id, r.reason, r.shadowed), ("b", "seat", ("e", "needs-reauth")))


class CodexPlanTier(unittest.TestCase):
    """The seat, and only the seat, yields to a higher codex plan. The seat
    otherwise moves only when it cannot serve, so a free seat taken while the
    paid account was depleted would hold every unpinned session for good - and
    the API refuses several models on a free plan."""

    FREE = codex_account("f", "free@x", "free")
    PLUS = codex_account("p", "plus@x", "plus")
    PLUS_DEPLETED = codex_account("p", "plus@x", "plus", weekly_pct=100)
    NO_PLAN = codex_account("n", "none@x", "")

    def resolve(self, accounts, seat=None, pin=None):
        state = {"version": 2,
                 "providers": {"anthropic": vend.empty_provider_state(),
                               "openai-codex": {
                                   "pin": None,
                                   "seat": {"account_id": seat, "since": NOW} if seat else None,
                                   "cooldowns": {}}},
                 "sessions": {KEY.key: {
                     "uuid": KEY.uuid, "active_id": KEY.active_id,
                     "pins": {"openai-codex": {"account_id": pin, "at": NOW}} if pin else {},
                     "vends": {}, "last_seen": NOW}}}
        intent = vend.intent_for(state, KEY, "openai-codex")
        return vend.resolve(intent, accounts, {}, {}, CFG, NOW)

    def test_a_free_seat_moves_to_a_usable_plus_account(self):
        r = self.resolve([self.FREE, self.PLUS], seat="f")
        self.assertEqual((r.account.id, r.reason), ("p", "seat_upgrade"))

    def test_a_plus_seat_does_not_move_to_a_free_account(self):
        r = self.resolve([self.FREE, self.PLUS], seat="p")
        self.assertEqual((r.account.id, r.reason), ("p", "seat"))

    def test_a_free_seat_holds_when_the_plus_account_is_depleted(self):
        r = self.resolve([self.FREE, self.PLUS_DEPLETED], seat="f")
        self.assertEqual((r.account.id, r.reason), ("f", "seat"))

    def test_a_pin_on_the_free_account_outranks_the_upgrade(self):
        r = self.resolve([self.FREE, self.PLUS], seat="f", pin="f")
        self.assertEqual((r.account.id, r.reason), ("f", "session_pin"))

    def test_an_unknown_plan_ranks_as_free(self):
        r = self.resolve([self.NO_PLAN, self.PLUS], seat="n")
        self.assertEqual((r.account.id, r.reason), ("p", "seat_upgrade"))

    def test_anthropic_has_no_plan_field_so_the_rule_never_fires(self):
        self.assertEqual(resolved(state_v2(seat="b")).reason, "seat")

    def test_the_plan_is_on_a_codex_row_and_absent_from_an_anthropic_one(self):
        codex = vend.build_rows([self.PLUS], vend.Intent(), {}, {}, CFG, NOW, None, None)
        anthropic = vend.build_rows([A], vend.Intent(), {}, {}, CFG, NOW, None, None)
        self.assertEqual(codex[0]["plan"], "plus")
        self.assertNotIn("plan", anthropic[0])


class PoolPin(unittest.TestCase):
    def test_a_pool_pin_beats_the_seat(self):
        r = resolved(state_v2(pool_pin="c", seat="b"))
        self.assertEqual((r.account.id, r.reason), ("c", "pool_pin"))

    def test_a_session_pin_beats_a_pool_pin(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "a", "at": NOW}}, pool_pin="c"))
        self.assertEqual((r.account.id, r.reason), ("a", "session_pin"))

    def test_a_pool_pin_holds_a_depleted_account(self):
        r = resolved(state_v2(pool_pin="d", seat="b"))
        self.assertEqual((r.account.id, r.reason), ("d", "pool_pin"))

    def test_a_pool_pin_yields_on_needs_reauth(self):
        r = resolved(state_v2(pool_pin="e", seat="b"))
        self.assertEqual((r.account.id, r.reason), ("b", "seat"))


class Fallbacks(unittest.TestCase):
    def test_a_cooling_seat_moves(self):
        r = resolved(state_v2(seat="b", cooldowns={"b": NOW + 60}))
        self.assertEqual((r.account.id, r.reason), ("a", "seat_move"))

    def test_a_missing_pin_account_yields(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "gone", "at": NOW}}, seat="b"))
        self.assertEqual((r.account.id, r.shadowed), ("b", ("gone", "missing")))

    def test_no_usable_account_resolves_to_nothing(self):
        self.assertIsNone(resolved(state_v2(), [DEPLETED, BROKEN]))

    def test_sessions_already_on_an_account_lose_to_a_fresh_one(self):
        r = resolved(state_v2(), in_use={"a": 3})
        self.assertEqual(r.account.id, "b")


class Migration(unittest.TestCase):
    V1 = {"assignments": {"31813:Sun Sep  6 14:33:51 2026": {"uuid": "a", "email": "a@x", "vends": 65}},
          "cooldowns": {"c": NOW + 60, "d": NOW - 60},
          "seat": {"uuid": "b", "email": "b@x", "assigned_at": NOW - 10},
          "pin": "a@x"}

    def migrated(self):
        return vend.migrate(dict(self.V1), {a.email: a.id for a in ALL}, NOW)

    def test_the_v1_pin_email_becomes_an_account_id(self):
        self.assertEqual(self.migrated()["providers"]["anthropic"]["pin"], "a")

    def test_the_seat_and_live_cooldowns_carry_over(self):
        out = self.migrated()
        self.assertEqual(out["providers"]["anthropic"]["seat"]["account_id"], "b")
        self.assertEqual(out["providers"]["anthropic"]["cooldowns"], {"c": NOW + 60})

    def test_pid_keyed_assignments_are_dropped(self):
        self.assertEqual(self.migrated()["sessions"], {})

    def test_an_unknown_pin_email_is_dropped(self):
        out = vend.migrate({"pin": "nobody@x"}, {a.email: a.id for a in ALL}, NOW)
        self.assertIsNone(out["providers"]["anthropic"]["pin"])

    def test_migrating_twice_changes_nothing(self):
        once = self.migrated()
        self.assertEqual(vend.migrate(once, {}, NOW), once)

    def test_both_providers_exist_after_migration(self):
        self.assertEqual(sorted(self.migrated()["providers"]), ["anthropic", "openai-codex"])


class Writers(unittest.TestCase):
    def test_the_hook_records_a_vend_and_counts_repeats(self):
        state = state_v2(seat="b")
        w = vend.HookWriter(state)
        w.record_vend(KEY, "anthropic", B, "parked", "seat", None, NOW)
        w.record_vend(KEY, "anthropic", B, "parked", "seat", None, NOW + 1)
        self.assertEqual(state["sessions"][KEY.key]["vends"]["anthropic"]["n"], 2)
        w.record_vend(KEY, "anthropic", A, "parked", "seat_move", ("d", "depleted"), NOW + 2)
        vended = state["sessions"][KEY.key]["vends"]["anthropic"]
        self.assertEqual((vended["account_id"], vended["n"], vended["shadowed"]), ("a", 1, ["d", "depleted"]))

    def test_the_cli_writes_a_pin_without_touching_a_vend(self):
        state = state_v2(seat="b")
        vend.HookWriter(state).record_vend(KEY, "anthropic", B, "parked", "seat", None, NOW)
        vend.IntentWriter(state).set_pin(KEY, "anthropic", "c", False, "cli", NOW)
        rec = state["sessions"][KEY.key]
        self.assertEqual(rec["pins"]["anthropic"]["account_id"], "c")
        self.assertEqual(rec["vends"]["anthropic"]["account_id"], "b")

    def test_setting_the_same_pin_twice_is_the_same_state(self):
        state = state_v2()
        vend.IntentWriter(state).set_pin(KEY, "anthropic", "c", False, "cli", NOW)
        first = repr(state)
        vend.IntentWriter(state).set_pin(KEY, "anthropic", "c", False, "cli", NOW)
        self.assertEqual(repr(state), first)

    def test_following_the_pool_removes_only_the_pin(self):
        state = state_v2(pins={"anthropic": {"account_id": "c", "at": NOW},
                               "openai-codex": {"account_id": "z", "at": NOW}})
        vend.IntentWriter(state).clear_pin(KEY, "anthropic")
        self.assertEqual(list(state["sessions"][KEY.key]["pins"]), ["openai-codex"])

    def test_an_expired_cooldown_is_pruned(self):
        state = state_v2(cooldowns={"a": NOW - 1, "b": NOW + 60})
        vend.HookWriter(state).prune(CFG, NOW)
        self.assertEqual(state["providers"]["anthropic"]["cooldowns"], {"b": NOW + 60})

    def test_pruning_nothing_reports_no_change(self):
        state = state_v2(cooldowns={"b": NOW + 60})
        self.assertFalse(vend.HookWriter(state).prune(CFG, NOW))

    def test_pruning_reports_a_change(self):
        state = state_v2(cooldowns={"a": NOW - 1})
        self.assertTrue(vend.HookWriter(state).prune(CFG, NOW))

    def test_record_vend_returns_the_record_it_wrote(self):
        state = state_v2()
        vended = vend.HookWriter(state).record_vend(KEY, "anthropic", B, "parked", "seat", None, NOW)
        self.assertIs(vended, state["sessions"][KEY.key]["vends"]["anthropic"])
class IndexV2Windows(unittest.TestCase):
    """tokenmaxxing index v2 windows, classified by windowSeconds and name
    rather than array position, for both providers."""

    @staticmethod
    def win(pct, secs, reset_in=None, name=None, sampled=NOW):
        return {"name": name, "usedPercentage": pct, "windowSeconds": secs, "sampledAt": sampled * 1000,
                "resetsAt": None if reset_in is None else (NOW + reset_in) * 1000}

    def test_a_plan_with_only_a_thirty_day_window_has_no_session_bar(self):
        acct = {"windows": [self.win(40, 2592000, 2592000)]}
        self.assertEqual(vend.usage_pct(acct, NOW), (0, 40))

    def test_a_five_hour_and_weekly_pair_is_classified_by_window_seconds(self):
        acct = {"windows": [self.win(100, 604800, 604800), self.win(12, 18000, 18000)]}
        self.assertEqual(vend.usage_pct(acct, NOW), (12, 100))

    def test_a_passed_reset_self_heals_to_zero(self):
        acct = {"windows": [self.win(87, 18000, -60)]}
        self.assertEqual(vend.usage_pct(acct, NOW), (0, 0))

    def test_a_null_reset_expires_after_its_own_window(self):
        acct = {"windows": [self.win(87, 18000, None, sampled=NOW - 18001)]}
        self.assertEqual(vend.usage_pct(acct, NOW), (0, 0))

    def test_named_windows_feed_only_the_gated_cap(self):
        acct = {"windows": [self.win(5, 18000, 100), self.win(10, 604800, 100),
                            self.win(100, 604800, 100, name="Fable"), self.win(70, 604800, 100, name="Sonnet")]}
        self.assertEqual(vend.usage_pct(acct, NOW), (5, 10))
        self.assertEqual(vend.gated_pct(acct, CFG, NOW), 100)
        self.assertEqual(vend.gated_pct(acct, dict(CFG, switch_models=["opus"]), NOW), 0)


class StoreLayout(unittest.TestCase):
    """The store path and keychain service must match tokenmaxxing's
    storeDirFor and namespacedCredService byte for byte."""

    def test_service_is_sha256_of_the_store_path(self):
        store = "/Users/someone/.config/tokenmaxxing/stores/382bc870"
        import hashlib
        expected = "Claude Code-credentials-" + hashlib.sha256(store.encode()).hexdigest()[:8]
        self.assertEqual(vend.store_service(store), expected)

    def test_store_dir_uses_the_first_eight_chars(self):
        self.assertEqual(os.path.basename(vend.store_dir("382bc870-8dc4-484d")), "382bc870")

    def test_a_v1_index_is_refused_with_the_version(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "accounts.json")
            with open(path, "w") as f:
                json.dump({"version": 1, "accounts": []}, f)
            with self.assertRaisesRegex(RuntimeError, "schema v1"):
                vend._read_index(path)

    def test_mark_needs_reauth_flags_one_account_and_keeps_the_rest(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "accounts.json")
            idx = {"version": 2, "accounts": [{"id": "a", "email": "a@x", "windows": [], "extra": 1},
                                              {"id": "b", "email": "b@x", "windows": []}]}
            with open(path, "w") as f:
                json.dump(idx, f)
            vend.mark_needs_reauth(path, "a")
            out = json.load(open(path))
            self.assertEqual(out["accounts"][0]["needsReauth"], True)
            self.assertEqual(out["accounts"][0]["extra"], 1)
            self.assertNotIn("needsReauth", out["accounts"][1])


class AnthropicRefusal(unittest.TestCase):
    """Only 401 and 403 refuse; rate limits and outages do not."""

    @staticmethod
    def raising(code, body):
        import urllib.error
        def fake(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, code, "x", {}, io.BytesIO(body.encode()))
        return fake

    def test_an_org_that_disallows_oauth_is_named(self):
        body = '{"error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization."}}'
        with unittest.mock.patch.object(vend.urllib.request, "urlopen", self.raising(403, body)):
            self.assertEqual(vend.anthropic_refusal("t"), "oauth not allowed for organization")

    def test_a_revoked_token_is_a_refusal(self):
        with unittest.mock.patch.object(vend.urllib.request, "urlopen", self.raising(401, "{}")):
            self.assertEqual(vend.anthropic_refusal("t"), "token rejected (401)")

    def test_rate_limits_and_outages_are_not(self):
        for code in (400, 429, 500):
            with unittest.mock.patch.object(vend.urllib.request, "urlopen", self.raising(code, "{}")):
                self.assertIsNone(vend.anthropic_refusal("t"))


class MarkRefused(unittest.TestCase):
    def test_sets_enforced_until_and_never_shortens_it(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "accounts.json")
            vend.save_json(path, {"version": 2, "accounts": [{"id": "a", "windows": [], "enforcedUntil": 5000}]})
            with unittest.mock.patch.object(vend, "TM_ACCOUNTS", path), \
                 unittest.mock.patch.object(vend, "TM_LOCK", os.path.join(d, "lock")):
                vend.mark_refused("a", 10)
                self.assertEqual(vend.load_json(path)["accounts"][0]["enforcedUntil"], 10000)
                vend.mark_refused("a", 3)
                self.assertEqual(vend.load_json(path)["accounts"][0]["enforcedUntil"], 10000)


class ClaudeRefreshLockDirs(unittest.TestCase):
    def test_takes_and_releases_both_lock_dirs(self):
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "stores", "abcd1234")
            with vend.ClaudeRefreshLock(store):
                self.assertTrue(os.path.isdir(os.path.join(store, ".oauth_refresh.lock")))
                self.assertTrue(os.path.isdir(os.path.realpath(store) + ".lock"))
            self.assertFalse(os.path.exists(os.path.join(store, ".oauth_refresh.lock")))
            self.assertFalse(os.path.exists(os.path.realpath(store) + ".lock"))

    def test_a_held_lock_is_contested(self):
        with tempfile.TemporaryDirectory() as d:
            store = os.path.join(d, "s")
            with vend.ClaudeRefreshLock(store):
                with self.assertRaises(TimeoutError):
                    with vend.ClaudeRefreshLock(store, attempts=2, retry_sec=0.01):
                        pass


class JWTClaimDecode(unittest.TestCase):
    """jwt_claims reads the payload segment only; no signature is checked,
    matching tokenmaxxing's own isCodexAccessExpiring."""

    @staticmethod
    def token_for(payload):
        seg = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
        return f"header.{seg}.signature"

    def test_decodes_the_account_id_claim(self):
        tok = self.token_for({"exp": 1234567890,
                              "https://api.openai.com/auth": {"chatgpt_account_id": "abc-123"}})
        claims = vend.jwt_claims(tok)
        self.assertEqual(claims["exp"], 1234567890)
        self.assertEqual(claims["https://api.openai.com/auth"]["chatgpt_account_id"], "abc-123")

    def test_decodes_without_base64_padding(self):
        tok = self.token_for({"exp": 1})
        payload_len = len(tok.split(".")[1])
        self.assertNotEqual(payload_len % 4, 1)
        self.assertEqual(vend.jwt_claims(tok)["exp"], 1)

    def test_assert_codex_identity_passes_on_a_match(self):
        tok = self.token_for({"https://api.openai.com/auth": {"chatgpt_account_id": "acc-1"}})
        vend.assert_codex_identity(tok, "acc-1")

    def test_assert_codex_identity_fails_closed_on_a_mismatch(self):
        tok = self.token_for({"https://api.openai.com/auth": {"chatgpt_account_id": "acc-1"}})
        with self.assertRaises(RuntimeError):
            vend.assert_codex_identity(tok, "acc-2")


class LsRowBuilding(unittest.TestCase):
    """build_rows() is what `ls --json` and /account render. Fixed index and
    state in, exact rows out."""

    def test_rows_carry_usage_reason_and_flags(self):
        intent = vend.Intent(session_pin="c", pool_pin=None, seat="b")
        cooldowns = {}
        rows = vend.build_rows(ALL, intent, in_use={"a": 2}, cooldowns=cooldowns,
                               cfg=CFG, now=NOW, current_id="b", seat_id="b")
        by_id = {r["id"]: r for r in rows}
        self.assertEqual(by_id["a"]["usage"], "10%/0%")
        self.assertEqual(by_id["a"]["usable"], True)
        self.assertIsNone(by_id["a"]["reason"])
        self.assertEqual(by_id["a"]["score"], vend.account_score(A, {"a": 2}, CFG))
        self.assertEqual(by_id["b"]["seat"], True)
        self.assertEqual(by_id["b"]["current"], True)
        self.assertEqual(by_id["c"]["pinned"], True)
        self.assertEqual(by_id["c"]["force"], False)
        self.assertEqual(by_id["d"]["usable"], False)
        self.assertEqual(by_id["d"]["reason"], "depleted")
        self.assertIsNone(by_id["d"]["score"])
        self.assertEqual(by_id["e"]["reason"], "needs-reauth")

    def test_a_force_pin_is_flagged_separately_from_a_plain_pin(self):
        intent = vend.Intent(session_pin="d", session_pin_force=True)
        rows = vend.build_rows(ALL, intent, in_use={}, cooldowns={}, cfg=CFG, now=NOW,
                               current_id=None, seat_id=None)
        by_id = {r["id"]: r for r in rows}
        self.assertEqual((by_id["d"]["pinned"], by_id["d"]["force"]), (True, True))
        self.assertEqual((by_id["a"]["pinned"], by_id["a"]["force"]), (False, False))

    def test_a_cooldown_reason_carries_a_countdown(self):
        cooling = account("f", "f@x", session_pct=5)
        rows = vend.build_rows([cooling], vend.Intent(), in_use={}, cooldowns={"f": NOW + 125},
                               cfg=CFG, now=NOW, current_id=None, seat_id=None)
        self.assertEqual(rows[0]["reason"], "cooldown 2m")

    def test_a_pool_pin_is_reported_as_pinned_too(self):
        rows = vend.build_rows(ALL, vend.Intent(pool_pin="b"), in_use={}, cooldowns={},
                               cfg=CFG, now=NOW, current_id=None, seat_id=None)
        by_id = {r["id"]: r for r in rows}
        self.assertEqual(by_id["b"]["pinned"], True)


class UseIdempotence(unittest.TestCase):
    """cmd_use never writes when the requested state already holds."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.state_path = os.path.join(self.tmp, "state.json")
        self.saves = []
        self._patches = [
            unittest.mock.patch.object(vend, "STATE", self.state_path),
            unittest.mock.patch.object(vend, "LOCK", os.path.join(self.tmp, "lock")),
            unittest.mock.patch.object(vend, "session_key", lambda: KEY),
            unittest.mock.patch.object(vend, "load_index", lambda provider: ALL),
        ]
        for p in self._patches:
            p.start()
        real_save_json = vend.save_json

        def spy_save_json(path, data):
            self.saves.append(path)
            real_save_json(path, data)
        self._save_patch = unittest.mock.patch.object(vend, "save_json", spy_save_json)
        self._save_patch.start()

    def tearDown(self):
        self._save_patch.stop()
        for p in self._patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _use(self, *args):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = vend.cmd_use(list(args))
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

    def test_changing_the_force_flag_is_not_a_no_op(self):
        self._use("a@x")
        self.saves.clear()
        rc, out = self._use("a@x", "--force")
        self.assertEqual(rc, 0)
        self.assertEqual(len(self.saves), 1)

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
        vend.save_json(fb_path, {
            "anthropic": {"type": "oauth", "access": "old", "refresh": "r", "expires": 0},
            "openai-codex": {"type": "oauth", "access": "c", "refresh": "cr", "expires": 1},
        })
        fresh = {"accessToken": "new", "refreshToken": "r2", "expiresAt": 9e12}
        with unittest.mock.patch.object(vend, "FALLBACK", fb_path), \
             unittest.mock.patch.object(vend, "refresh_token", lambda creds: fresh):
            self.assertEqual(vend.fallback_token("anthropic", CFG), "new")
        after = vend.load_json(fb_path)
        self.assertEqual(after["anthropic"]["access"], "new")
        self.assertEqual(after["openai-codex"]["access"], "c")

    def test_legacy_bare_shape_is_wrapped(self):
        fb_path = os.path.join(os.environ["PI_POOL_DIR"], "fallback-legacy.json")
        vend.save_json(fb_path, {"type": "oauth", "access": "old", "refresh": "r", "expires": 0})
        fresh = {"accessToken": "new", "refreshToken": "r2", "expiresAt": 9e12}
        with unittest.mock.patch.object(vend, "FALLBACK", fb_path), \
             unittest.mock.patch.object(vend, "refresh_token", lambda creds: fresh):
            self.assertEqual(vend.fallback_token("anthropic", CFG), "new")
        self.assertEqual(vend.load_json(fb_path)["anthropic"]["access"], "new")

    def test_codex_fallback_refreshes_and_keeps_its_account_id(self):
        fb_path = os.path.join(os.environ["PI_POOL_DIR"], "fallback-codex.json")
        vend.save_json(fb_path, {"openai-codex": {"type": "oauth", "access": "old", "refresh": "cr",
                                                  "expires": 0, "accountId": "acc"}})
        payload = base64.urlsafe_b64encode(json.dumps({"exp": 2000000000}).encode()).rstrip(b"=").decode()
        fresh = {"access_token": f"h.{payload}.s", "refresh_token": "cr2"}
        with unittest.mock.patch.object(vend, "FALLBACK", fb_path), \
             unittest.mock.patch.object(vend, "refresh_codex_token", lambda r: fresh):
            self.assertEqual(vend.fallback_token("openai-codex", CFG), fresh["access_token"])
        after = vend.load_json(fb_path)["openai-codex"]
        self.assertEqual((after["refresh"], after["expires"], after["accountId"]), ("cr2", 2000000000000, "acc"))


class AdoptLogins(unittest.TestCase):
    def test_a_login_for_a_pooled_provider_moves_to_the_fallback(self):
        with tempfile.TemporaryDirectory() as agent:
            vend.save_json(os.path.join(agent, "models.json"), {"providers": {
                "anthropic": {"apiKey": "!/x/pi-pool-token"},
                "openai-codex": {"apiKey": "!/x/pi-pool-token --provider openai-codex"}}})
            login = {"type": "oauth", "access": "a", "refresh": "r", "expires": 1, "accountId": "acc"}
            vend.save_json(os.path.join(agent, "auth.json"), {"openai-codex": login, "virev": {"type": "api_key"}})
            fb_path = os.path.join(agent, "fallback.json")
            with unittest.mock.patch.dict(os.environ, {"PRIME_AGENT_CODING_AGENT_DIR": agent}), \
                 unittest.mock.patch.object(vend, "FALLBACK", fb_path), \
                 contextlib.redirect_stdout(io.StringIO()):
                vend.cmd_adopt_logins()
            self.assertEqual(vend.load_json(os.path.join(agent, "auth.json")), {"virev": {"type": "api_key"}})
            self.assertEqual(vend.load_json(fb_path)["openai-codex"], login)
            self.assertFalse(os.path.exists(os.path.join(agent, "auth.json.lock")))

    def test_a_provider_outside_the_pool_keeps_its_login(self):
        with tempfile.TemporaryDirectory() as agent:
            vend.save_json(os.path.join(agent, "models.json"), {"providers": {"anthropic": {"apiKey": "sk-x"}}})
            vend.save_json(os.path.join(agent, "auth.json"), {"anthropic": {"type": "oauth"}})
            with unittest.mock.patch.dict(os.environ, {"PRIME_AGENT_CODING_AGENT_DIR": agent}):
                vend.cmd_adopt_logins()
            self.assertIn("anthropic", vend.load_json(os.path.join(agent, "auth.json")))


class RefusedAccountsBreakForcePins(unittest.TestCase):
    def test_a_force_pin_yields_to_a_refusal_cooldown(self):
        intent = vend.Intent(session_pin="a", session_pin_force=True, seat="b")
        res = vend.resolve(intent, [A, B], {}, {"a": NOW + 100}, CFG, NOW)
        self.assertEqual((res.account.id, res.reason), ("b", "seat"))


class InUseCountsOnlyRecentVends(unittest.TestCase):
    def test_an_idle_session_record_does_not_count(self):
        state = {"sessions": {"s1": {"vends": {"anthropic": {"account_id": "a", "at": NOW - 10}}},
                              "s2": {"vends": {"anthropic": {"account_id": "a", "at": NOW - 7200}}}}}
        self.assertEqual(vend.in_use_counts(state, "anthropic", NOW, 3600), {"a": 1})

if __name__ == "__main__":
    unittest.main()
