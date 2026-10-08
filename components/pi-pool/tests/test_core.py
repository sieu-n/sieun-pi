"""Unit tests for the pure core of vend.py: migrate, resolve, prune, codex
index parsing, JWT claim decoding, ls row building, and use idempotence.

Run: python3 -m unittest discover -s tests   (from the pool directory)
"""
import base64, contextlib, dataclasses, importlib.util, io, json, os, shutil, subprocess, sys, tempfile, time, types, unittest, unittest.mock

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

    def test_a_pool_pin_yields_when_its_account_is_depleted(self):
        r = resolved(state_v2(pool_pin="d", seat="b"))
        self.assertEqual((r.account.id, r.reason, r.shadowed), ("b", "seat", ("d", "depleted")))

    def test_a_pool_pin_yields_on_needs_reauth(self):
        r = resolved(state_v2(pool_pin="e", seat="b"))
        self.assertEqual((r.account.id, r.reason), ("b", "seat"))

    def test_a_pool_pin_yields_when_its_account_is_in_cooldown(self):
        r = resolved(state_v2(pool_pin="c", seat="b", cooldowns={"c": NOW + 60}))
        self.assertEqual((r.account.id, r.reason, r.shadowed), ("b", "seat", ("c", "cooldown")))

    def test_a_pool_pin_yields_when_its_account_is_limited(self):
        r = resolved(state_v2(pool_pin="c", seat="b"), limited({"c": NOW + 3600}))
        self.assertEqual((r.account.id, r.reason, r.shadowed), ("b", "seat", ("c", "limited")))

    def test_a_depleted_session_pin_falls_through_to_a_usable_pool_pin(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "d", "at": NOW}}, pool_pin="c", seat="b"))
        self.assertEqual((r.account.id, r.reason, r.shadowed), ("c", "pool_pin", ("d", "depleted")))


def limited(limits, accounts=ALL):
    """ALL with `pi-pool limited` records applied, as vend() applies them."""
    state = {"providers": {"anthropic": {"limits": {k: {"until": t, "at": NOW} for k, t in limits.items()}}}}
    return vend.with_pool_state(accounts, state, "anthropic")


class LimitedByThe429(unittest.TestCase):
    """A 429 recorded by `pi-pool limited` makes every pin yield until it expires.
    Fall-through order: session pin, pool pin, seat, best score, last resort."""

    def test_a_limited_account_reports_limited_with_its_countdown(self):
        a = limited({"a": NOW + 7200})[0]
        self.assertEqual(vend.unusable_reason(a, {}, CFG, NOW), "limited")
        self.assertEqual(vend.format_reason(a, {}, CFG, NOW), "limited 2h0m")

    def test_an_expired_limit_does_not_block(self):
        a = limited({"a": NOW - 1})[0]
        self.assertIsNone(vend.unusable_reason(a, {}, CFG, NOW))

    def test_a_limited_session_pin_yields_to_the_pool_pin(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "a", "at": NOW}}, pool_pin="c", seat="b"),
                     limited({"a": NOW + 60}))
        self.assertEqual((r.account.id, r.reason, r.shadowed), ("c", "pool_pin", ("a", "limited")))

    def test_a_forced_session_pin_yields_to_limited(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "a", "at": NOW, "force": True}}, seat="b"),
                     limited({"a": NOW + 60}))
        self.assertEqual((r.account.id, r.reason, r.shadowed), ("b", "seat", ("a", "limited")))

    def test_a_forced_session_pin_still_holds_a_depleted_account(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "d", "at": NOW, "force": True}}, seat="b"),
                     limited({"a": NOW + 60}))
        self.assertEqual((r.account.id, r.reason), ("d", "session_pin"))

    def test_a_limited_seat_moves_to_the_best_score(self):
        r = resolved(state_v2(seat="a"), limited({"a": NOW + 60}))
        self.assertEqual((r.account.id, r.reason), ("b", "seat_move"))

    def test_session_pin_then_pool_pin_then_seat_then_best_score(self):
        state = state_v2(pins={"anthropic": {"account_id": "a", "at": NOW}}, pool_pin="b", seat="c")
        steps = [({}, "a", "session_pin"), ({"a": NOW + 60}, "b", "pool_pin"),
                 ({"a": NOW + 60, "b": NOW + 60}, "c", "seat")]
        for limits, want, reason in steps:
            r = resolved(state, limited(limits))
            self.assertEqual((r.account.id, r.reason), (want, reason), limits)
        accounts = limited({"a": NOW + 60, "b": NOW + 60, "c": NOW + 60}) + [account("f", "f@x", session_pct=50)]
        r = resolved(state, accounts)
        self.assertEqual((r.account.id, r.reason, r.shadowed), ("f", "seat_move", ("a", "limited")))

    def test_with_everything_limited_the_last_resort_is_the_soonest_reset(self):
        accounts = limited({"a": NOW + 7200, "b": NOW + 600, "c": NOW + 3600}, [A, B, C])
        self.assertIsNone(resolved(state_v2(seat="a"), accounts))
        self.assertEqual(vend.last_resort(accounts, {}, CFG, NOW).id, "b")

    def test_the_last_resort_prefers_a_depleted_account_the_provider_still_serves(self):
        # 2026-10-08: sieun@virev.ai 429'd until 19:30, sieunpark77 at 85% of its 5h
        # window (cutoff 85) resetting 20:10. The 429'd account must not win.
        cfg = dict(CFG, five_hour_max_pct=85)
        win = {"usedPercentage": 85, "windowSeconds": 18000, "resetsAt": (NOW + 9000) * 1000,
               "sampledAt": NOW * 1000}
        near = dataclasses.replace(account("n", "n@x", session_pct=85, weekly_pct=86), windows=(win,))
        full = dataclasses.replace(account("w", "w@x", weekly_pct=100),
                                   windows=(dict(win, usedPercentage=100, windowSeconds=604800,
                                                 resetsAt=(NOW + 90000) * 1000),))
        [hit] = limited({"a": NOW + 600}, [account("a", "a@x", session_pct=100)])
        self.assertEqual(vend.last_resort([hit, near, full], {}, cfg, NOW).id, "n")
        self.assertEqual(vend.last_resort([hit, full], {}, cfg, NOW).id, "a")

    def test_set_limit_keeps_the_latest_reset_and_prune_drops_it_when_it_passes(self):
        state = state_v2()
        writer = vend.HookWriter(state)
        writer.set_limit("anthropic", "a", NOW + 600, KEY, NOW)
        writer.set_limit("anthropic", "a", NOW + 60, KEY, NOW)
        self.assertEqual(state["providers"]["anthropic"]["limits"]["a"]["until"], NOW + 600)
        self.assertFalse(writer.prune(CFG, NOW + 599))
        self.assertTrue(writer.prune(CFG, NOW + 600))
        self.assertEqual(state["providers"]["anthropic"]["limits"], {})

    def test_an_ls_row_carries_the_limit(self):
        row = vend.build_rows(limited({"a": NOW + 600}, [A]), vend.Intent(), {}, {}, CFG, NOW, None, None)[0]
        self.assertEqual((row["usable"], row["reason"], row["limited_until"]), (False, "limited 10m", NOW + 600))

    def test_a_v2_state_without_limits_gains_an_empty_map(self):
        raw = {"version": 2, "providers": {"anthropic": {"pin": None, "seat": None, "cooldowns": {}}}, "sessions": {}}
        out = vend.migrate(raw, {}, NOW)
        self.assertEqual((out["providers"]["anthropic"]["limits"], out["providers"]["openai-codex"]["limits"]), ({}, {}))


class Fallbacks(unittest.TestCase):
    def test_a_cooling_seat_moves(self):
        r = resolved(state_v2(seat="b", cooldowns={"b": NOW + 60}))
        self.assertEqual((r.account.id, r.reason), ("a", "seat_move"))

    def test_a_missing_pin_account_yields(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "gone", "at": NOW}}, seat="b"))
        self.assertEqual((r.account.id, r.shadowed), ("b", ("gone", "missing")))

    def test_no_usable_account_resolves_to_nothing(self):
        self.assertIsNone(resolved(state_v2(), [DEPLETED, BROKEN]))

    def test_last_resort_is_the_depleted_account_that_resets_first(self):
        def win(pct, secs, resets_at):
            return {"usedPercentage": pct, "windowSeconds": secs, "resetsAt": resets_at * 1000,
                    "sampledAt": NOW * 1000}
        late = dataclasses.replace(DEPLETED, id="late", email="late@x",
                                   windows=(win(99, 18000, NOW + 7000),))
        soon = dataclasses.replace(DEPLETED, id="soon", email="soon@x",
                                   windows=(win(99, 18000, NOW + 600),))
        weekly = dataclasses.replace(DEPLETED, id="wk", email="wk@x", session_pct=0, weekly_pct=100,
                                     windows=(win(0, 18000, NOW + 100), win(100, 604800, NOW + 90000)))
        refused = dataclasses.replace(DEPLETED, id="ref", email="ref@x",
                                      windows=(win(99, 18000, NOW + 10),))
        pool = [late, soon, weekly, refused, BROKEN]
        pick = vend.last_resort(pool, {"ref": NOW + 3600}, CFG, NOW)
        self.assertEqual(pick.id, "soon")
        self.assertEqual(vend.account_free_at(weekly, CFG, NOW), NOW + 90000)
        self.assertIsNone(vend.last_resort([BROKEN], {}, CFG, NOW))
        self.assertIsNone(vend.last_resort([refused], {"ref": NOW + 3600}, CFG, NOW))

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
        w.record_vend(KEY, "anthropic", B, "parked", "seat", None, NOW, (123, "parent-start"))
        w.record_vend(KEY, "anthropic", B, "parked", "seat", None, NOW + 1, (123, "parent-start"))
        self.assertEqual(state["sessions"][KEY.key]["vends"]["anthropic"]["n"], 2)
        w.record_vend(KEY, "anthropic", A, "parked", "seat_move", ("d", "depleted"), NOW + 2, (123, "parent-start"))
        vended = state["sessions"][KEY.key]["vends"]["anthropic"]
        self.assertEqual((vended["account_id"], vended["n"], vended["shadowed"]), ("a", 1, ["d", "depleted"]))

    def test_the_cli_writes_a_pin_without_touching_a_vend(self):
        state = state_v2(seat="b")
        vend.HookWriter(state).record_vend(KEY, "anthropic", B, "parked", "seat", None, NOW, (123, "parent-start"))
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
        vended = vend.HookWriter(state).record_vend(KEY, "anthropic", B, "parked", "seat", None, NOW, (123, "parent-start"))
        self.assertIs(vended, state["sessions"][KEY.key]["vends"]["anthropic"])


class SessionVend(unittest.TestCase):
    def test_session_credential_is_emitted_and_parent_is_read_outside_pool_lock(self):
        for provider in ("anthropic", "openai-codex"):
            with self.subTest(provider=provider):
                state = state_v2()
                acct = B if provider == "anthropic" else codex_account("b", "b@x", "pro")
                state["providers"][provider]["seat"] = {"account_id": acct.id, "since": NOW}
                held = []

                @contextlib.contextmanager
                def lock(*args, **kwargs):
                    held.append(True)
                    try:
                        yield
                    finally:
                        held.pop()

                def parent_info(pid):
                    self.assertFalse(held, "process lookup must not block other token requests")
                    return {"start": "parent-start"}

                output = io.StringIO()
                with contextlib.ExitStack() as stack:
                    for name, value in {"config": CFG, "load_index": [acct], "session_key": KEY,
                                        "load_state": state, "credential_for": ("fixture-token", "store")}.items():
                        stack.enter_context(unittest.mock.patch.object(vend, name, return_value=value))
                    stack.enter_context(unittest.mock.patch.object(vend, "Flock", lock))
                    stack.enter_context(unittest.mock.patch.object(vend, "proc_info", side_effect=parent_info))
                    stack.enter_context(unittest.mock.patch.object(vend.os, "getppid", return_value=123))
                    stack.enter_context(unittest.mock.patch.object(vend.time, "time", return_value=NOW))
                    stack.enter_context(unittest.mock.patch.object(vend, "save_json"))
                    stack.enter_context(unittest.mock.patch.object(vend, "log"))
                    stack.enter_context(contextlib.redirect_stdout(output))
                    vend.vend(provider)
                self.assertEqual(output.getvalue(), "fixture-token")
                rec = state["sessions"][KEY.key]
                self.assertEqual((rec["pid"], rec["pid_start"]), (123, "parent-start"))
                self.assertEqual(rec["vends"][provider]["account_id"], acct.id)


class BusyPoolLock(unittest.TestCase):
    """A request whose pool flock times out keeps the session's last account."""

    def vended_state(self, account_id="b", limits=None, cooldowns=None, disabled=None):
        state = state_v2(cooldowns=cooldowns)
        prov = state["providers"]["anthropic"]
        prov["limits"], prov["disabled"] = limits or {}, disabled or {}
        state["sessions"][KEY.key]["vends"]["anthropic"] = {"account_id": account_id, "email": "b@x", "at": NOW - 5, "n": 3}
        return state

    def run_vend(self, state, busy_calls, key=KEY, accounts=(A, B)):
        calls, logged, saved = [], [], []

        @contextlib.contextmanager
        def lock(*args, **kwargs):
            calls.append(True)
            if len(calls) in busy_calls:
                raise TimeoutError("could not lock pool")
            yield

        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            for name, value in {"config": CFG, "load_index": list(accounts), "session_key": key,
                                "load_state": state, "load_json": state,
                                "credential_for": ("fixture-token", "store"), "proc_info": {"start": "s"}}.items():
                stack.enter_context(unittest.mock.patch.object(vend, name, return_value=value))
            stack.enter_context(unittest.mock.patch.object(vend, "Flock", lock))
            stack.enter_context(unittest.mock.patch.object(vend.time, "time", return_value=NOW))
            stack.enter_context(unittest.mock.patch.object(vend, "save_json", side_effect=lambda *a: saved.append(a)))
            stack.enter_context(unittest.mock.patch.object(vend, "log", side_effect=lambda e, **kw: logged.append((e, kw))))
            stack.enter_context(contextlib.redirect_stdout(output))
            vend.vend("anthropic")
        return output.getvalue(), logged, saved

    def test_a_busy_lock_serves_the_last_vended_account_and_logs_it(self):
        out, logged, saved = self.run_vend(self.vended_state(), busy_calls={1})
        self.assertEqual(out, "fixture-token")
        self.assertEqual(logged, [("vend_lock_busy", {"provider": "anthropic", "account": "b@x",
                                                      "source": "store", "session": KEY.key})])
        self.assertEqual(saved, [])

    def test_a_busy_lock_refuses_a_last_account_that_cannot_serve(self):
        cases = {"limited": self.vended_state(limits={"b": {"until": NOW + 600, "at": NOW}}),
                 "cooldown": self.vended_state(cooldowns={"b": NOW + 600}),
                 "disabled": self.vended_state(disabled={"b": NOW}),
                 "gone from the index": self.vended_state(account_id="zz")}
        for why, state in cases.items():
            with self.subTest(why=why), self.assertRaises(TimeoutError):
                self.run_vend(state, busy_calls={1})
        with self.assertRaises(TimeoutError):
            self.run_vend(self.vended_state(account_id="e"), busy_calls={1}, accounts=(A, BROKEN))

    def test_a_busy_lock_with_no_vend_on_file_still_fails(self):
        with self.assertRaises(TimeoutError):
            self.run_vend(state_v2(), busy_calls={1})
        with self.assertRaises(TimeoutError):
            self.run_vend(self.vended_state(), busy_calls={1}, key=None)

    def test_an_expired_limit_does_not_stop_the_busy_lock_path(self):
        out, _, _ = self.run_vend(self.vended_state(limits={"b": {"until": NOW - 1, "at": NOW - 600}}), busy_calls={1})
        self.assertEqual(out, "fixture-token")

    def test_a_busy_lock_at_record_time_still_emits_the_token(self):
        state = self.vended_state()
        state["providers"]["anthropic"]["seat"] = {"account_id": "b", "since": NOW}
        out, logged, saved = self.run_vend(state, busy_calls={2})
        self.assertEqual(out, "fixture-token")
        self.assertIn(("vend_unrecorded", {"provider": "anthropic", "account": "b@x", "session": KEY.key}), logged)
        self.assertEqual(saved, [])


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


class ModelGatedCap(unittest.TestCase):
    """A spent Fable cap stops an account only for sessions that run Fable."""
    FABLE_SPENT = account("f", "f@x", session_pct=5, weekly_pct=75, gated_pct=100)

    def reason(self, models):
        [acct] = vend.with_models([self.FABLE_SPENT], models, CFG)
        return vend.unusable_reason(acct, {}, CFG, NOW)

    def test_opus_session_can_use_an_account_whose_fable_cap_is_spent(self):
        self.assertIsNone(self.reason(["claude-opus-5-5"]))
        self.assertIsNone(self.reason(["anthropic/claude-opus-5-5"]))

    def test_fable_or_unknown_model_keeps_the_cap(self):
        self.assertEqual(self.reason(["claude-fable-5-1"]), "depleted")
        self.assertEqual(self.reason(["claude-opus-5-5", "claude-fable-5-1"]), "depleted")
        self.assertEqual(self.reason([]), "depleted")
        self.assertEqual(self.reason(None), "depleted")

    def test_the_weekly_limit_still_depletes_an_opus_session(self):
        [acct] = vend.with_models([account("w", "w@x", weekly_pct=100)], ["claude-opus-5-5"], CFG)
        self.assertEqual(vend.unusable_reason(acct, {}, CFG, NOW), "depleted")

    def test_session_models_reads_the_tree_record(self):
        state = state_v2()
        state["sessions"][KEY.key]["models"] = {"anthropic": {
            "root": {"model": "claude-opus-5-5", "at": NOW},
            "old-child": {"model": "claude-fable-5-1", "at": NOW - CFG["pin_ttl_sec"] - 1}}}
        self.assertEqual(vend.session_models(state, KEY, "anthropic", CFG, NOW), ["claude-opus-5-5"])
        self.assertEqual(vend.session_models(state, None, "anthropic", CFG, NOW), [])

    def test_session_models_reads_a_record_filed_before_the_uuid_was_known(self):
        # A new worker records its model at session_start, before the daemon writes
        # rootSessionId, so the record sits under the short active id with no uuid.
        state = state_v2()
        state["sessions"]["35abe469e594"] = {"uuid": None, "active_id": KEY.active_id, "pins": {},
                                             "models": {"anthropic": {"01a0-uuid": {"model": "claude-opus-5-5", "at": NOW}}}}
        state["sessions"]["other-worker"] = {"uuid": None, "active_id": "ffffffffffff", "pins": {},
                                             "models": {"anthropic": {"x": {"model": "claude-fable-5-1", "at": NOW}}}}
        self.assertEqual(vend.session_models(state, KEY, "anthropic", CFG, NOW), ["claude-opus-5-5"])
        [acct] = vend.with_models([account("k", "k@x", gated_pct=100)], vend.session_models(state, KEY, "anthropic", CFG, NOW), CFG)
        self.assertIsNone(vend.unusable_reason(acct, {}, CFG, NOW))


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

    def test_consumer_terms_not_accepted_is_named(self):
        """The body Anthropic sent on 2026-10-08 for an account whose terms were pending."""
        with unittest.mock.patch.object(vend.urllib.request, "urlopen", self.raising(400, TERMS_BODY)):
            self.assertEqual(vend.anthropic_refusal("t"), vend.NEEDS_TERMS)
            self.assertEqual(vend.anthropic_refusal("t", infer=True), vend.NEEDS_TERMS)

    def test_the_terms_check_sends_a_one_token_message(self):
        sent = []
        def fake(req, timeout=None):
            sent.append((req.full_url, json.loads(req.data)))
            return contextlib.nullcontext()
        with unittest.mock.patch.object(vend.urllib.request, "urlopen", fake):
            self.assertIsNone(vend.anthropic_refusal("t", infer=True))
        self.assertEqual(sent[0][0], vend.INFER_URL)
        self.assertEqual(sent[0][1]["max_tokens"], 1)


TERMS_BODY = '{"type":"error","error":{"type":"invalid_request_error","message":"We\'ve updated our Consumer Terms and Privacy Policy. You\'ll need to accept them in claude.ai with the email in /status to continue."},"request_id":"req_011Cfpei9Q2FndKLU23sLdgU"}'


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


class LsUsageWindows(unittest.TestCase):
    """`ls --json` carries every usage window with its reset time, the tier,
    the age of the usage data and the cooldown reason, for the browser chat."""

    @staticmethod
    def windowed(windows, usage_at=NOW - 90, **kw):
        return dataclasses.replace(account("w", "w@x", **kw), tier="max 20x", windows=tuple(windows), usage_at=usage_at)

    def test_windows_come_in_display_order_with_live_reset_times(self):
        win = IndexV2Windows.win
        a = self.windowed([win(100, 604800, 3600, name="Fable"), win(61, 604800, 7200), win(7, 18000, 600)])
        row = vend.build_rows([a], vend.Intent(), {}, {}, CFG, NOW, None, None)[0]
        self.assertEqual([(w["kind"], w["label"], w["pct"], w["resets_at"]) for w in row["windows"]],
                         [("session", "5h", 7, NOW + 600), ("weekly", "week", 61, NOW + 7200), ("model", "Fable", 100, NOW + 3600)])
        self.assertEqual((row["tier"], row["usage_at"], row["usage_age_sec"]), ("max 20x", NOW - 90, 90))

    def test_a_passed_reset_reads_zero_with_no_reset_time(self):
        a = self.windowed([IndexV2Windows.win(87, 18000, -60)])
        self.assertEqual(vend.build_rows([a], vend.Intent(), {}, {}, CFG, NOW, None, None)[0]["windows"][0]["resets_at"], None)

    def test_a_thirty_day_codex_window_is_labelled_by_days(self):
        a = dataclasses.replace(codex_account("c", "c@x", "free"), windows=(IndexV2Windows.win(100, 2592000, 86400),))
        row = vend.build_rows([a], vend.Intent(), {}, {}, CFG, NOW, None, None)[0]
        self.assertEqual([w["label"] for w in row["windows"]], ["30d"])
        self.assertEqual(row["plan"], "free")

    def test_a_cooldown_carries_its_end_and_the_refusal(self):
        a = self.windowed([])
        rows = vend.build_rows([a], vend.Intent(), {}, {"w": NOW + 300, "gone": NOW - 1}, CFG, NOW, None, None,
                               {"w": "oauth not allowed for organization"})
        self.assertEqual((rows[0]["cooldown_until"], rows[0]["cooldown_reason"]), (NOW + 300, "oauth not allowed for organization"))

    def test_an_account_never_sampled_has_no_age(self):
        row = vend.build_rows([self.windowed([], usage_at=0)], vend.Intent(), {}, {}, CFG, NOW, None, None)[0]
        self.assertEqual((row["windows"], row["usage_at"], row["usage_age_sec"], row["cooldown_until"]), ([], None, None, None))


class LsNamesThePoolPin(unittest.TestCase):
    def test_ls_json_names_the_pool_pin_and_the_seat(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "state.json")
            state = state_v2(pool_pin="b", seat="a")
            vend.save_json(path, state)
            out = io.StringIO()
            with unittest.mock.patch.object(vend, "STATE", path), unittest.mock.patch.object(vend, "session_key", lambda: None), \
                 unittest.mock.patch.object(vend, "load_index", lambda provider: ALL), contextlib.redirect_stdout(out):
                self.assertEqual(vend.cmd_ls(["--json"]), 0)
            listing = json.loads(out.getvalue())
            self.assertEqual((listing["pin"], listing["seat"]), ({"id": "b", "email": "b@x"}, {"id": "a", "email": "a@x"}))


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
        return unittest.mock.patch.object(vend, "tokenmaxxing_runtime", lambda: (path, "src"))

    def run_refresh(self, *args):
        out = io.StringIO()
        with unittest.mock.patch.object(vend, "log", lambda *a, **k: None), contextlib.redirect_stdout(out):
            code = vend.cmd_refresh(list(args))
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
        self.assertEqual(report["openai-codex"], [{"id": "c", "email": "c@x", "ok": True, "reason": None, "retry_at": None, "usage_at": 1790000001}])

    def test_named_accounts_need_a_provider(self):
        code, out = self.run_refresh("--json", "a@x")
        self.assertEqual(code, 1)
        self.assertIn("--provider", json.loads(out)["error"])

    def test_named_account_is_resolved_to_its_id(self):
        seen = os.path.join(self.tmp, "args")
        account = types.SimpleNamespace(id="abc-123", email="a@x")
        with self.fake(f'echo "$@" > {seen}\necho \'{{"event":"accounts","accounts":[]}}\'\n'), \
             unittest.mock.patch.object(vend, "load_index", lambda provider: [account]):
            code, _ = self.run_refresh("--json", "--provider", "anthropic", "a@x")
        self.assertEqual(code, 0)
        with open(seen) as f:
            self.assertTrue(f.read().split()[-2:] == ["anthropic", "abc-123"])

    def test_a_read_still_running_at_the_deadline_is_reported_unfinished(self):
        events = []
        with self.fake('echo \'{"event":"accounts","accounts":[{"id":"a","email":"a@x"}]}\'\necho \'{"event":"reading","id":"a"}\'\nexec sleep 30\n'):
            errors = vend.read_usage({"anthropic": None}, events.append, timeout=3)
        self.assertEqual(errors, {})
        self.assertEqual(events[-1], {"event": "read", "provider": "anthropic", "id": "a", "email": "a@x", "ok": False,
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
        with unittest.mock.patch.object(vend, "TM", self.tmp):
            self.assertEqual(vend.tokenmaxxing_runtime(), ("/x/bun", "/y/tokenmaxxing/src"))

    def test_usage_read_loads_against_the_installed_tokenmaxxing(self):
        """Contract check: a tokenmaxxing auto-update that renames a function usage-read.ts calls fails here."""
        try:
            bun, src = vend.tokenmaxxing_runtime()
        except RuntimeError as e:
            self.skipTest(str(e))
        done = subprocess.run([bun, "--no-env-file", vend.USAGE_READ, src, "anthropic", "not-an-account"], capture_output=True, text=True,
                              timeout=60, env=dict(os.environ, TOKENMAXXING_HOME=self.tmp))
        lines = [json.loads(line) for line in done.stdout.splitlines()]
        self.assertEqual((done.returncode, lines[-1]), (0, {"event": "read", "id": "not-an-account", "ok": False, "reason": "not in the pool", "retry_at": None}))


GRANT = {"id": "opus55-launch", "label": "Launch reset", "resets_total": 1, "resets_left": 1, "starts_at": "2026-09-22T16:00:00+00:00",
         "ends_at": "2999-10-22T16:00:00+00:00", "clears": ["five_hour", "seven_day", "bogus"], "paused": False, "usable_now": True,
         "use_requires_limit": False, "percent_used": {"five_hour": 3, "seven_day": 98}}
BLOCK = {"eligible": True, "ineligible_reason": None, "at_limit": False, "grants": [GRANT], "next_grant_id": "opus55-launch",
         "weekly_resets_at": "2026-10-10T13:00:00+00:00", "cooldown_until": None}


class ResetGrants(unittest.TestCase):
    """The cedar_ember block parses strictly, and a grant is spent only when nothing blocks it."""

    def test_block_parses_and_drops_unknown_windows(self):
        status = vend.parse_grant_status(BLOCK)
        self.assertEqual(status["grants"][0]["clears"], ["five_hour", "seven_day"])
        self.assertEqual(status["next_grant_id"], "opus55-launch")
        self.assertIsNone(vend.grant_blocker(status, "opus55-launch", time.time()))
        self.assertEqual(vend.pick_grant(status, time.time())["id"], "opus55-launch")

    def test_one_bad_grant_rejects_the_block(self):
        for bad in ({"resets_left": 2}, {"id": "Bad Id"}, {"ends_at": "soon"}, {"usable_now": "yes"}):
            self.assertIsNone(vend.parse_grant_status({**BLOCK, "grants": [{**GRANT, **bad}]}), bad)
        self.assertIsNone(vend.parse_grant_status({**BLOCK, "grants": [GRANT, GRANT]}))
        self.assertIsNone(vend.parse_grant_status({"grants": []}))

    def test_missing_flags_default_to_refusing(self):
        grant = {k: v for k, v in GRANT.items() if k not in ("usable_now", "use_requires_limit")}
        status = vend.parse_grant_status({**BLOCK, "grants": [grant]})
        self.assertEqual(vend.grant_blocker(status, "opus55-launch", time.time()), "not_usable")
        status["grants"][0]["usable_now"] = True
        self.assertEqual(vend.grant_blocker(status, "opus55-launch", time.time()), "not_limited")

    def test_blockers(self):
        now = time.time()
        cases = {"exhausted": {"grants": [{**GRANT, "resets_left": 0}]}, "ineligible": {"eligible": False},
                 "cooldown": {"cooldown_until": "2999-01-01T00:00:00+00:00"}, "ended": {"grants": [{**GRANT, "ends_at": "2000-01-01T00:00:00Z"}]},
                 "paused": {"grants": [{**GRANT, "paused": True}]}}
        for blocker, change in cases.items():
            status = vend.parse_grant_status({**BLOCK, **change})
            self.assertEqual(vend.grant_blocker(status, "opus55-launch", now), blocker)
            self.assertIsNone(vend.pick_grant(status, now))


class ResetClaims(unittest.TestCase):
    """`pi-pool reset` journals the request id before the POST and reuses it after an unknown outcome."""

    ORG = "11111111-2222-3333-4444-555555555555"

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.account = types.SimpleNamespace(id="acc-1", email="a@x", needs_reauth=False)
        self.left, self.posts, self.answers = 1, [], []
        patches = [unittest.mock.patch.object(vend, name, os.path.join(self.tmp, file)) for name, file in
                   (("RESETS", "resets.json"), ("RESET_CLAIMS", "claims.json"), ("RESET_LOCK", "reset.lock"), ("LOCK", "lock"))]
        patches += [unittest.mock.patch.object(vend, "log", lambda *a, **k: None),
                    unittest.mock.patch.object(vend, "load_index", lambda provider: [self.account]),
                    unittest.mock.patch.object(vend, "config", lambda: {}),
                    unittest.mock.patch.object(vend, "credential_for", lambda a, cfg: ("tok", "store")),
                    unittest.mock.patch.object(vend, "anthropic_call", self.call)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def call(self, url, token, payload=None, timeout=12.0):
        if url == vend.PROFILE_URL:
            return 200, {"organization": {"uuid": self.ORG}}
        if url == vend.GRANT_STATUS_URL:
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
            code = vend.cmd_reset(["a@x", "--json", *args])
        return code, json.loads(out.getvalue())

    def claims(self):
        return vend.load_json(vend.RESET_CLAIMS, {})

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
        claims["acc-1"]["created_at"] -= vend.RESET_RETRY_SEC + 1
        vend.save_json(vend.RESET_CLAIMS, claims)
        self.left = 0
        code, out = self.reset()
        self.assertEqual((code, out["result"], len(self.posts)), (0, "reset", 1))

    def test_an_unspent_expired_claim_allows_a_new_claim(self):
        self.answers = [TimeoutError(), (200, {"result": "reset"})]
        self.reset()
        claims = self.claims()
        claims["acc-1"]["created_at"] -= vend.RESET_RETRY_SEC + 1
        vend.save_json(vend.RESET_CLAIMS, claims)
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


class DisabledAccountsNeverServe(unittest.TestCase):
    OFF = dataclasses.replace(A, disabled=True)

    def test_every_pin_yields_to_an_off_account(self):
        for intent in (vend.Intent(session_pin="a", session_pin_force=True, seat="b"),
                       vend.Intent(pool_pin="a", seat="b"), vend.Intent(seat="a")):
            res = vend.resolve(intent, [self.OFF, B], {}, {}, CFG, NOW)
            self.assertEqual(res.account.id, "b", intent)

    def test_with_pool_state_marks_only_the_named_accounts(self):
        state = {"providers": {"anthropic": {"disabled": {"a": NOW}}}}
        marked = vend.with_pool_state([A, B], state, "anthropic")
        self.assertEqual([a.disabled for a in marked], [True, False])
        self.assertEqual(vend.unusable_reason(marked[0], {}, CFG, NOW), "disabled")


class InUseCountsOnlyRecentVends(unittest.TestCase):
    def test_an_idle_session_record_does_not_count(self):
        state = {"sessions": {"s1": {"vends": {"anthropic": {"account_id": "a", "at": NOW - 10}}},
                              "s2": {"vends": {"anthropic": {"account_id": "a", "at": NOW - 7200}}}}}
        self.assertEqual(vend.in_use_counts(state, "anthropic", NOW, 3600), {"a": 1})

if __name__ == "__main__":
    unittest.main()
