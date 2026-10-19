import importlib.util
import os
import re
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEM = ROOT / "deploy/linux/memory"
spec = importlib.util.spec_from_file_location("oom_protect", MEM / "oom-protect.py")
oom = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oom)


def earlyoom_args() -> list[str]:
    line = next(l for l in (MEM / "earlyoom.default").read_text().splitlines() if l.startswith("EARLYOOM_ARGS="))
    return shlex.split(shlex.split(line.split("=", 1)[1])[0])


class OomProtectPlan(unittest.TestCase):
    def test_core_mains_get_minus_900_workers_minus_500_and_children_go_back_to_200(self):
        units = {
            "prime-agent-daemon.service": {10: "prime-agent", 11: "prime-agent", 12: "python3", 13: "bash"},
            "sieun-pi-chat.service": {20: "node-MainThread", 21: "node-MainThread"},
            "pi-pool-serve.service": {30: "python3"},
            "pi-pool-hookd.service": {40: "python3", 41: "python3"},
        }
        mains = {"prime-agent-daemon.service": 10, "sieun-pi-chat.service": 20, "pi-pool-serve.service": 30, "pi-pool-hookd.service": 40}
        current = {10: 200, 11: 200, 12: -500, 13: 200, 20: 200, 21: -900, 30: 200, 40: -900, 41: -900}
        self.assertEqual(oom.plan(units, mains, current), {10: -900, 11: -500, 12: 200, 20: -900, 21: 200, 30: -900, 41: 200})

    def test_a_converged_box_needs_no_writes_and_a_raised_score_stays(self):
        units = {"prime-agent-daemon.service": {10: "prime-agent", 12: "python3"}, "sieun-pi-chat.service": {20: "node-MainThread"}}
        mains = {"prime-agent-daemon.service": 10, "sieun-pi-chat.service": 20}
        self.assertEqual(oom.plan(units, mains, {10: -900, 12: 500, 20: -900}), {})


class EarlyoomConfig(unittest.TestCase):
    def test_thresholds_are_the_pages_5_and_2_percent(self):
        args = earlyoom_args()
        self.assertEqual(args[args.index("-m") + 1], "5,2")
        self.assertEqual(args[args.index("-s") + 1], "5,2")

    def test_avoid_and_prefer_match_the_comm_names_seen_on_us_metal02(self):
        args = earlyoom_args()
        avoid, prefer = re.compile(args[args.index("--avoid") + 1]), re.compile(args[args.index("--prefer") + 1])
        for comm in ("systemd", "sshd", "sshd-session", "tailscaled", "dockerd", "containerd", "containerd-shim", "earlyoom", "prime-agent"):
            self.assertTrue(avoid.search(comm), comm)
        for comm in ("qemu:ci-g17", "qemu-system-x86", "vitest", "svelte-check"):
            self.assertTrue(prefer.search(comm), comm)
        for comm in ("node-MainThread", "python3", "chrome"):
            self.assertFalse(avoid.search(comm) or prefer.search(comm), comm)


class Heavy(unittest.TestCase):
    def run_heavy(self, *args: str, path: str) -> subprocess.CompletedProcess:
        return subprocess.run(["/bin/sh", str(MEM / "heavy"), *args], capture_output=True, text=True, env={"PATH": path})

    def test_without_systemd_run_it_runs_the_command_as_is(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.symlink("/bin/echo", Path(tmp) / "echo")
            done = self.run_heavy("1G", "--", "echo", "ran", path=tmp)
        self.assertEqual((done.returncode, done.stdout), (0, "ran\n"))

    def test_a_missing_command_is_a_usage_error(self):
        self.assertEqual(self.run_heavy("1G", "--", path="/usr/bin:/bin").returncode, 2)
        self.assertEqual(self.run_heavy("1G", path="/usr/bin:/bin").returncode, 2)


class Sysctls(unittest.TestCase):
    def test_values_and_the_owner_ask(self):
        text = (MEM / "90-agent-memory.conf").read_text()
        values = dict(re.findall(r"^(vm\.\w+) = (\d+)$", text, re.M))
        self.assertEqual(values, {"vm.swappiness": "100", "vm.watermark_scale_factor": "125", "vm.min_free_kbytes": "1048576"})
        self.assertIn("https://cho.sh/ko/1983DC", text)


class OomPolicy(unittest.TestCase):
    def test_a_kernel_oom_kill_in_the_daemon_or_chat_unit_ends_only_its_pick(self):
        for unit in ("prime-agent-daemon.service", "sieun-pi-chat.service"):
            service = (ROOT / "deploy/linux" / unit).read_text().split("[Service]", 1)[1].split("\n[", 1)[0]
            self.assertEqual(re.findall(r"^OOMPolicy=(\S+)$", service, re.M), ["continue"], unit)


if __name__ == "__main__":
    unittest.main()
