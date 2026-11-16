"""Frontend bro on the Mac, 11-16: its kernel lost its request reader (EBADF in rlm.repl `_read_requests`) at about 10:23Z, so the
`agent_message.send` in its running cell waited 11.7 h for a host reply that could never be read. Its worker also ran a busy subagent,
so the watchdog took the shared-worker path, found no pipe holder or parked shell, and sent 85 steers, each saying "I stopped the
stuck worker and restarted you"; 16 landed and filled the queue to the daemon's limit of 20, and nothing was stopped.

1. kernel_session read /proc only, so on the Mac it named no session for any kernel; it now falls back to `ps -E`.
2. A frozen call with no process under it gets its kernel interrupted (SIGUSR2), and SIGTERM when the same kernel froze again.
3. A steer that stops nothing says so."""
import json, signal, subprocess, sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import watchdog  # noqa: E402
import wd_procs as wd  # noqa: E402

ROOT, CHILD = '01a11ba8-9d2c-727c-8ded-38f819ca9f29', '01a1e373-e439-761d-ad10-5c48b2d6a774'
PS = """\
54592     1 Ss   11:59:52  8:21.27  0.6 prime-agent --mode daemon --daemon-socket worker-bab13329a1b8-f6e0d0592a51.sock
54636 54592 S    11:59:52  0:05.47  0.0 /Users/sieunpark/.prime/agent/kernel-venv/bin/python -m rlm.repl
40732 54592 S    01:20:00  0:02.00  0.1 /Users/sieunpark/.prime/agent/kernel-venv/bin/python -m rlm.repl
"""
MAC_ENV = {
    '54636': f'python -m rlm.repl RLM_SESSION_DIR=/Users/me/.prime/agent/session-artifacts/{ROOT} '
             f'RLM_HARNESS_STATE_DIR=/Users/me/.prime/agent/session-artifacts/{ROOT}/harness',
    '40732': f'python -m rlm.repl RLM_HARNESS_STATE_DIR=/Users/me/.prime/agent/session-artifacts/{ROOT}/session-artifacts/{CHILD}/harness',
}


class NoProc:
    """A Path stand-in for a box with no /proc, as on the Mac."""

    def __init__(self, path):
        self.path = path

    def read_bytes(self):
        raise FileNotFoundError(self.path)

    def exists(self):
        return False


def fake_run(argv, *a, **k):
    argv = list(argv)
    if argv[:2] == ['ps', '-A']:
        return subprocess.CompletedProcess(argv, 0, PS, '')
    if argv[:2] == ['ps', '-E']:
        return subprocess.CompletedProcess(argv, 0, MAC_ENV.get(argv[-1], ''), '')
    return subprocess.CompletedProcess(argv, 0, '', '')


class MacKernels(unittest.TestCase):
    def setUp(self):
        self.run, self.path = subprocess.run, wd.Path
        subprocess.run, wd.Path = fake_run, NoProc

    def tearDown(self):
        subprocess.run, wd.Path = self.run, self.path

    def test_the_session_of_a_kernel_reads_from_ps_on_the_mac(self):
        self.assertEqual(wd.kernel_session('54636'), ROOT)
        self.assertEqual(wd.kernel_session('40732'), CHILD)
        self.assertIsNone(wd.kernel_session('1'))

    def test_the_root_kernel_is_found_among_its_subagents(self):
        self.assertEqual(wd.session_kernel('54592', ROOT), '54636')
        self.assertEqual(wd.session_kernel('54592', CHILD), '40732')


class Interrupt(unittest.TestCase):
    def test_the_first_interrupt_keeps_the_kernel_and_a_second_ends_it(self):
        sent = []
        self.assertEqual(wd.interrupt_cell('54636', kill=lambda pid, sig: sent.append((pid, sig))), 'SIGUSR2')
        self.assertEqual(wd.interrupt_cell('54636', again=True, kill=lambda pid, sig: sent.append((pid, sig))), 'SIGTERM')
        self.assertEqual(sent, [(54636, signal.SIGUSR2), (54636, signal.SIGTERM)])


class Nudge(unittest.TestCase):
    def setUp(self):
        self.saved = {name: getattr(watchdog, name) for name in ('unblock', 'kill_stuck_cell', 'session_kernel', 'interrupt_cell', 'pa', 'LOG_F')}
        self.log = Path(tempfile.mkdtemp()) / 'log.jsonl'
        self.signals, self.sends = [], []
        watchdog.unblock = lambda pid: ([], [])
        watchdog.kill_stuck_cell = lambda pid, min_age_min=20: []
        watchdog.session_kernel = lambda worker, sid: '54636' if sid == ROOT else None
        watchdog.interrupt_cell = lambda kernel, again=False: self.signals.append((kernel, again)) or ('SIGTERM' if again else 'SIGUSR2')
        watchdog.pa = lambda *args, **k: self.sends.append(args) or subprocess.CompletedProcess(args, 0, '', '')
        watchdog.LOG_F = self.log

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(watchdog, name, value)

    def row(self, sid=ROOT):
        return {'id': 'aa77bb6cfbb6', 'sid': sid, 'name': 'designer bro, works on 5180 only', 'depth': 0, 'stale_min': 54.6, 'pid': '54592',
                'tools': True, 'bash': False}

    def test_a_frozen_call_gets_its_kernel_interrupted_then_ended(self):
        first = watchdog.nudge(self.row(), 'tool marked running 54.6m with no live process', shared_worker=True)
        self.assertEqual((first['method'], first['kernel'], first['signal']), ('interrupt-cell', '54636', 'SIGUSR2'))
        second = watchdog.nudge(self.row(), 'tool marked running 65.0m with no live process', shared_worker=True)
        self.assertEqual(second['signal'], 'SIGTERM')
        self.assertEqual(self.signals, [('54636', False), ('54636', True)])
        self.assertEqual(len(self.log.read_text().splitlines()), 2)
        self.assertTrue(all('--steer' in args and 'restarted you' not in args[-1] for args in self.sends))

    def test_a_steer_that_stops_nothing_says_so(self):
        out = watchdog.nudge(self.row(sid=CHILD), 'tool marked running 54.6m with no live process', shared_worker=True)
        self.assertEqual(out['method'], 'steer')
        self.assertEqual(self.signals, [])
        self.assertIn('this message is all I did', self.sends[0][-1])
        self.assertNotIn('restarted', self.sends[0][-1])


if __name__ == '__main__':
    unittest.main()
