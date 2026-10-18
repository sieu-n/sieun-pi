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


def _run(*argv):
    """stdout of argv run directly. A `bash -lc` wrapper sourced nvm.sh and cost ~1 s CPU per call on us-metal02."""
    try:
        return subprocess.run(argv, capture_output=True, text=True).stdout
    except OSError:
        return ''
