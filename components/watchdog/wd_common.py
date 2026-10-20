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
RESUME_PAUSED = next((path for path in (Path(__file__).resolve().parents[2] / 'skills/resume-paused-sessions/scripts/resume_paused.py',
                                        Path.home() / '.prime/agent/skills/resume-paused-sessions/scripts/resume_paused.py') if path.exists()), None)
_resume_paused = None


def credential_wait_at(message):
    """retryAtMs of Prime's credential wait marker, from resume_paused.py's own reader, else None."""
    global _resume_paused
    if _resume_paused is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location('resume_paused', RESUME_PAUSED)
        _resume_paused = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_resume_paused)
    return _resume_paused.credential_wait_at(message)


def log(entry):
    """Append one record to log.jsonl."""
    with open(LOG_F, 'a') as f:
        f.write(json.dumps(entry, default=str) + '\n')
    return entry


def pa(*args, timeout=180):
    return subprocess.run(['prime-agent', *args], capture_output=True, text=True, env=ENV, timeout=timeout)


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


# The chat service's records (components/user-history): archived-chats.json holds the chats the owner archived and clean-room-chats.json the
# clean-room test chats. On 10-18 the watchdog sent plan-and-duties run-1's test chat "[watchdog] Your last turn was dropped" at 14:34:58Z,
# 6.8 min after its teardown archived it, and the chat went on working into run-2.
CHAT_DATA = Path(os.environ.get('AGENT_CHAT_DATA_DIR') or Path.home() / '.prime/agent/browser-chat')


def chat_ids(name):
    """The ids of one chat service record, empty when the file is missing or unreadable."""
    try:
        ids = json.loads((CHAT_DATA / name).read_text()).get('ids')
    except (OSError, ValueError, AttributeError):
        return set()
    return {i for i in ids if isinstance(i, str)} if isinstance(ids, list) else set()


def stop_reason(sid, file, archived, test_chats):
    """Why no recovery may wake this session, or None: its chat (the session or the root of its session-artifacts tree) is in
    archived-chats.json or clean-room-chats.json. An archived session_state in the file is no reason: the daemon's eviction and the Mac
    copy write it too. Only the owner's unarchive brings such a chat back."""
    parts = Path(file).parts if file else ()
    root = parts[parts.index('session-artifacts') + 1] if 'session-artifacts' in parts[:-2] else None
    ids = {sid, root} - {None}
    if ids & archived:
        return 'archived by the owner (archived-chats.json)'
    if ids & test_chats:
        return 'a clean-room test chat (clean-room-chats.json)'
    return None


def _run(*argv):
    """stdout of argv run directly. A `bash -lc` wrapper sourced nvm.sh and cost ~1 s CPU per call on us-metal02."""
    try:
        return subprocess.run(argv, capture_output=True, text=True).stdout
    except OSError:
        return ''
