"""The prime-agent CLI waits a fixed 3 s for the daemon's hello. On 10-22 65 of 108 probes on us-metal02 got it after 3 to 7 s, and at 04:42Z
`prime-agent list` failed so twice, which made a watchdog cycle fail before it read any session. The watchdog's list and plain sends now go
through sieun-pi's daemon reader (daemon-cli.mjs, a 30 s hello and a second open), and every other command runs once more after a missed hello.

WATCHDOG_DIR=<folder with the old watchdog files> runs the same cases against the old pa, where the reader and retry cases fail."""
import json, os, shutil, stat, sys, tempfile, unittest
from pathlib import Path

HERE = Path(os.environ.get('WATCHDOG_DIR') or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(HERE))
import wd_common  # noqa: E402

MISS = 'Error: Timed out after 3000ms waiting for the Prime Agent daemon handshake. Socket: /tmp/prime-agent-1001/daemon.sock.'


class DaemonReads(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.calls = self.dir / 'calls.jsonl'
        self.saved_path, self.saved_reader = wd_common.ENV.get('PATH'), getattr(wd_common, 'daemon_reader', None)
        reader = self.dir / 'daemon-cli.py'
        reader.write_text(f"""import json, sys
open({str(self.calls)!r}, 'a').write(json.dumps(['reader', *sys.argv[1:]]) + '\\n')
print(json.dumps({{'sessions': [{{'id': 'a1', 'sessionId': '01a15f90-afb8-7434-814a-2e5fbcafb1ec'}}]}}) if sys.argv[1] == 'list' else json.dumps({{'ok': True}}))
""")
        self.reader = [sys.executable, str(reader)]
        cli = self.dir / 'bin' / 'prime-agent'
        cli.parent.mkdir()
        cli.write_text(f"""#!{sys.executable}
import json, os, sys
calls = {str(self.calls)!r}
open(calls, 'a').write(json.dumps(['cli', *sys.argv[1:]]) + '\\n')
seen = sum(1 for _ in open(calls))
mode = open({str(self.dir / 'mode')!r}).read().strip()
if mode == 'miss-once' and seen == 1:
    sys.stderr.write({MISS!r} + '\\n'); sys.exit(1)
if mode == 'refuse':
    sys.stderr.write('Error: Unknown active session: x\\n'); sys.exit(1)
print('ok')
""")
        cli.chmod(cli.stat().st_mode | stat.S_IXUSR)
        wd_common.ENV['PATH'] = f"{cli.parent}{os.pathsep}{self.saved_path}"
        self.mode('ok')

    def tearDown(self):
        wd_common.ENV['PATH'] = self.saved_path
        if self.saved_reader is not None:
            wd_common.daemon_reader = self.saved_reader
        shutil.rmtree(self.dir)

    def mode(self, text):
        (self.dir / 'mode').write_text(text)

    def ran(self):
        return [json.loads(ln) for ln in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def test_the_list_goes_through_the_reader(self):
        wd_common.daemon_reader = lambda: self.reader
        done = wd_common.pa('list', '--all', '--json')
        self.assertEqual((done.returncode, json.loads(done.stdout)['sessions'][0]['id'], self.ran()), (0, 'a1', [['reader', 'list', '--all']]))

    def test_a_plain_send_goes_through_the_reader(self):
        wd_common.daemon_reader = lambda: self.reader
        done = wd_common.pa('send', '01a15f90-afb8-7434-814a-2e5fbcafb1ec', '[watchdog] continue')
        self.assertEqual((done.returncode, done.stdout, self.ran()),
                         (0, 'Sent to 01a15f90-afb8-7434-814a-2e5fbcafb1ec', [['reader', 'send', '01a15f90-afb8-7434-814a-2e5fbcafb1ec', '[watchdog] continue']]))

    def test_a_steer_runs_the_cli_and_once_more_after_a_missed_hello(self):
        wd_common.daemon_reader = lambda: self.reader
        self.mode('miss-once')
        done = wd_common.pa('send', '--steer', 'a1', 'hi')
        self.assertEqual((done.returncode, [c[0] for c in self.ran()]), (0, ['cli', 'cli']))

    def test_without_a_reader_a_missed_hello_runs_the_cli_once_more(self):
        wd_common.daemon_reader = lambda: None
        self.mode('miss-once')
        done = wd_common.pa('list', '--all', '--json')
        self.assertEqual((done.returncode, len(self.ran())), (0, 2))

    def test_a_refusal_is_not_run_again(self):
        wd_common.daemon_reader = lambda: None
        self.mode('refuse')
        done = wd_common.pa('send', 'x', 'hi')
        self.assertEqual((done.returncode, len(self.ran())), (1, 1))


if __name__ == '__main__':
    unittest.main()
