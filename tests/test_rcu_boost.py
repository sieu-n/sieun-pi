# 10-20 us-metal02: a clickhouse thread preempted in an RCU read section got no CPU from 11:23Z to 13:06Z and grace period g=220375749 hung the box.
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CPU = ROOT / "deploy/linux/cpu"
spec = importlib.util.spec_from_file_location("rcu_boost", CPU / "rcu-boost.py")
rcu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rcu)

# Three records from the 10-20 kernel log (~/work/census-stall-1020/kernel-1000-1340.log), text after the kmsg header.
NORMAL = "rcu:         Tasks blocked on level-1 rcu_node (CPUs 0-15): P1786742/1:b..l"
EXPEDITED = "rcu: INFO: rcu_preempt detected expedited stalls on CPUs/tasks: { P1786742 } 62139 jiffies s: 25006729 root: 0x1/."
OTHER = "task:clickhouse      state:R  running task     stack:0     pid:1786742 tgid:1741459 ppid:1741417 task_flags:0x40044c flags:0x00080800"
FIFO_BOOST = (os.SCHED_FIFO | os.SCHED_RESET_ON_FORK, rcu.BOOST_PRIORITY)


class FakeProc:
    def __init__(self):
        self.threads: dict[int, rcu.Seen] = {}

    def seen(self, tid):
        return self.threads.get(tid)

    def describe(self, tid):
        return "clickhouse in /dev.slice/docker-x.scope"


class FakeSched:
    def __init__(self, policies):
        self.policies = dict(policies)
        self.calls = []

    def get(self, tid):
        if tid not in self.policies:
            raise ProcessLookupError(tid)
        return self.policies[tid]

    def set(self, tid, policy, priority):
        self.calls.append((tid, policy, priority))
        self.policies[tid] = (policy, priority)


def booster(threads, policies, state_file=None):
    proc, sched, lines = FakeProc(), FakeSched(policies), []
    proc.threads.update(threads)
    return rcu.Booster(proc, sched, lines.append, state_file), proc, sched, lines


class Parse(unittest.TestCase):
    def test_both_warning_forms_name_the_blocked_thread_and_other_lines_name_none(self):
        self.assertEqual(rcu.blocked_tids(NORMAL), [1786742])
        self.assertEqual(rcu.blocked_tids(EXPEDITED), [1786742])
        self.assertEqual(rcu.blocked_tids(OTHER), [])
        self.assertEqual(rcu.blocked_tids("rcu: INFO: rcu_preempt detected stalls on CPUs/tasks:"), [])

    def test_several_tasks_and_a_pr_cont_split_record(self):
        self.assertEqual(rcu.blocked_tids("rcu:  Tasks blocked on level-0 rcu_node (CPUs 0-79): P10/1:b..l P20/2:b..l"), [10, 20])
        self.assertEqual(rcu.blocked_tids(" P30/1:b..l P40/1:b..l"), [30, 40])
        self.assertEqual(rcu.blocked_tids("Program P30 started"), [])


class Step(unittest.TestCase):
    boost = rcu.Boost(policy=os.SCHED_OTHER, priority=0, ran_ns=100, started=5)

    def test_a_thread_keeps_fifo_until_it_runs_unless_it_is_exiting(self):
        self.assertEqual(rcu.step(self.boost, rcu.Seen(exiting=False, ran_ns=100, started=5)), "keep")
        self.assertEqual(rcu.step(self.boost, rcu.Seen(exiting=False, ran_ns=101, started=5)), "restore")
        self.assertEqual(rcu.step(self.boost, rcu.Seen(exiting=True, ran_ns=9999, started=5)), "keep")

    def test_a_gone_or_reused_tid_is_dropped(self):
        self.assertEqual(rcu.step(self.boost, None), "drop")
        self.assertEqual(rcu.step(self.boost, rcu.Seen(exiting=False, ran_ns=0, started=6)), "drop")


class Serve(unittest.TestCase):
    def test_the_10_20_reader_runs_at_once_and_a_live_thread_gets_its_policy_back_after_it_ran(self):
        b, proc, sched, lines = booster({1786742: rcu.Seen(True, 50, 7), 99: rcu.Seen(False, 10, 8)},
                                        {1786742: (os.SCHED_OTHER, 0), 99: (os.SCHED_BATCH, 0)})
        timeouts = []
        script = iter([NORMAL, EXPEDITED, " P99/1:b..l", None, None, None])

        def next_message(timeout):
            timeouts.append(timeout)
            message = next(script, StopIteration)
            if message is StopIteration:
                raise EOFError
            if len(timeouts) == 5:
                proc.threads[99] = rcu.Seen(False, 11, 8)
            if len(timeouts) == 6:
                del proc.threads[1786742]
            return message

        with self.assertRaises(EOFError):
            rcu.serve(b, next_message)
        self.assertEqual(timeouts, [None, rcu.CHECK_S, rcu.CHECK_S, rcu.CHECK_S, rcu.CHECK_S, rcu.CHECK_S, None])
        self.assertEqual(sched.calls, [(1786742, *FIFO_BOOST), (99, *FIFO_BOOST), (99, os.SCHED_BATCH, 0)])
        self.assertEqual(b.boosts, {})
        self.assertIn("boosted tid 1786742 (clickhouse in /dev.slice/docker-x.scope) to SCHED_FIFO 1 while it exits", lines[0])

    def test_an_rt_thread_a_gone_thread_and_a_thread_someone_else_changed_are_left_alone(self):
        b, proc, sched, _ = booster({1: rcu.Seen(False, 0, 1), 3: rcu.Seen(False, 0, 3)}, {1: (os.SCHED_RR, 10), 3: (os.SCHED_OTHER, 0)})
        b.on_message("rcu: Tasks blocked on level-1 rcu_node (CPUs 0-15): P1/1:b..l P2/1:b..l P3/1:b..l")
        self.assertEqual(sched.calls, [(3, *FIFO_BOOST)])
        sched.policies[3] = (os.SCHED_FIFO, 50)
        proc.threads[3] = rcu.Seen(False, 1, 3)
        b.settle()
        self.assertEqual(sched.calls, [(3, *FIFO_BOOST)])
        self.assertEqual(b.boosts, {})

    def test_a_restart_takes_back_the_boosts_the_last_run_left(self):
        with tempfile.TemporaryDirectory() as folder:
            state = os.path.join(folder, "run/boosted.json")
            first, _, _, _ = booster({5: rcu.Seen(False, 0, 9)}, {5: (os.SCHED_OTHER, 0)}, state)
            first.on_message(EXPEDITED.replace("1786742", "5"))
            self.assertEqual(json.load(open(state)), {"5": {"policy": os.SCHED_OTHER, "priority": 0, "ran_ns": 0, "started": 9}})
            second, proc, sched, _ = booster({5: rcu.Seen(False, 3, 9)}, {5: FIFO_BOOST}, state)
            second.load()
            second.settle()
            self.assertEqual(sched.calls, [(5, os.SCHED_OTHER, 0)])
            self.assertEqual(json.load(open(state)), {})


class Files(unittest.TestCase):
    def test_the_stall_timeout_is_upstreams_default_and_is_written_to_the_param(self):
        self.assertEqual(rcu.STALL_TIMEOUT_S, 21)
        with tempfile.NamedTemporaryFile("r") as param:
            rcu.set_stall_timeout(param.name)
            self.assertEqual(open(param.name).read(), "21")

    def test_the_unit_runs_the_watcher_at_fifo_and_setup_installs_it(self):
        unit = (CPU / "rcu-boost.service").read_text()
        for line in ("CPUSchedulingPolicy=fifo", "CPUSchedulingPriority=1", "CPUSchedulingResetOnFork=true", "/usr/local/lib/cpu-protect/rcu-boost.py"):
            self.assertIn(line, unit)
        setup = (CPU / "setup-cpu.sh").read_text()
        self.assertIn('install -m 755 "$here/rcu-boost.py" /usr/local/lib/cpu-protect/rcu-boost.py', setup)
        self.assertIn("systemctl enable rcu-boost.service", setup)

    def test_proc_reads_exiting_from_task_flags_like_the_stall_report(self):
        self.assertTrue(0x40044C & rcu.PF_EXITING)


if __name__ == "__main__":
    unittest.main()
