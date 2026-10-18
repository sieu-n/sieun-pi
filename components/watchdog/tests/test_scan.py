"""The process scan reads one ps table and per-pid lsof, never a login shell or a whole-system lsof (us-metal02, 2026-10-18: 49 s CPU per cycle)."""
import json, os, subprocess, sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wd_common  # noqa: E402
import wd_procs as wd  # noqa: E402

PS = """\
  100     1 Ss   01:00:00  0:05.00  0.0 prime-agent worker
  200   100 S    01:00:00  0:02.00  0.0 python -m ipykernel_launcher -f k.json
  300   200 S       40:00  0:00.10  0.0 /bin/bash -c sleep 9999 | cat
  301   300 S       40:00  0:00.00  0.0 sleep 9999
  302   300 R       40:00  1:02.00 50.0 cat
  400     1 S       45:00  0:00.01  0.0 bash -c nohup thing &
  500     1 S       45:00  0:00.01  0.0 grep bash -c
"""
LSOF = {
    '100': "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n"
           "node 100 me 20u IPv4 0x1 0t0 TCP 10.0.0.1:5000->1.2.3.4:443 (ESTABLISHED)\n"
           "node 100 me 21u IPv4 0x2 0t0 TCP 10.0.0.1:5001->1.2.3.4:443 (ESTABLISHED)\n"
           "node 100 me 22u IPv4 0x3 0t0 TCP 127.0.0.1:7000 (LISTEN)\n",
    '200': "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n"
           "python 200 me 1u PIPE 0xaaa 16384 ->0xbbb\n"
           "python 200 me 9r PIPE 0xccc 16384 ->0xddd\n",
    '300': "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n"
           "bash 300 me 1w PIPE 0xccc 16384 ->0xddd\n",
    '400': "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n"
           "bash 400 me 1w PIPE 0xccc 16384 ->0xddd\n",
}
LSOF_USER = LSOF['200'] + LSOF['300'].split('\n', 1)[1] + LSOF['400'].split('\n', 1)[1]


class FakeRun:
    def __init__(self):
        self.calls = []

    def __call__(self, argv, *a, **k):
        argv = list(argv)
        self.calls.append(argv)
        out = ''
        if argv[:2] == ['ps', '-A']:
            out = PS
        elif argv[:3] == ['lsof', '-nP', '-p']:
            out = LSOF.get(argv[3], '')
        elif argv[:3] == ['lsof', '-nP', '-u']:
            out = LSOF_USER
        return subprocess.CompletedProcess(argv, 0, out, '')


class Scan(unittest.TestCase):
    def setUp(self):
        self.real = subprocess.run
        self.fake = FakeRun()
        subprocess.run = self.fake

    def tearDown(self):
        subprocess.run = self.real

    def assert_no_shell_or_full_lsof(self):
        for c in self.fake.calls:
            self.assertNotIn('bash', c[0])
            if c[0] == 'lsof':
                self.assertIn(c[2], ('-p', '-u'), c)

    def test_descendants_walk_one_ps_table(self):
        got = wd._descendants('100')
        self.assertEqual([d[0] for d in got], ['200', '300', '301', '302'])
        self.assertEqual(got[3], ('302', 'R', 62.0, 50.0, 'cat'))
        self.assertEqual(sum(1 for c in self.fake.calls if c[0] == 'ps'), 1)
        self.assert_no_shell_or_full_lsof()

    def test_tls_counts_443_lines_of_one_pid(self):
        self.assertEqual(wd._tls_count('100'), 2)
        self.assertTrue(wd._tls_confirmed('100', gap=0))
        self.assertEqual(self.fake.calls[0], ['lsof', '-nP', '-p', '100'])

    def test_stuck_cell_sees_parked_shell_under_kernel(self):
        got = wd.stuck_cell_procs('100', min_age_min=20)
        self.assertEqual([(c['kernel'], c['pid'], c['children']) for c in got], [('200', '300', ['301', '302'])])
        self.assertEqual(got[0]['child_cmds'], ['sleep 9999', 'cat'])
        self.assert_no_shell_or_full_lsof()

    def test_pipe_blockers_scan_only_this_users_processes(self):
        got = wd.pipe_blockers('100', min_age_min=15)
        self.assertEqual([(c['pid'], c['ppid'], c['safe_to_kill']) for c in got], [('300', '200', False), ('400', '1', True)])
        self.assertIn(['lsof', '-nP', '-u', str(os.getuid())], self.fake.calls)
        self.assert_no_shell_or_full_lsof()

    def test_parked_shells_skip_grep_and_keep_pipe_holders(self):
        got = wd.parked_shells(min_age_min=10)
        self.assertEqual(sorted(c['pid'] for c in got), ['300', '400'])
        self.assertEqual(next(c for c in got if c['pid'] == '300')['child_cmds'], ['sleep 9999', 'cat'])
        self.assertTrue(wd.shell_belongs_to('300', '100'))
        self.assertTrue(wd.shell_belongs_to('400', '100'))
        self.assertFalse(wd.shell_belongs_to('400', '999'))
        self.assert_no_shell_or_full_lsof()


class TailEvents(unittest.TestCase):
    def test_last_n_parsed_events_in_order(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 's.jsonl'
            p.write_text('\n'.join([json.dumps({'i': i}) for i in range(50)] + ['not json', '']))
            self.assertEqual([e['i'] for e in wd_common._tail_events(p, n=30)], list(range(20, 50)))

    def test_small_tail_first_matches_one_full_window_read(self):
        def full_window(path, n=30, window=400_000):
            data = path.read_bytes()[-window:].decode('utf-8', 'ignore').splitlines()[1:]
            out = []
            for ln in data:
                try:
                    out.append(json.loads(ln))
                except Exception:
                    pass
            return out[-n:]
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 's.jsonl'
            for rows in ([10, 10], [5000] * 40, [30000] * 12, [100] * 3, [90000] * 6, [20] * 500):
                p.write_text('\n'.join(json.dumps({'i': i, 'pad': 'x' * w}) for i, w in enumerate(rows)) + '\n')
                self.assertEqual(wd_common._tail_events(p), full_window(p), rows[:2])


if __name__ == '__main__':
    unittest.main()
