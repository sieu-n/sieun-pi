"""Usage reads (pool/usage.py): what each provider's body lands in the index, rate
limits, the refresh command's events, and which accounts the sampler reads. Every
credential and HTTP call is faked; no network."""
import contextlib, io, json, os, tempfile, threading, time, unittest, unittest.mock

from fixture_isolation import isolate_test_module
import test_core  # noqa: F401  (loads vend.py with an isolated pool folder)
from vend.pool import base, commands, registry, usage, vending


def setUpModule():
    isolate_test_module()


NOW = 1_800_000_000.0
CLAUDE = {"five_hour": {"utilization": 40.0, "resets_at": "2027-01-15T10:00:00.5+00:00"},
          "seven_day": {"utilization": 12.0, "resets_at": "2027-01-20T10:00:00Z"},
          "limits": [{"kind": "weekly_scoped", "percent": 4, "resets_at": "2027-01-20T10:00:00+00:00",
                      "scope": {"model": {"display_name": "Fable"}}}, {"kind": "session", "percent": 40}]}
SEAT = {"five_hour": {"utilization": 10.0, "resets_at": "2026-10-10T14:59:59.9+00:00"}, "seven_day": None,
        "limits": [{"kind": "weekly_scoped", "percent": 4, "resets_at": "2026-10-10T13:59:59+00:00",
                    "scope": {"model": {"display_name": "Fable"}}}]}
CODEX = {"account_id": "c", "email": "c@new", "plan_type": "pro",
         "rate_limit": {"primary_window": {"used_percent": 7, "limit_window_seconds": 18000, "reset_at": 1800003600},
                        "secondary_window": {"used_percent": 30, "limit_window_seconds": 604800, "reset_at": 1800300000}},
         "additional_rate_limits": [{"limit_name": "GPT-5.3-Codex-Spark", "rate_limit": {
             "primary_window": {"used_percent": 1, "limit_window_seconds": 18000, "reset_at": None}}}]}


class Store(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        d = self.tmp.name
        self.bodies, self.probed = {}, []
        for patch in (
                unittest.mock.patch.dict(base.INDEX, {"anthropic": os.path.join(d, "anthropic.json"),
                                                      "openai-codex": os.path.join(d, "openai-codex.json")}),
                unittest.mock.patch.dict(base.INDEX_LOCK, {"anthropic": os.path.join(d, "a.lock"),
                                                           "openai-codex": os.path.join(d, "c.lock")}),
                unittest.mock.patch.object(base, "ACCOUNTS", d),
                unittest.mock.patch.object(base, "log", lambda *a, **k: None),
                unittest.mock.patch.object(base, "kc_read", lambda service: json.dumps(
                    {"claudeAiOauth": {"subscriptionType": "max", "rateLimitTier": "default_claude_max_20x"}})),
                unittest.mock.patch.object(vending, "credential_for", lambda a, cfg: ("token-" + a.id, "store")),
                unittest.mock.patch.object(vending, "probe_failed_reads", self.probed.append),
                unittest.mock.patch.object(usage, "get_json", self.answer)):
            patch.start()
            self.addCleanup(patch.stop)
        base.write_index("anthropic", {"version": 1, "accounts": [
            {"id": "a", "label": "a@x", "email": "a@x", "windows": []},
            {"id": "b", "label": "b@x", "email": "b@x", "windows": []}]})
        base.write_index("openai-codex", {"version": 1, "accounts": [{"id": "c", "label": "c@x", "email": "c@x", "windows": []}]})

    def answer(self, url, headers):
        for key, body in self.bodies.items():
            if key in url + headers.get("Authorization", ""):
                if isinstance(body, Exception):
                    raise body
                return body
        raise RuntimeError("usage read failed (HTTP 500)")

    def record(self, provider, account_id):
        return next(r for r in base.read_index(provider)["accounts"] if r["id"] == account_id)

    def read(self, provider, account_id):
        account = next(a for a in registry.load_index(provider) if a.id == account_id)
        return usage.read_account(provider, account, base.config())


class ClaudeReads(Store):
    def test_a_full_body_lands_both_windows_the_model_cap_and_the_plan(self):
        self.bodies["token-a"] = CLAUDE
        self.assertTrue(self.read("anthropic", "a")["ok"])
        rec = self.record("anthropic", "a")
        self.assertEqual([(w["name"], w["usedPercentage"], w["windowSeconds"]) for w in rec["windows"]],
                         [(None, 40.0, 18000), (None, 12.0, 604800), ("Fable", 4, 604800)])
        self.assertEqual(rec["windows"][0]["resetsAt"], 1800007200500)
        self.assertEqual(rec["tier"], "max 20x")
        self.assertEqual(rec["lastUsageAt"], rec["windows"][0]["sampledAt"])

    def test_a_team_seat_body_with_no_week_lands_its_five_hours_and_model_rows(self):
        self.bodies["token-a"] = SEAT
        self.assertTrue(self.read("anthropic", "a")["ok"])
        rec = self.record("anthropic", "a")
        self.assertEqual([(w["name"], w["usedPercentage"], w["resetsAt"]) for w in rec["windows"]],
                         [(None, 10.0, 1791644399900), ("Fable", 4, 1791640799000)])

    def test_a_body_with_no_five_hour_window_is_a_failed_read(self):
        self.bodies["token-a"] = {"five_hour": None, "seven_day": None}
        out = self.read("anthropic", "a")
        self.assertEqual((out["ok"], out["reason"]), (False, "usage read returned no 5h window"))
        self.assertNotIn("lastUsageAt", self.record("anthropic", "a"))
        self.assertIn("lastProbeAt", self.record("anthropic", "a"))

    def test_a_rate_limit_is_kept_and_honoured_until_it_ends(self):
        self.bodies["token-a"] = usage.RateLimited(time.time() + 600)
        self.assertFalse(self.read("anthropic", "a")["ok"])
        self.bodies["token-a"] = CLAUDE
        out = self.read("anthropic", "a")
        self.assertFalse(out["ok"])
        self.assertIn("rate limited", out["reason"])
        self.assertAlmostEqual(out["retry_at"], time.time() + 600, delta=5)

    def test_a_model_row_missing_from_a_later_body_is_kept(self):
        self.bodies["token-a"] = CLAUDE
        self.read("anthropic", "a")
        self.bodies["token-a"] = {**CLAUDE, "limits": []}
        self.read("anthropic", "a")
        self.assertEqual([w["name"] for w in self.record("anthropic", "a")["windows"]], [None, None, "Fable"])


class CodexReads(Store):
    def test_plan_windows_and_named_limits_land_with_email_and_plan(self):
        self.bodies["token-c"] = CODEX
        self.assertTrue(self.read("openai-codex", "c")["ok"])
        rec = self.record("openai-codex", "c")
        self.assertEqual([(w["name"], w["usedPercentage"], w["resetsAt"]) for w in rec["windows"]],
                         [(None, 7, 1800003600000), (None, 30, 1800300000000), ("GPT-5.3-Codex-Spark", 1, None)])
        self.assertEqual((rec["email"], rec["tier"]), ("c@new", "pro"))


class Refresh(Store):
    def run_refresh(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = commands.cmd_refresh(list(args))
        return code, out.getvalue()

    def test_stream_names_provider_and_label_on_every_read_and_probes_failed_claude_reads(self):
        self.bodies["token-a"] = CLAUDE
        code, out = self.run_refresh("--stream", "--provider", "anthropic")
        events = [json.loads(line) for line in out.splitlines()]
        self.assertEqual(code, 0)
        kinds = [e["event"] for e in events]
        # The reads run in parallel, so a read may land before the next reading starts.
        self.assertEqual((kinds[0], kinds[-1], sorted(kinds[1:-1])), ("accounts", "end", ["read", "read", "reading", "reading"]))
        for e in events[1:-1]:
            if e["event"] == "read":
                self.assertLess(kinds.index("reading"), events.index(e))
                self.assertTrue(any(x["event"] == "reading" and x["id"] == e["id"] for x in events[:events.index(e)]), e)
        reads = {e["id"]: e for e in events if e["event"] == "read"}
        self.assertEqual((reads["a"]["ok"], reads["a"]["label"], reads["b"]["ok"]), (True, "a@x", False))
        self.assertEqual(self.probed, [{"b"}])

    def test_json_reports_every_provider(self):
        self.bodies.update({"token-a": CLAUDE, "token-b": CLAUDE, "token-c": CODEX})
        code, out = self.run_refresh("--json")
        report = json.loads(out)["providers"]
        self.assertEqual(code, 0)
        self.assertEqual(sorted(r["id"] for r in report["anthropic"]), ["a", "b"])
        self.assertTrue(all(r["ok"] for rows in report.values() for r in rows))

    def test_named_accounts_need_a_provider(self):
        code, out = self.run_refresh("--json", "a@x")
        self.assertEqual(code, 1)
        self.assertIn("--provider", json.loads(out)["error"])

    def test_a_read_still_running_at_the_deadline_is_reported_unfinished(self):
        gate = threading.Event()
        self.addCleanup(gate.set)
        events = []
        with unittest.mock.patch.object(usage, "read_account", lambda *a: gate.wait(10) and {"ok": True}):
            usage.read_many({"openai-codex": None}, events.append, timeout=0.5)
        self.assertEqual(events[-1], {"event": "read", "provider": "openai-codex", "id": "c", "email": "c@x", "label": "c@x",
                                      "ok": False, "reason": "the read did not finish in 0.5s", "retry_at": None})


class Sampler(Store):
    def win(self, pct, secs=18000):
        return {"name": None, "usedPercentage": pct, "resetsAt": None, "windowSeconds": secs, "sampledAt": NOW * 1000}

    def test_the_interval_shrinks_as_a_window_fills_and_waits_out_a_full_one(self):
        cfg = base.config()
        self.assertEqual(usage.sample_interval({"windows": []}, cfg, NOW), usage.SAMPLE_MIN_SEC)
        self.assertEqual(usage.sample_interval({"windows": [self.win(0)]}, cfg, NOW), usage.SAMPLE_MAX_SEC)
        self.assertEqual(usage.sample_interval({"windows": [self.win(50), self.win(10, 604800)]}, cfg, NOW), usage.SAMPLE_MAX_SEC / 2)
        self.assertEqual(usage.sample_interval({"windows": [self.win(99)]}, cfg, NOW), usage.SAMPLE_MIN_SEC)
        self.assertEqual(usage.sample_interval({"windows": [self.win(100)]}, cfg, NOW), usage.SAMPLE_MAX_SEC)

    def test_sample_reads_only_due_accounts_and_skips_one_that_needs_a_sign_in(self):
        now_ms = int(time.time() * 1000)
        base.write_index("anthropic", {"version": 1, "accounts": [
            {"id": "a", "label": "a@x", "email": "a@x", "windows": [], "lastUsageAt": now_ms},
            {"id": "b", "label": "b@x", "email": "b@x", "windows": []},
            {"id": "e", "label": "e@x", "email": "e@x", "windows": [], "needsReauth": True}]})
        self.bodies.update({"token-b": CLAUDE, "token-c": CODEX})
        usage.cmd_sample()
        self.assertNotIn("windows", [k for k, v in self.record("anthropic", "a").items() if v])
        self.assertEqual(len(self.record("anthropic", "b")["windows"]), 3)
        self.assertNotIn("lastProbeAt", self.record("anthropic", "e"))
        self.assertEqual(len(self.record("openai-codex", "c")["windows"]), 3)


if __name__ == "__main__":
    unittest.main()
