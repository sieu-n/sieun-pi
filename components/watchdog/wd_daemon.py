"""The daemon socket client, which clears a phantom turn, and the tmux drivers of the interactive UI."""
import json
import os
import socket as _socket
import subprocess
import time
import uuid as _uuid

from wd_common import pa

DAEMON_SOCK = os.environ.get('PRIME_AGENT_DAEMON_SOCK') or \
    f"/var/folders/xr/dg7p5bwj479742q3nl2t23b80000gn/T/prime-agent-{os.getuid()}/daemon.sock"


def daemon_call(command, wait=10.0, sock=None):
    """Send one command over the daemon socket (protocol 7 envelope) and return the response.

    `prime-agent stop` kills the worker; on resume the unfinished action is replayed and the
    session drops straight back into the wedge. The daemon's own `abort` reaches the live
    session object instead, which is what actually ends a phantom turn.
    """
    cid = _uuid.uuid4().hex[:8]
    env = {'type': 'command', 'id': cid,
           'protocol': {'name': 'prime-agent.daemon', 'version': 7}, 'command': command}
    s = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
    s.settimeout(wait)
    try:
        s.connect(sock or DAEMON_SOCK)
        s.sendall((json.dumps(env) + '\n').encode())
        buf, t0 = b'', time.time()
        while time.time() - t0 < wait:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
            while b'\n' in buf:
                line, buf = buf.split(b'\n', 1)
                if not line.strip():
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get('id') == cid:
                    return o
    except Exception as e:
        return {'error': f'{type(e).__name__}: {e}'}
    finally:
        s.close()
    return {'error': 'no response'}


def unwedge(active_id, message=None):
    """Clear a phantom streaming turn and drain the queue behind it.

    Wedge signature: activity 'working' + isStreaming true + unfinishedActionCount > 0, no tool
    running, no open provider socket, messages coming back "Queued" instead of "Sent", and no
    assistant record for hours. Cause: requestAbort() leaves _sessionInputPumpSuspended = true and
    the session keeps isStreaming = true, so neither _prompt nor _promptInjectedMessage (both
    gated on !isStreaming) ever unsuspends the pump -- every later message queues forever.
    """
    out = {'id': active_id}
    out['abort'] = daemon_call({'type': 'abort', 'activeSessionId': active_id})
    time.sleep(4)
    out['resume_queue'] = daemon_call({'type': 'resume_queue', 'activeSessionId': active_id})
    if message:
        time.sleep(2)
        sd = pa('send', active_id, message)
        out['send_rc'] = sd.returncode
        out['send_out'] = (sd.stdout or sd.stderr).strip()[:160]
    return out


# ---- tier 3: drive the interactive UI in a detached tmux (ESC + retype) ----

def _tmux(*args, timeout=60):
    return subprocess.run(['tmux', *args], capture_output=True, text=True, timeout=timeout)


def ui_retry(active_id, message, wait=45, keep=False):
    """Attach the real UI in a detached tmux, abort the phantom turn (ESC), retype the prompt.

    `stop` + `send` recreates the session but a resumed turn woken by an agent-message
    sometimes never dispatches a provider request. An attached client + ESC + a typed
    user message does dispatch it.
    """
    ses = f'pawd-{active_id[:8]}'
    msg = ' '.join(str(message).split())[:400].replace('"', "'").replace(';', ',')
    _tmux('kill-session', '-t', ses)
    _tmux('new-session', '-d', '-s', ses, '-x', '200', '-y', '50', f'prime-agent attach {active_id}')
    import time as _t
    _t.sleep(12)
    _tmux('send-keys', '-t', ses, 'Escape'); _t.sleep(3)
    _tmux('send-keys', '-t', ses, msg); _t.sleep(1)
    _tmux('send-keys', '-t', ses, 'Enter'); _t.sleep(wait)
    pane = _tmux('capture-pane', '-p', '-t', ses).stdout
    if not keep:
        pass  # leave the client attached; ui_close() drops it once the turn is moving
    return {'tmux': ses, 'pane_tail': '\n'.join(pane.strip().splitlines()[-8:])}


def ui_close(active_id):
    return _tmux('kill-session', '-t', f'pawd-{active_id[:8]}').returncode == 0


def ui_close_all():
    out = _tmux('ls').stdout
    killed = []
    for ln in out.splitlines():
        name = ln.split(':', 1)[0]
        if name.startswith('pawd'):
            _tmux('kill-session', '-t', name)
            killed.append(name)
    return killed


def switch_model(active_id, model='claude-opus-5', prompt=None, wait=60):
    """Change a live session's model through the real UI selector, then re-prompt it.

    The only cure for a model-level stall: the session, worker and context are fine, the
    provider just never answers for that model.
    """
    ses = f'pmodel-{active_id[:8]}'
    _tmux('kill-session', '-t', ses)
    _tmux('new-session', '-d', '-s', ses, '-x', '200', '-y', '50', f'prime-agent attach {active_id}')
    import time as _t
    _t.sleep(12)
    _tmux('send-keys', '-t', ses, 'Escape'); _t.sleep(3)
    _tmux('send-keys', '-t', ses, '/model'); _t.sleep(2)
    _tmux('send-keys', '-t', ses, 'Enter'); _t.sleep(2)   # accept the completion
    _tmux('send-keys', '-t', ses, 'Enter'); _t.sleep(4)   # open the selector
    _tmux('send-keys', '-t', ses, model); _t.sleep(3)     # filter: signed-in provider ranks first
    _tmux('send-keys', '-t', ses, 'Enter'); _t.sleep(5)
    pane = _tmux('capture-pane', '-p', '-t', ses).stdout
    footer = [l for l in pane.splitlines() if 'agents/resume' in l]
    if prompt:
        msg = ' '.join(str(prompt).split())[:400].replace('"', "'").replace(';', ',')
        _tmux('send-keys', '-t', ses, msg); _t.sleep(1)
        _tmux('send-keys', '-t', ses, 'Enter'); _t.sleep(wait)
        pane = _tmux('capture-pane', '-p', '-t', ses).stdout
    return {'tmux': ses, 'model_line': (footer[0].strip()[:120] if footer else ''),
            'pane_tail': '\n'.join(pane.strip().splitlines()[-6:])}
