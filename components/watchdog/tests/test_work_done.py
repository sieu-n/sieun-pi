"""On 10-22 at 03:11Z and 03:22Z the Mac's cycles woke ten chat jobs whose turns dropped on 10-15, among them duties green fleet (01a13f22,
p456 done), mac usable resident workers (01a13fd6) and checkin stuck_steps fix, once the gone jobs stopped taking the cycle's budget. Each found
its work finished or taken over and stopped. A dropped turn of a job a chat lists now gets a wake only while its work is owed: an open board step
names it, the chat shows it working, or an owner message to it has no reply. Otherwise it reads WORK_DONE, and the skip is logged once.

WATCHDOG_DIR=<folder with the old watchdog files> runs the same cases against the old cycle, where the finished-work cases fail."""
import datetime as dt, json, os, shutil, sys, tempfile, unittest
from pathlib import Path

HERE = Path(os.environ.get('WATCHDOG_DIR') or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(HERE))
import wd_common  # noqa: E402
import watchdog  # noqa: E402

JOB = '01a13f22-360f-754b-8932-05c80b1a99e3'
CHAT = '01a1164b-4a2d-742d-b27a-82f086ed0200'
BRIEF = "Owner's words: none, started by AI harness developer environment VP.\nMake every duty green."


def at(minutes_ago):
    return (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=minutes_ago)).isoformat().replace('+00:00', 'Z')


def user(text, minutes_ago):
    return {'type': 'message', 'timestamp': at(minutes_ago), 'message': {'role': 'user', 'content': [{'type': 'text', 'text': text}]}}


def tool_call(minutes_ago):
    return {'type': 'message', 'timestamp': at(minutes_ago), 'message': {'role': 'assistant', 'stopReason': 'toolUse', 'content': [
        {'type': 'toolCall', 'id': 'call_1', 'name': 'ipython', 'arguments': {'code': 'run_duties()'}}]}}


def tool_result(minutes_ago):
    return {'type': 'message', 'timestamp': at(minutes_ago), 'message': {'role': 'toolResult', 'toolCallId': 'call_1', 'toolName': 'ipython',
                                                                          'content': [{'type': 'text', 'text': 'ok'}]}}


DROPPED = [user(BRIEF, 9900), tool_call(9899), tool_result(9898)]


class WorkDone(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.calls = []
        self.saved = {name: getattr(watchdog, name, None) for name in ('pa', 'daemon_call', 'pressure', 'heartbeat_rearm', 'LOG_F', 'STATE_F',
                                                                         'outbox_notice', 'chat_jobs')}
        self.saved_data = wd_common.CHAT_DATA
        wd_common.CHAT_DATA = self.dir
        watchdog.LOG_F, watchdog.STATE_F = self.dir / 'log.jsonl', self.dir / 'state.json'
        watchdog.pressure = lambda: (0.0, 0.0)
        watchdog.daemon_call = lambda payload, *a, **k: {}
        watchdog.heartbeat_rearm = lambda recs, *a, **k: []
        watchdog.outbox_notice = lambda session, root, text: {'deliveryStatus': 'queued'}
        self.file = self.dir / 'sessions' / f'{JOB}.jsonl'
        self.file.parent.mkdir()

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(watchdog, name, value)
        wd_common.CHAT_DATA = self.saved_data
        shutil.rmtree(self.dir)

    def cycle(self, events, jobs):
        watchdog.chat_jobs = lambda: jobs
        self.file.write_text(''.join(json.dumps(e) + '\n' for e in [{'type': 'session', 'id': JOB, 'timestamp': at(9999)}, *events]))
        row = {'id': JOB, 'sessionId': JOB, 'sessionName': 'duties green fleet', 'sessionFile': str(self.file), 'lifecycle': 'live',
               'activity': 'idle', 'rlmDepth': 0, 'model': {'id': 'claude-opus-5-5'}, 'messageCount': len(events)}

        def pa(*args, **k):
            self.calls.append(args)
            out = json.dumps({'sessions': [row]}) if args[:1] == ('list',) else 'Sent to duties green fleet'
            return type('Done', (), {'returncode': 0, 'stdout': out, 'stderr': ''})()
        watchdog.pa = pa
        verdicts, _ = watchdog._cycle(verbose=False)
        return verdicts[0]['verdict'], [c for c in self.calls if c[:1] == ('send',)]

    def skips(self):
        return [json.loads(ln) for ln in (self.dir / 'log.jsonl').read_text().splitlines() if '"work_done"' in ln]

    def test_a_job_whose_steps_are_closed_gets_no_wake_and_one_logged_skip(self):
        jobs = {JOB: (CHAT, 'idle', [], False)}
        first = self.cycle(DROPPED, jobs)
        second = self.cycle(DROPPED, jobs)
        self.assertEqual((first, second[0]), (('WORK_DONE', []), 'NOTICED'))
        self.assertEqual([(s['sid'], s['skip']) for s in self.skips()], [(JOB, 'work_done')])

    def test_a_job_an_open_step_names_is_woken(self):
        verdict, sends = self.cycle(DROPPED, {JOB: (CHAT, 'idle', ['p456'], False)})
        self.assertEqual((verdict, len(sends)), ('DROPPED_TURN', 1))

    def test_a_job_the_chat_shows_working_is_woken(self):
        self.assertEqual(self.cycle(DROPPED, {JOB: (CHAT, 'working', [], False)})[0], 'DROPPED_TURN')

    def test_an_unanswered_owner_message_to_a_finished_job_is_woken(self):
        events = [*DROPPED, {'type': 'message', 'timestamp': at(9800), 'message': {'role': 'assistant', 'stopReason': 'stop',
                                                                                     'content': [{'type': 'text', 'text': 'All duties are green.'}]}},
                  user('did the d9 duty stay green?', 60)]
        self.assertEqual(self.cycle(events, {JOB: (CHAT, 'done', [], False)})[0], 'DROPPED_TURN')

    def test_a_session_no_chat_lists_is_woken(self):
        self.assertEqual(self.cycle(DROPPED, {})[0], 'DROPPED_TURN')

    def test_a_board_that_did_not_read_never_reads_work_as_done(self):
        self.assertEqual(self.cycle(DROPPED, {JOB: (CHAT, 'idle', [], True)})[0], 'DROPPED_TURN')

    def test_open_steps_walk_children(self):
        board = {'plan': [{'id': 'p1', 'status': 'done', 'children': [{'id': 'p2', 'status': 'doing'}]}, {'id': 'p3', 'status': 'dropped'},
                          {'id': 'p4', 'status': 'todo'}]}
        self.assertEqual(wd_common.open_steps(board), {'p2', 'p4'})

    def test_a_brief_is_no_owner_message(self):
        self.assertFalse(watchdog.from_owner(user(BRIEF, 1)))
        self.assertFalse(watchdog.from_owner(user('[task from parent]\n\nOwner\'s words: fix it', 1)))


if __name__ == '__main__':
    unittest.main()
