"""Plan-and-duties run-1 on 10-18: the clean-room teardown archived the test chat "Pinterest gaps" at 14:28:10Z, the chat service re-adopted it
at 14:29:52Z, and at 14:34:58Z a watchdog cycle read it as a dropped turn (input 94.8 min old) and sent it resume_queue and "[watchdog] Your
last turn was dropped". The chat worked on into run-2 and voided it. A cycle now sends nothing to a session whose chat is in
archived-chats.json or clean-room-chats.json.

WATCHDOG_DIR=<folder with the old watchdog files> runs the same cases against the old cycle, where the archived cases fail."""
import datetime as dt, json, os, sys, tempfile, unittest
from pathlib import Path

HERE = Path(os.environ.get('WATCHDOG_DIR') or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(HERE))
import wd_common  # noqa: E402
import watchdog  # noqa: E402

SID = '01a14f17-2fa7-74a5-b263-1b5f98a46c51'


def at(minutes_ago):
    return (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=minutes_ago)).isoformat().replace('+00:00', 'Z')


class Run1(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.data = self.dir / 'browser-chat'
        self.data.mkdir()
        self.calls, self.daemon, self.rearmed = [], [], []
        self.saved = {name: getattr(watchdog, name) for name in ('pa', 'daemon_call', 'pressure', 'heartbeat_rearm', 'LOG_F', 'STATE_F')}
        self.saved_data = getattr(wd_common, 'CHAT_DATA', None)
        wd_common.CHAT_DATA = self.data
        watchdog.LOG_F, watchdog.STATE_F = self.dir / 'log.jsonl', self.dir / 'state.json'
        watchdog.pressure = lambda: (0.0, 0.0)
        watchdog.daemon_call = lambda payload, *a, **k: self.daemon.append(payload) or {}
        watchdog.heartbeat_rearm = lambda recs, *a, **k: self.rearmed.extend(r['sid'] for r in recs) or []

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(watchdog, name, value)
        wd_common.CHAT_DATA = self.saved_data

    def session(self, events):
        f = self.dir / f'{SID}.jsonl'
        f.write_text(''.join(json.dumps(e) + '\n' for e in events))
        row = {'id': 'ead9afdc6831', 'sessionId': SID, 'sessionName': 'Pinterest gaps', 'sessionFile': str(f),
               'lifecycle': 'live', 'activity': 'idle', 'rlmDepth': 0, 'model': {'id': 'claude-opus-5-5'}, 'messageCount': 3}

        def pa(*args, **k):
            self.calls.append(args)
            out = json.dumps({'sessions': [row]}) if args[:1] == ('list',) else 'Sent to Pinterest gaps'
            return type('Done', (), {'returncode': 0, 'stdout': out, 'stderr': ''})()
        watchdog.pa = pa

    def cycle(self):
        verdicts, actions = watchdog._cycle(verbose=False)
        sends = [c for c in self.calls if c[:1] == ('send',)]
        return verdicts[0]['verdict'], sends, actions

    def run1_events(self, ended_archived=False):
        events = [{'type': 'session', 'id': SID, 'timestamp': at(100)},
                  {'type': 'message', 'timestamp': at(94.8), 'message': {'role': 'user', 'content': 'fix plan and duties'}},
                  {'type': 'session_state', 'timestamp': at(6.8), 'state': {'status': 'archived'}}]
        if not ended_archived:
            events += [{'type': 'custom_message', 'customType': 'harness_digest', 'timestamp': at(5.1), 'content': '[harness-digest]'},
                       {'type': 'session_state', 'timestamp': at(5.1), 'state': {'status': 'active'}}]
        return events

    def assert_untouched(self):
        verdict, sends, actions = self.cycle()
        self.assertEqual(sends, [], 'no continue or dropped-turn message')
        self.assertEqual(self.daemon, [], 'no resume_queue')
        self.assertEqual(actions, [])
        self.assertNotIn(SID, self.rearmed, 'no heartbeat re-arm wakes it')
        self.assertEqual(verdict, 'ARCHIVED')

    def test_1434_the_re_adopted_test_chat_in_clean_room_chats_gets_nothing(self):
        (self.data / 'clean-room-chats.json').write_text(json.dumps({'ids': [SID]}))
        self.session(self.run1_events())
        self.assert_untouched()

    def test_a_chat_in_archived_chats_gets_nothing(self):
        (self.data / 'archived-chats.json').write_text(json.dumps({'ids': [SID]}))
        self.session(self.run1_events())
        self.assert_untouched()

    def test_a_session_whose_file_ends_archived_but_is_in_neither_record_is_still_resumed(self):
        self.session(self.run1_events(ended_archived=True))
        verdict, sends, _ = self.cycle()
        self.assertEqual(verdict, 'DROPPED_TURN', "the daemon's eviction and the Mac copy write an archived state too")
        self.assertEqual(len(sends), 1)

    def test_the_same_dropped_turn_on_a_chat_nobody_archived_is_still_resumed(self):
        self.session(self.run1_events())
        verdict, sends, _ = self.cycle()
        self.assertEqual(verdict, 'DROPPED_TURN')
        self.assertEqual(len(sends), 1)
        self.assertIn('Your last turn was dropped', sends[0][2])
        self.assertEqual(self.daemon, [{'type': 'resume_queue', 'activeSessionId': 'ead9afdc6831'}])


class FleetTriage(unittest.TestCase):
    def test_apply_sends_no_continue_to_a_session_of_an_archived_chat(self):
        import fleet_triage
        d = Path(tempfile.mkdtemp())
        saved = (fleet_triage.send, fleet_triage.STATE_F, fleet_triage.LOG_F, fleet_triage.daemon_resume_queue)
        sent = []
        fleet_triage.send = lambda sid, msg: sent.append(sid) or (0, '')
        fleet_triage.daemon_resume_queue = lambda active: sent.append(active) or {}
        fleet_triage.STATE_F, fleet_triage.LOG_F = d / 'triage_state.json', d / 'triage.jsonl'
        try:
            row = dict(sid=SID, active='ead9afdc6831', name='Pinterest gaps', depth=0, verdict='DROPPED', stop='toolUse', err='',
                       last_age=94.8, head_sid=SID, provider='anthropic', recent='', stream=False)
            fleet_triage.apply([dict(row, stopped='a clean-room test chat (clean-room-chats.json)')])
            self.assertEqual(sent, [])
            fleet_triage.apply([dict(row, stopped=None)])
            self.assertEqual(sent, ['ead9afdc6831', SID], 'the same row on a chat nobody archived is resumed')
        finally:
            fleet_triage.send, fleet_triage.STATE_F, fleet_triage.LOG_F, fleet_triage.daemon_resume_queue = saved


if __name__ == '__main__':
    unittest.main()
