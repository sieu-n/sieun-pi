"""Re-applies the local kernel revive guard (prime-agent#3447) when a prime-agent update or rollback rewrites rlm/repl.py.

Without the guard, a kernel revive reopens a saved write-mode file handle with mode 'w' and truncates the file it points at
(2026-10-09/10: controls.py twice). The guard is repl-guard.patch, ported 2026-10-18 to the lazy-restore repl.py of
0.9.8-daemon-fix.1-mem.2 (fix1-mem commit 61a7730), or repl-guard-pre-mem.patch (from w58) for 0.9.8-daemon-fix.1 and older,
which a rollback to bin/previous brings back. Run each watchdog cycle by cron_cycle.py.
Returns one status dict and appends it to log.jsonl when it acted or failed.
"""
import json, os, subprocess, time
from pathlib import Path

WATCH = Path.home() / '.prime/agent/watchdog'
REPL = Path.home() / '.prime/agent/kernel-venv/lib/python3.11/site-packages/rlm/repl.py'
PY = Path.home() / '.prime/agent/kernel-venv/bin/python'
HERE = Path(__file__).resolve().parent
PATCHES = (HERE / 'repl-guard.patch', HERE / 'repl-guard-pre-mem.patch')
MARKER = '_reopen_is_unsafe'
STATE = WATCH / 'repl_guard_state.json'
ALERT_SESSION = '01a11af8-962e-773d-a19a-ee4104011987'   # ops guy (+observability): told once per failed repl.py version


def _log(entry):
    entry = {'kind': 'repl_guard', 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), **entry}
    with open(WATCH / 'log.jsonl', 'a') as fh:
        fh.write(json.dumps(entry) + '\n')
    return entry


def check(repl=REPL, patches=PATCHES, py=PY, run=subprocess.run, send=None, state_file=STATE):
    if not repl.exists():
        return {'status': 'no-repl'}
    text = repl.read_text(errors='ignore')
    if MARKER in text:
        return {'status': 'ok'}
    mtime = int(repl.stat().st_mtime)
    backup = repl.with_name(f'repl.py.bak-unguarded-{mtime}')
    if not backup.exists():
        backup.write_text(text)
    for patch in patches:
        dry = run(['patch', '--dry-run', '--forward', '-p0', str(repl), '-i', str(patch)], capture_output=True, text=True)
        if dry.returncode == 0:
            break
    if dry.returncode == 0:
        run(['patch', '--forward', '-p0', str(repl), '-i', str(patch)], capture_output=True, text=True)
        ok = MARKER in repl.read_text(errors='ignore') and run([str(py), '-c', 'import rlm.repl'], capture_output=True, text=True).returncode == 0
        if ok:
            return _log({'status': 'reapplied', 'repl_mtime': mtime, 'backup': str(backup)})
        repl.write_text(text)   # a guard that breaks the import is worse than none: put the file back
        result = {'status': 'failed', 'why': 'patched repl.py did not import; restored the unpatched file', 'repl_mtime': mtime}
    else:
        result = {'status': 'failed', 'why': 'no repl-guard patch applies to this repl.py: ' + (dry.stdout + dry.stderr).strip()[:200], 'repl_mtime': mtime}
    seen = {}
    try:
        seen = json.loads(state_file.read_text())
    except Exception:
        pass
    if seen.get('alerted_mtime') != mtime and send is not None:
        send(ALERT_SESSION, '[watchdog] The kernel revive guard (prime-agent#3447) is missing from ' + str(repl) +
             ' after a prime-agent update or rollback, and it could not be re-applied automatically (' + result['why'][:160] +
             '). Until it is back, a kernel revive can truncate a tracked file to 0 bytes. Re-port components/watchdog/repl-guard.patch in sieun-pi' +
             ', or rebuild Prime from a tree that carries the guard (fix1-mem commit 61a7730).')
        state_file.write_text(json.dumps({'alerted_mtime': mtime}))
        result['alerted'] = True
    return _log(result)
