"""A chat may end a turn on a non-owner input (an agent message, a check-in, a notice) with no words. gpt sol
(01a15f90-afb8-7434-814a-2e5fbcafb1ec) did that on the Mac on 10-21: the watchdog read each silent end as a dropped turn and sent "[watchdog]
Your last turn was dropped ... the input was never answered" at 20:08Z, 20:43Z, 21:19Z and 22:18Z, and each wake ended silent again. A turn
that ended normally now answers its non-owner inputs, an owner message stays owed until a turn says something, and one owed input gets one
resume notice. gpt sol (metal 02) (01a160c9-9906-777e-b624-0bffc6c5f04d) on us-metal02 had answered its owner, and the correction refine's
notes after that turn read as input owed since 00:58:56Z on 10-22, so the box's cycle at 01:47:55Z sent it "dropped 48.2 minutes ago". Only
the custom messages that wake the agent count as input now, and a tell_owner call answers the owner.

WATCHDOG_DIR=<folder with the old watchdog files> runs the same cases against the old cycle, where the silent and repeat cases fail."""
import datetime as dt, json, os, re, shutil, sys, tempfile, unittest
from pathlib import Path

HERE = Path(os.environ.get('WATCHDOG_DIR') or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(HERE))
import wd_common  # noqa: E402
import watchdog  # noqa: E402

SID = '01a15f90-afb8-7434-814a-2e5fbcafb1ec'
CHAT_FEED = Path(__file__).resolve().parents[2] / 'user-history/src/shared/chat-feed.ts'
TURNS = Path(__file__).resolve().parents[2] / 'user-history/src/shared/turns.ts'


def at(minutes_ago):
    return (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=minutes_ago)).isoformat().replace('+00:00', 'Z')


def user(text, minutes_ago):
    return {'type': 'message', 'timestamp': at(minutes_ago), 'message': {'role': 'user', 'content': [{'type': 'text', 'text': text}]}}


def agent_message(minutes_ago):
    return {'type': 'custom_message', 'customType': 'agent_message', 'timestamp': at(minutes_ago), 'display': True,
            'content': '[agent-message from child:audit]\n\nresult sent'}


def assistant(minutes_ago, stop='stop', text=''):
    content = [{'type': 'thinking', 'thinking': '', 'thinkingSignature': 'enc'}] + ([{'type': 'text', 'text': text}] if text else [])
    return {'type': 'message', 'timestamp': at(minutes_ago), 'message': {'role': 'assistant', 'content': content, 'stopReason': stop,
                                                                          **({'errorMessage': 'socket hang up'} if stop == 'error' else {})}}


def note(custom_type, minutes_ago):
    return {'type': 'custom_message', 'customType': custom_type, 'timestamp': at(minutes_ago), 'display': True, 'content': '/refine c153'}


def tell_owner(minutes_ago):
    return {'type': 'message', 'timestamp': at(minutes_ago), 'message': {'role': 'assistant', 'stopReason': 'toolUse', 'content': [
        {'type': 'thinking', 'thinking': '', 'thinkingSignature': 'enc'},
        {'type': 'toolCall', 'id': 'call_1', 'name': 'tell_owner', 'arguments': {'text': 'Both audit results are sent.', 'why': 'answer'}}]}}


def tool_result(minutes_ago):
    return {'type': 'message', 'timestamp': at(minutes_ago), 'message': {'role': 'toolResult', 'toolCallId': 'call_1', 'toolName': 'tell_owner',
                                                                          'content': [{'type': 'text', 'text': 'Sent.'}]}}


ANSWERED = [user('audit the board', 300), assistant(290, text='Both audit results are sent.')]


class SilentTurn(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.calls, self.daemon = [], []
        self.saved = {name: getattr(watchdog, name) for name in ('pa', 'daemon_call', 'pressure', 'heartbeat_rearm', 'LOG_F', 'STATE_F', 'outbox_notice')}
        self.outbox = []
        watchdog.outbox_notice = lambda session, root, text: self.outbox.append(session) or {'deliveryStatus': 'queued'}
        self.saved_data = getattr(wd_common, 'CHAT_DATA', None)
        wd_common.CHAT_DATA = self.dir
        watchdog.LOG_F, watchdog.STATE_F = self.dir / 'log.jsonl', self.dir / 'state.json'
        watchdog.pressure = lambda: (0.0, 0.0)
        watchdog.daemon_call = lambda payload, *a, **k: self.daemon.append(payload) or {}
        watchdog.heartbeat_rearm = lambda recs, *a, **k: []
        self.file = self.dir / f'{SID}.jsonl'

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(watchdog, name, value)
        wd_common.CHAT_DATA = self.saved_data
        shutil.rmtree(self.dir)

    def cycle(self, events, send_rc=0):
        self.file.write_text(''.join(json.dumps(e) + '\n' for e in [{'type': 'session', 'id': SID, 'timestamp': at(400)}, *events]))
        row = {'id': '807ad0c77aca', 'sessionId': SID, 'sessionName': 'gpt sol', 'sessionFile': str(self.file),
               'lifecycle': 'live', 'activity': 'idle', 'rlmDepth': 0, 'model': {'id': 'gpt-5.5'}, 'messageCount': len(events)}

        def pa(*args, **k):
            self.calls.append(args)
            listing = args[:1] == ('list',)
            out = json.dumps({'sessions': [row]}) if listing else 'Sent to gpt sol' if send_rc == 0 else 'Error: Unknown active session'
            return type('Done', (), {'returncode': 0 if listing else send_rc, 'stdout': out, 'stderr': ''})()
        watchdog.pa = pa
        verdicts, _ = watchdog._cycle(verbose=False)
        return verdicts[0]['verdict'], [c for c in self.calls if c[:1] == ('send',)]

    def test_a_silent_end_after_an_agent_message_is_answered(self):
        verdict, sends = self.cycle([*ANSWERED, agent_message(35.3), assistant(35)])
        self.assertEqual((verdict, sends, self.daemon), ('OK', [], []))

    def test_a_silent_end_after_a_check_in_is_answered(self):
        verdict, sends = self.cycle([*ANSWERED, user('[check-in] Board rev54 has no open steps.', 40), assistant(39)])
        self.assertEqual((verdict, sends), ('OK', []))

    def test_a_silent_end_after_the_watchdog_notice_is_answered(self):
        notice = user('[watchdog] Your last turn was dropped 33.6 minutes ago (machine sleep or worker restart) and the input was never answered.', 34)
        verdict, sends = self.cycle([*ANSWERED, agent_message(70), assistant(69), notice, assistant(33.5)])
        self.assertEqual((verdict, sends), ('OK', []))

    def test_an_owner_message_a_dead_worker_never_answered_is_resumed(self):
        verdict, sends = self.cycle([*ANSWERED, user('is the audit done?', 40)])
        self.assertEqual((verdict, len(sends)), ('DROPPED_TURN', 1))

    def test_an_owner_message_a_turn_ended_silent_on_is_resumed(self):
        verdict, sends = self.cycle([*ANSWERED, user('is the audit done?', 40), assistant(39)])
        self.assertEqual((verdict, len(sends)), ('DROPPED_TURN', 1))

    def test_an_owner_message_after_a_notice_keeps_the_silent_end_owed(self):
        verdict, sends = self.cycle([*ANSWERED, agent_message(41), user('is the audit done?', 40), assistant(39)])
        self.assertEqual((verdict, len(sends)), ('DROPPED_TURN', 1))

    def test_a_turn_cut_by_an_error_after_a_notice_is_resumed(self):
        verdict, sends = self.cycle([*ANSWERED, agent_message(40), assistant(39, stop='error')])
        self.assertEqual((verdict, len(sends)), ('DROPPED_TURN', 1))

    def test_one_owed_input_gets_one_resume_notice(self):
        owed = [*ANSWERED, user('is the audit done?', 80)]
        first = self.cycle(owed)
        notice = user('[watchdog] Your last turn was dropped 80 minutes ago (machine sleep or worker restart) and the input was never answered.', 40)
        second = self.cycle([*owed, notice])
        self.assertEqual((first[0], second[0], len(self.calls_of('send'))), ('DROPPED_TURN', 'NOTICED', 1))

    def test_the_correction_refine_notes_after_an_answered_owner_turn_owe_nothing(self):
        verdict, sends = self.cycle([user('is the audit done?', 50), assistant(49.5, text='Yes, both results are sent.'),
                                     note('session_slash_command', 49), note('refinement_notice', 48.2)])
        self.assertEqual((verdict, sends), ('OK', []))

    def test_a_tell_owner_reply_answers_the_owner_before_a_silent_end(self):
        verdict, sends = self.cycle([user('is the audit done?', 50), tell_owner(49.6), tool_result(49.5), assistant(49.4)])
        self.assertEqual((verdict, sends), ('OK', []))

    def test_a_refused_send_goes_to_the_outbox_and_uses_up_the_notice(self):
        owed = [*ANSWERED, user('is the audit done?', 80)]
        first = self.cycle(owed, send_rc=1)
        second = self.cycle(owed)
        self.assertEqual((first[0], second[0], len(self.calls_of('send')), self.outbox), ('DROPPED_TURN', 'NOTICED', 1, [SID]))

    def test_the_prompt_types_match_the_chat_feed(self):
        names = re.search(r'const PROMPT_TYPES = new Set\(\[([^\]]*)\]\)', TURNS.read_text()).group(1)
        self.assertEqual(set(watchdog.PROMPT_TYPES), set(re.findall(r'"([^"]+)"', names)))

    def calls_of(self, verb):
        return [c for c in self.calls if c[:1] == (verb,)]

    def test_every_chat_service_note_prefix_reads_as_not_the_owner(self):
        feed = CHAT_FEED.read_text()
        consts = dict(re.findall(r'(?:export )?const (\w+) = "([^"]+)";', feed))
        notes = re.search(r'const SERVER_NOTES[^=]*= \[(.*?)\];', feed, re.S).group(1)
        prefixes = [consts[name] for name in re.findall(r'\[(\w+), "', notes)] + re.findall(r'\["([^"]+)", "', notes) + [consts['NUDGE_PREFIX']]
        self.assertGreaterEqual(len(prefixes), 10)
        for prefix in prefixes:
            self.assertFalse(watchdog.from_owner(user(prefix + 'x', 1)), prefix)
        self.assertTrue(watchdog.from_owner(user(consts['CHECK_IN_PREFIX'] + consts['OWNER_RETRY_MARK'] + 'hi', 1)))
        self.assertTrue(watchdog.from_owner(user('<b>bold</b> is fine?', 1)))
        self.assertFalse(watchdog.from_owner(user('<provider_quota_resumed>\nreset', 1)))


if __name__ == '__main__':
    unittest.main()
