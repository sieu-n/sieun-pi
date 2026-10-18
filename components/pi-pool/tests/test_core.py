"""Unit tests for the pure core of pi-pool: normalize, resolve, prune, codex
index parsing, JWT claim decoding, and ls row building. test_commands.py holds
the command tests that share these fixtures.

Run: python3 -m unittest discover -s tests   (from the pool directory)
"""
import base64, contextlib, dataclasses, importlib.util, io, json, os, sys, tempfile, time, unittest, unittest.mock, urllib.request

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
from vend.pool import base, registry, sched, session_cmds, status_view, vending  # noqa: E402

CFG = dict(base.DEFAULTS)
NOW = 1000000.0


def account(id, email, session_pct=0, weekly_pct=0, gated_pct=0, needs_reauth=False):
    return registry.Account(provider="anthropic", id=id, email=email, needs_reauth=needs_reauth,
                            session_pct=session_pct, weekly_pct=weekly_pct, gated_pct=gated_pct,
                            cred=registry.Keychain("pi-pool.anthropic." + id))


def codex_account(id, email, plan, session_pct=0, weekly_pct=0):
    return registry.Account(provider="openai-codex", id=id, email=email, needs_reauth=False,
                            session_pct=session_pct, weekly_pct=weekly_pct, gated_pct=0,
                            cred=registry.CredFile("/dev/null"), plan=plan)


A = account("a", "a@x", session_pct=10)
B = account("b", "b@x", session_pct=20)
C = account("c", "c@x", session_pct=30)
DEPLETED = account("d", "d@x", session_pct=99)
BROKEN = account("e", "e@x", needs_reauth=True)
ALL = [A, B, C, DEPLETED, BROKEN]
KEY = registry.SessionKey("01a0-uuid", "01a0-uuid", "35abe469e594")


def vend_record(account_id, at=NOW):
    return {"account_id": account_id, "email": f"{account_id}@x", "at": at, "n": 1}


def state_v2(pins=None, pool_pin=None, current=None, cooldowns=None):
    """`current` is the account KEY's session was last vended."""
    return {"version": 2,
            "providers": {"anthropic": {"pin": pool_pin, "cooldowns": cooldowns or {}},
                          "openai-codex": registry.empty_provider_state()},
            "sessions": {KEY.key: {"uuid": KEY.uuid, "active_id": KEY.active_id, "pins": pins or {},
                                   "vends": {"anthropic": vend_record(current)} if current else {},
                                   "last_seen": NOW}}}


def resolved(state, accounts=ALL, cooldowns=None, provider="anthropic"):
    """sched.decide for KEY's tree, as the hook runs it."""
    tree = sched.tree_for(state, KEY, provider)
    book = sched.book_for(state, provider, KEY, CFG, NOW)
    return sched.decide(tree, accounts, book, state["providers"][provider]["cooldowns"] if cooldowns is None else cooldowns,
                        CFG, NOW)


class Precedence(unittest.TestCase):
    """A pending pin, the pool pin, the tree's own account, then an admission."""

    def test_a_session_stays_on_its_usable_account(self):
        r = resolved(state_v2(current="b"))
        self.assertEqual((r.account.id, r.reason, r.shadowed), ("b", "stay", None))

    def test_a_new_session_is_admitted_to_the_best_account(self):
        r = resolved(state_v2())
        self.assertEqual((type(r), r.reason, r.account.id), (sched.Admit, "new", "a"))
        self.assertEqual({e for e, _ in r.scores}, {"a@x", "b@x", "c@x"})

    def test_a_pending_pin_beats_the_current_account(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "c", "at": NOW + 1}}, current="b"))
        self.assertEqual((r.account.id, r.reason), ("c", "session_pin"))

    def test_a_pin_on_an_account_that_cannot_take_the_tree_yields_and_reports_why(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "d", "at": NOW + 1}}, current="b"))
        self.assertEqual((r.account.id, r.reason, r.shadowed), ("b", "stay", ("d", "depleted")))

    def test_a_yielded_pin_is_not_written_away(self):
        state = state_v2(pins={"anthropic": {"account_id": "d", "at": NOW + 1}}, current="b")
        resolved(state)
        self.assertEqual(state["sessions"][KEY.key]["pins"]["anthropic"]["account_id"], "d")

    def test_a_pin_survives_a_resumed_session(self):
        state = state_v2(pins={"anthropic": {"account_id": "c", "at": NOW + 1}}, current="b")
        state["sessions"][KEY.key]["last_seen"] = NOW - 3600
        vending.HookWriter(state).prune(CFG, NOW)
        self.assertIn(KEY.key, state["sessions"])
        self.assertEqual(resolved(state).account.id, "c")

    def test_a_pin_older_than_the_ttl_is_pruned(self):
        state = state_v2(pins={"anthropic": {"account_id": "c", "at": NOW - 8 * 86400}}, current="b")
        state["sessions"][KEY.key]["last_seen"] = NOW - 8 * 86400
        vending.HookWriter(state).prune(CFG, NOW)
        self.assertEqual(state["sessions"], {})

    def test_a_pin_on_the_current_account_is_a_pin(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "b", "at": NOW}}, current="b"))
        self.assertEqual((r.account.id, r.reason), ("b", "session_pin"))

    def test_a_subagent_inherits_by_construction(self):
        state = state_v2(pins={"anthropic": {"account_id": "c", "at": NOW}}, current="b")
        child = registry.SessionKey(KEY.key, KEY.uuid, "ffffffffffff")
        self.assertEqual(sched.tree_for(state, child, "anthropic").pin, "c")


class CodexPlanTier(unittest.TestCase):
    """A session's current account, and only that, yields to a higher codex
    plan. It otherwise moves only when it cannot serve, so a free account taken
    while the paid account was depleted would hold the session for good - and
    the API refuses several models on a free plan."""

    FREE = codex_account("f", "free@x", "free")
    PLUS = codex_account("p", "plus@x", "plus")
    PLUS_DEPLETED = codex_account("p", "plus@x", "plus", weekly_pct=100)
    NO_PLAN = codex_account("n", "none@x", "")

    def resolve(self, accounts, current=None, pin=None):
        state = {"version": 2,
                 "providers": {"anthropic": registry.empty_provider_state(),
                               "openai-codex": registry.empty_provider_state()},
                 "sessions": {KEY.key: {
                     "uuid": KEY.uuid, "active_id": KEY.active_id,
                     "pins": {"openai-codex": {"account_id": pin, "at": NOW}} if pin else {},
                     "vends": {"openai-codex": vend_record(current)} if current else {},
                     "last_seen": NOW}}}
        return resolved(state, accounts, provider="openai-codex")

    def test_a_free_account_moves_to_a_usable_plus_account(self):
        r = self.resolve([self.FREE, self.PLUS], current="f")
        self.assertEqual((r.account.id, r.reason), ("p", "upgrade"))

    def test_a_new_session_takes_the_highest_usable_plan(self):
        r = self.resolve([self.FREE, self.PLUS])
        self.assertEqual((r.account.id, r.reason), ("p", "new"))

    def test_a_new_session_takes_the_free_account_when_no_paid_one_serves(self):
        r = self.resolve([self.FREE, self.PLUS_DEPLETED])
        self.assertEqual((r.account.id, r.reason), ("f", "new"))

    def test_a_plus_account_does_not_move_to_a_free_account(self):
        r = self.resolve([self.FREE, self.PLUS], current="p")
        self.assertEqual((r.account.id, r.reason), ("p", "stay"))

    def test_a_free_account_holds_when_the_plus_account_is_depleted(self):
        r = self.resolve([self.FREE, self.PLUS_DEPLETED], current="f")
        self.assertEqual((r.account.id, r.reason), ("f", "stay"))

    def test_an_unknown_plan_ranks_as_free(self):
        r = self.resolve([self.NO_PLAN, self.PLUS], current="n")
        self.assertEqual((r.account.id, r.reason), ("p", "upgrade"))

    def test_anthropic_has_no_plan_field_so_the_rule_never_fires(self):
        self.assertEqual(resolved(state_v2(current="b")).reason, "stay")

    def test_the_plan_is_on_a_codex_row_and_absent_from_an_anthropic_one(self):
        codex = status_view.build_rows([self.PLUS], sched.Tree(), sched.Book(), {}, CFG, NOW)
        anthropic = status_view.build_rows([A], sched.Tree(), sched.Book(), {}, CFG, NOW)
        self.assertEqual(codex[0]["plan"], "plus")
        self.assertNotIn("plan", anthropic[0])


class PoolPin(unittest.TestCase):
    def test_a_pool_pin_beats_the_current_account(self):
        r = resolved(state_v2(pool_pin="c", current="b"))
        self.assertEqual((r.account.id, r.reason), ("c", "pool_pin"))

    def test_a_session_pin_beats_a_pool_pin(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "a", "at": NOW}}, pool_pin="c"))
        self.assertEqual((r.account.id, r.reason), ("a", "session_pin"))

    def test_a_pool_pin_yields_when_its_account_is_depleted(self):
        r = resolved(state_v2(pool_pin="d", current="b"))
        self.assertEqual((r.account.id, r.reason, r.shadowed), ("b", "stay", ("d", "depleted")))

    def test_a_pool_pin_yields_on_needs_reauth(self):
        r = resolved(state_v2(pool_pin="e", current="b"))
        self.assertEqual((r.account.id, r.reason), ("b", "stay"))

    def test_a_pool_pin_yields_when_its_account_is_in_cooldown(self):
        r = resolved(state_v2(pool_pin="c", current="b", cooldowns={"c": NOW + 60}))
        self.assertEqual((r.account.id, r.reason, r.shadowed), ("b", "stay", ("c", "cooldown")))

    def test_a_pool_pin_yields_when_its_account_is_limited(self):
        r = resolved(state_v2(pool_pin="c", current="b"), limited({"c": NOW + 3600}))
        self.assertEqual((r.account.id, r.reason, r.shadowed), ("b", "stay", ("c", "limited")))

    def test_a_depleted_session_pin_falls_through_to_a_usable_pool_pin(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "d", "at": NOW + 1}}, pool_pin="c", current="b"))
        self.assertEqual((r.account.id, r.reason, r.shadowed), ("c", "pool_pin", ("d", "depleted")))


def limited(limits, accounts=ALL):
    """ALL with `pi-pool limited` records applied, as vend() applies them."""
    state = {"providers": {"anthropic": {"limits": {k: {"until": t, "at": NOW} for k, t in limits.items()}}}}
    return registry.with_pool_state(accounts, state, "anthropic")


class LimitedByThe429(unittest.TestCase):
    """A 429 recorded by `pi-pool limited` makes every pin and the tree's own
    account yield until it expires."""

    def test_a_limited_account_reports_limited_with_its_countdown(self):
        a = limited({"a": NOW + 7200})[0]
        self.assertEqual(sched.admit_reason(a, {}, CFG, NOW), "limited")
        self.assertEqual(sched.format_reason(a, {}, CFG, NOW), "limited 2h0m")

    def test_an_expired_limit_does_not_block(self):
        a = limited({"a": NOW - 1})[0]
        self.assertIsNone(sched.admit_reason(a, {}, CFG, NOW))

    def test_a_limited_session_pin_yields_to_the_pool_pin(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "a", "at": NOW + 1}}, pool_pin="c", current="b"),
                     limited({"a": NOW + 60}))
        self.assertEqual((r.account.id, r.reason, r.shadowed), ("c", "pool_pin", ("a", "limited")))

    def test_a_limited_current_account_moves(self):
        r = resolved(state_v2(current="a"), limited({"a": NOW + 60}))
        self.assertEqual((r.reason, r.left), ("switch", ("a", "limited")))
        self.assertIn(r.account.id, {"b", "c"})

    def test_with_everything_limited_the_tree_waits_for_the_first_reset(self):
        accounts = limited({"a": NOW + 7200, "b": NOW + 600, "c": NOW + 3600}, [A, B, C])
        r = resolved(state_v2(current="a"), accounts)
        self.assertEqual((type(r), r.slot_account.id, r.slot_at, r.vend.id), (sched.Wait, "b", NOW + 600, "a"))

    def test_set_limit_keeps_the_latest_reset_and_prune_drops_it_when_it_passes(self):
        state = state_v2()
        writer = vending.HookWriter(state)
        writer.set_limit("anthropic", "a", NOW + 600, KEY, NOW)
        writer.set_limit("anthropic", "a", NOW + 60, KEY, NOW)
        self.assertEqual(state["providers"]["anthropic"]["limits"]["a"]["until"], NOW + 600)
        self.assertFalse(writer.prune(CFG, NOW + 599))
        self.assertTrue(writer.prune(CFG, NOW + 600))
        self.assertEqual(state["providers"]["anthropic"]["limits"], {})

    def test_an_ls_row_carries_the_limit(self):
        row = status_view.build_rows(limited({"a": NOW + 600}, [A]), sched.Tree(), sched.Book(), {}, CFG, NOW)[0]
        self.assertEqual((row["usable"], row["reason"], row["limited_until"]), (False, "limited 10m", NOW + 600))


class Fallbacks(unittest.TestCase):
    def test_a_cooling_current_account_moves(self):
        r = resolved(state_v2(current="b", cooldowns={"b": NOW + 60}))
        self.assertEqual((r.reason, r.left), ("switch", ("b", "cooldown")))
        self.assertIn(r.account.id, {"a", "c"})

    def test_a_missing_pin_account_yields(self):
        r = resolved(state_v2(pins={"anthropic": {"account_id": "gone", "at": NOW + 1}}, current="b"))
        self.assertEqual((r.account.id, r.shadowed), ("b", ("gone", "missing")))

    def test_no_account_that_can_ever_serve_resolves_to_nothing(self):
        self.assertIsNone(resolved(state_v2(), [BROKEN]))

    def test_a_dead_login_is_never_waited_on(self):
        r = resolved(state_v2(current="e"), [DEPLETED, BROKEN])
        self.assertIsNone(r)


class Normalize(unittest.TestCase):
    def test_a_file_that_is_not_v2_starts_empty_with_both_providers(self):
        out = registry.normalize({"pin": "a@x", "cooldowns": {"c": NOW + 60}}, NOW)
        self.assertEqual((out["sessions"], sorted(out["providers"])), ({}, ["anthropic", "openai-codex"]))
        self.assertEqual(out["providers"]["anthropic"], registry.empty_provider_state())

    def test_normalizing_twice_changes_nothing(self):
        once = registry.normalize({}, NOW)
        self.assertEqual(registry.normalize(json.loads(json.dumps(once)), NOW), once)


class Writers(unittest.TestCase):
    def test_the_hook_records_a_vend_and_counts_repeats(self):
        state = state_v2()
        w = vending.HookWriter(state)
        w.record_vend(KEY, "anthropic", B, "parked", "stay", None, NOW, (123, "parent-start"))
        w.record_vend(KEY, "anthropic", B, "parked", "stay", None, NOW + 1, (123, "parent-start"))
        self.assertEqual(state["sessions"][KEY.key]["vends"]["anthropic"]["n"], 2)
        w.record_vend(KEY, "anthropic", A, "parked", "switch", ("d", "depleted"), NOW + 2, (123, "parent-start"))
        vended = state["sessions"][KEY.key]["vends"]["anthropic"]
        self.assertEqual((vended["account_id"], vended["n"], vended["shadowed"]), ("a", 1, ["d", "depleted"]))

    def test_the_cli_writes_a_pin_without_touching_a_vend(self):
        state = state_v2(current="b")
        vending.HookWriter(state).record_vend(KEY, "anthropic", B, "parked", "stay", None, NOW, (123, "parent-start"))
        vending.IntentWriter(state).set_pin(KEY, "anthropic", "c", "cli", NOW)
        rec = state["sessions"][KEY.key]
        self.assertEqual(rec["pins"]["anthropic"]["account_id"], "c")
        self.assertEqual(rec["vends"]["anthropic"]["account_id"], "b")

    def test_setting_the_same_pin_twice_is_the_same_state(self):
        state = state_v2()
        vending.IntentWriter(state).set_pin(KEY, "anthropic", "c", "cli", NOW)
        first = repr(state)
        vending.IntentWriter(state).set_pin(KEY, "anthropic", "c", "cli", NOW)
        self.assertEqual(repr(state), first)

    def test_following_the_pool_removes_only_the_pin(self):
        state = state_v2(pins={"anthropic": {"account_id": "c", "at": NOW},
                               "openai-codex": {"account_id": "z", "at": NOW}})
        vending.IntentWriter(state).clear_pin(KEY, "anthropic")
        self.assertEqual(list(state["sessions"][KEY.key]["pins"]), ["openai-codex"])

    def test_an_expired_cooldown_is_pruned(self):
        state = state_v2(cooldowns={"a": NOW - 1, "b": NOW + 60})
        vending.HookWriter(state).prune(CFG, NOW)
        self.assertEqual(state["providers"]["anthropic"]["cooldowns"], {"b": NOW + 60})

    def test_pruning_nothing_reports_no_change(self):
        state = state_v2(cooldowns={"b": NOW + 60})
        self.assertFalse(vending.HookWriter(state).prune(CFG, NOW))

    def test_pruning_reports_a_change(self):
        state = state_v2(cooldowns={"a": NOW - 1})
        self.assertTrue(vending.HookWriter(state).prune(CFG, NOW))

    def test_record_vend_returns_the_record_it_wrote(self):
        state = state_v2()
        vended = vending.HookWriter(state).record_vend(KEY, "anthropic", B, "parked", "stay", None, NOW, (123, "parent-start"))
        self.assertIs(vended, state["sessions"][KEY.key]["vends"]["anthropic"])


class SessionVend(unittest.TestCase):
    def test_session_credential_is_emitted_and_parent_is_read_outside_pool_lock(self):
        for provider in ("anthropic", "openai-codex"):
            with self.subTest(provider=provider):
                state = state_v2()
                acct = B if provider == "anthropic" else codex_account("b", "b@x", "pro")
                state["sessions"][KEY.key]["vends"][provider] = vend_record(acct.id)
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
                    for module, name, value in ((base, "config", CFG), (registry, "load_index", [acct]),
                                                (registry, "session_key", KEY), (registry, "load_state", state),
                                                (vending, "credential_for", ("fixture-token", "store"))):
                        stack.enter_context(unittest.mock.patch.object(module, name, return_value=value))
                    stack.enter_context(unittest.mock.patch.object(base, "Flock", lock))
                    stack.enter_context(unittest.mock.patch.object(base, "proc_info", side_effect=parent_info))
                    stack.enter_context(unittest.mock.patch.object(os, "getppid", return_value=123))
                    stack.enter_context(unittest.mock.patch.object(time, "time", return_value=NOW))
                    stack.enter_context(unittest.mock.patch.object(base, "save_json"))
                    stack.enter_context(unittest.mock.patch.object(base, "log"))
                    stack.enter_context(contextlib.redirect_stdout(output))
                    vending.vend(provider)
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

    def run_vend(self, state, busy_calls, key=KEY, accounts=(A, B), credential=None, calls=None):
        calls, logged, saved = [] if calls is None else calls, [], []

        @contextlib.contextmanager
        def lock(*args, **kwargs):
            calls.append(True)
            if len(calls) in busy_calls:
                raise TimeoutError("could not lock pool")
            yield

        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            for module, name, value in ((base, "config", CFG), (registry, "load_index", list(accounts)),
                                        (registry, "session_key", key), (registry, "load_state", state),
                                        (base, "load_json", state), (base, "proc_info", {"start": "s"})):
                stack.enter_context(unittest.mock.patch.object(module, name, return_value=value))
            stack.enter_context(unittest.mock.patch.object(vending, "credential_for",
                                                           side_effect=credential or (lambda a, cfg, refresh=True: ("fixture-token", "store"))))
            stack.enter_context(unittest.mock.patch.object(base, "anthropic_refusal", return_value=None))
            stack.enter_context(unittest.mock.patch.object(base, "Flock", lock))
            stack.enter_context(unittest.mock.patch.object(time, "time", return_value=NOW))
            stack.enter_context(unittest.mock.patch.object(base, "save_json", side_effect=lambda *a: saved.append(a)))
            stack.enter_context(unittest.mock.patch.object(base, "log", side_effect=lambda e, **kw: logged.append((e, kw))))
            stack.enter_context(contextlib.redirect_stdout(output))
            vending.vend("anthropic")
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
        refreshing = lambda a, cfg, refresh=True: ("fixture-token", "refreshed") if refresh else None
        out, logged, saved = self.run_vend(self.vended_state(), busy_calls={2}, credential=refreshing)
        self.assertEqual(out, "fixture-token")
        self.assertIn(("vend_unrecorded", {"provider": "anthropic", "account": "b@x", "session": KEY.key}), logged)
        self.assertEqual(saved, [])



class OneHoldStay(unittest.TestCase):
    """us-metal02, 10-18 08:23 to 08:33Z: the pool flock was held 91% of the time and 23 hooks gave up after
    STATE_LOCK_TIMEOUT, because every vend read and wrote the 2.7 MB state.json under two holds."""

    def setUp(self):
        self.busy = BusyPoolLock()

    def test_a_stay_with_a_file_credential_takes_the_flock_once_and_records_the_vend(self):
        calls, state = [], self.busy.vended_state()
        with unittest.mock.patch.object(base, "FILE_SECRETS", True):
            out, logged, saved = self.busy.run_vend(state, busy_calls=set(), calls=calls)
        self.assertEqual((out, len(calls), len(saved)), ("fixture-token", 1, 1))
        vend = state["sessions"][KEY.key]["vends"]["anthropic"]
        self.assertEqual((vend["account_id"], vend["n"], vend["at"], vend["source"]), ("b", 4, NOW, "store"))
        self.assertEqual(logged, [])

    def test_a_stay_that_needs_a_refresh_or_a_keychain_read_keeps_the_two_holds(self):
        refreshing = lambda a, cfg, refresh=True: ("fixture-token", "refreshed") if refresh else None
        for why, secrets, credential in (("refresh", True, refreshing), ("keychain", False, None)):
            with self.subTest(why=why), unittest.mock.patch.object(base, "FILE_SECRETS", secrets):
                calls, state = [], self.busy.vended_state()
                out, _, saved = self.busy.run_vend(state, busy_calls=set(), credential=credential, calls=calls)
                self.assertEqual((out, len(calls), len(saved)), ("fixture-token", 2, 1))
                self.assertEqual(state["sessions"][KEY.key]["vends"]["anthropic"]["n"], 4)

    def test_a_switch_keeps_the_two_holds(self):
        calls, state = [], self.busy.vended_state(account_id="b", cooldowns={"b": NOW + 600})
        with unittest.mock.patch.object(base, "FILE_SECRETS", True):
            out, _, _ = self.busy.run_vend(state, busy_calls=set(), calls=calls)
        self.assertEqual((out, len(calls)), ("fixture-token", 2))
        self.assertEqual(state["sessions"][KEY.key]["vends"]["anthropic"]["account_id"], "a")

class IndexWindows(unittest.TestCase):
    """Index windows, classified by windowSeconds and name
    rather than array position, for both providers."""

    @staticmethod
    def win(pct, secs, reset_in=None, name=None, sampled=NOW):
        return {"name": name, "usedPercentage": pct, "windowSeconds": secs, "sampledAt": sampled * 1000,
                "resetsAt": None if reset_in is None else (NOW + reset_in) * 1000}

    def test_a_plan_with_only_a_thirty_day_window_has_no_session_bar(self):
        acct = {"windows": [self.win(40, 2592000, 2592000)]}
        self.assertEqual(registry.usage_pct(acct, NOW), (0, 40))

    def test_a_five_hour_and_weekly_pair_is_classified_by_window_seconds(self):
        acct = {"windows": [self.win(100, 604800, 604800), self.win(12, 18000, 18000)]}
        self.assertEqual(registry.usage_pct(acct, NOW), (12, 100))

    def test_a_passed_reset_self_heals_to_zero(self):
        acct = {"windows": [self.win(87, 18000, -60)]}
        self.assertEqual(registry.usage_pct(acct, NOW), (0, 0))

    def test_a_null_reset_expires_after_its_own_window(self):
        acct = {"windows": [self.win(87, 18000, None, sampled=NOW - 18001)]}
        self.assertEqual(registry.usage_pct(acct, NOW), (0, 0))

    def test_named_windows_feed_only_the_gated_cap(self):
        acct = {"windows": [self.win(5, 18000, 100), self.win(10, 604800, 100),
                            self.win(100, 604800, 100, name="Fable"), self.win(70, 604800, 100, name="Sonnet")]}
        self.assertEqual(registry.usage_pct(acct, NOW), (5, 10))
        self.assertEqual(registry.gated_pct(acct, CFG, NOW), 100)
        self.assertEqual(registry.gated_pct(acct, dict(CFG, switch_models=["opus"]), NOW), 0)


class ModelGatedCap(unittest.TestCase):
    """A spent Fable cap stops an account only for sessions that run Fable."""
    FABLE_SPENT = account("f", "f@x", session_pct=5, weekly_pct=75, gated_pct=100)

    def reason(self, models):
        [acct] = registry.with_models([self.FABLE_SPENT], models, CFG)
        return sched.admit_reason(acct, {}, CFG, NOW)

    def test_opus_session_can_use_an_account_whose_fable_cap_is_spent(self):
        self.assertIsNone(self.reason(["claude-opus-5-5"]))
        self.assertIsNone(self.reason(["anthropic/claude-opus-5-5"]))

    def test_fable_or_unknown_model_keeps_the_cap(self):
        self.assertEqual(self.reason(["claude-fable-5-1"]), "depleted")
        self.assertEqual(self.reason(["claude-opus-5-5", "claude-fable-5-1"]), "depleted")
        self.assertEqual(self.reason([]), "depleted")
        self.assertEqual(self.reason(None), "depleted")

    def test_the_weekly_limit_still_depletes_an_opus_session(self):
        [acct] = registry.with_models([account("w", "w@x", weekly_pct=100)], ["claude-opus-5-5"], CFG)
        self.assertEqual(sched.admit_reason(acct, {}, CFG, NOW), "depleted")

    def test_session_models_reads_the_tree_record(self):
        state = state_v2()
        state["sessions"][KEY.key]["models"] = {"anthropic": {
            "root": {"model": "claude-opus-5-5", "at": NOW},
            "old-child": {"model": "claude-fable-5-1", "at": NOW - CFG["pin_ttl_sec"] - 1}}}
        self.assertEqual(registry.session_models(state, KEY, "anthropic", CFG, NOW), ["claude-opus-5-5"])
        self.assertEqual(registry.session_models(state, None, "anthropic", CFG, NOW), [])

    def test_session_models_reads_a_record_filed_before_the_uuid_was_known(self):
        # A new worker records its model at session_start, before the daemon writes
        # rootSessionId, so the record sits under the short active id with no uuid.
        state = state_v2()
        state["sessions"]["35abe469e594"] = {"uuid": None, "active_id": KEY.active_id, "pins": {},
                                             "models": {"anthropic": {"01a0-uuid": {"model": "claude-opus-5-5", "at": NOW}}}}
        state["sessions"]["other-worker"] = {"uuid": None, "active_id": "ffffffffffff", "pins": {},
                                             "models": {"anthropic": {"x": {"model": "claude-fable-5-1", "at": NOW}}}}
        self.assertEqual(registry.session_models(state, KEY, "anthropic", CFG, NOW), ["claude-opus-5-5"])
        [acct] = registry.with_models([account("k", "k@x", gated_pct=100)], registry.session_models(state, KEY, "anthropic", CFG, NOW), CFG)
        self.assertIsNone(sched.admit_reason(acct, {}, CFG, NOW))


class StoreLayout(unittest.TestCase):
    """The account store: one index per provider in the pool folder."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        index = os.path.join(self.tmp.name, "anthropic.json")
        for patch in (unittest.mock.patch.dict(base.INDEX, {"anthropic": index}),
                      unittest.mock.patch.object(base, "ACCOUNTS", self.tmp.name)):
            patch.start()
            self.addCleanup(patch.stop)
        self.index = index

    def test_each_account_has_its_own_keychain_service(self):
        self.assertEqual(base.claude_service("382bc870-8dc4-484d"), "pi-pool.anthropic.382bc870-8dc4-484d")

    def test_a_missing_index_is_an_empty_pool(self):
        self.assertEqual(base.read_index("anthropic")["accounts"], [])

    def test_a_foreign_index_is_refused(self):
        with open(self.index, "w") as f:
            json.dump({"version": 2, "accounts": []}, f)
        with self.assertRaisesRegex(RuntimeError, "anthropic.json unreadable"):
            base.read_index("anthropic")

    def test_mark_needs_reauth_flags_one_account_and_keeps_the_rest(self):
        base.write_index("anthropic", {"version": 1, "accounts": [{"id": "a", "email": "a@x", "windows": [], "extra": 1},
                                                                  {"id": "b", "email": "b@x", "windows": []}]})
        base.mark_needs_reauth("anthropic", "a")
        with open(self.index) as f:
            out = json.load(f)
        self.assertEqual(out["accounts"][0]["needsReauth"], True)
        self.assertEqual(out["accounts"][0]["extra"], 1)
        self.assertNotIn("needsReauth", out["accounts"][1])
        self.assertEqual(os.stat(self.index).st_mode & 0o777, 0o600)


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
        with unittest.mock.patch.object(urllib.request, "urlopen", self.raising(403, body)):
            self.assertEqual(base.anthropic_refusal("t"), "oauth not allowed for organization")

    def test_a_revoked_token_is_a_refusal(self):
        with unittest.mock.patch.object(urllib.request, "urlopen", self.raising(401, "{}")):
            self.assertEqual(base.anthropic_refusal("t"), "token rejected (401)")

    def test_rate_limits_and_outages_are_not(self):
        for code in (400, 429, 500):
            with unittest.mock.patch.object(urllib.request, "urlopen", self.raising(code, "{}")):
                self.assertIsNone(base.anthropic_refusal("t"))

    def test_consumer_terms_not_accepted_is_named(self):
        """The body Anthropic sent on 2026-10-08 for an account whose terms were pending."""
        with unittest.mock.patch.object(urllib.request, "urlopen", self.raising(400, TERMS_BODY)):
            self.assertEqual(base.anthropic_refusal("t"), base.NEEDS_TERMS)
            self.assertEqual(base.anthropic_refusal("t", infer=True), base.NEEDS_TERMS)

    def test_the_terms_check_sends_a_one_token_message(self):
        sent = []
        def fake(req, timeout=None):
            sent.append((req.full_url, json.loads(req.data)))
            return contextlib.nullcontext()
        with unittest.mock.patch.object(urllib.request, "urlopen", fake):
            self.assertIsNone(base.anthropic_refusal("t", infer=True))
        self.assertEqual(sent[0][0], base.INFER_URL)
        self.assertEqual(sent[0][1]["max_tokens"], 1)


TERMS_BODY = '{"type":"error","error":{"type":"invalid_request_error","message":"We\'ve updated our Consumer Terms and Privacy Policy. You\'ll need to accept them in claude.ai with the email in /status to continue."},"request_id":"req_011Cfpei9Q2FndKLU23sLdgU"}'


class JWTClaimDecode(unittest.TestCase):
    """jwt_claims reads the payload segment only; no signature is checked."""

    @staticmethod
    def token_for(payload):
        seg = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
        return f"header.{seg}.signature"

    def test_decodes_the_account_id_claim(self):
        tok = self.token_for({"exp": 1234567890,
                              "https://api.openai.com/auth": {"chatgpt_account_id": "abc-123"}})
        claims = base.jwt_claims(tok)
        self.assertEqual(claims["exp"], 1234567890)
        self.assertEqual(claims["https://api.openai.com/auth"]["chatgpt_account_id"], "abc-123")

    def test_decodes_without_base64_padding(self):
        tok = self.token_for({"exp": 1})
        payload_len = len(tok.split(".")[1])
        self.assertNotEqual(payload_len % 4, 1)
        self.assertEqual(base.jwt_claims(tok)["exp"], 1)

    def test_assert_codex_identity_passes_on_a_match(self):
        tok = self.token_for({"https://api.openai.com/auth": {"chatgpt_account_id": "acc-1"}})
        registry.assert_codex_identity(tok, "acc-1")

    def test_assert_codex_identity_fails_closed_on_a_mismatch(self):
        tok = self.token_for({"https://api.openai.com/auth": {"chatgpt_account_id": "acc-1"}})
        with self.assertRaises(RuntimeError):
            registry.assert_codex_identity(tok, "acc-2")


class LsRowBuilding(unittest.TestCase):
    """build_rows() is what `ls --json` and /account render. Fixed index and
    state in, exact rows out."""

    def test_rows_carry_usage_reason_and_flags(self):
        tree = sched.Tree(key=KEY.key, pin="c", current="b")
        rows = status_view.build_rows(ALL, tree, sched.Book(load={"a": 2}), {}, CFG, NOW)
        by_id = {r["id"]: r for r in rows}
        self.assertEqual(by_id["a"]["usage"], "10%/0%")
        self.assertEqual((by_id["a"]["usable"], by_id["a"]["serves"]), (True, True))
        self.assertIsNone(by_id["a"]["reason"])
        self.assertEqual(by_id["a"]["score"], round(sched.score(A, CFG, NOW, "normal", {"a": 2}), 2))
        self.assertEqual(by_id["a"]["sessions"], 2)
        self.assertNotIn("seat", by_id["b"])
        self.assertEqual(by_id["b"]["current"], True)
        self.assertEqual(by_id["c"]["pinned"], True)
        self.assertEqual((by_id["d"]["usable"], by_id["d"]["serves"]), (False, True))
        self.assertEqual(by_id["d"]["reason"], "depleted")
        self.assertIsNone(by_id["d"]["score"])
        self.assertEqual(by_id["e"]["reason"], "needs-reauth")

    def test_a_low_tree_sees_a_lower_admit_cap(self):
        mid = account("m", "m@x", session_pct=55)
        normal = status_view.build_rows([mid], sched.Tree(), sched.Book(), {}, CFG, NOW)[0]
        low = status_view.build_rows([mid], sched.Tree(priority="low"), sched.Book(), {}, CFG, NOW)[0]
        self.assertEqual((normal["usable"], low["usable"], low["reason"]), (True, False, "depleted"))

    def test_a_cooldown_reason_carries_a_countdown(self):
        cooling = account("f", "f@x", session_pct=5)
        rows = status_view.build_rows([cooling], sched.Tree(), sched.Book(), {"f": NOW + 125}, CFG, NOW)
        self.assertEqual(rows[0]["reason"], "cooldown 2m")

    def test_a_pool_pin_is_reported_as_pinned_too(self):
        rows = status_view.build_rows(ALL, sched.Tree(pool_pin="b"), sched.Book(), {}, CFG, NOW)
        by_id = {r["id"]: r for r in rows}
        self.assertEqual(by_id["b"]["pinned"], True)


class LsUsageWindows(unittest.TestCase):
    """`ls --json` carries every usage window with its reset time, the tier,
    the age of the usage data and the cooldown reason, for the browser chat."""

    @staticmethod
    def windowed(windows, usage_at=NOW - 90, **kw):
        return dataclasses.replace(account("w", "w@x", **kw), tier="max 20x", windows=tuple(windows), usage_at=usage_at)

    def test_windows_come_in_display_order_with_live_reset_times(self):
        win = IndexWindows.win
        a = self.windowed([win(100, 604800, 3600, name="Fable"), win(61, 604800, 7200), win(7, 18000, 600)])
        row = status_view.build_rows([a], sched.Tree(), sched.Book(), {}, CFG, NOW)[0]
        self.assertEqual([(w["kind"], w["label"], w["pct"], w["resets_at"]) for w in row["windows"]],
                         [("session", "5h", 7, NOW + 600), ("weekly", "week", 61, NOW + 7200), ("model", "Fable", 100, NOW + 3600)])
        self.assertEqual((row["tier"], row["usage_at"], row["usage_age_sec"]), ("max 20x", NOW - 90, 90))

    def test_a_passed_reset_reads_zero_with_no_reset_time(self):
        a = self.windowed([IndexWindows.win(87, 18000, -60)])
        self.assertEqual(status_view.build_rows([a], sched.Tree(), sched.Book(), {}, CFG, NOW)[0]["windows"][0]["resets_at"], None)

    def test_a_thirty_day_codex_window_is_labelled_by_days(self):
        a = dataclasses.replace(codex_account("c", "c@x", "free"), windows=(IndexWindows.win(100, 2592000, 86400),))
        row = status_view.build_rows([a], sched.Tree(), sched.Book(), {}, CFG, NOW)[0]
        self.assertEqual([w["label"] for w in row["windows"]], ["30d"])
        self.assertEqual(row["plan"], "free")

    def test_a_cooldown_carries_its_end_and_the_refusal(self):
        a = self.windowed([])
        rows = status_view.build_rows([a], sched.Tree(), sched.Book(), {"w": NOW + 300, "gone": NOW - 1}, CFG, NOW,
                                      {"w": "oauth not allowed for organization"})
        self.assertEqual((rows[0]["cooldown_until"], rows[0]["cooldown_reason"]), (NOW + 300, "oauth not allowed for organization"))

    def test_an_account_never_sampled_has_no_age(self):
        row = status_view.build_rows([self.windowed([], usage_at=0)], sched.Tree(), sched.Book(), {}, CFG, NOW)[0]
        self.assertEqual((row["windows"], row["usage_at"], row["usage_age_sec"], row["cooldown_until"]), ([], None, None, None))


class LsNamesThePoolPin(unittest.TestCase):
    def test_ls_json_names_the_pool_pin(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "state.json")
            state = state_v2(pool_pin="b", current="a")
            base.save_json(path, state)
            out = io.StringIO()
            with unittest.mock.patch.object(base, "STATE", path), unittest.mock.patch.object(registry, "session_key", lambda: None), \
                 unittest.mock.patch.object(registry, "load_index", lambda provider: ALL), contextlib.redirect_stdout(out):
                self.assertEqual(session_cmds.cmd_ls(["--json"]), 0)
            listing = json.loads(out.getvalue())
            self.assertEqual(listing["pin"], {"id": "b", "email": "b@x", "label": "b@x"})
            self.assertNotIn("seat", listing)


class RefusedAccountsBreakPins(unittest.TestCase):
    def test_a_pin_yields_to_a_refusal_cooldown(self):
        tree = sched.Tree(key=KEY.key, pin="a", pin_at=NOW, current="b", current_at=NOW - 60)
        res = sched.decide(tree, [A, B], sched.Book(), {"a": NOW + 100}, CFG, NOW)
        self.assertEqual((res.account.id, res.reason, res.shadowed), ("b", "stay", ("a", "cooldown")))


class DisabledAccountsNeverServe(unittest.TestCase):
    OFF = dataclasses.replace(A, disabled=True)

    def test_every_pin_yields_to_an_off_account(self):
        for tree in (sched.Tree(pin="a", pin_at=NOW, current="b", current_at=NOW - 60),
                     sched.Tree(pool_pin="a", current="b"), sched.Tree(current="a")):
            res = sched.decide(tree, [self.OFF, B], sched.Book(), {}, CFG, NOW)
            self.assertEqual(res.account.id, "b", tree)

    def test_with_pool_state_marks_only_the_named_accounts(self):
        state = {"providers": {"anthropic": {"disabled": {"a": NOW}}}}
        marked = registry.with_pool_state([A, B], state, "anthropic")
        self.assertEqual([a.disabled for a in marked], [True, False])
        self.assertEqual(sched.admit_reason(marked[0], {}, CFG, NOW), "disabled")


class InUseCountsOnlyRecentVends(unittest.TestCase):
    def test_an_idle_session_record_does_not_count(self):
        state = {"sessions": {"s1": {"vends": {"anthropic": {"account_id": "a", "at": NOW - 10}}},
                              "s2": {"vends": {"anthropic": {"account_id": "a", "at": NOW - 7200}}}}}
        self.assertEqual(sched.in_use_counts(state, "anthropic", NOW, 3600), {"a": 1})


if __name__ == "__main__":
    unittest.main()
