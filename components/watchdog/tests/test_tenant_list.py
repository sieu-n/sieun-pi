"""On 11-13 a herd of full daemon lists (`list --all`, 11,228 saved sessions, 97 MB, about 13 CPU-s each on the supervisor's one thread)
held every other daemon call up to 657 s. The stop+send recovery reads which sessions share the wedged worker, and only a row a worker holds
has a workerPid, so it reads the live list."""
import json, os, sys, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(os.environ.get('WATCHDOG_DIR') or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(HERE))
import watchdog  # noqa: E402


class TenantList(unittest.TestCase):
    def test_the_sole_tenant_check_reads_the_live_list(self):
        calls = []
        rows = [{'sessionId': 'own', 'workerPid': 4242, 'activity': 'working'}, {'sessionId': 'kid', 'workerPid': 4242, 'activity': 'idle'}]

        def pa(*args, timeout=None):
            calls.append(args)
            if args[0] == 'stop':
                return SimpleNamespace(returncode=1, stdout='', stderr='timed out')
            if args[0] == 'list':
                return SimpleNamespace(returncode=0, stdout=json.dumps({'sessions': rows}), stderr='')
            return SimpleNamespace(returncode=0, stdout='sent', stderr='')

        killed = []
        r = {'id': 'abc', 'sid': 'own', 'name': 'job', 'depth': 0, 'stale_min': 40, 'tools': False, 'bash': False, 'streaming': False, 'pid': 4242}
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(watchdog, 'pa', pa), \
                mock.patch.object(watchdog, '_run', lambda *a: killed.append(a)), mock.patch.object(watchdog, 'LOG_F', Path(tmp) / 'log.jsonl'), \
                mock.patch('time.sleep', lambda s: None):
            out = watchdog.nudge(r, 'frozen')
        self.assertIn(('list', '--json'), calls)
        self.assertFalse([c for c in calls if '--all' in c])
        self.assertEqual((out['killed_worker'], killed), (4242, [('kill', '4242')]))


if __name__ == '__main__':
    unittest.main()
