"""swap_used_gib reads /proc/meminfo off macOS, where sysctl has no vm.swapusage (us-metal02, 2026-10-17: 13 of 13 cycles died)."""
import sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wd_procs as wd  # noqa: E402


class SwapOnLinux(unittest.TestCase):
    def setUp(self):
        self.platform = sys.platform
        sys.platform = 'linux'
        self.dir = tempfile.TemporaryDirectory()
        wd.MEMINFO = Path(self.dir.name) / 'meminfo'

    def tearDown(self):
        sys.platform = self.platform
        self.dir.cleanup()

    def test_used_is_total_minus_free(self):
        wd.MEMINFO.write_text('MemTotal:       259000000 kB\nSwapCached:            0 kB\n'
                              'SwapTotal:      16777212 kB\nSwapFree:       12582908 kB\n')
        self.assertEqual(wd.pressure()[0], 4.0)

    def test_no_swap_in_use_is_zero(self):
        wd.MEMINFO.write_text('SwapTotal:      16777212 kB\nSwapFree:       16777212 kB\n')
        self.assertEqual(wd.swap_used_gib(), 0.0)


if __name__ == '__main__':
    unittest.main()
