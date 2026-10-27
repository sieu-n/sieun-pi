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


class DevServerScores(unittest.TestCase):
    def test_every_dev_server_process_goes_to_minus_500_and_a_raised_one_stays(self):
        units = {"auto-sns-dev-pm2.service": {50: "PM2 v6.0.8: God", 51: "node-MainThread", 52: "esbuild", 53: "chrome"},
                 "llm-wiki.service": {60: "node-MainThread", 61: "sh"}}
        current = {50: 200, 51: 200, 52: -500, 53: 300, 60: 200, 61: -900}
        self.assertEqual(oom.plan(units, {"llm-wiki.service": 60}, current), {50: -500, 51: -500, 60: -500, 61: -500})


class RunawaySession(unittest.TestCase):
    # 10-26 in small: worker 11 with its kernel 12 in session 11, a pytest command in session 20, and a recursive bash
    # command in session 30 whose forks are each smaller than the kernel and together larger.
    procs = {10: "prime-agent", 11: "prime-agent", 12: "python", 20: "bash", 21: "pytest", 30: "bash", 31: "bash", 32: "bash", 33: "bash"}
    sessions = {10: 10, 11: 11, 12: 11, 20: 20, 21: 20, 30: 30, 31: 30, 32: 30, 33: 30}

    def test_a_fork_tree_larger_than_any_one_process_outside_it_goes_first(self):
        memory = {10: 900, 11: 500, 12: 5000, 20: 4, 21: 700, 30: 1500, 31: 1600, 32: 1700, 33: 1800}
        self.assertEqual(oom.runaway(self.procs, 10, self.sessions, memory), 30)

    def test_no_session_goes_first_while_one_process_outside_holds_more(self):
        memory = {10: 900, 11: 500, 12: 9000, 20: 4, 21: 700, 30: 1500, 31: 1600, 32: 1700, 33: 1800}
        self.assertIsNone(oom.runaway(self.procs, 10, self.sessions, memory))

    def test_a_worker_session_with_its_kernels_is_never_marked(self):
        memory = {10: 900, 11: 500, 12: 90000, 20: 4, 21: 700, 30: 1, 31: 1, 32: 1, 33: 1}
        self.assertIsNone(oom.runaway(self.procs, 10, self.sessions, memory))

    def test_the_marked_session_goes_to_1000_and_a_mark_that_moved_on_goes_back_to_200(self):
        units = {"prime-agent-daemon.service": self.procs}
        current = {10: -900, 11: -500, 12: 200, 20: 1000, 21: 1000, 30: 200, 31: 200, 32: 1000, 33: 500}
        writes = oom.plan(units, {"prime-agent-daemon.service": 10}, current, frozenset({30, 31, 32, 33}))
        self.assertEqual(writes, {20: 200, 21: 200, 30: 1000, 31: 1000, 33: 1000})


class LoginScopes(unittest.TestCase):
    # 10-27 in small: a supervisor (70) that a command over ssh started in session-c155369.scope, with a worker (71), its
    # kernel (72) and an agent command (73, session 73) that all inherited tailscaled's -500, beside another ssh login
    # whose carrier (80) keeps -500 and whose command (81) goes back to 200.
    units = {
        "prime-agent-daemon.service": {10: "prime-agent"},
        "session-c155369.scope": {69: "tailscaled", 70: "prime-agent", 71: "prime-agent", 72: "python", 73: "bash", 74: "node-MainThread"},
        "session-c158784.scope": {80: "tailscaled", 81: "python3"},
    }
    current = {10: -500, 69: -500, 70: -500, 71: -500, 72: -500, 73: -500, 74: -500, 80: -500, 81: -500}

    def test_a_command_over_ssh_goes_back_to_200_and_its_carrier_keeps_its_score(self):
        units = {"session-c158784.scope": self.units["session-c158784.scope"]}
        self.assertEqual(oom.plan(units, {}, self.current), {81: 200})

    def test_the_scope_of_a_supervisor_started_over_ssh_is_scored_as_the_daemon(self):
        scope = oom.daemon_scope(self.units, 70)
        self.assertEqual(scope, "session-c155369.scope")
        units = oom.with_scope_as_daemon(self.units, scope)
        self.assertNotIn(scope, units)
        writes = oom.plan(units, {"prime-agent-daemon.service": 70}, self.current, frozenset({73, 74}))
        self.assertEqual(writes, {70: -900, 72: 200, 73: 1000, 74: 1000, 81: 200})

    def test_its_agent_command_tree_can_be_marked_and_its_kernels_cannot(self):
        units = oom.with_scope_as_daemon(self.units, "session-c155369.scope")
        procs = units["prime-agent-daemon.service"]
        sessions = {10: 10, 69: 69, 70: 69, 71: 71, 72: 71, 73: 73, 74: 73}
        memory = {10: 900, 69: 10, 70: 900, 71: 500, 72: 3000, 73: 2000, 74: 2000}
        self.assertEqual(oom.runaway(procs, 70, sessions, memory), 73)

    def test_a_supervisor_inside_its_unit_leaves_the_login_scopes_alone(self):
        self.assertIsNone(oom.daemon_scope(self.units, 10))
        self.assertIs(oom.with_scope_as_daemon(self.units, None), self.units)


class KillSessionHook(unittest.TestCase):
    def test_it_kills_only_the_marked_session_members_that_still_carry_the_mark(self):
        spec = importlib.util.spec_from_file_location("oom_kill_session", MEM / "oom-kill-session.py")
        hook = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hook)
        with tempfile.TemporaryDirectory() as proc:
            for pid, sid, adj in ((40, 40, 1000), (41, 40, 1000), (42, 40, 200), (43, 43, 1000), (44, 40, 1000)):
                os.makedirs(f"{proc}/{pid}")
                Path(f"{proc}/{pid}/stat").write_text(f"{pid} (ba sh) S 1 {sid} {sid} 0 -1\n")
                Path(f"{proc}/{pid}/oom_score_adj").write_text(f"{adj}\n")
            os.makedirs(f"{proc}/self")
            self.assertEqual(sorted(hook.members(40, proc)), [40, 41, 44])

    def test_earlyoom_runs_it_after_each_kill_and_its_unit_has_no_memory_or_task_cap(self):
        args = earlyoom_args()
        self.assertEqual(args[args.index("-N") + 1], "/usr/local/lib/oom-protect/oom-kill-session.py")
        conf = (MEM / "earlyoom-limits.conf").read_text()
        self.assertEqual(re.findall(r"^(\w+)=(\S+)$", conf, re.M), [("MemoryMax", "infinity"), ("TasksMax", "infinity")])
        setup = (MEM / "setup-memory.sh").read_text()
        for line in ('install -m 755 "$here/oom-kill-session.py" /usr/local/lib/oom-protect/oom-kill-session.py',
                     'install -m 644 "$here/earlyoom-limits.conf" /etc/systemd/system/earlyoom.service.d/limits.conf'):
            self.assertIn(line, setup)


class EarlyoomConfig(unittest.TestCase):
    def test_thresholds_are_the_pages_5_and_2_percent(self):
        args = earlyoom_args()
        self.assertEqual(args[args.index("-m") + 1], "5,2")
        self.assertEqual(args[args.index("-s") + 1], "5,2")

    def test_avoid_and_prefer_match_the_comm_names_seen_on_us_metal02(self):
        args = earlyoom_args()
        avoid, prefer = re.compile(args[args.index("--avoid") + 1]), re.compile(args[args.index("--prefer") + 1])
        for comm in ("systemd", "sshd", "sshd-session", "tailscaled", "dockerd", "containerd", "containerd-shim", "earlyoom", "prime-agent", "qemu:ci-g17"):
            self.assertTrue(avoid.search(comm), comm)
            self.assertFalse(prefer.search(comm), comm)
        for comm in ("qemu-system-x86", "vitest", "pytest", "svelte-check"):
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


class ThpDefrag(unittest.TestCase):
    def test_defer_at_boot_and_from_setup(self):
        unit = (MEM / "thp-defrag.service").read_text()
        self.assertIn("echo defer > /sys/kernel/mm/transparent_hugepage/defrag", unit)
        self.assertIn("WantedBy=sysinit.target", unit)
        setup = (MEM / "setup-memory.sh").read_text()
        for line in ('install -m 644 "$here/thp-defrag.service" /etc/systemd/system/thp-defrag.service',
                     "systemctl enable thp-defrag.service", "systemctl restart thp-defrag.service"):
            self.assertIn(line, setup)


class Sysctls(unittest.TestCase):
    def test_values_and_the_owner_ask(self):
        text = (MEM / "90-agent-memory.conf").read_text()
        values = dict(re.findall(r"^(vm\.\w+) = (\d+)$", text, re.M))
        self.assertEqual(values, {"vm.swappiness": "100", "vm.watermark_scale_factor": "125", "vm.min_free_kbytes": "1048576"})
        self.assertIn("https://cho.sh/ko/1983DC", text)


class OomPolicy(unittest.TestCase):
    def test_a_kernel_oom_kill_in_the_daemon_or_chat_unit_ends_only_its_pick(self):
        for unit in ("legacy/prime/deploy/prime-agent-daemon.service", "deploy/linux/sieun-pi-chat.service"):
            service = (ROOT / unit).read_text().split("[Service]", 1)[1].split("\n[", 1)[0]
            self.assertEqual(re.findall(r"^OOMPolicy=(\S+)$", service, re.M), ["continue"], unit)


if __name__ == "__main__":
    unittest.main()
