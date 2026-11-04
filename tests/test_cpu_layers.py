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


PUBLIC = "/tmp/prime-agent-1001"
SUPERVISOR = ["/home/sieun/.local/share/prime-agent/releases/r1/prime-agent", "/$bunfs/root/prime-agent", "--mode", "daemon", "--daemon-socket", f"{PUBLIC}/daemon.sock"]
WORKER = ["/home/sieun/.local/share/prime-agent/releases/r1/prime-agent", "--mode", "daemon", "--daemon-socket", f"{PUBLIC}/worker-ee92e1d8c39e-6106871d6519.sock"]
CTL = ["/usr/bin/python3", "-B", "/home/sieun/.local/bin/prime-agent-daemon-ctl", "update"]


class CpuProtectPlan(unittest.TestCase):
    """The worker f2f8b4ebd885 stall of 11-02 18:08Z (5,049 ms, 1,418 ms waiting for a CPU) in a daemon cgroup of 253 processes."""

    def test_the_supervisor_and_workers_stay_and_every_command_they_start_moves_to_the_tools_scope(self):
        daemon = {10: (1, SUPERVISOR), 11: (10, WORKER), 20: (11, ["/home/sieun/.prime/agent/kernel-venv/bin/python", "-m", "rlm.repl"]),
                  21: (20, ["/bin/bash", "-c", "pytest"]), 22: (1, ["node", "server.mjs"]), 23: (11, ["/usr/local/bin/pi-pool-token", "get"])}
        self.assertEqual(cpu.plan(daemon, {}, PUBLIC), ([20, 21, 22], []))

    def test_a_reload_keeps_the_ctl_and_what_it_starts_in_the_unit(self):
        daemon = {10: (1, SUPERVISOR), 30: (1, CTL), 31: (30, ["/home/sieun/.local/bin/prime-agent", "update", "--self"])}
        self.assertEqual(cpu.plan(daemon, {}, PUBLIC), ([], []))

    def test_a_supervisor_started_from_the_tools_scope_goes_back_and_a_test_daemon_stays_a_command(self):
        test_daemon = ["/home/sieun/.local/share/prime-agent/releases/r1/prime-agent", "--mode", "daemon", "--daemon-socket", "/tmp/x/prime-agent-1001/daemon.sock"]
        daemon = {40: (20, test_daemon)}
        self.assertEqual(cpu.plan(daemon, {12: (1, SUPERVISOR), 41: (20, test_daemon)}, PUBLIC), ([40], [12]))

    def test_the_catalogs_the_supervisor_starts_stay_and_one_in_the_tools_scope_goes_back(self):
        """The name catalog waited 13.3 s in the run queue per CPU-second in the tools scope, and a rename waited 2,767 ms on 11-03 at 23:37Z."""
        catalog = ["/home/sieun/.local/share/prime-agent/releases/r1/prime-agent", "--version"]
        daemon = {10: (1, SUPERVISOR), 11: (10, WORKER), 12: (10, catalog), 20: (11, ["/bin/bash", "-c", "prime-agent --version"]), 21: (20, catalog)}
        self.assertEqual(cpu.plan(daemon, {13: (10, catalog), 22: (20, catalog)}, PUBLIC), ([20, 21], [13]))

    def test_the_tools_scope_runs_at_the_default_weight_with_no_cap(self):
        text = (CPU / "cpu-protect.py").read_text()
        self.assertNotIn('"CPUWeight"', text)
        self.assertIn('"OOMPolicy", "s", "continue"', text)


class Setup(unittest.TestCase):
    def test_logins_get_1000_and_the_chat_and_daemon_the_most_systemd_takes(self):
        self.assertEqual(weights("SYSTEM"), {"ssh.service": 1000, "tailscaled.service": 1000, "user.slice": 1000, "user@1001.service": 10000,
                                             "virev.slice": 4000, "virev-prod.slice": 300, "virev-ci.slice": 300,
                                             "system.slice": 400, "dev.slice": 400})
        self.assertEqual(weights("USER"), {"sieun-pi-chat.service": 10000, "sieun-pi-apps-chat.service": 10000, "meilisearch.service": 10000, "pi-host.service": 10000,
                                           "pi-host-relay.service": 10000, "pi-history.service": 10000, "sieun-pi-wiki.service": 10000,
                                           "auto-sns-dev-pm2.service": 10000, "pi-pool-serve.service": 1000, "pi-pool-hookd.service": 1000,
                                           "prime-agent-daemon.service": 10000})

    def test_the_chat_path_is_outweighed_below_the_root_at_no_level(self):
        system, user = weights("SYSTEM"), weights("USER")
        self.assertGreater(system["user@1001.service"], 100)
        self.assertEqual(user["sieun-pi-chat.service"], max(user.values()))

    def test_every_unit_a_sw_factory_search_or_page_call_waits_on_runs_at_the_chat_weight(self):
        user = weights("USER")
        for unit in ("sieun-pi-apps-chat.service", "pi-host.service", "pi-host-relay.service", "meilisearch.service"):
            self.assertEqual(user[unit], user["sieun-pi-apps-chat.service"], unit)

    def test_busy_ci_outweighs_the_agents_and_system_and_dev_keep_their_old_floor(self):
        system = weights("SYSTEM")
        ci_at_root = system["virev.slice"] * system["virev-ci.slice"] / (system["virev-ci.slice"] + system["virev-prod.slice"])
        self.assertEqual(ci_at_root, 2 * system["user.slice"])
        root = system["user.slice"] + system["virev.slice"] + system["system.slice"] + system["dev.slice"]
        old_floor = 80 * 100 / 1600
        for unit in ("system.slice", "dev.slice"):
            self.assertGreaterEqual(80 * system[unit] / root, old_floor)
        self.assertNotIn("machine.slice", system)

    def test_no_unit_gets_a_cap(self):
        for path in (p for p in CPU.iterdir() if p.is_file()):
            self.assertNotRegex(path.read_text(), r"CPUQuota|AllowedCPUs|cpu\.max|MemoryMax", path.name)

    def test_files_cite_the_page(self):
        for name in ("cpu-protect.py", "setup-cpu.sh"):
            self.assertIn("https://cho.sh/ko/1983DC", (CPU / name).read_text(), name)


if __name__ == "__main__":
    unittest.main()
