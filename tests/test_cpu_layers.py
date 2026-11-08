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
CHAT_SERVE = ["/home/sieun/.local/node/bin/node", "/home/sieun/.local/share/sieun-pi-chat/current/legacy/prime/user-history/src/chat-service-cli.mjs", "serve", "--port", "5182"]


class CpuProtectPlan(unittest.TestCase):
    """The worker f2f8b4ebd885 stall of 11-02 18:08Z (5,049 ms, 1,418 ms waiting for a CPU) in a daemon cgroup of 253 processes, and the 14 worker
    stalls of 5 to 65.6 s at 01:55 to 01:58Z on 11-04 with the control loop in user.slice at 1000 against virev.slice at 10000."""

    def test_the_control_loop_moves_to_agents_slice_and_every_command_it_starts_to_the_tools_scope(self):
        daemon = {10: (1, SUPERVISOR), 11: (10, WORKER), 20: (11, ["/home/sieun/.prime/agent/kernel-venv/bin/python", "-m", "rlm.repl"]),
                  21: (20, ["/bin/bash", "-c", "pytest"]), 22: (1, ["node", "server.mjs"]), 23: (11, ["/usr/local/bin/pi-pool-token", "get"])}
        core = {12: (10, WORKER), 24: (12, ["/bin/bash", "-c", "vitest run"])}
        self.assertEqual(cpu.plan({cpu.DAEMON: daemon, cpu.CORE: core}, {cpu.DAEMON: 10}, PUBLIC),
                         {cpu.CORE: [10, 11, 23], cpu.TOOLS: [20, 21, 22, 24]})

    def test_a_supervisor_moves_only_once_it_is_the_main_pid_so_systemd_reads_its_pidfile_in_the_unit(self):
        daemon = {10: (1, SUPERVISOR)}
        self.assertEqual(cpu.plan({cpu.DAEMON: daemon, cpu.CORE: {9: (1, SUPERVISOR)}}, {cpu.DAEMON: 9}, PUBLIC), {})
        self.assertEqual(cpu.plan({cpu.DAEMON: daemon}, {cpu.DAEMON: None}, PUBLIC), {})
        self.assertEqual(cpu.plan({cpu.TOOLS: {12: (1, SUPERVISOR)}, cpu.CORE: {13: (1, SUPERVISOR)}}, {cpu.DAEMON: 10}, PUBLIC),
                         {cpu.DAEMON: [12, 13]})

    def test_a_reload_keeps_the_ctl_and_what_it_starts_in_the_unit(self):
        daemon = {10: (1, SUPERVISOR), 30: (1, CTL), 31: (30, ["/home/sieun/.local/bin/prime-agent", "update", "--self"]), 32: (30, SUPERVISOR)}
        self.assertEqual(cpu.plan({cpu.DAEMON: daemon}, {cpu.DAEMON: 10}, PUBLIC), {cpu.CORE: [10]})

    def test_a_test_daemon_on_another_socket_stays_a_command(self):
        test_daemon = ["/home/sieun/.local/share/prime-agent/releases/r1/prime-agent", "--mode", "daemon", "--daemon-socket", "/tmp/x/prime-agent-1001/daemon.sock"]
        groups = {cpu.DAEMON: {40: (20, test_daemon)}, cpu.TOOLS: {41: (20, test_daemon)}}
        self.assertEqual(cpu.plan(groups, {cpu.DAEMON: 10}, PUBLIC), {cpu.TOOLS: [40]})

    def test_the_catalogs_the_supervisor_starts_join_it_and_one_in_the_tools_scope_goes_back(self):
        """The name catalog waited 13.3 s in the run queue per CPU-second in the tools scope, and a rename waited 2,767 ms on 11-03 at 23:37Z."""
        catalog = ["/home/sieun/.local/share/prime-agent/releases/r1/prime-agent", "--version"]
        core = {10: (1, SUPERVISOR), 11: (10, WORKER), 12: (10, catalog), 20: (11, ["/bin/bash", "-c", "prime-agent --version"]), 21: (20, catalog)}
        groups = {cpu.CORE: core, cpu.TOOLS: {13: (10, catalog), 22: (20, catalog)}}
        self.assertEqual(cpu.plan(groups, {cpu.DAEMON: 10}, PUBLIC), {cpu.TOOLS: [20, 21], cpu.CORE: [13]})

    def test_a_service_main_process_moves_to_its_core_scope_and_its_helpers_go_back_to_the_unit(self):
        unit, scope = "sieun-pi-chat.service", "sieun-pi-chat-core.scope"
        groups = {unit: {50: (2, CHAT_SERVE), 51: (52, ["git", "status"])}, scope: {52: (2, CHAT_SERVE), 53: (52, ["python3", "precheck.py"])}}
        self.assertEqual(cpu.plan(groups, {unit: 52}, PUBLIC), {unit: [53]})
        self.assertEqual(cpu.plan(groups, {unit: 50}, PUBLIC), {scope: [50], unit: [52, 53]})
        self.assertEqual(cpu.plan(groups, {unit: None}, PUBLIC), {})

    def test_the_batch_indexers_stay_in_user_slice(self):
        """meilisearch's and pi-history's index threads ran 92% and 94% of their CPU on 11-04."""
        self.assertNotIn("meilisearch.service", cpu.SERVICES)
        self.assertNotIn("pi-history.service", cpu.SERVICES)

    def test_systemd_is_asked_again_only_when_a_main_pid_may_have_changed(self):
        steady = {cpu.CORE: {10: (1, SUPERVISOR), 11: (10, WORKER)}, "sieun-pi-chat-core.scope": {52: (2, CHAT_SERVE)},
                  "sieun-pi-chat.service": {53: (52, ["git", "status"]), 54: (2, ["ssh", "-M"])}}
        self.assertEqual(cpu.candidates(steady, 2, PUBLIC), {(cpu.DAEMON, 10), ("sieun-pi-chat.service", 52), ("sieun-pi-chat.service", 54)})
        reload = {**steady, cpu.DAEMON: {30: (1, CTL), 12: (30, SUPERVISOR)}}
        self.assertEqual(cpu.candidates(reload, 2, PUBLIC), cpu.candidates(steady, 2, PUBLIC))

    def test_a_service_main_process_stays_in_its_unit_until_systemd_counts_it_started(self):
        """On 11-08 the chat's READY=1 came from a child in its core scope, which systemd --user drops, and its starts hung 5 to 7.5 min."""
        out = ("Id=prime-agent-daemon.service\nActiveState=reloading\nMainPID=10\n\n"
               "Id=sieun-pi-chat.service\nActiveState=activating\nMainPID=50\n\n"
               "Id=sieun-pi-apps-chat.service\nActiveState=active\nMainPID=60\n\n"
               "Id=pi-host.service\nActiveState=inactive\nMainPID=0\n")
        units = (cpu.DAEMON, "sieun-pi-chat.service", "sieun-pi-apps-chat.service", "pi-host.service")
        mains = cpu.parse_mains(out, units)
        self.assertEqual(mains, {cpu.DAEMON: 10, "sieun-pi-chat.service": None, "sieun-pi-apps-chat.service": 60, "pi-host.service": None})
        self.assertEqual(cpu.plan({"sieun-pi-chat.service": {50: (2, CHAT_SERVE)}}, mains, PUBLIC), {})
        started = cpu.parse_mains(out.replace("ActiveState=activating", "ActiveState=active"), units)
        self.assertEqual(cpu.plan({"sieun-pi-chat.service": {50: (2, CHAT_SERVE)}}, started, PUBLIC), {"sieun-pi-chat-core.scope": [50]})

    def test_a_pass_asks_systemd_again_while_a_service_with_a_candidate_is_starting(self):
        asks = []
        main_pids, cpu.main_pids = cpu.main_pids, lambda: asks.append(1) or {cpu.DAEMON: None, "sieun-pi-chat.service": None}
        procs, cpu.procs = cpu.procs, lambda path, only_comm=None: {50: (2, CHAT_SERVE)} if path == "chat" else {}
        try:
            paths = {"sieun-pi-chat.service": "chat"}
            known = cpu.run_once(paths, ({}, frozenset()), 2, PUBLIC)
            cpu.run_once(paths, known, 2, PUBLIC)
        finally:
            cpu.main_pids, cpu.procs = main_pids, procs
        self.assertEqual(len(asks), 2)

    def test_a_process_systemd_forked_stays_put_until_it_runs_its_command(self):
        """A Type=simple start moved before it ran node failed with status=219/CGROUP at 09:29:13Z on 11-08."""
        moved = []
        saved = cpu.main_pids, cpu.procs, cpu.read, cpu.move
        cpu.main_pids = lambda: {cpu.DAEMON: None, "pi-host.service": 50}
        cpu.procs = lambda path, only_comm=None: {50: (2, ["/home/sieun/.local/node/bin/node", "main.ts"])} if path == "unit" else {}
        cpu.move = lambda pid, cgroup, source: moved.append((pid, cgroup)) or True
        try:
            for comm in ("(node)\n", "node\n"):
                cpu.read = lambda path, comm=comm: comm if path.endswith("/comm") else None
                cpu.run_once({"pi-host.service": "unit", "pi-host-core.scope": "."}, ({}, frozenset({("", 0)})), 2, PUBLIC)
        finally:
            cpu.main_pids, cpu.procs, cpu.read, cpu.move = saved
        self.assertEqual(moved, [(50, ".")])

    def test_the_scopes_run_at_the_default_weight_with_no_cap(self):
        text = (CPU / "cpu-protect.py").read_text()
        self.assertNotIn('"CPUWeight"', text)
        self.assertIn('"OOMPolicy", "s", "continue"', text)


class Setup(unittest.TestCase):
    def test_logins_get_1000_and_the_chat_and_daemon_the_most_systemd_takes(self):
        self.assertEqual(weights("SYSTEM"), {"ssh.service": 1000, "tailscaled.service": 1000, "user.slice": 1000, "user@1001.service": 10000,
                                             "virev.slice": 10000, "virev-prod.slice": 300, "virev-ci.slice": 300,
                                             "system.slice": 400, "dev.slice": 400, "agents.slice": 10000})
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

    def test_busy_ci_outweighs_the_agents_tools_and_the_control_loop_meets_ci_as_an_equal(self):
        """t68 ranks CI above dev box work; the 01:55Z 11-04 stalls came from the control loop sharing user.slice's 1000 with the tools."""
        system = weights("SYSTEM")
        ci_at_root = system["virev.slice"] * system["virev-ci.slice"] / (system["virev-ci.slice"] + system["virev-prod.slice"])
        self.assertEqual(ci_at_root, 5 * system["user.slice"])
        self.assertEqual(system["agents.slice"], system["virev.slice"])
        self.assertNotIn("machine.slice", system)

    def test_agents_slice_is_installed_with_no_setting_of_its_own(self):
        text = (CPU / "agents.slice").read_text()
        self.assertIn("[Slice]", text)
        self.assertNotRegex(text, r"(?m)^(CPUWeight|Memory\w*|Tasks\w*)=")
        self.assertIn('install -m 644 "$here/agents.slice" /etc/systemd/system/agents.slice', (CPU / "setup-cpu.sh").read_text())

    def test_no_unit_gets_a_cap(self):
        for path in (p for p in CPU.iterdir() if p.is_file()):
            self.assertNotRegex(path.read_text(), r"CPUQuota|AllowedCPUs|cpu\.max|MemoryMax", path.name)

    def test_files_cite_the_page(self):
        for name in ("cpu-protect.py", "setup-cpu.sh"):
            self.assertIn("https://cho.sh/ko/1983DC", (CPU / name).read_text(), name)


if __name__ == "__main__":
    unittest.main()
