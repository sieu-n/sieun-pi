"""01a17f25 on us-metal02, 10-27: from 20:55:56Z its turn waited for a pi-pool working slot, Prime ended the turn on "pi-pool: this run waits
for a working slot, place 134 of 139", and the idle unload stopped its worker. Through 21:22:09Z it sat 104th to 139th in pi-pool's line, and
the cycle read such a session as a frozen turn to stop and resend while its run waited inside a live model call, and probed its model
every cycle. The cycle now reads the wait through sieun-pi's one reader (legacy/prime/user-history/src/slot-park.ts, `daemon-cli.mjs slot-park`),
and a parked session reads SLOT_WAIT with its place and gets no probe, stop, send or notice.

The cases replay cuts of legacy/prime/user-history/test/fixtures/slot-park-01a17f25-1028.jsonl through the real reader, with pi-pool's line left
out or stubbed. WATCHDOG_DIR=<folder with the old watchdog files> runs them against the old cycle, where the parked cases fail."""
import datetime as dt, json, os, sys, tempfile, unittest
from pathlib import Path

HERE = Path(os.environ.get('WATCHDOG_DIR') or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import wd_common  # noqa: E402
import watchdog  # noqa: E402
from slot_reader import FIXTURE_ID, fixture_lines, use_reader  # noqa: E402

PARKED = '2026-10-27T20:56:58.575Z'      # the turn ended on the slot wait and the idle unload stopped the worker
QUEUED = '2026-10-27T21:11:19.187Z'      # the parent's message waits 112th of 164 inside a live model call
RESUMED = '2026-10-27T21:17:00.755Z'     # Prime's wake wrote provider_quota_resume "cancelled"
RAN = '2026-10-27T21:22:15.311Z'         # the turn ran


class Cycle(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        (self.dir / 'browser-chat' / 'wakes').mkdir(parents=True)
        self.calls, self.probed = [], []
        names = ('pa', 'daemon_call', 'pressure', 'heartbeat_rearm', 'probe_model', 'stuck_cell_procs', 'session_busy_tools', '_ps_table',
                 '_descendants', '_tls_count', 'LOG_F', 'STATE_F')
        self.saved = {name: getattr(watchdog, name) for name in names}
        self.saved_common = (wd_common.CHAT_DATA, wd_common.POOL_TURNS)
        wd_common.CHAT_DATA, wd_common.POOL_TURNS = self.dir / 'browser-chat', self.dir / 'turns.json'
        watchdog.LOG_F, watchdog.STATE_F = self.dir / 'log.jsonl', self.dir / 'state.json'
        watchdog.pressure = lambda: (0.0, 0.0)
        watchdog.daemon_call = lambda payload, *a, **k: self.calls.append(('daemon', payload)) or {}
        watchdog.heartbeat_rearm = lambda *a, **k: []
        watchdog.stuck_cell_procs = lambda *a, **k: []
        watchdog.session_busy_tools = lambda *a, **k: []
        watchdog._ps_table = lambda *a, **k: {}
        watchdog._descendants = lambda *a, **k: []
        watchdog._tls_count = lambda *a, **k: 0
        watchdog.probe_model = lambda model, *a, **k: self.probed.append(model) or {'outcome': 'alive', 'model': model}

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(watchdog, name, value)
        wd_common.CHAT_DATA, wd_common.POOL_TURNS = self.saved_common

    def cycle(self, upto, activity):
        f = self.dir / f'{FIXTURE_ID}.jsonl'
        f.write_text('\n'.join(fixture_lines(upto)) + '\n')
        row = {'id': FIXTURE_ID, 'sessionId': FIXTURE_ID, 'sessionName': 'parked jobs show as waiting', 'sessionFile': str(f),
               'lifecycle': 'live', 'activity': activity, 'rlmDepth': 0, 'model': {'id': 'claude-opus-5-5'}, 'messageCount': 9,
               'workerPid': 4242, 'isStreaming': False}

        def pa(*args, **k):
            self.calls.append(args)
            out = json.dumps({'sessions': [row]}) if args[:1] == ('list',) else f'Sent to {args[1]}'
            return type('Done', (), {'returncode': 0, 'stdout': out, 'stderr': ''})()
        watchdog.pa = pa
        verdicts, actions = watchdog._cycle(verbose=False)
        acted = [c for c in self.calls if c[:1] in (('send',), ('stop',), ('daemon',))]
        return verdicts[0]['verdict'], verdicts[0]['why'], acted


class SlotWait(Cycle):
    def test_a_parked_idle_job_reads_its_place_and_gets_nothing(self):
        use_reader(self)
        verdict, why, acted = self.cycle(PARKED, 'idle')
        self.assertEqual((verdict, acted), ('SLOT_WAIT', []))
        self.assertRegex(why, r'^waits for a working slot, place \d+ of 139; pi-pool wakes it when its slot starts$')

    def test_a_run_queued_inside_a_live_model_call_gets_no_probe_stop_or_send(self):
        use_reader(self)
        verdict, why, acted = self.cycle(QUEUED, 'working')
        self.assertEqual((verdict, why, acted, self.probed), ('SLOT_WAIT', 'waits for a working slot, place 112 of 164; pi-pool wakes it when its slot starts', [], []))

    def test_pi_pool_s_line_gives_the_place_now(self):
        use_reader(self, {'enabled': True, 'working': [], 'queued': [{'session': FIXTURE_ID, 'position': 61, 'total': 170}]})
        self.assertEqual(self.cycle(PARKED, 'idle')[:2], ('SLOT_WAIT', 'waits for a working slot, place 61 of 170; pi-pool wakes it when its slot starts'))


class Cleared(Cycle):
    def test_a_wait_pi_pool_dropped_after_its_time_is_no_park(self):
        use_reader(self, {'enabled': True, 'working': [], 'queued': []})
        self.assertNotEqual(self.cycle(QUEUED, 'working')[0], 'SLOT_WAIT')

    def test_a_cancelled_wake_and_a_turn_that_ran_are_no_park(self):
        use_reader(self)
        self.assertNotEqual(self.cycle(RESUMED, 'idle')[0], 'SLOT_WAIT')
        self.assertEqual(self.cycle(RAN, 'idle')[:2], ('OK', 'live/idle'))


if __name__ == '__main__':
    unittest.main()
