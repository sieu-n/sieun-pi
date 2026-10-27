"""Paths, the prime-agent CLI and small readers shared by every watchdog module.

The code runs from its installed copy (components/watchdog/install.py); the state and logs stay in ~/.prime/agent/watchdog.
"""
import datetime as dt
import json
import os
import subprocess
from pathlib import Path

WATCH = Path.home() / '.prime/agent/watchdog'
WATCH.mkdir(parents=True, exist_ok=True)
STATE_F = WATCH / 'state.json'
LOG_F = WATCH / 'log.jsonl'
ENV = dict(os.environ); ENV.pop('FORCE_COLOR', None); ENV['NO_COLOR'] = '1'
# The resume skill owns the reading of a turn's end, credential_wait_at included: the checkout's copy, else the installed skill, since the
# watchdog runs from its own installed release.
RESUME_PAUSED = next((path for path in (Path(__file__).resolve().parents[2] / 'legacy/prime/skills/resume-paused-sessions/scripts/resume_paused.py',
                                        Path.home() / '.prime/agent/skills/resume-paused-sessions/scripts/resume_paused.py') if path.exists()), None)
_resume_paused = None


def credential_wait_at(message):
    """retryAtMs of Prime's credential wait marker, from resume_paused.py's own reader, else None."""
    return _rp().credential_wait_at(message)


def log(entry):
    """Append one record to log.jsonl."""
    with open(LOG_F, 'a') as f:
        f.write(json.dumps(entry, default=str) + '\n')
    return entry


# sieun-pi's daemon reader (legacy/prime/user-history/src/daemon-cli.mjs, src/daemon-list.ts) in the installed runtime or chat release. The
# prime-agent CLI waits a fixed 3 s for the daemon's hello, and on 10-22 65 of 108 probes on us-metal02 got it after 3 to 7 s, and at 04:42Z
# `prime-agent list` failed so twice. The reader waits 30 s and opens the daemon once more after a failed hello.
READER_ROOTS = (Path.home() / '.local/share/sieun-pi-runtime/current', Path.home() / '.local/share/sieun-pi-chat/current')
HANDSHAKE_MISSES = ('waiting for the Prime Agent daemon handshake', 'connecting to the Prime Agent daemon')


def daemon_reader():
    """[node, daemon-cli.mjs] from the first root that has it with its tsx, or None."""
    import shutil
    node = next((str(p) for p in (Path.home() / '.local/node/bin/node', Path.home() / '.local/bin/node') if p.exists()), None) or shutil.which('node', path=ENV.get('PATH'))
    script = next((root / 'legacy/prime/user-history/src/daemon-cli.mjs' for root in READER_ROOTS
                   if (root / 'legacy/prime/user-history/src/daemon-cli.mjs').is_file() and (root / 'legacy/prime/user-history/node_modules/tsx').is_dir()), None)
    return [node, str(script)] if node and script else None


def pa(*args, timeout=180):
    """One prime-agent command. A list or a plain send goes through the daemon reader when this box has it; every other command, or any
    command on a box without it, runs the CLI and runs once more when the daemon's hello missed its 3 s, since nothing was done then."""
    reader = daemon_reader()
    if reader and args[:1] == ('list',) and set(args[1:]) <= {'--all', '--json'}:
        return subprocess.run([*reader, 'list', *(['--all'] if '--all' in args else [])], capture_output=True, text=True, env=ENV, timeout=timeout)
    if reader and args[:1] == ('send',) and len(args) == 3 and not args[1].startswith('-'):
        done = subprocess.run([*reader, 'send', args[1], args[2]], capture_output=True, text=True, env=ENV, timeout=timeout)
        if done.returncode == 0:
            done.stdout = f'Sent to {args[1]}'
        return done
    done = subprocess.run(['prime-agent', *args], capture_output=True, text=True, env=ENV, timeout=timeout)
    if done.returncode != 0 and any(miss in (done.stderr or '') + (done.stdout or '') for miss in HANDSHAKE_MISSES):
        done = subprocess.run(['prime-agent', *args], capture_output=True, text=True, env=ENV, timeout=timeout)
    return done


def _ts(x):
    try:
        return dt.datetime.fromisoformat(str(x).replace('Z', '+00:00'))
    except Exception:
        return None


def _tail_events(path, n=30, window=400_000):
    """The last n parseable events of the file's last `window` bytes, read from a small tail first."""
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2); size = f.tell()
            for back in (min(window, 64_000), window):
                f.seek(max(0, size - back))
                out = []
                for ln in reversed(f.read().decode('utf-8', 'ignore').splitlines()[1:]):
                    if len(out) == n:
                        break
                    try:
                        out.append(json.loads(ln))
                    except Exception:
                        pass
                if len(out) == n or back >= size:
                    break
    except OSError:
        return []
    return out[::-1]


# The chat service's records (legacy/prime/user-history): archived-chats.json holds the chats the owner archived, clean-room-chats.json the
# clean-room test chats, and chats.json and threads.json the chats and threads it shows. On 10-18 the watchdog sent plan-and-duties run-1's
# test chat "[watchdog] Your last turn was dropped" at 14:34:58Z, 6.8 min after its teardown archived it, and the chat went on working into run-2.
DEFAULT_CHAT_DATA = Path.home() / '.prime/agent/browser-chat'
CHAT_DATA = Path(os.environ.get('AGENT_CHAT_DATA_DIR') or DEFAULT_CHAT_DATA)


POOL_TURNS = Path(os.environ.get('PI_POOL_DIR') or Path.home() / '.config/pi-pool') / 'turns.json'


def pending_wake(sid):
    """The name of a board.wake file the chat service still holds for session `sid`, else None. The service deletes a wake once it sends it."""
    return next((p.name for p in sorted((CHAT_DATA / 'wakes').glob(f'{sid}-*.json'))), None) if sid else None


def pool_kept(sid):
    """Whether pi-pool's turn queue (turns.json `kept`) keeps the place of a run of session `sid` that it let go on an account wait or with
    input queued, for the session's next run. A run that waits for a working slot reads through `slot_parks`."""
    try:
        turns = json.loads(POOL_TURNS.read_text())
    except (OSError, ValueError):
        return False
    return sid in (turns.get('kept') or {})


# sieun-pi's one reader of a session parked on a pi-pool working slot (legacy/prime/user-history/src/slot-park.ts), through the daemon reader's
# `slot-park` command, which also reads `pi-pool queue --json`. On us-metal02 on 10-28 it read the 1,967 live session files in 3.2 s and all
# 7,028 in 6.7 s at a load near 110.
SLOT_PARK_S = 60


def slot_parks(files):
    """{session id: park} for each of the session `files` that waits for a pi-pool working slot, or None when this box has no reader or it
    failed. A park is {since, place?, total?, resumeAt?, starting?, words}, and `words` reads "waits for a working slot, place 104 of 193"."""
    files = sorted({f for f in files if f})
    if not files:
        return {}
    reader = daemon_reader()
    if not reader:
        return None
    try:
        done = subprocess.run([*reader, 'slot-park', *files], capture_output=True, text=True, env=ENV, timeout=SLOT_PARK_S)
        parks = json.loads(done.stdout).get('parks') if done.returncode == 0 else None
    except (OSError, ValueError, AttributeError, subprocess.TimeoutExpired):
        return None
    return {sid: park for sid, park in parks.items() if isinstance(park, dict)} if isinstance(parks, dict) else None


def pool_admitted_at(sid):
    """When pi-pool's turn queue (turns.json `working`) gave session `sid` the slot it holds now, else None."""
    try:
        since = ((json.loads(POOL_TURNS.read_text()).get('working') or {}).get(sid) or {}).get('since')
    except (OSError, ValueError, AttributeError):
        return None
    return dt.datetime.fromtimestamp(since, dt.timezone.utc) if isinstance(since, (int, float)) else None


def _rp():
    """resume_paused.py, loaded once."""
    global _resume_paused
    if _resume_paused is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location('resume_paused', RESUME_PAUSED)
        _resume_paused = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_resume_paused)
    return _resume_paused


def chat_text(name):
    """The text of one chat service file, or None. It comes from the chat host when hosts.json puts the chat role on another box
    (resume_paused.chat_file_text): the Mac's own browser-chat folder stopped on 10-18 when the chat moved to us-metal02, and its
    archived-chats.json lacked the 10-20 archive of Douyin index gaps, so the Mac's cycles kept waking that chat's job douyin duty box sync.
    A CHAT_DATA set by a test or AGENT_CHAT_DATA_DIR reads that folder alone."""
    if CHAT_DATA == DEFAULT_CHAT_DATA and RESUME_PAUSED:
        import contextlib, io
        try:
            with contextlib.redirect_stderr(io.StringIO()):
                return _rp().chat_file_text(CHAT_DATA / name)[0]
        except Exception:
            return None
    try:
        return (CHAT_DATA / name).read_text()
    except OSError:
        return None


def chat_ids(name):
    """The ids of one chat service record, empty when the file is missing or unreadable; None for chats.json and threads.json then, since
    an empty list of those would read every tree as gone."""
    try:
        ids = json.loads(chat_text(name) or 'null').get('ids')
    except (ValueError, AttributeError):
        ids = None
    if not isinstance(ids, list):
        return None if name in ('chats.json', 'threads.json') else set()
    return {i for i in ids if isinstance(i, str)}


def tree_root(file):
    """The root session of the session-artifacts tree that holds `file`, or None for a root's own file."""
    parts = Path(file).parts if file else ()
    return parts[parts.index('session-artifacts') + 1] if 'session-artifacts' in parts[:-2] else None


def stop_reason(sid, file, archived, test_chats):
    """Why no recovery may wake this session, or None: its chat (the session or the root of its session-artifacts tree) is in
    archived-chats.json or clean-room-chats.json. An archived session_state in the file is no reason: the daemon's eviction and the Mac
    copy write it too. Only the owner's unarchive brings such a chat back."""
    ids = {sid, tree_root(file)} - {None}
    if ids & archived:
        return 'archived by the owner (archived-chats.json)'
    if ids & test_chats:
        return 'a clean-room test chat (clean-room-chats.json)'
    return None


def gone_reason(file, root_life, shown):
    """Why a job's tree is gone, or None: a record says it or a job above it was deleted or cancelled on purpose (resume_paused.stop_record:
    deleted-jobs.json, the RLM ledger, rlm-subagent.json, job-cancels.json), or its root is archived on this daemon and is no chat or thread
    the chat service shows (`shown`, None when chats.json or threads.json did not read). From 10-20 to 10-22 the Mac woke box-takeover,
    vite-mem and limits-flagged-10-16 every cycle, jobs whose roots were archived and in no chat list."""
    root = tree_root(file)
    if not root:
        return None
    if CHAT_DATA == DEFAULT_CHAT_DATA and RESUME_PAUSED:
        import contextlib, io
        try:
            with contextlib.redirect_stderr(io.StringIO()):
                why = _rp().stop_record(file)
        except Exception:
            why = None
        if why:
            return why
    if shown is not None and root not in shown and root_life in ('archived', None):
        return f"its tree's root {root} is {root_life or 'not listed'} and no chat or thread of the chat service holds it"
    return None


def chat_service():
    """(base URL, write token, origin) of the chat service, as legacy/prime/user-history/src/chat-host.ts chatService finds it: the chat host of
    hosts.json with ~/.config/sieun-pi/chat-access.json when that is another box, else this box's configuration.json. None when neither is set up."""
    import socket
    hosts_file = Path(os.environ.get('SIEUN_PI_HOSTS') or Path.home() / '.config/sieun-pi/hosts.json')
    try:
        hosts = json.loads(hosts_file.read_text()).get('hosts') or []
    except (OSError, ValueError, AttributeError):
        hosts = []
    try:
        holder = next((h for h in hosts if 'chat' in (h.get('roles') or {})), None)
        if holder and str(holder.get('hostname', '')).split('.')[0].lower() != socket.gethostname().split('.')[0].lower():
            role = holder['roles']['chat']
            origin = (role.get('url') or f"http://{holder['address']}:{role['port']}").rstrip('/')
            access = json.loads((hosts_file.parent / 'chat-access.json').read_text())
            return f"{origin}/{access['capability']}/", access['csrfToken'], origin
        config = json.loads((CHAT_DATA / 'configuration.json').read_text())
        return f"http://127.0.0.1:{config['port']}/{config['capability']}/", config['csrfToken'], f"http://127.0.0.1:{config['port']}"
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def outbox_notice(session, root, text, timeout=60):
    """Hands a notice to the chat service's agent outbox (api/agent/notice, src/agent-outbox.ts), which relays it to the parent of a subagent
    the daemon holds no worker for and opens a root from its file. The answer, or {'error': ...}."""
    import urllib.error
    import urllib.request
    service = chat_service()
    if not service:
        return {'error': 'no chat service is set up on this box or in hosts.json'}
    base, token, origin = service
    body = json.dumps({'to': session, 'message': text, **({'root': root} if root else {})}).encode()
    request = urllib.request.Request(base + 'api/agent/notice', data=body, method='POST', headers={
        'Content-Type': 'application/json', 'X-Chat-Token': token, 'Origin': origin})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode() or '{}')
    except urllib.error.HTTPError as error:
        return {'error': f'{error.code} {error.read().decode(errors="replace")[:200]}'}
    except (OSError, ValueError) as error:
        return {'error': f'{type(error).__name__}: {error}'[:200]}


def _get(path, timeout=30):
    """The JSON answer of one GET to the chat service (the capability in the URL is the read key), or None."""
    import urllib.request
    service = chat_service()
    if not service:
        return None
    try:
        with urllib.request.urlopen(service[0] + path, timeout=timeout) as response:
            return json.loads(response.read().decode() or 'null')
    except (OSError, ValueError):
        return None


def open_steps(board):
    """The ids of a board's plan steps that are neither done nor dropped, children included."""
    found, todo = set(), list((board or {}).get('plan') or [])
    while todo:
        step = todo.pop()
        if isinstance(step, dict):
            if step.get('status') not in ('done', 'dropped') and isinstance(step.get('id'), str):
                found.add(step['id'])
            todo.extend(step.get('children') or [])
    return found


def chat_jobs():
    """{session id: (chat id, state, open step ids that name it)} for every agent a chat lists (api/threads/<chat>/agents, the chat's agents
    panel, with its board's open steps), or None when the chat list or any chat did not answer, so no job reads as finished on a failed read."""
    chats = chat_ids('chats.json')
    if not chats:
        return None
    jobs = {}
    for chat in sorted(chats):
        listed, board = _get(f'api/threads/{chat}/agents'), _get(f'api/agent/board?chat={chat}')
        if not isinstance(listed, dict) or not isinstance(listed.get('agents'), list):
            return None
        live = open_steps(board) if isinstance(board, dict) else None
        for agent in listed['agents']:
            sid = agent.get('sessionId') if isinstance(agent, dict) else None
            if isinstance(sid, str) and sid not in jobs:
                steps = [s for s in agent.get('steps') or [] if isinstance(s, str)]
                jobs[sid] = (chat, agent.get('state'), steps if live is None else [s for s in steps if s in live], live is None)
    return jobs


def work_done(sid, file, events, jobs, shown):
    """Why a dropped turn of a chat's job owes no work, or None. Only a job a chat lists (`chat_jobs`) is judged, by the job sweep's own rule
    (resume_paused.work_owed): it owes work when it is a chat or thread (`shown`), an open step of its chat's board names it, its parent lists
    it as a live child, or an owner or agent message to it has no answer. A job the chat shows working, a board that did not read, a chat list
    that did not read, or a missing resume_paused.py reads as owed. On 10-22 at 03:11Z and 03:22Z the Mac's cycles woke ten jobs whose turns
    dropped on 10-15, among them duties green fleet (p456 done) and checkin stuck_steps fix, and each found its work finished or taken over and
    stopped, a full turn each for nothing."""
    job = (jobs or {}).get(sid)
    if not job or not RESUME_PAUSED or not shown:
        return None
    chat, state, steps, unread = job
    if state == 'working' or unread:
        return None
    if _rp().work_owed(sid, file, events, owners={sid} if steps else set(), chats=shown):
        return None
    return f"the chat {chat} lists it {state or 'with no state'}, and no open step, live parent or unanswered message holds it"


def _run(*argv):
    """stdout of argv run directly. A `bash -lc` wrapper sourced nvm.sh and cost ~1 s CPU per call on us-metal02."""
    try:
        return subprocess.run(argv, capture_output=True, text=True).stdout
    except OSError:
        return ''
