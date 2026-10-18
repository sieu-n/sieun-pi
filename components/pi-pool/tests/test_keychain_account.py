"""The keychain account pi-pool reads stores under."""
import os, pwd, subprocess, sys, tempfile, unittest

from fixture_isolation import isolate_test_module


def setUpModule():
    isolate_test_module()


SOURCE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class KeychainAccountTests(unittest.TestCase):
    def test_a_process_without_user_reads_the_stores_under_the_login_name(self):
        # 10-12 19:52 KST: a Prime daemon started with only HOME, PATH and TERM read every store under account "unknown",
        # `security` answered 44 (not found) for all 17 items, and pi-pool told every account to log in again.
        with tempfile.TemporaryDirectory(prefix="pi-pool-test-") as pool:
            env = {k: v for k, v in os.environ.items() if k not in ("USER", "LOGNAME")}
            env.update(PI_POOL_DIR=pool, HOME=pool)
            code = ("import importlib.util, sys; s = importlib.util.spec_from_file_location('vend', 'vend.py'); m = importlib.util.module_from_spec(s); "
                    "sys.modules['vend'] = m; s.loader.exec_module(m); print(m.pool.base.KC_ACCOUNT)")
            out = subprocess.run([sys.executable, "-B", "-c", code], cwd=SOURCE, env=env, capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.strip(), pwd.getpwuid(os.getuid()).pw_name)


if __name__ == "__main__":
    unittest.main()
