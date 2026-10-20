"""On 10-19 from 06:51Z to 08:31Z the watchdog sent resume_queue and "[watchdog] Your last turn was dropped" to 50 idle sessions, among
them SEO guy 609 min after its last turn failed on a 429 with "pi-pool: this session waits for its slot". The chat service's idle unload stops
such a session while pi-pool holds its tree, and resume_paused.py and the chat revive continue it once `pi-pool who` admits the tree, so each
send loaded a worker and a kernel again only to meet the same limit. A turn that ended on a rate limit or a pool hold now reads POOL_WAIT and
gets nothing; a turn lost any other way is still resumed.

WATCHDOG_DIR=<folder with the old watchdog files> runs the same cases against the old cycle, where the held cases fail."""
import datetime as dt, json, os, sys, tempfile, unittest
from pathlib import Path

HERE = Path(os.environ.get('WATCHDOG_DIR') or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(HERE))
import wd_common  # noqa: E402
import watchdog  # noqa: E402

SID = '01a11a24-a46e-77ff-adf7-671d01d462e2'


def at(minutes_ago):
    return (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=minutes_ago)).isoformat().replace('+00:00', 'Z')


def failed(message, diagnostics=()):
    return {'type': 'message', 'timestamp': at(609), 'message': {'role': 'assistant', 'content': [], 'stopReason': 'error',
                                                                  'errorMessage': message, 'diagnostics': list(diagnostics)}}


HOOK = ('Failed to resolve API key for provider "anthropic" from shell command: /home/sieun/.config/pi-pool/bin/pi-pool-token pi-pool: '
        'this session waits for its slot at 2026-10-19T06:09:54.000Z. Try again in 101 minutes.')
LIMIT = "Provider rate limit exceeded (rate_limit_error, 429): This request would exceed your account's rate limit."


class PoolHeld(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.data = self.dir / 'browser-chat'
        self.data.mkdir()
        self.calls, self.daemon = [], []
        self.saved = {name: getattr(watchdog, name) for name in ('pa', 'daemon_call', 'pressure', 'heartbeat_rearm', 'LOG_F', 'STATE_F')}
        self.saved_data = getattr(wd_common, 'CHAT_DATA', None)
        wd_common.CHAT_DATA = self.data
        watchdog.LOG_F, watchdog.STATE_F = self.dir / 'log.jsonl', self.dir / 'state.json'
        watchdog.pressure = lambda: (0.0, 0.0)
        watchdog.daemon_call = lambda payload, *a, **k: self.daemon.append(payload) or {}
        watchdog.heartbeat_rearm = lambda recs, *a, **k: []

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(watchdog, name, value)
        wd_common.CHAT_DATA = self.saved_data

    def cycle(self, last):
        f = self.dir / f'{SID}.jsonl'
        events = [{'type': 'session', 'id': SID, 'timestamp': at(700)},
                  {'type': 'message', 'timestamp': at(610), 'message': {'role': 'user', 'content': 'check the SEO board'}}, *last]
        f.write_text(''.join(json.dumps(e) + '\n' for e in events))
        row = {'id': '870017d1ff65', 'sessionId': SID, 'sessionName': 'SEO guy', 'sessionFile': str(f),
               'lifecycle': 'live', 'activity': 'idle', 'rlmDepth': 0, 'model': {'id': 'claude-opus-5-5'}, 'messageCount': 3}

        def pa(*args, **k):
            self.calls.append(args)
            out = json.dumps({'sessions': [row]}) if args[:1] == ('list',) else 'Sent to SEO guy'
            return type('Done', (), {'returncode': 0, 'stdout': out, 'stderr': ''})()
        watchdog.pa = pa
        verdicts, actions = watchdog._cycle(verbose=False)
        return verdicts[0]['verdict'], [c for c in self.calls if c[:1] == ('send',)], actions

    def test_a_turn_that_ended_on_the_pool_token_hook_refusal_gets_nothing(self):
        verdict, sends, actions = self.cycle([failed(HOOK, [{'type': 'provider_stream_failure', 'details': {'status': 429, 'kind': 'rate_limit'}}])])
        self.assertEqual((verdict, sends, self.daemon, actions), ('POOL_WAIT', [], [], []))

    def test_a_turn_that_ended_on_a_429_gets_nothing(self):
        verdict, sends, actions = self.cycle([failed(LIMIT, [{'type': 'provider_stream_failure', 'details': {'kind': 'rate_limit', 'status': 429}}])])
        self.assertEqual((verdict, sends, self.daemon, actions), ('POOL_WAIT', [], [], []))

    def test_a_turn_that_ended_on_a_credential_wait_marker_gets_nothing(self):
        # dhx.3 Prime with the p692 hook on us-metal02, 10-20: the hook answered exit 75 and Prime wrote this wait marker, whose text names
        # no pi-pool slot (marker shape from a dhx.3 session, times from 01a15a2b-be18's 17:30:08Z wait).
        marker = failed('API key for provider "anthropic" is temporarily unavailable until 2026-10-20T17:32:00.000Z: waiting for an account slot',
                        [{'type': 'provider_stream_failure', 'details': {'kind': 'credential_unavailable', 'retryAtMs': 1792517520000, 'retryAfterMs': 111860}}])
        verdict, sends, actions = self.cycle([marker])
        self.assertEqual((verdict, sends, self.daemon, actions), ('POOL_WAIT', [], [], []))

    def test_a_turn_that_failed_another_way_is_still_resumed(self):
        verdict, sends, _ = self.cycle([failed('Connection reset by peer')])
        self.assertEqual(verdict, 'DROPPED_TURN')
        self.assertEqual(len(sends), 1)
        self.assertEqual(self.daemon, [{'type': 'resume_queue', 'activeSessionId': '870017d1ff65'}])

    def test_a_lost_turn_with_no_reply_is_still_resumed(self):
        verdict, sends, _ = self.cycle([])
        self.assertEqual(verdict, 'DROPPED_TURN')
        self.assertEqual(len(sends), 1)


if __name__ == '__main__':
    unittest.main()
