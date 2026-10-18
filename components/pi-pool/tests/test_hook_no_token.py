import json, os, shutil, signal, subprocess, sys, tempfile, time, unittest

from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()


SOURCE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOOK = os.path.join(SOURCE, "bin", "pi-pool-token")


def events(pool):
    try:
        with open(os.path.join(pool, "pi-pool.log")) as f:
            return [json.loads(line) for line in f]
    except FileNotFoundError:
        return []


class HookNoToken(unittest.TestCase):
    def run_hook(self, accounts):
        home = tempfile.mkdtemp(prefix="pi-pool-empty-home-")
        self.addCleanup(shutil.rmtree, home, True)
        pool = os.path.join(home, ".config", "pi-pool")
        os.makedirs(os.path.join(pool, "accounts"))
        if accounts is not None:
            with open(os.path.join(pool, "accounts", "anthropic.json"), "w") as f:
                json.dump(accounts, f)
        env = dict(os.environ, HOME=home, PI_POOL_DIR=pool, PI_POOL_SECRETS="file",
                   PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID="fixture-empty")
        run = subprocess.run([sys.executable, "-B", HOOK], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
        self.assertNotEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout, "")
        no_token = [e for e in events(pool) if e["event"] == "hook_no_token"]
        self.assertEqual(len(no_token), 1, events(pool))
        self.assertEqual((no_token[0]["provider"], no_token[0]["session"]), ("anthropic", "fixture-empty"))
        return no_token[0]["reason"]

    def test_an_empty_store_in_a_temp_home_logs_why_no_token_came(self):
        self.assertEqual(self.run_hook({"version": 1, "accounts": []}), "no_account")

    def test_no_store_yet_is_an_empty_pool(self):
        self.assertEqual(self.run_hook(None), "no_account")

    def test_an_unreadable_store_index_logs_why_no_token_came(self):
        self.assertEqual(self.run_hook({"version": 2, "accounts": []}), "account_index_unreadable")

    def test_a_kill_while_vend_loads_is_logged(self):
        root = tempfile.mkdtemp(prefix="pi-pool-slow-load-")
        self.addCleanup(shutil.rmtree, root, True)
        os.makedirs(os.path.join(root, "bin"))
        shutil.copy(HOOK, os.path.join(root, "bin", "pi-pool-token"))
        with open(os.path.join(root, "vend.py"), "w") as f:
            f.write("import sys, time\nprint('loading', file=sys.stderr, flush=True)\ntime.sleep(30)\n")
        pool = os.path.join(root, "state")
        os.makedirs(pool)
        env = dict(os.environ, PI_POOL_DIR=pool, PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID="fixture-slow")
        hook = subprocess.Popen([sys.executable, "-B", os.path.join(root, "bin", "pi-pool-token"), "--provider", "openai-codex"], env=env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(hook.stderr.readline(), "loading\n")
            hook.send_signal(signal.SIGTERM)
            out, _ = hook.communicate(timeout=10)
        finally:
            if hook.poll() is None:
                hook.kill()
                hook.communicate()
        self.assertEqual((hook.returncode, out), (128 + signal.SIGTERM, ""))
        [e] = events(pool)
        self.assertEqual((e["event"], e["provider"], e["session"]), ("hook_no_token", "openai-codex", "fixture-slow"))
        self.assertEqual((e["reason"], e["signal"], e["phase"]), ("interrupted", signal.SIGTERM, "load"))


    def stub(self, code, provider="anthropic"):
        root = tempfile.mkdtemp(prefix="pi-pool-outcome-")
        self.addCleanup(shutil.rmtree, root, True)
        os.makedirs(os.path.join(root, "bin"))
        os.makedirs(os.path.join(root, "state"))
        shutil.copy(HOOK, os.path.join(root, "bin", "pi-pool-token"))
        with open(os.path.join(root, "vend.py"), "w") as f:
            f.write(code)
        env = dict(os.environ, HOME=root, PI_POOL_DIR=os.path.join(root, "state"),
                   PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID="fixture-outcome")
        return root, env, [sys.executable, "-B", os.path.join(root, "bin", "pi-pool-token"), "--provider", provider]

    def outcome(self, code, reason, provider="anthropic"):
        root, env, args = self.stub(code, provider)
        run = subprocess.run(args, env=env, capture_output=True, text=True, timeout=60)
        rows = events(os.path.join(root, "state"))
        self.assertEqual(len(rows), 1, rows)
        [event] = rows
        self.assertEqual((event["event"], event["reason"], event["provider"]), ("hook_no_token", reason, provider))
        self.assertTrue(event["invocation"].startswith(str(event["pid"]) + "-"))
        self.assertGreaterEqual(event["awake_sec"], 0)
        self.assertGreaterEqual(event["wall_sec"], 0)
        self.assertNotIn("fixture-secret", json.dumps(rows) + run.stderr)
        return event, run

    def test_empty_result_includes_exit_zero_and_whitespace(self):
        for code in ("pass", "raise SystemExit(0)", "print('   ')", "print('  '); raise SystemExit(0)"):
            with self.subTest(code=code):
                event, run = self.outcome(code, "empty_result")
                self.assertEqual((run.returncode, event["exit_code"]), (0, 0))

    def test_an_exception_does_not_log_its_credential_payload(self):
        event, _ = self.outcome("raise RuntimeError('fixture-secret')", "exception", "openai-codex")
        self.assertEqual(event["error_type"], "RuntimeError")

    def test_a_string_exit_does_not_log_its_credential_payload(self):
        self.outcome("raise SystemExit('fixture-secret')", "exit_nonzero")

    def test_a_nonzero_exit_after_output_is_still_a_failed_hook(self):
        event, run = self.outcome("print('fixture-secret'); raise SystemExit(7)", "exit_nonzero")
        self.assertEqual((run.returncode, event["exit_code"]), (7, 7))

    def test_credential_provider_refusal_has_a_fixed_reason(self):
        self.outcome("raise RuntimeError('invalid_grant: fixture-secret')", "credential_provider_refused")

    def test_operation_timeout_is_distinct_from_lock_wait(self):
        self.outcome("raise TimeoutError('fixture-secret')", "operation_timeout")
        self.outcome("raise TimeoutError('could not lock fixture-secret')", "lock_wait_timeout")

    def test_an_exit_number_is_not_evidence_of_a_signal(self):
        self.outcome("raise SystemExit(143)", "exit_nonzero")

    def test_a_token_success_has_no_failure_record(self):
        root, env, args = self.stub("print('synthetic-token')")
        run = subprocess.run(args, env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(run.returncode, 0)
        self.assertTrue(run.stdout.strip())
        self.assertEqual(events(os.path.join(root, "state")), [])

    def test_the_shell_timeout_leaves_an_interrupted_record(self):
        root, env, args = self.stub("import time\ntime.sleep(30)\n", "openai-codex")
        driver = os.path.join(root, "timeout.mjs")
        with open(driver, "w") as f:
            f.write("import { execSync } from 'node:child_process';\n"
                    "try { execSync(process.argv[2], { timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }); "
                    "process.exitCode = 1; } catch (error) { "
                    "process.stdout.write(JSON.stringify({ code: error.code, signal: error.signal })); }\n")
        import shlex
        run = subprocess.run(["node", driver, shlex.join(args)], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(run.returncode, 0)
        self.assertEqual(json.loads(run.stdout)["code"], "ETIMEDOUT")
        failures = [e for e in events(os.path.join(root, "state")) if e["event"] == "hook_no_token"]
        self.assertEqual(len(failures), 1)
        self.assertEqual((failures[0]["reason"], failures[0]["signal"]), ("interrupted", signal.SIGTERM))
        self.assertGreater(failures[0]["wall_sec"], 0)

    def test_pool_lock_contention_logs_wait_without_changing_the_account(self):
        import fcntl
        root = tempfile.mkdtemp(prefix="pi-pool-contended-")
        self.addCleanup(shutil.rmtree, root, True)
        pool = os.path.join(root, "pool")
        os.makedirs(os.path.join(pool, "accounts"))
        with open(os.path.join(pool, "accounts", "openai-codex.json"), "w") as f:
            json.dump({"version": 1, "accounts": []}, f)
        env = dict(os.environ, HOME=root, PI_POOL_DIR=pool, PI_POOL_SECRETS="file",
                   PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID="fixture-lock")
        with open(os.path.join(pool, "lock"), "w") as held:
            fcntl.flock(held.fileno(), fcntl.LOCK_EX)
            run = subprocess.run([sys.executable, "-B", HOOK, "--provider", "openai-codex"],
                                 env=env, capture_output=True, text=True, timeout=60)
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(run.stdout, "")
        failures = [e for e in events(pool) if e["event"] == "hook_no_token"]
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["reason"], "lock_wait_timeout")
        self.assertGreaterEqual(failures[0]["awake_sec"], 2.5)
        self.assertFalse(os.path.exists(os.path.join(pool, "state.json")))


if __name__ == "__main__":
    unittest.main()
