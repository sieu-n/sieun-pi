"""From 10-20 to 10-22 the Mac's watchdog sent 1291 dropped-turn notices, 1203 of them to sessions whose uuid the daemon refused as "Unknown
active session". 1011 went to five jobs whose trees were gone: douyin duty box sync and discover page errors, whose chats the owner archived on
the chat host while the Mac read its own stale archived-chats.json, and box-takeover, vite-mem and limits-flagged-10-16, whose roots were
archived and in no chat or thread list. A job whose tree is gone now reads ARCHIVED and takes none of the cycle's budget, and a notice the
daemon refuses for its uuid goes through the chat service's agent outbox, which relays it to the parent or opens the root.

WATCHDOG_DIR=<folder with the old watchdog files> runs the same cases against the old cycle, where the gone and outbox cases fail."""
import datetime as dt, http.server, json, os, shutil, sys, tempfile, threading, unittest
from pathlib import Path

HERE = Path(os.environ.get('WATCHDOG_DIR') or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(HERE))
import wd_common  # noqa: E402
import watchdog  # noqa: E402

ROOT = '01a14d65-a8d3-75d8-91f6-ca06a694e4ac'
JOB = '01a14d9c-3aa8-723b-87b6-c0167dfd3db2'
REFUSED = 'Error: Unknown active session: ' + JOB


def at(minutes_ago):
    return (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=minutes_ago)).isoformat().replace('+00:00', 'Z')


class GoneAndOutbox(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.calls, self.daemon, self.outbox = [], [], []
        self.saved = {name: getattr(watchdog, name, None) for name in ('pa', 'daemon_call', 'pressure', 'heartbeat_rearm', 'LOG_F', 'STATE_F', 'outbox_notice')}
        self.saved_data = wd_common.CHAT_DATA
        wd_common.CHAT_DATA = self.dir
        watchdog.LOG_F, watchdog.STATE_F = self.dir / 'log.jsonl', self.dir / 'state.json'
        watchdog.pressure = lambda: (0.0, 0.0)
        watchdog.daemon_call = lambda payload, *a, **k: self.daemon.append(payload) or {}
        watchdog.heartbeat_rearm = lambda recs, *a, **k: []
        watchdog.outbox_notice = lambda session, root, text: self.outbox.append((session, root)) or {'deliveryStatus': 'queued', 'session': session}
        job_dir = self.dir / 'session-artifacts' / ROOT / 'sub-a118b785'
        job_dir.mkdir(parents=True)
        self.file = job_dir / f'{JOB}.jsonl'
        events = [{'type': 'session', 'id': JOB, 'timestamp': at(400)},
                  {'type': 'message', 'timestamp': at(300), 'message': {'role': 'user', 'content': [{'type': 'text', 'text': '[task from parent] take over the box'}]}}]
        self.file.write_text(''.join(json.dumps(e) + '\n' for e in events))

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(watchdog, name, value)
        wd_common.CHAT_DATA = self.saved_data
        shutil.rmtree(self.dir)

    def records(self, chats=(), threads=()):
        (self.dir / 'chats.json').write_text(json.dumps({'ids': list(chats)}))
        (self.dir / 'threads.json').write_text(json.dumps({'ids': list(threads)}))

    def cycle(self, root_life='archived', send_rc=1):
        rows = [{'id': JOB, 'sessionId': JOB, 'sessionName': 'box-takeover', 'sessionFile': str(self.file), 'lifecycle': 'live', 'activity': 'idle',
                 'rlmDepth': 1, 'runtimeKind': 'subagent', 'model': {'id': 'claude-opus-5-5'}, 'messageCount': 2}]
        if root_life:
            rows.append({'id': ROOT, 'sessionId': ROOT, 'sessionName': None, 'sessionFile': str(self.dir / f'{ROOT}.jsonl'), 'lifecycle': root_life,
                         'activity': 'idle', 'rlmDepth': 0, 'model': {'id': 'claude-opus-5-5'}, 'messageCount': 40})

        def pa(*args, **k):
            self.calls.append(args)
            listing = args[:1] == ('list',)
            out = json.dumps({'sessions': rows}) if listing else 'Sent to box-takeover' if send_rc == 0 else REFUSED
            return type('Done', (), {'returncode': 0 if listing else send_rc, 'stdout': out, 'stderr': ''})()
        watchdog.pa = pa
        verdicts, actions = watchdog._cycle(verbose=False)
        job = next(v for v in verdicts if v['sid'] == JOB)
        return job['verdict'], [c for c in self.calls if c[:1] == ('send',)], actions

    def test_a_job_whose_root_is_archived_and_in_no_chat_list_reads_archived(self):
        self.records(chats=['01a1164b-4a2d-742d-b27a-82f086ed0200'])
        verdict, sends, actions = self.cycle()
        self.assertEqual((verdict, sends, self.outbox, actions), ('ARCHIVED', [], [], []))
        self.assertEqual(watchdog.LAST_COUNTS['resumed'], 0)

    def test_a_job_whose_root_is_not_listed_and_in_no_chat_list_reads_archived(self):
        self.records()
        self.assertEqual(self.cycle(root_life=None)[0], 'ARCHIVED')

    def test_a_job_of_a_dormant_chat_is_still_resumed_through_the_outbox(self):
        self.records(chats=[ROOT])
        verdict, sends, actions = self.cycle()
        self.assertEqual((verdict, len(sends), self.outbox), ('DROPPED_TURN', 1, [(JOB, ROOT)]))
        self.assertEqual((actions[0]['method'], actions[0]['outbox']['deliveryStatus']), ('resume_queue + outbox', 'queued'))

    def test_a_job_of_a_thread_is_still_resumed(self):
        self.records(threads=[ROOT])
        self.assertEqual(self.cycle()[0], 'DROPPED_TURN')

    def test_a_job_under_a_live_root_is_still_resumed(self):
        self.records()
        self.assertEqual(self.cycle(root_life='live')[0], 'DROPPED_TURN')

    def test_unread_chat_lists_never_read_a_tree_as_gone(self):
        self.assertEqual(self.cycle()[0], 'DROPPED_TURN')

    def test_a_send_that_goes_through_needs_no_outbox(self):
        self.records(chats=[ROOT])
        verdict, sends, actions = self.cycle(send_rc=0)
        self.assertEqual((verdict, len(sends), self.outbox, actions[0]['method']), ('DROPPED_TURN', 1, [], 'resume_queue + send'))

    def test_the_outbox_notice_posts_to_the_chat_service_with_its_token(self):
        got = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                got.append((self.path, self.headers['X-Chat-Token'], self.headers['Origin'], json.loads(body)))
                answer = json.dumps({'deliveryStatus': 'queued', 'session': JOB}).encode()
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(answer)

            def log_message(self, *args):
                pass
        server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        port = server.server_address[1]
        (self.dir / 'configuration.json').write_text(json.dumps({'port': port, 'capability': 'cap', 'csrfToken': 'tok'}))
        saved = os.environ.get('SIEUN_PI_HOSTS')
        os.environ['SIEUN_PI_HOSTS'] = str(self.dir / 'no-hosts.json')
        try:
            answer = wd_common.outbox_notice(JOB, ROOT, '[watchdog] continue')
        finally:
            os.environ.pop('SIEUN_PI_HOSTS') if saved is None else os.environ.__setitem__('SIEUN_PI_HOSTS', saved)
        self.assertEqual(answer, {'deliveryStatus': 'queued', 'session': JOB})
        self.assertEqual(got, [('/cap/api/agent/notice', 'tok', f'http://127.0.0.1:{port}', {'to': JOB, 'message': '[watchdog] continue', 'root': ROOT})])


if __name__ == '__main__':
    unittest.main()
