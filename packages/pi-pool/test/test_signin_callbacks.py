"""2026-10-19: cross-device localhost URLs were exchanged as manual codes.

Run the OAuth boundary and one clean subprocess through the same stdin contract
that Prime's account-add consumer uses. Provider traffic uses a loopback fixture.
"""
import contextlib
import hashlib
import io
import http.client
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch
import urllib.parse

from fixture_isolation import isolate_test_module
from test_account_admin import FakeInput, InProcessStore, PROFILE, TOKENS, state_of
from vend.pool import base, registry, signin, usage


READ_ACCOUNT = usage.read_account


def setUpModule():
    isolate_test_module()


def redirect_of(event):
    return urllib.parse.parse_qs(urllib.parse.urlsplit(event["url"]).query)["redirect_uri"][0]


def callback_of(event, code="good", **fields):
    query = {"code": code, "state": state_of(event), **fields}
    return redirect_of(event) + "?" + urllib.parse.urlencode(query)


class CallbackURLs(InProcessStore):
    def run_login(self, stdin, accept=("good",)):
        sent = []

        def post(url, body, form=False):
            sent.append(body)
            return (200, TOKENS) if body["code"] in accept else (400, {"error": "invalid_grant"})
        with patch.object(signin, "post", post), patch.object(signin, "claude_profile", lambda token: PROFILE):
            harvest = signin.claude_login(stdin.events.append, stdin, time.time() + signin.LOGIN_TIMEOUT_SEC)
        return harvest, sent

    def test_full_localhost_url_keeps_original_redirect_state_and_pkce(self):
        stdin = FakeInput(lambda events: [callback_of(events[0])])
        harvest, sent = self.run_login(stdin)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["redirect_uri"], redirect_of(stdin.events[0]))
        self.assertEqual(sent[0]["state"], state_of(stdin.events[0]))
        authorization = urllib.parse.parse_qs(urllib.parse.urlsplit(stdin.events[0]["url"]).query)
        challenge = signin.b64url(hashlib.sha256(sent[0]["code_verifier"].encode()).digest())
        self.assertEqual(challenge, authorization["code_challenge"][0])
        self.assertEqual(harvest["record"]["email"], "d@x")

    def test_exact_provider_manual_callback_url_uses_manual_redirect(self):
        stdin = FakeInput(lambda events: [signin.CLAUDE_MANUAL_REDIRECT + "?" + urllib.parse.urlencode({"code": "good", "state": state_of(events[0])})])
        _, sent = self.run_login(stdin)
        self.assertEqual(sent[0]["redirect_uri"], signin.CLAUDE_MANUAL_REDIRECT)

    def test_invalid_callbacks_never_exchange_and_the_pending_flow_can_continue(self):
        cases = [
            lambda e: callback_of(e, state="another-flow"),
            lambda e: callback_of(e).replace("localhost:", "attacker.invalid:"),
            lambda e: callback_of(e).replace("/callback?", "/elsewhere?"),
            lambda e: callback_of(e) + "&state=duplicate",
            lambda e: callback_of(e) + "#fragment",
            lambda e: callback_of(e, code=""),
            lambda e: callback_of(e, state=""),
            lambda e: callback_of(e, state="non-ascii-\u2603"),
            lambda e: callback_of(e) + "&broken=%not-encoded",
            lambda e: "http://[invalid/callback?code=hidden",
            lambda e: callback_of(e, error="access_denied"),
        ]
        for bad in cases:
            with self.subTest(case=cases.index(bad)):
                stdin = FakeInput(lambda events: [bad(events[0])], lambda events: [callback_of(events[0])])
                _, sent = self.run_login(stdin)
                self.assertEqual(len(sent), 1)
                self.assertEqual(stdin.events[1]["event"], "retry")
                self.assertNotIn("good", json.dumps(stdin.events[1]))

    def test_provider_denial_is_terminal_and_never_prints_provider_details(self):
        stdin = FakeInput(lambda events: [redirect_of(events[0]) + "?" + urllib.parse.urlencode({"state": state_of(events[0]), "error": "access_denied", "error_description": "sensitive-provider-detail"})])
        with self.assertRaisesRegex(signin.LoginFailed, "did not approve") as caught:
            self.run_login(stdin)
        self.assertNotIn("sensitive-provider-detail", str(caught.exception))

    def test_duplicate_refused_code_is_exchanged_once_across_paste_and_loopback(self):
        answers = []
        def visit(events):
            url = urllib.parse.urlsplit(callback_of(events[0], "bad"))
            conn = http.client.HTTPConnection("127.0.0.1", url.port)
            conn.request("GET", url.path + "?" + url.query)
            answer = conn.getresponse()
            answers.append(answer.status)
            answer.read()
            conn.close()
            return [url.geturl()]
        stdin = FakeInput(visit, lambda events: [callback_of(events[0])])
        with patch.dict(os.environ, {"PI_POOL_TEST_ALLOW_LOOPBACK": "1"}):
            _, sent = self.run_login(stdin)
        self.assertEqual(answers, [302])
        self.assertEqual([body["code"] for body in sent], ["bad", "good"])
        self.assertTrue(any("already submitted" in event.get("message", "") for event in stdin.events))

    def test_successful_duplicate_in_one_batch_files_once(self):
        stdin = FakeInput(lambda events: [callback_of(events[0]), callback_of(events[0])])
        original = signin.claude_login
        def sign_in(emit, source, deadline):
            return original(lambda event: (stdin.events.append(event), emit(event)), source, deadline)
        with contextlib.redirect_stdout(io.StringIO()), patch.object(signin, "claude_login", sign_in), patch.object(signin, "Input", return_value=stdin), patch.object(signin, "post", return_value=(200, TOKENS)), patch.object(signin, "claude_profile", return_value=PROFILE), patch.object(signin, "file_anywhere", return_value="added fixture") as file:
            self.assertEqual(signin.cmd_login([]), 0)
        self.assertEqual(file.call_count, 1)


class ReservedAccountAdd(InProcessStore):
    def test_off_is_written_before_the_new_account_is_published(self):
        original = base.write_index
        account_id = PROFILE["account"]["uuid"]
        observed = []
        def publish(provider, index):
            state = json.loads(Path(base.STATE).read_text())
            observed.append(account_id in state["providers"][provider]["disabled"])
            original(provider, index)
        with patch.object(base, "write_index", publish):
            signin.file_login("anthropic", {"record": {"id": account_id, "email": "d@x"}, "secret": TOKENS}, off=True)
        self.assertEqual(observed, [True])
        self.assertEqual(sum(row["id"] == account_id for row in self.index()), 1)

    def test_reauth_login_block_cleanup_and_usage_refresh_keep_off(self):
        with patch.object(signin, "claude_profile", return_value=PROFILE):
            harvest = signin.claude_harvest(TOKENS)
        _, account_id = signin.file_login("anthropic", harvest, off=True)
        account = next(row for row in registry.load_index("anthropic") if row.id == account_id)
        with base.Flock(base.LOCK, timeout=base.STATE_LOCK_TIMEOUT):
            state = registry.load_state()
            provider = state["providers"]["anthropic"]
            provider["limits"][account_id] = {"until": time.time() + base.DEFAULTS["refused_cooldown_sec"]}
            provider["cooldowns"][account_id] = time.time() + base.DEFAULTS["refused_cooldown_sec"]
            provider.setdefault("cooldown_reasons", {})[account_id] = base.TOKEN_REJECTED
            base.save_json(base.STATE, state)
        signin.drop_login_blocks("anthropic", account)
        state = json.loads(Path(base.STATE).read_text())["providers"]["anthropic"]
        self.assertNotIn(account_id, state["limits"])
        self.assertNotIn(account_id, state["cooldowns"])
        self.assertIn(account_id, state["disabled"])
        with patch.object(usage.vending, "credential_for", return_value=("fixture-token", False)), patch.object(usage, "get_json", return_value={"five_hour": {"utilization": 12}}):
            result = READ_ACCOUNT("anthropic", account, base.config())
        self.assertIs(result["ok"], True)
        self.assertIn(account_id, json.loads(Path(base.STATE).read_text())["providers"]["anthropic"]["disabled"])
        signin.file_login("anthropic", harvest)
        self.assertIn(account_id, json.loads(Path(base.STATE).read_text())["providers"]["anthropic"]["disabled"])
        self.assertEqual(sum(row["id"] == account_id for row in self.index()), 1)

    def test_off_is_forwarded_to_the_holder(self):
        calls = []
        def ask(cfg, args, stdin):
            calls.append(json.loads(stdin))
            return 0, json.dumps({"message": "added fixture", "id": "fixture"}), ""
        with patch.object(signin.remote, "client", return_value={"fixture": True}), patch.object(signin.remote, "ask", ask):
            signin.file_anywhere("anthropic", {"record": {"id": "fixture"}, "secret": {}}, None, off=True)
        self.assertIs(calls[0]["off"], True)

    def test_login_off_is_an_option_not_an_account_selector(self):
        with contextlib.redirect_stdout(io.StringIO()), patch.object(signin, "Input"), patch.object(signin, "claude_login", return_value={"record": {}, "secret": {}}), patch.object(signin, "file_anywhere", return_value="added fixture") as file:
            self.assertEqual(signin.cmd_login(["--off"]), 0)
        self.assertIsNone(file.call_args.args[2])
        self.assertEqual(file.call_args.kwargs, {"off": True})


class CleanAccountAdd(InProcessStore):
    def test_device_separation_through_real_stdin_and_account_store(self):
        exchanged = []
        tokens = {**TOKENS, "access_token": "fixture-access-token-private", "refresh_token": "fixture-refresh-token-private"}
        class Provider(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def reply(self, body, status=200):
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                exchanged.append(body)
                challenge = signin.b64url(hashlib.sha256(body.get("code_verifier", "").encode()).digest())
                valid = body.get("code") == "good" and body.get("redirect_uri") == expected["redirect_uri"][0] and body.get("state") == expected["state"][0] and challenge == expected["code_challenge"][0]
                self.reply(tokens if valid else {"error": "invalid_grant"}, 200 if valid else 400)
            def do_GET(self):
                self.reply(PROFILE)
        with patch.dict(os.environ, {"PI_POOL_TEST_ALLOW_LOOPBACK": "1"}):
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
            self.addCleanup(server.server_close)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.addCleanup(server.shutdown)
            source = str(Path(__file__).resolve().parents[1])
            endpoint = "http://127.0.0.1:" + str(server.server_address[1])
            script = """import sys
sys.path.insert(0, sys.argv[1])
import vend
from vend.pool import base, registry, signin, usage


READ_ACCOUNT = usage.read_account, usage
base.TOKEN_URL = sys.argv[2] + '/token'
signin.CLAUDE_PROFILE_URL = sys.argv[2] + '/profile'
usage.read_account = lambda *args: {'ok': True}
raise SystemExit(signin.cmd_login(["--off"]))
"""
            env = {**self.env, "PI_POOL_TEST_ALLOW_LOOPBACK": "1"}
            child = subprocess.Popen([sys.executable, "-B", "-c", script, source, endpoint], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.addCleanup(lambda: child.kill() if child.poll() is None else None)
            event = json.loads(child.stdout.readline())
            expected = urllib.parse.parse_qs(urllib.parse.urlsplit(event["url"]).query)
            child.stdin.write(callback_of(event, state="wrong-pending-flow") + "\n")
            child.stdin.flush()
            rejected = json.loads(child.stdout.readline())
            self.assertEqual(rejected["event"], "retry")
            pasted = callback_of(event)
            child.stdin.write(pasted + "\n" + pasted + "\n")
            child.stdin.flush()
            done = json.loads(child.stdout.readline())
            child.stdin.close()
            child.wait()
            stderr = child.stderr.read()
            child.stdout.close()
            child.stderr.close()
            self.assertEqual((child.returncode, done["event"], done["ok"]), (0, "done", True), stderr)
            self.assertEqual(len(exchanged), 1)
            self.assertEqual(exchanged[0]["redirect_uri"], redirect_of(event))
            self.assertEqual(exchanged[0]["state"], state_of(event))
            matches = [account for account in self.index() if account["id"] == PROFILE["account"]["uuid"]]
            self.assertEqual(len(matches), 1)
            self.assertEqual(matches[0]["email"], PROFILE["account"]["email"])
            state = json.loads((Path(self.pool) / "state.json").read_text())
            self.assertIn(PROFILE["account"]["uuid"], state["providers"]["anthropic"]["disabled"])
            logs = (Path(self.pool) / "pi-pool.log").read_text()
            for secret in (pasted, exchanged[0]["code_verifier"], tokens["access_token"], tokens["refresh_token"]):
                self.assertNotIn(secret, logs)
