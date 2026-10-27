"""dhx.3 Prime with the p692 hook on us-metal02, 10-20: when the hook answers exit 75, Prime writes a credential wait marker whose text,
"API key for provider ... is temporarily unavailable until ...: waiting for an account slot", matches ACCOUNT_RE on "api key". The triage
read it as ACCOUNT_ERR, and --apply moves such a tree to another pool account and messages it while pi-pool holds it on purpose."""
import datetime as dt, json, os, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(os.environ.get('WATCHDOG_DIR') or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fleet_triage  # noqa: E402
import wd_common  # noqa: E402
from slot_reader import FIXTURE_ID, fixture_lines, use_reader  # noqa: E402

SID = '01a15a2b-be18-7478-8fd1-ec1fc833dec4'
MARKER = {'type': 'message', 'timestamp': '2026-10-20T17:30:08.140Z', 'message': {
    'role': 'assistant', 'content': [], 'provider': 'anthropic', 'model': 'claude-opus-5-5', 'stopReason': 'error',
    'errorMessage': 'API key for provider "anthropic" is temporarily unavailable until 2026-10-20T17:32:00.000Z: waiting for an account slot',
    'diagnostics': [{'type': 'provider_stream_failure', 'details': {'kind': 'credential_unavailable', 'retryAtMs': 1792517520000, 'retryAfterMs': 111860}}]}}


class MarkerTriage(unittest.TestCase):
    def rows(self, last):
        folder = Path(tempfile.mkdtemp())
        f = folder / f'{SID}.jsonl'
        events = [{'type': 'message', 'timestamp': '2026-10-20T17:30:07.900Z', 'message': {'role': 'user', 'content': 'the duty brief'}}, last]
        f.write_text(''.join(json.dumps(e) + '\n' for e in events))
        row = {'id': 'ec1fc833dec4', 'sessionId': SID, 'sessionName': 'chat page from the mac metal-management 01:34', 'sessionFile': str(f),
               'lifecycle': 'live', 'activity': 'idle', 'rlmDepth': 0, 'model': {'id': 'claude-opus-5-5', 'provider': 'anthropic'}}
        with patch.object(fleet_triage, 'stop_reason', return_value=None):
            return fleet_triage.classify(row, dt.datetime(2026, 10, 20, 17, 45, tzinfo=dt.timezone.utc))

    def test_a_credential_wait_marker_reads_pool_wait_and_apply_does_nothing(self):
        r = self.rows(MARKER)
        self.assertEqual(r['verdict'], 'POOL_WAIT')
        folder = Path(tempfile.mkdtemp())
        with patch.object(fleet_triage, 'load_state', return_value={}), patch.object(fleet_triage.subprocess, 'run') as run, \
                patch.object(fleet_triage, 'send') as send, patch.object(fleet_triage, 'STATE_F', folder / 'state.json'), \
                patch.object(fleet_triage, 'LOG_F', folder / 'triage.jsonl'):
            self.assertEqual(fleet_triage.apply([{**r, 'head_sid': SID, 'recent': ''}], dry=False), [])
        self.assertEqual((run.call_count, send.call_count), (0, 0))

    def test_a_429_still_reads_account_err(self):
        limit = {**MARKER, 'message': {**MARKER['message'], 'errorMessage': 'Provider rate limit exceeded (rate_limit_error, 429)',
                                       'diagnostics': [{'type': 'provider_stream_failure', 'details': {'kind': 'rate_limit', 'status': 429}}]}}
        self.assertEqual(self.rows(limit)['verdict'], 'ACCOUNT_ERR')



class SlotWaitTriage(unittest.TestCase):
    """01a17f25 on 10-27 from 20:56:58Z: its turn ended on pi-pool's slot wait, place 134 of 139, and the table read it POOL_WAIT with no place."""

    def test_a_parked_session_reads_slot_wait_with_its_place(self):
        use_reader(self)
        f = Path(tempfile.mkdtemp()) / f'{FIXTURE_ID}.jsonl'
        f.write_text('\n'.join(fixture_lines('2026-10-27T20:56:58.575Z')) + '\n')
        row = {'id': FIXTURE_ID, 'sessionId': FIXTURE_ID, 'sessionName': 'parked jobs show as waiting', 'sessionFile': str(f), 'lifecycle': 'live',
               'activity': 'idle', 'rlmDepth': 0, 'model': {'id': 'claude-opus-5-5', 'provider': 'anthropic'}}
        with patch.object(fleet_triage, 'list_sessions', return_value=[row]), patch.object(fleet_triage, 'chat_ids', return_value=set()):
            (r,) = fleet_triage.triage()
        self.assertEqual(r['verdict'], 'SLOT_WAIT')
        self.assertRegex(r.get('wait') or '', r'^waits for a working slot, place \d+ of 139$')
        with patch.object(fleet_triage, 'load_state', return_value={}), patch.object(fleet_triage, 'send') as send, \
                patch.object(fleet_triage, 'STATE_F', f.parent / 'state.json'), patch.object(fleet_triage, 'LOG_F', f.parent / 'triage.jsonl'):
            self.assertEqual(fleet_triage.apply([{**r, 'recent': ''}], dry=False), [])
        self.assertEqual(send.call_count, 0)


if __name__ == '__main__':
    unittest.main()
