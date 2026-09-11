import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
import unittest
from unittest.mock import patch


from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()


SOURCE = Path(__file__).resolve().parents[1] / "vend.py"


class EnableRecovery(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="pi-pool-enable-test-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.pool = root / "pool"
        self.agent = root / "agent"
        self.pool.mkdir()
        self.agent.mkdir()
        self.auth = self.agent / "auth.json"
        self.models = self.agent / "models.json"
        self.fallback = self.pool / "fallback.json"
        environment = patch.dict(os.environ, {
            "HOME": str(root),
            "PI_POOL_DIR": str(self.pool),
            "PRIME_AGENT_CODING_AGENT_DIR": str(self.agent),
        })
        environment.start()
        self.addCleanup(environment.stop)
        spec = importlib.util.spec_from_file_location("vend_enable_recovery", SOURCE)
        self.vend = importlib.util.module_from_spec(spec)
        modules = patch.dict(sys.modules, {spec.name: self.vend})
        modules.start()
        self.addCleanup(modules.stop)
        spec.loader.exec_module(self.vend)
        logging = patch.object(self.vend, "log")
        logging.start()
        self.addCleanup(logging.stop)

    def enable(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), \
             patch.object(self.vend, "load_json", wraps=self.vend.load_json) as reads, \
             patch.object(self.vend, "save_json", wraps=self.vend.save_json) as writes:
            result = self.vend.cmd_enable(["openai-codex"])
        self.assertEqual(result, 0)
        return output.getvalue(), [call.args[0] for call in reads.call_args_list], [
            call.args[0] for call in writes.call_args_list
        ]

    def test_enable_retains_native_login_and_other_configuration(self):
        auth = b'{ "openai-codex": {"type":"oauth","access":"native-fixture","refresh":"native-fixture-refresh","expires":9000000000000}, "anthropic":{"untouched":true} }\n'
        self.auth.write_bytes(auth)
        models = {
            "providers": {"anthropic": {"apiKey": "fixture-key", "models": [{"id": "fixture-model"}]}},
            "fixtureSetting": {"retained": True},
        }
        self.models.write_text(json.dumps(models))

        output, reads, writes = self.enable()

        self.assertEqual(self.auth.read_bytes(), auth)
        self.assertFalse(self.fallback.exists())
        self.assertFalse((self.pool / "backups").exists())
        self.assertEqual(reads, [str(self.models)])
        self.assertEqual(writes, [str(self.models)])
        actual = json.loads(self.models.read_text())
        self.assertEqual(actual["providers"].pop("openai-codex"), {
            "baseUrl": "https://chatgpt.com/backend-api",
            "api": "openai-codex-responses",
            "apiKey": f"!{shlex.quote(str(SOURCE.parent / 'bin/pi-pool-token'))} --provider openai-codex",
        })
        self.assertEqual(actual, models)
        self.assertIn("native login remains managed by Prime", output)

    def test_enable_twice_preserves_newer_login_and_legacy_fallback(self):
        auth = b'{ "openai-codex": {"type":"oauth","access":"newer-fixture","refresh":"newer-fixture-refresh","expires":9000000000000} }\n'
        fallback = b'{ "openai-codex":{"type":"oauth","access":"older-fixture","refresh":"unknown-origin","expires":1}, "anthropic":{"preserved":true}, "other":{"preserved":true} }\n'
        self.auth.write_bytes(auth)
        self.fallback.write_bytes(fallback)

        first_output, first_reads, first_writes = self.enable()

        self.assertEqual(self.auth.read_bytes(), auth)
        self.assertEqual(self.fallback.read_bytes(), fallback)
        enabled_models = self.models.read_bytes()
        second_output, second_reads, second_writes = self.enable()
        self.assertEqual(self.auth.read_bytes(), auth)
        self.assertEqual(self.fallback.read_bytes(), fallback)
        self.assertEqual(self.models.read_bytes(), enabled_models)
        self.assertEqual(first_reads, [str(self.models)])
        self.assertEqual(second_reads, [str(self.models)])
        self.assertEqual(first_writes, [str(self.models)])
        self.assertEqual(second_writes, [])
        self.assertFalse((self.pool / "backups").exists())
        self.assertIn("already enabled", second_output)
        for output in (first_output, second_output):
            self.assertIn("native login remains managed by Prime", output)

    def test_enable_leaves_unknown_legacy_fallback_untouched(self):
        for fallback in (
            b'{ "type":"oauth", "access":"legacy-fixture", "refresh":"unknown-origin", "expires":1 }\n',
            b'unknown legacy fallback format\n',
        ):
            with self.subTest(fallback=fallback):
                self.fallback.write_bytes(fallback)

                _, reads, _ = self.enable()

                self.assertEqual(self.fallback.read_bytes(), fallback)
                self.assertFalse(self.auth.exists())
                self.assertEqual(reads, [str(self.models)])

    def test_enable_without_login_does_not_create_auth(self):
        output, reads, writes = self.enable()

        self.assertFalse(self.auth.exists())
        self.assertFalse(self.fallback.exists())
        self.assertFalse((self.pool / "backups").exists())
        self.assertEqual(reads, [str(self.models)])
        self.assertEqual(writes, [str(self.models)])
        self.assertIn("native login remains managed by Prime", output)


if __name__ == "__main__":
    unittest.main()
