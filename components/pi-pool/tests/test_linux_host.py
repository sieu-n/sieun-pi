"""pi-pool on a Linux host: Claude credentials in 0600 files instead of the macOS Keychain (base.kc_*), and the
memory governor's level from /proc/meminfo and cgroup v2 PSI instead of sysctlbyname (pressure.read_linux)."""
import json, os, stat, subprocess, sys, tempfile, unittest
from unittest import mock

from fixture_isolation import isolate_test_module
from test_core import SOURCE  # noqa: F401, puts vend on sys.path
from vend.pool import base, pressure

GB = 2 ** 30


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


MEMINFO = """MemTotal:       263840768 kB
MemFree:        100000000 kB
SwapTotal:        8388604 kB
SwapFree:         6291452 kB
Zswap:             524288 kB
"""


def psi(some, full):
    return (f"some avg10={some:.2f} avg60=1.00 avg300=0.50 total=123456\n"
            f"full avg10={full:.2f} avg60=0.20 avg300=0.10 total=6543\n")


class LinuxPressure(unittest.TestCase):
    """A fake /proc and /sys/fs/cgroup for the dev half of us-metal02: 256 GB of RAM, and the chat in dev.slice
    with MemoryMax 120G."""

    def setUp(self):
        root = tempfile.mkdtemp(prefix="pi-pool-linux-")
        self.proc, self.cg = os.path.join(root, "proc"), os.path.join(root, "cgroup")
        self.slice = os.path.join(self.cg, "dev.slice")
        self.unit = os.path.join(self.slice, "prime-chat.service")
        for d in (os.path.join(self.proc, "self"), os.path.join(self.proc, "pressure"), self.unit):
            os.makedirs(d)
        self.write(os.path.join(self.proc, "meminfo"), MEMINFO)
        self.write(os.path.join(self.proc, "self", "cgroup"), "0::/dev.slice/prime-chat.service\n")
        self.write(os.path.join(self.unit, "memory.max"), "max\n")
        self.write(os.path.join(self.slice, "memory.max"), f"{120 * GB}\n")
        self.write(os.path.join(self.proc, "pressure", "memory"), psi(90, 80))

    def write(self, path, text):
        with open(path, "w") as f:
            f.write(text)

    def read(self):
        return pressure.read_linux(self.proc, self.cg)

    def test_a_calm_slice_reads_ok_with_its_memory_max_as_ram_whatever_the_host_psi_says(self):
        self.write(os.path.join(self.slice, "memory.pressure"), psi(0.5, 0))
        r = self.read()
        self.assertEqual(r, {"kernel": 1, "swap_used": 2097152 * 1024, "swap_total": 8388604 * 1024, "compressor": 524288 * 1024, "ram": 120 * GB})
        self.assertEqual(pressure.level(r), "ok")

    def test_some_stall_at_lmkd_partial_cutoff_reads_high_and_full_at_its_complete_cutoff_reads_critical(self):
        for some, full, want in ((6.99, 0, "ok"), (7.0, 0, "high"), (40, 69.9, "high"), (90, 70.0, "critical")):
            self.write(os.path.join(self.slice, "memory.pressure"), psi(some, full))
            self.assertEqual(pressure.level(self.read()), want, (some, full))

    def test_without_a_capping_cgroup_the_host_psi_and_memtotal_stand(self):
        self.write(os.path.join(self.slice, "memory.max"), "max\n")
        r = self.read()
        self.assertEqual((r["ram"], r["kernel"]), (263840768 * 1024, pressure.KERNEL_CRITICAL))

    def test_a_kernel_without_a_full_line_and_a_missing_psi_file(self):
        self.assertEqual(pressure.parse_psi("some avg10=12.50 avg60=0 avg300=0 total=1\n"), {"some": 12.5, "full": 0.0})
        os.remove(os.path.join(self.proc, "pressure", "memory"))
        self.write(os.path.join(self.slice, "memory.max"), "max\n")
        self.assertIsNone(self.read())


if __name__ == "__main__":
    unittest.main()
