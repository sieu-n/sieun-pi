"""The model probe: one throwaway session asks the model for one word.

It tells "this session is wedged" from "this model is not answering", which need opposite answers (restart the
session, or leave it alone and switch the model), and from a third case: pi-pool holds the new session in a slot
wait, which says nothing about the model.

The probe runs `prime-agent --mode rpc`, so the watchdog can end it with the rpc `abort` command and close its
stdin. The old probe ran `prime-agent -p` and, after 100 s, ran `pkill -f 'prime-agent -p --model <m>'`. Killing a
-p client mid-turn makes the supervisor log "prompt_and_wait failed: Daemon worker client closed", a fault in the
Whole system precheck (10-18 at 12:44:48Z, 12:54:46Z, 13:14:52Z and the 10:14Z to 10:46Z pairs), and the pattern
also killed a pong probe another agent ran by hand at 13:14:22Z. An abort followed by stdin close ends the turn and
the client with no failed supervisor command (isolated daemon test on 10-18 at 17:05Z).
"""
import datetime as dt
import json
import os
import re
import selectors
import signal
import subprocess
import time
from pathlib import Path

from wd_common import ENV

PROMPT = 'reply with exactly: pong'
PROBE_TIMEOUT_S = 100
# The rpc abort was answered in 0.2 s and the client exited at once after stdin closed (isolated daemon, 10-18 17:05Z).
END_WAIT_S = 15
POOL_LOG = Path(os.environ.get('PI_POOL_DIR') or Path.home() / '.config/pi-pool') / 'pi-pool.log'
# pi-pool's own words for a held session: the extension's "this session waits for its slot at <iso>" and the
# hook's "this session waits for a slot on <account> at <iso>".
SLOT_WAIT = re.compile(r'waits for (?:its|a) slot(?: on \S+)? at (\d{4}-\d\d-\d\dT[\d:.]+Z?)')
POOL_WAIT_EVENTS = ('wait', 'parked')


def _send(proc, command):
    try:
        proc.stdin.write((json.dumps(command) + '\n').encode())
        proc.stdin.flush()
        return True
    except (BrokenPipeError, OSError, ValueError):
        return False


def _lines(proc, deadline):
    """Yield stdout lines of the probe until EOF or the deadline."""
    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ)
    buf = b''
    try:
        while True:
            left = deadline - time.monotonic()
            if left <= 0 or not sel.select(left):
                return
            chunk = os.read(proc.stdout.fileno(), 65536)
            if not chunk:
                return
            buf += chunk
            while b'\n' in buf:
                line, buf = buf.split(b'\n', 1)
                if line.strip():
                    yield line.decode('utf-8', 'replace')
    finally:
        sel.close()


def _assistant_text(message):
    return ''.join(c.get('text') or '' for c in (message.get('content') or []) if isinstance(c, dict))


def pool_wait_row(session, pool_log=POOL_LOG, offset=0):
    """pi-pool's wait row for this session written after `offset` (its parked row when no wait row came), or None.
    A parked row carries slot_at as epoch seconds, which comes back as an ISO time like a wait row's."""
    if not session:
        return None
    try:
        with open(pool_log, 'rb') as f:
            f.seek(offset)
            data = f.read().decode('utf-8', 'replace')
    except OSError:
        return None
    found = None
    for ln in data.splitlines():
        if session not in ln:
            continue
        try:
            row = json.loads(ln)
        except ValueError:
            continue
        if row.get('event') in POOL_WAIT_EVENTS and row.get('session') == session:
            if isinstance(row.get('slot_at'), (int, float)):
                row['slot_at'] = dt.datetime.fromtimestamp(row['slot_at'], dt.timezone.utc).isoformat(timespec='seconds')
            if row['event'] == 'wait':
                return row
            found = found or row
    return found


def _finish(proc, turn_open, end_wait=END_WAIT_S):
    """End the probe: rpc abort when its turn is still open, then close stdin. Signals go only to the probe's own
    process group, which it got from start_new_session, never to a command-line pattern."""
    how = 'closed'
    if turn_open and _send(proc, {'type': 'abort', 'id': 'abort'}):
        how = 'aborted'
        for line in _lines(proc, time.monotonic() + end_wait):
            if '"abort"' in line and '"response"' in line:
                break
    try:
        proc.stdin.close()
    except OSError:
        pass
    try:
        proc.wait(end_wait)
        proc.stdout.close()
        return how
    except subprocess.TimeoutExpired:
        pass
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            break
        try:
            proc.wait(5)
            break
        except subprocess.TimeoutExpired:
            continue
    proc.stdout.close()
    return 'killed own group'


def probe_model(model, timeout=PROBE_TIMEOUT_S, pool_log=POOL_LOG, env=None, end_wait=END_WAIT_S):
    """-> {'outcome': 'alive' | 'stalled' | 'pool_wait', ...} for one throwaway session on `model`.

    'pool_wait' comes from pi-pool's slot-wait text in the session's own stream, or from a pi-pool.log wait row
    for the session's id, and means the pool, not the model, held the turn.
    """
    started = time.monotonic()
    try:
        offset = os.path.getsize(pool_log)
    except OSError:
        offset = 0
    out = {'model': model, 'outcome': 'stalled', 'session': None,
           'at': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}
    try:
        proc = subprocess.Popen(['prime-agent', '--mode', 'rpc', '--model', model, '--no-session', '--no-tools'],
                                cwd='/tmp', stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, env=env or ENV, start_new_session=True)
    except OSError as e:
        out.update(error=f'{type(e).__name__}: {e}'[:200], sec=0.0)
        return out
    out['pid'] = proc.pid
    _send(proc, {'type': 'get_state', 'id': 'state'})
    _send(proc, {'type': 'prompt', 'id': 'probe', 'message': PROMPT})
    turn_open = True
    for line in _lines(proc, started + timeout):
        wait = SLOT_WAIT.search(line)
        if wait:
            out.update(outcome='pool_wait', slot_at=wait.group(1), via='stream')
            break
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get('type') == 'response' and ev.get('command') == 'get_state':
            out['session'] = (ev.get('data') or {}).get('sessionId')
        elif ev.get('type') == 'message_end' and (ev.get('message') or {}).get('role') == 'assistant':
            msg = ev['message']
            if 'pong' in _assistant_text(msg).lower():
                out['outcome'] = 'alive'
            elif msg.get('errorMessage'):
                out['error'] = str(msg['errorMessage'])[:200]
        elif ev.get('type') == 'agent_end':
            turn_open = False
            break
    if out['outcome'] == 'stalled':
        row = pool_wait_row(out['session'], pool_log, offset)
        if row:
            out.update(outcome='pool_wait', slot_at=row.get('slot_at'), via='pi-pool.log', account=row.get('account'))
    out['end'] = _finish(proc, turn_open, end_wait)
    out['sec'] = round(time.monotonic() - started, 1)
    return out


def probe_verdict(verdict, why, model, probes):
    """A wedge verdict for a session whose model's probe did not get a word out: MODEL_STALL when the model stalled,
    POOL_WAIT when pi-pool held the probe in a slot wait. Either way host-side recovery would only lose the turn."""
    if verdict not in ('PHANTOM_TURN', 'FROZEN_TURN', 'FROZEN_TOOL', 'STUCK_TOOL') or model not in probes:
        return verdict, why
    p = probes[model]
    if p['outcome'] == 'pool_wait':
        return 'POOL_WAIT', (f"pi-pool holds new {model} sessions in a slot wait (until {p.get('slot_at')}), "
                             f"so this silence is the pool's queue; host-side recovery cannot fix it")
    if p['outcome'] == 'stalled':
        return 'MODEL_STALL', (f"every live {model} session is silent (cohort stall, no provider error) -- "
                               f"host-side recovery cannot fix this; switch the model")
    return verdict, why
