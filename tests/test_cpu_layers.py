import importlib.util
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CPU = ROOT / "deploy/linux/cpu"
spec = importlib.util.spec_from_file_location("cpu_protect", CPU / "cpu-protect.py")
cpu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cpu)


def weights(kind: str) -> dict[str, int]:
    line = re.search(rf"^declare -A {kind}_WEIGHTS=\((.*)\)$", (CPU / "setup-cpu.sh").read_text(), re.M).group(1)
    return {unit.replace("$uid", "1001"): int(value) for unit, value in re.findall(r"\[([^\]]+)\]=(\d+)", line)}


class CpuProtectPlan(unittest.TestCase):
    def test_workers_go_to_minus_10_and_their_inherited_children_back_to_0(self):
        threads = {10: ("prime-agent", 0), 11: ("prime-agent", 0), 12: ("prime-agent", -10), 20: ("python", -10), 21: ("bash", -10), 22: ("node", 0)}
        self.assertEqual(cpu.plan(threads), {10: -10, 11: -10, 20: 0, 21: 0})

    def test_a_job_that_niced_itself_up_keeps_its_value_and_a_converged_unit_needs_no_writes(self):
        self.assertEqual(cpu.plan({10: ("prime-agent", -10), 20: ("vitest", 10), 21: ("python", 0)}), {})

    def test_minus_10_matches_the_10_to_1_of_the_chat_weight(self):
        self.assertEqual(weights("USER")["sieun-pi-chat.service"] // 100, 10)
        self.assertEqual(cpu.CORE_NICE, -10)


class Setup(unittest.TestCase):
    def test_logins_and_the_chat_get_1000_and_agents_and_prod_300_on_every_level(self):
        self.assertEqual(weights("SYSTEM"), {"ssh.service": 1000, "tailscaled.service": 1000, "user.slice": 300, "user@1001.service": 300,
                                             "virev.slice": 400, "virev-prod.slice": 300})
        self.assertEqual(weights("USER"), {"sieun-pi-chat.service": 1000, "pi-pool-serve.service": 1000, "pi-pool-hookd.service": 1000,
                                           "prime-agent-daemon.service": 300})

    def test_ci_dev_and_rigs_stay_at_the_default(self):
        system = weights("SYSTEM")
        for unit in ("virev-ci.slice", "dev.slice", "machine.slice"):
            self.assertNotIn(unit, system)
        prod_share = system["virev-prod.slice"] / (system["virev-prod.slice"] + 100)
        self.assertEqual(system["virev.slice"] * prod_share, 300)

    def test_no_unit_gets_a_cap(self):
        for path in CPU.iterdir():
            self.assertNotRegex(path.read_text(), r"CPUQuota|AllowedCPUs|cpu\.max|MemoryMax", path.name)

    def test_files_cite_the_page(self):
        for name in ("cpu-protect.py", "setup-cpu.sh"):
            self.assertIn("https://cho.sh/ko/1983DC", (CPU / name).read_text(), name)


if __name__ == "__main__":
    unittest.main()
