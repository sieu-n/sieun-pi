"""Stalled tools on us-metal02, 10-24: a git grep and a reach.py under two code cut 3 subagents burned 2.7 and 0.95 cores for over an
hour while their sessions wrote nothing. The watchdog said nothing useful, for three reasons this file covers.

1. Its swap and load caps were hard gates: from 10-19 16:53Z to 10-24 08:46Z they skipped 14,649 actions at 16 to 80 GiB swap used,
   while 132 GiB RAM sat free and the load sat near 200 on 80 cores. Owner rule c98 makes every sieun-pi limit a soft cap.
2. A subagent shares its worker, so the worker's busy descendants could not say whose tool was running. The kernel's harness dir names
   its session, so the CHILD_WEDGED notice now names the pid that burns CPU.
3. Every probe read stalled while pi-pool queued it (covered in test_probe.py)."""
import json, subprocess, sys, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_pool_wait  # noqa: E402
import watchdog  # noqa: E402
import wd_procs as wd  # noqa: E402

A, B = '01a16c6c-fa4a-74ad-9e4a-b6d81740a865', '01a16c6c-f299-718e-8c59-f81bb54172eb'
PS = """\
  100     1 Ss   09:00:00  0:05.00  1.0 prime-agent --mode daemon --daemon-socket worker.sock
  200   100 S    09:00:00  0:02.00  0.1 /home/me/.prime/agent/kernel-venv/bin/python -m rlm.repl
  210   100 S    09:00:00  0:02.00  0.1 /home/me/.prime/agent/kernel-venv/bin/python -m rlm.repl
  300   200 S       48:08  0:00.01  0.0 /bin/bash -c exec 9>&0 8>&1 0</dev/null
  301   300 R       48:08 56:49.00 118.0 real-git grep -I -n -w -F -f fnames.txt origin/dev/sieun-mac-a -- apps/virev-demo
  310   210 S       30:00  0:00.01  0.0 /bin/bash -c exec 9>&0 8>&1 0</dev/null
  311   310 S       30:00  0:00.01  0.0 sleep 3600
"""


def fake_run(argv, *a, **k):
    return subprocess.CompletedProcess(argv, 0, PS if list(argv)[:2] == ['ps', '-A'] else '', '')


class BusyTools(unittest.TestCase):
    def setUp(self):
        self.real = subprocess.run
        subprocess.run = fake_run

    def tearDown(self):
        subprocess.run = self.real

    def test_the_tool_is_read_from_the_kernel_of_that_session_only(self):
        kernels = {'200': A, '210': B}.get
        got = wd.session_busy_tools('100', A, read_session=kernels)
        self.assertEqual([(p, round(secs), cmd.split()[0]) for p, secs, _, cmd in got], [('301', 3409, 'real-git')])
        self.assertEqual(wd.session_busy_tools('100', B, read_session=kernels), [], 'a sleeping tool burns no CPU')

    def test_the_session_comes_from_the_last_id_in_the_harness_dir(self):
        harness = f'/home/me/.prime/agent/session-artifacts/01a15c6c-8bec-71fe-b7d3-1fac79a315c9/session-artifacts/{A}/harness'
        kernel = subprocess.Popen(['sleep', '30'], env={'RLM_HARNESS_STATE_DIR': harness})
        try:
            self.assertEqual(wd.kernel_session(kernel.pid), A)
        finally:
            kernel.kill()
            kernel.wait()
        self.assertIsNone(wd.kernel_session(999999999))

    def test_a_silent_subagent_with_a_busy_tool_names_the_pid_to_stop(self):
        r = {'id': 'x', 'sid': A, 'name': 'cut-convex-dead', 'life': 'live', 'act': 'working', 'depth': 1, 'stale_min': 48,
             'last_asst_min': 48, 'awaiting_min': None, 'compact': False, 'busy_procs': ['real-git grep cpu=3409s 118.0%'],
             'own_busy': ['pid 301 (real-git grep -I -n -w -F -f fnames.txt, 57 CPU-min in 48:08)'], 'tls': 0, 'tools': True, 'bash': True,
             'streaming': True, 'pid': '100', 'stopped': None}
        v, why = watchdog.classify(r, {})
        self.assertEqual(v, 'CHILD_WEDGED')
        self.assertIn('pid 301', why)


class PressureIsSoft(test_pool_wait.PoolHeld):
    """The same lost turn as test_pool_wait, on a box at 70 GiB swap and load 200: it is resumed, and the overrun is logged."""

    def setUp(self):
        super().setUp()
        watchdog.pressure = lambda: (70.0, 200.0)

    def test_a_lost_turn_is_resumed_over_the_pressure_targets(self):
        verdict, sends, _ = self.cycle([])
        self.assertEqual((verdict, len(sends)), ('DROPPED_TURN', 1))
        rows = [json.loads(ln) for ln in watchdog.LOG_F.read_text().splitlines()]
        self.assertEqual(sorted(r['over'] for r in rows if 'over' in r), ['load', 'swap'])
        self.assertFalse([r for r in rows if r.get('skip') in ('swap', 'load')])


if __name__ == '__main__':
    unittest.main()
