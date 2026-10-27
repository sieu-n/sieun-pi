"""checkin pushes goals (01a14d7c-1a93-7008-bc1e-bde0d047eaf9) on us-metal02, 10-24: its parent's prompt at 19:05:27Z sat 105th in pi-pool's
turn queue, its board.wake for 10:40Z on 10-25 was pending, and it reported to its parent at 19:33:50Z, while the cycle that read it at 19:33Z
probed the model. At 19:35:33Z that cycle sent its parent "[watchdog] Your subagent 'checkin pushes goals' has produced nothing for 137.9
minutes: its turn never dispatched and there is no shell process left to unblock. Cancel that child (rlm.delete_subagent) ...". A silent
subagent with a pending wake, a run in pi-pool's turn queue or a message to its parent after its last prompt now gets no notice, and
ChildRanAgain replays pi cutover prep on 10-27, which pi-pool admitted while the cycle that read it silent probed the models.

WATCHDOG_DIR=<folder with the old watchdog files> runs the same cases against the old cycle, where the waiting cases fail."""
import datetime as dt, json, os, sys, tempfile, time, unittest
from pathlib import Path

HERE = Path(os.environ.get('WATCHDOG_DIR') or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(HERE))
import wd_common  # noqa: E402
import watchdog  # noqa: E402

CHILD, PARENT = '01a14d7c-1a93-7008-bc1e-bde0d047eaf9', '01a1164b-4a2d-742d-b27a-82f086ed0200'


def at(minutes_ago):
    return (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=minutes_ago)).isoformat().replace('+00:00', 'Z')


def report(minutes_ago):
    code = 'await agent_message.send("p516 row added; d9 duties_green_pct 71.", receiver_role="parent")'
    return {'type': 'message', 'timestamp': at(minutes_ago), 'message': {'role': 'assistant', 'stopReason': 'toolUse', 'content': [
        {'type': 'toolCall', 'id': 'call_1', 'name': 'ipython', 'arguments': {'code': code}}]}}


def done(minutes_ago):
    return {'type': 'message', 'timestamp': at(minutes_ago), 'message': {'role': 'assistant', 'stopReason': 'stop',
                                                                          'content': [{'type': 'text', 'text': 'Reported.'}]}}


def prompt(minutes_ago):
    return {'type': 'message', 'timestamp': at(minutes_ago), 'message': {'role': 'user', 'content': [{'type': 'text', 'text': 'check p962'}]}}


def queued(minutes_ago):
    return {'type': 'custom', 'customType': 'pi-pool-queue', 'timestamp': at(minutes_ago),
            'data': {'text': 'Queued for a working slot, 105th of 105', 'position': 105, 'total': 105}}


# The child's tail as the 19:33Z cycle read it: its 17:15Z report, then the parent's 19:05:27Z prompt queued in pi-pool.
TAIL = [prompt(146), report(138.4), done(137.9), prompt(28), queued(28)]


class Cycle(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.data = self.dir / 'browser-chat'
        (self.data / 'wakes').mkdir(parents=True)
        self.turns = self.dir / 'turns.json'
        self.turns.write_text(json.dumps({'working': {}, 'queued': {}, 'owner': {}, 'lead': [], 'kept': {}}))
        self.calls = []
        names = ('pa', 'daemon_call', 'pressure', 'heartbeat_rearm', 'probe_model', 'stuck_cell_procs', 'session_busy_tools', '_ps_table',
                 '_descendants', '_tls_count', 'LOG_F', 'STATE_F')
        self.saved = {name: getattr(watchdog, name) for name in names}
        self.saved_common = (wd_common.CHAT_DATA, getattr(wd_common, 'POOL_TURNS', None))
        wd_common.CHAT_DATA, wd_common.POOL_TURNS = self.data, self.turns
        watchdog.LOG_F, watchdog.STATE_F = self.dir / 'log.jsonl', self.dir / 'state.json'
        watchdog.pressure = lambda: (0.0, 0.0)
        watchdog.daemon_call = lambda *a, **k: {}
        watchdog.heartbeat_rearm = lambda *a, **k: []
        watchdog.stuck_cell_procs = lambda *a, **k: []
        watchdog.session_busy_tools = lambda *a, **k: []
        watchdog._ps_table = lambda *a, **k: {}
        watchdog._descendants = lambda *a, **k: []
        watchdog._tls_count = lambda *a, **k: 0
        self.during_probe = None
        watchdog.probe_model = lambda model, *a, **k: (self.during_probe and self.during_probe()) or {'outcome': 'alive', 'model': model}

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(watchdog, name, value)
        wd_common.CHAT_DATA, wd_common.POOL_TURNS = self.saved_common

    def cycle(self, tail):
        child = self.dir / f'{CHILD}.jsonl'
        child.write_text(''.join(json.dumps(e) + '\n' for e in [{'type': 'session', 'id': CHILD, 'timestamp': at(1200)}, *tail]))
        parent = self.dir / f'{PARENT}.jsonl'
        parent.write_text(''.join(json.dumps(e) + '\n' for e in [{'type': 'session', 'id': PARENT, 'timestamp': at(3000)}, prompt(2), done(1)]))
        rows = [{'id': PARENT, 'sessionId': PARENT, 'sessionName': 'AI harness developer environment VP', 'sessionFile': str(parent),
                 'lifecycle': 'live', 'activity': 'working', 'rlmDepth': 0, 'model': {'id': 'claude-opus-5-5'}, 'messageCount': 900,
                 'workerPid': 4242},
                {'id': CHILD, 'sessionId': CHILD, 'sessionName': 'checkin pushes goals', 'sessionFile': str(child), 'parentSessionId': PARENT,
                 'lifecycle': 'live', 'activity': 'working', 'rlmDepth': 1, 'model': {'id': 'claude-opus-5-5'}, 'messageCount': 1549,
                 'workerPid': 4242, 'isStreaming': False}]

        def pa(*args, **k):
            self.calls.append(args)
            out = json.dumps({'sessions': rows}) if args[:1] == ('list',) else f'Sent to {args[1]}'
            return type('Done', (), {'returncode': 0, 'stdout': out, 'stderr': ''})()
        watchdog.pa = pa
        verdicts, _ = watchdog._cycle(verbose=False)
        return next(r['verdict'] for r in verdicts if r['sid'] == CHILD), [c for c in self.calls if c[:1] == ('send',)]


class WaitingChild(Cycle):
    def test_a_child_with_no_reason_to_wait_still_gets_its_parent_a_notice(self):
        verdict, sends = self.cycle(TAIL)
        self.assertEqual(verdict, 'CHILD_WEDGED')
        self.assertEqual([(s[1], 'Cancel that child' in s[2]) for s in sends], [(PARENT, True)])

    def test_a_child_with_a_pending_wake_gets_no_notice(self):
        wake = {'session': CHILD, 'root': PARENT, 'on': {'kind': 'time', 'at': 1792924800000}, 'note': 'p962 daily reds', 'since': 1792862110532}
        (self.data / 'wakes' / f'{CHILD}-time-1792924800.json').write_text(json.dumps(wake))
        self.assertEqual(self.cycle(TAIL), ('OK', []))

    def test_a_child_queued_in_pi_pool_gets_no_notice(self):
        self.turns.write_text(json.dumps({'working': {}, 'queued': {CHILD: {'tree': PARENT, 'since': 1792868727.6}}, 'owner': {}, 'lead': [],
                                          'kept': {}}))
        self.assertEqual(self.cycle(TAIL), ('OK', []))

    def test_a_child_that_reported_while_the_cycle_probed_gets_no_notice(self):
        def reports():
            with open(self.dir / f'{CHILD}.jsonl', 'a') as f:
                f.write(json.dumps(report(0)) + '\n')
        self.during_probe = reports
        self.assertEqual(self.cycle(TAIL), ('OK', []))


def agent_message(minutes_ago):
    return {'type': 'custom_message', 'customType': 'agent_message', 'timestamp': at(minutes_ago),
            'content': '[agent-message from parent:AI harness developer environment VP]\n\nAdd the pi-host schedules test.'}


def tool_call(minutes_ago):
    return {'type': 'message', 'timestamp': at(minutes_ago), 'message': {'role': 'assistant', 'stopReason': 'toolUse', 'content': [
        {'type': 'toolCall', 'id': 'call_2', 'name': 'ipython', 'arguments': {'code': 'print(1)'}}]}}


# pi cutover prep (01a17e4f-f87a-756b-ac56-2ed15ad5b609) as the 19:08:57Z cycle on 10-27 read it: its turn ended at 18:17:37Z, its parent's
# message at 18:27:58Z sat 136th in pi-pool's turn queue, and pi-pool admitted it at 19:14:37Z while that cycle probed three models.
REOPENED = [prompt(120), done(51.7), agent_message(41.3), queued(41.3)]


class ChildRanAgain(Cycle):
    """The 19:08:57Z cycle read pi cutover prep silent 51.7 min and sent its parent "Cancel that child" at 19:15:31Z, after pi-pool had
    admitted the child at 19:14:37Z and it had written 7 tool calls. A child that got its pool slot or wrote output after the cycle read it
    gets no notice; one that holds its slot and has said nothing for 45 min still does."""

    def queue(self):
        self.turns.write_text(json.dumps({'working': {}, 'queued': {CHILD: {'tree': PARENT, 'since': time.time() - 41.3 * 60}}, 'owner': {},
                                          'lead': [], 'kept': {}}))

    def admit(self, minutes_ago):
        self.turns.write_text(json.dumps({'working': {CHILD: {'tree': PARENT, 'kind': 'slot', 'since': time.time() - minutes_ago * 60}},
                                          'queued': {}, 'owner': {}, 'lead': [], 'kept': {}}))

    def test_a_child_admitted_and_working_while_the_cycle_probed_gets_no_notice(self):
        self.queue()

        def runs():
            self.admit(0.9)
            with open(self.dir / f'{CHILD}.jsonl', 'a') as f:
                f.write(json.dumps(tool_call(0.8)) + '\n')
        self.during_probe = runs
        self.assertEqual(self.cycle(REOPENED), ('OK', []))

    def test_a_child_admitted_while_the_cycle_probed_gets_no_notice_before_its_first_output(self):
        self.queue()
        self.during_probe = lambda: self.admit(0.2)
        self.assertEqual(self.cycle(REOPENED), ('OK', []))

    def test_a_child_that_holds_its_slot_and_says_nothing_for_45_minutes_still_gets_a_notice(self):
        self.admit(50)
        verdict, sends = self.cycle([prompt(120), done(70), agent_message(60), queued(60)])
        self.assertEqual(verdict, 'CHILD_WEDGED')
        self.assertEqual([(s[1], 'Cancel that child' in s[2]) for s in sends], [(PARENT, True)])


if __name__ == '__main__':
    unittest.main()
