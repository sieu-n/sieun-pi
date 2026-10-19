import importlib.util
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CPU = ROOT / "deploy/linux/cpu"
spec = importlib.util.spec_from_file_location("cpu_protect", CPU / "cpu-protect.py")
cpu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cpu)


class CpuProtectPlan(unittest.TestCase):
    def test_workers_go_to_minus_10_and_their_inherited_children_back_to_0(self):
        threads = {10: ("prime-agent", 0), 11: ("prime-agent", 0), 12: ("prime-agent", -10), 20: ("python", -10), 21: ("bash", -10), 22: ("node", 0)}
        self.assertEqual(cpu.plan(threads), {10: -10, 11: -10, 20: 0, 21: 0})

    def test_a_job_that_niced_itself_up_keeps_its_value_and_a_converged_unit_needs_no_writes(self):
        self.assertEqual(cpu.plan({10: ("prime-agent", -10), 20: ("vitest", 10), 21: ("python", 0)}), {})

    def test_minus_10_matches_the_10_to_1_of_the_unit_weights(self):
        weight = re.search(r"^CPUWeight=(\d+)$", (CPU / "cpu-weight.conf").read_text(), re.M)
        self.assertEqual(int(weight.group(1)) // 100, 10)
        self.assertEqual(cpu.CORE_NICE, -10)


class Setup(unittest.TestCase):
    def test_the_daemon_unit_gets_no_weight_so_its_job_commands_stay_at_the_default(self):
        text = (CPU / "setup-cpu.sh").read_text()
        units = re.search(r"^USER_UNITS=\((.*)\)$", text, re.M).group(1).split()
        self.assertIn("sieun-pi-chat.service", units)
        self.assertNotIn("prime-agent-daemon.service", units)
        self.assertEqual(re.search(r"^SYSTEM_UNITS=\((.*)\)$", text, re.M).group(1).split(), ["ssh.service", "tailscaled.service"])

    def test_no_unit_gets_a_cap(self):
        for path in CPU.iterdir():
            self.assertNotRegex(path.read_text(), r"CPUQuota|AllowedCPUs|cpu\.max|MemoryMax", path.name)

    def test_files_cite_the_page(self):
        for name in ("cpu-protect.py", "cpu-weight.conf", "setup-cpu.sh"):
            self.assertIn("https://cho.sh/ko/1983DC", (CPU / name).read_text(), name)


if __name__ == "__main__":
    unittest.main()
