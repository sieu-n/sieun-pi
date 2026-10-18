"""The model probe on 10-18: pi-pool held it in a slot wait, and the old probe read that as a model stall, killed its -p
client after 100 s (a "prompt_and_wait failed" fault at 12:44:48Z and 12:54:46Z) and ran a pkill pattern that also
killed another agent's hand-run pong probe at 13:14:22Z.

WATCHDOG_DIR=<folder with the old watchdog.py> runs the same cases against the old model_alive(), where they fail."""
import json, os, subprocess, sys, tempfile, textwrap, time, unittest
from pathlib import Path

HERE = Path(os.environ.get('WATCHDOG_DIR') or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(HERE))
OLD = not (HERE / 'wd_probe.py').exists()
if OLD:
    import watchdog as probe_mod  # noqa: E402
else:
    import wd_probe as probe_mod  # noqa: E402

MODEL = 'test-model-p619'   # a model name no real probe uses, so the old pkill pattern can only hit these fakes
WAIT_1244 = ('Failed to resolve API key for provider "anthropic" from shell command: /home/sieun/.config/pi-pool/bin/'
             'pi-pool-token pi-pool: this session waits for its slot at 2026-10-18T12:52:00.000Z. Try again in 10 minutes.')
ROW_1254 = {'ts': '2026-10-18T12:52:38', 'event': 'wait', 'provider': 'anthropic',
            'session': '01a14f12-3ccc-7779-855e-bbab264bd918', 'account': 'claude11@slack.green',
            'slot_at': '2026-10-18T13:12:00', 'priority': 'normal', 'vend': None, 'left': None, 'backoff': False}
ROW_1314_OTHER = {'ts': '2026-10-18T13:12:56', 'event': 'wait', 'provider': 'anthropic',
                  'session': '01a14f1a-33a4-73b8-a823-76e9725573b6', 'account': 'claude3@slack.green',
                  'slot_at': '2026-10-18T14:05:57', 'priority': 'low', 'vend': None, 'left': None, 'backoff': True}

FAKE = textwrap.dedent(r"""
    #!/usr/bin/env python3
    import json, os, subprocess, sys, time
    mode, record = os.environ.get('FAKE_PROBE', 'pong'), os.environ.get('FAKE_RECORD')
    session = os.environ.get('FAKE_SESSION', '01a14f09-1a5e-70ba-9dba-b88d0a557694')
    def note(what):
        if record:
            with open(record, 'a') as f:
                f.write(what + '\n')
    if '-p' in sys.argv:          # the old probe and the 13:14Z hand-run probe: a held turn prints nothing
        note('print-mode start')
        time.sleep(600)
        sys.exit(0)
    def out(o):
        sys.stdout.write(json.dumps(o) + '\n'); sys.stdout.flush()
    if mode == 'deaf':
        subprocess.Popen(['sleep', '600'])
    for line in sys.stdin:
        c = json.loads(line)
        note(c['type'])
        if c['type'] == 'get_state':
            out({'id': c.get('id'), 'type': 'response', 'command': 'get_state', 'success': True, 'data': {'sessionId': session}})
        elif c['type'] == 'prompt':
            out({'id': c.get('id'), 'type': 'response', 'command': 'prompt', 'success': True})
            out({'type': 'agent_start'})
            if mode == 'pong':
                out({'type': 'message_end', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'pong'}], 'stopReason': 'stop'}})
                out({'type': 'agent_end', 'messages': []})
            elif mode == 'stream_wait':
                out({'type': 'message_end', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': ''}],
                     'stopReason': 'error', 'errorMessage': os.environ['FAKE_ERROR']}})
            elif mode == 'row_wait':
                with open(os.environ['FAKE_POOL_LOG'], 'a') as f:
                    f.write(os.environ['FAKE_ROW'] + '\n')
        elif c['type'] == 'abort' and mode != 'deaf':
            out({'id': c.get('id'), 'type': 'response', 'command': 'abort', 'success': True})
            out({'type': 'agent_end', 'messages': []})
    note('eof')
    if mode == 'deaf':
        time.sleep(600)
""").lstrip()


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()[:1] not in ('Z', '')


class Probe(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        fake = self.dir / 'prime-agent'
        fake.write_text(FAKE)
        fake.chmod(0o755)
        self.pool_log = self.dir / 'pi-pool.log'
        self.pool_log.write_text('')
        self.record = self.dir / 'record.txt'
        self.env = dict(os.environ, PATH=f'{self.dir}:{os.environ["PATH"]}', FAKE_RECORD=str(self.record),
                        FAKE_POOL_LOG=str(self.pool_log))
        self.others = []

    def tearDown(self):
        for p in self.others:
            if p.poll() is None:
                p.kill()
                p.wait()

    def probe(self, mode, timeout=3, **extra):
        env = dict(self.env, FAKE_PROBE=mode, **extra)
        if OLD:
            probe_mod.ENV = env
            return {'outcome': 'alive' if probe_mod.model_alive(MODEL, timeout=timeout) else 'stalled'}
        return probe_mod.probe_model(MODEL, timeout=timeout, pool_log=self.pool_log, env=env, end_wait=3)

    def record_lines(self):
        return self.record.read_text().split() if self.record.exists() else []

    def test_1244_a_slot_wait_in_the_probe_stream_reads_as_a_pool_wait_and_the_turn_is_aborted(self):
        got = self.probe('stream_wait', FAKE_ERROR=WAIT_1244)
        self.assertEqual(got['outcome'], 'pool_wait')
        self.assertEqual(got.get('slot_at'), '2026-10-18T12:52:00.000Z')
        self.assertEqual(got.get('end'), 'aborted')
        self.assertEqual(self.record_lines(), ['get_state', 'prompt', 'abort', 'eof'])

    def test_1254_a_pool_log_wait_row_for_the_probe_session_reads_as_a_pool_wait(self):
        got = self.probe('row_wait', FAKE_SESSION=ROW_1254['session'], FAKE_ROW=json.dumps(ROW_1254))
        self.assertEqual((got['outcome'], got.get('slot_at'), got.get('via')), ('pool_wait', '2026-10-18T13:12:00', 'pi-pool.log'))
        self.assertIn('abort', self.record_lines())

    def test_a_parked_row_alone_also_reads_as_a_pool_wait(self):
        parked = {'ts': '2026-10-18T17:11:48', 'event': 'parked', 'provider': 'anthropic', 'session': ROW_1254['session'],
                  'at': 1792343508.4, 'account': 'krenerd77@naver.com', 'slot_at': 1792343610, 'backoff': False}
        got = self.probe('row_wait', FAKE_SESSION=ROW_1254['session'], FAKE_ROW=json.dumps(parked))
        self.assertEqual((got['outcome'], got.get('slot_at')), ('pool_wait', '2026-10-18T17:13:30+00:00'))

    def test_1314_a_probe_that_runs_out_of_time_ends_only_itself(self):
        hand_run = subprocess.Popen(['prime-agent', '-p', '--model', MODEL, '--no-session', '--no-tools', 'reply with exactly: pong'],
                                    env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.others.append(hand_run)
        with open(self.pool_log, 'a') as f:
            f.write(json.dumps(ROW_1314_OTHER) + '\n')
        time.sleep(0.5)
        got = self.probe('silent', timeout=2)
        self.assertEqual(got['outcome'], 'stalled', 'a wait row for another session says nothing about this probe')
        self.assertTrue(alive(hand_run.pid), "the other agent's hand-run probe was killed")
        self.assertEqual(got.get('end'), 'aborted')

    def test_a_probe_that_ignores_abort_and_stdin_close_is_ended_by_its_own_process_group(self):
        hand_run = subprocess.Popen(['prime-agent', '-p', '--model', MODEL, '--no-session', '--no-tools', 'reply with exactly: pong'],
                                    env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.others.append(hand_run)
        time.sleep(0.5)
        got = self.probe('deaf', timeout=1)
        self.assertEqual(got.get('end'), 'killed own group')
        self.assertTrue(alive(hand_run.pid))
        self.assertFalse(alive(got['pid']))

    def test_a_pong_reads_as_alive(self):
        got = self.probe('pong')
        self.assertEqual(got['outcome'], 'alive')
        self.assertEqual(got.get('end'), 'closed')


@unittest.skipIf(OLD, 'the old watchdog has no probe_verdict')
class Verdict(unittest.TestCase):
    def test_a_pool_wait_probe_gives_pool_wait_not_model_stall(self):
        probes = {'claude-opus-5-5': {'outcome': 'pool_wait', 'slot_at': '2026-10-18T12:52:00.000Z'}}
        v, why = probe_mod.probe_verdict('FROZEN_TURN', 'x', 'claude-opus-5-5', probes)
        self.assertEqual(v, 'POOL_WAIT')
        self.assertIn('12:52:00', why)

    def test_a_stalled_probe_still_gives_model_stall_and_alive_keeps_the_verdict(self):
        self.assertEqual(probe_mod.probe_verdict('PHANTOM_TURN', 'x', 'm', {'m': {'outcome': 'stalled'}})[0], 'MODEL_STALL')
        self.assertEqual(probe_mod.probe_verdict('FROZEN_TOOL', 'x', 'm', {'m': {'outcome': 'alive'}}), ('FROZEN_TOOL', 'x'))
        self.assertEqual(probe_mod.probe_verdict('OK', 'x', 'm', {'m': {'outcome': 'pool_wait'}}), ('OK', 'x'))


if __name__ == '__main__':
    unittest.main()
