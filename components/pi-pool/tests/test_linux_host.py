"""pi-pool on a Linux host: Claude credentials in 0600 files instead of the macOS Keychain (base.kc_*)."""
import json, os, stat, subprocess, sys, tempfile, unittest
from unittest import mock

from fixture_isolation import isolate_test_module
from test_core import SOURCE  # noqa: F401, puts vend on sys.path
from vend.pool import base

def setUpModule():
    isolate_test_module()


class FileSecrets(unittest.TestCase):
    def setUp(self):
        self.dir = os.path.join(tempfile.mkdtemp(prefix="pi-pool-secrets-"), "secrets")
        for patch in (mock.patch.object(base, "SECRETS", self.dir), mock.patch.object(base, "FILE_SECRETS", True)):
            patch.start()
            self.addCleanup(patch.stop)

    def test_an_item_is_written_0600_in_a_0700_folder_read_back_and_deleted(self):
        service = base.store_service(os.path.join(base.TM_STORES, "0a1b2c3d"))
        self.assertIsNone(base.kc_read(service))
        base.kc_write(service, "it's \"quoted\"\n")
        path = os.path.join(self.dir, service)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(self.dir).st_mode), 0o700)
        self.assertEqual(base.kc_read(service), "it's \"quoted\"\n")
        base.kc_write(service, "second")
        self.assertEqual(base.kc_read(service), "second")
        self.assertEqual(os.listdir(self.dir), [service])
        base.kc_delete(service)
        base.kc_delete(service)
        self.assertIsNone(base.kc_read(service))

    def test_the_keychain_adapter_round_trips_a_claude_blob_through_the_file(self):
        adapter = base.KeychainAdapter("Claude Code-credentials-1234abcd")
        blob = {"accessToken": "a", "refreshToken": "r", "expiresAt": 1792072000000}
        adapter.write(blob)
        self.assertEqual(adapter.read(), blob)
        with open(os.path.join(self.dir, "Claude Code-credentials-1234abcd")) as f:
            self.assertEqual(json.load(f), {"claudeAiOauth": blob})

    def test_a_service_that_names_a_path_is_refused(self):
        for service in ("../x", "a/b", ".hidden", ""):
            with self.assertRaises(RuntimeError):
                base.kc_write(service, "s")

    def test_PI_POOL_SECRETS_file_picks_the_files_on_macos_too(self):
        with tempfile.TemporaryDirectory(prefix="pi-pool-test-") as home:
            env = dict(os.environ, PI_POOL_SECRETS="file", PI_POOL_DIR=os.path.join(home, "pool"), TOKENMAXXING_HOME=os.path.join(home, "tm"))
            code = ("import importlib.util, sys; s = importlib.util.spec_from_file_location('vend', 'vend.py'); m = importlib.util.module_from_spec(s); "
                    "sys.modules['vend'] = m; s.loader.exec_module(m); b = m.pool.base; b.kc_write('svc', 'x'); print(b.FILE_SECRETS, b.kc_read('svc'), b.SECRETS)")
            out = subprocess.run([sys.executable, "-B", "-c", code], cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                 env=env, capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.split(), ["True", "x", os.path.join(home, "tm", "secrets")])


if __name__ == "__main__":
    unittest.main()
