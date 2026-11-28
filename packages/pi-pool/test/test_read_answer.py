"""What the provider answered an account's last usage read or reset check, as the Accounts page shows it
(owner, #sw-factory-build p249, 11-28: a refreshed row kept reading "Usage 6d 5h old"). Every HTTP call is
faked; no network."""
import contextlib, io, json, os, tempfile, time, unittest, unittest.mock, urllib.error, urllib.request

from fixture_isolation import isolate_test_module
import test_core  # noqa: F401  (loads vend.py with an isolated pool folder)
from vend.pool import base, limit_resets, registry, sched, status_view, usage, vending


def setUpModule():
    isolate_test_module()


OAUTH_OFF = {"type": "error", "error": {"type": "permission_error",
                                        "message": "OAuth authentication is currently not allowed for this organization."}}
GOOD = {"five_hour": {"utilization": 40.0, "resets_at": "2027-01-15T10:00:00Z"},
        "seven_day": {"utilization": 12.0, "resets_at": "2027-01-20T10:00:00Z"}}


def http_error(url, code, body, headers=None):
    return urllib.error.HTTPError(url, code, "", headers or {}, io.BytesIO(json.dumps(body).encode()))


class UsageReadAnswer(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        d = self.tmp.name
        self.answers = []
        for patch in (
                unittest.mock.patch.dict(base.INDEX, {"anthropic": os.path.join(d, "anthropic.json")}),
                unittest.mock.patch.dict(base.INDEX_LOCK, {"anthropic": os.path.join(d, "a.lock")}),
                unittest.mock.patch.object(base, "ACCOUNTS", d),
                unittest.mock.patch.object(base, "log", lambda *a, **k: None),
                unittest.mock.patch.object(base, "kc_read", lambda service: json.dumps({"claudeAiOauth": {}})),
                unittest.mock.patch.object(vending, "credential_for", lambda a, cfg, refresh=True, rejected=None: ("token", "store")),
                unittest.mock.patch.object(urllib.request, "urlopen", self.urlopen)):
            patch.start()
            self.addCleanup(patch.stop)
        base.write_index("anthropic", {"version": 1, "accounts": [{"id": "a", "label": "a@x", "email": "a@x", "windows": []}]})

    def urlopen(self, req, timeout=None):
        code, body, headers = self.answers.pop(0)
        if code != 200:
            raise http_error(req.full_url, code, body, headers)
        return contextlib.closing(io.BytesIO(json.dumps(body).encode()))

    def read(self):
        account = registry.load_index("anthropic")[0]
        return usage.read_account("anthropic", account, base.config())

    def row(self):
        account = registry.load_index("anthropic")[0]
        return status_view.build_rows([account], sched.Tree(), sched.Book(), {}, base.config(), time.time())[0]

    def test_a_403_keeps_anthropics_own_message_on_the_row_with_the_time_it_failed(self):
        self.answers = [(403, OAUTH_OFF, None)]
        before = time.time()
        out = self.read()
        reason = "Anthropic answered 403: OAuth authentication is currently not allowed for this organization."
        self.assertEqual((out["ok"], out["reason"]), (False, reason))
        row = self.row()
        self.assertEqual(row["read_error"], reason)
        self.assertGreaterEqual(row["read_failed_at"], round(before) - 1)

    def test_a_429_reads_as_rate_limited_with_the_providers_retry_time(self):
        self.answers = [(429, {}, {"Retry-After": "464"})]
        out = self.read()
        self.assertEqual(out["reason"], "Anthropic rate limited usage reads (429)")
        row = self.row()
        self.assertEqual(row["read_error"], "Anthropic rate limited usage reads (429)")
        self.assertAlmostEqual(row["usage_retry_at"], time.time() + 464, delta=5)

    def test_a_401_on_the_token_and_on_its_refresh_reads_as_signed_out(self):
        self.answers = [(401, {}, None), (401, {}, None)]
        self.assertEqual(self.read()["reason"], "signed out: Anthropic refused the token (401)")
        self.assertEqual(self.row()["read_error"], "signed out: Anthropic refused the token (401)")

    def test_a_dead_grant_reads_as_signed_out_with_the_token_endpoints_code(self):
        def dead(a, cfg, refresh=True, rejected=None):
            raise base.GrantDead("invalid_grant: refresh token is dead (needs reauth)")
        with unittest.mock.patch.object(vending, "credential_for", dead):
            self.assertEqual(self.read()["reason"], "signed out: Anthropic refused the sign-in (invalid_grant)")

    def test_a_good_read_clears_the_last_failure(self):
        self.answers = [(403, OAUTH_OFF, None)]
        self.read()
        time.sleep(0.002)
        self.answers = [(200, GOOD, None)]
        self.assertTrue(self.read()["ok"])
        row = self.row()
        self.assertEqual((row["read_error"], row["read_failed_at"], row["usage_retry_at"]), (None, None, None))
        self.assertNotIn("lastReadError", base.read_index("anthropic")["accounts"][0])


class ResetCheckAnswer(unittest.TestCase):
    def check(self, code, body):
        with unittest.mock.patch.object(limit_resets, "anthropic_call", lambda url, token: (code, body)):
            with self.assertRaises(limit_resets.ResetError) as caught:
                limit_resets.read_grant_status("token")
        return str(caught.exception)

    def test_each_refusal_names_anthropics_code_and_message(self):
        self.assertEqual(self.check(429, None), "Anthropic rate limited the reset check (429)")
        self.assertEqual(self.check(401, None), "signed out: Anthropic refused the token (401)")
        self.assertEqual(self.check(403, OAUTH_OFF),
                         "Anthropic answered 403: OAuth authentication is currently not allowed for this organization.")
        self.assertEqual(self.check(500, None), "Anthropic answered 500")


if __name__ == "__main__":
    unittest.main()
