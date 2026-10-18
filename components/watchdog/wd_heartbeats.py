"""Heartbeat re-arm (W64, W67): a killed session close cancels its rlm heartbeats, and the watchdog re-creates them once."""
import datetime as dt
import json
import os
import time
import uuid as _uuid
from pathlib import Path

from wd_common import LOG_F, WATCH, _ts, pa
from wd_daemon import daemon_call


# ---- heartbeat re-arm (W64, W67): a killed session close cancels its rlm heartbeats ----
#
# The runtime keeps every scheduled job in ~/.prime/agent/session-artifacts/<session-uuid>/
# scheduled-jobs.json, and the daemon builds its heartbeat list from those files. A "killed" close
# (daemon restart, `prime-agent stop`, a `-p` client exit) flips every active/paused job to
# "cancelled" and nothing re-creates them. On 2026-10-10 12:46Z a fleet event also cancelled them
# one job at a time while every worker pid stayed the same, so a pid change is not loss evidence.
#
# The daemon has no command that creates an rlm heartbeat for a session: `rlm_heartbeat.create` is
# a host request from inside the session's own kernel. So the watchdog re-creates a lost job the way
# the store does (append it to the session's file under the store's own lock, as paused), then asks
# the daemon to resume it (`heartbeat_manage` action "resume"), which sets nextRunAt and wakes the
# scheduler.


HB_F = WATCH / 'heartbeats.json'
ARTIFACTS = Path.home() / '.prime/agent/session-artifacts'
HB_FORGET_DAYS = 7
HB_REARM_ATTEMPTS = 3
JOB_KEYS = ('source', 'runtimeKind', 'deliveryMode', 'sessionId', 'sessionFile', 'cwd', 'label', 'prompt',
            'schedule')
JOB_REQUIRED = ('sessionId', 'sessionFile', 'cwd', 'prompt', 'schedule')
JOBS_LOCK_STALE_S = 30   # the store locks with proper-lockfile: a `<file>.lock` directory, stale after 30 s


def _jobs_file(sid):
    return ARTIFACTS / sid / 'scheduled-jobs.json'


def _artifact_jobs(sid):
    """Jobs in the session's scheduled-jobs.json, by id; None when the file is missing or unreadable."""
    try:
        d = json.loads(_jobs_file(sid).read_text())
        return {j['id']: j for j in d.get('jobs', []) if isinstance(j, dict) and j.get('id')}
    except Exception:
        return None


def _armed(jobs):
    return [j for j in jobs if j.get('source') == 'rlm_heartbeat' and j.get('status') in ('active', 'paused')]


def _hb_key(j):
    return (j.get('label') or '', str((j.get('schedule') or {}).get('expression') or ''))


def _cadence(h):
    s = h.get('schedule') or {}
    e = str(s.get('expression') or '?')
    if s.get('kind') == 'interval':
        return e if e.startswith('every ') else f'every {e}'
    return f"cron '{e}'" if s.get('kind') == 'cron' else e


def _hb_entry(j):
    e = {k: j.get(k) for k in JOB_KEYS if j.get(k) is not None}
    e.update(id=j.get('id'), status=j.get('status'), cadence=_cadence(j))
    return e


def _hb_names(hbs):
    return ', '.join(f"{h.get('label') or str(h.get('id'))[:8]} ({h['cadence']})" for h in hbs)


def _load_hb():
    try:
        d = json.loads(HB_F.read_text())
        return d if isinstance(d.get('sessions'), dict) else {'sessions': {}}
    except Exception:
        return {'sessions': {}}


def _deleted_by_session(session_file, since):
    """Did the session's own transcript call rlm_heartbeat.delete at or after `since`? None: unreadable."""
    t0 = _ts(since)
    if not session_file or not t0:
        return None
    try:
        with open(session_file, errors='replace') as f:
            for line in f:
                if 'rlm_heartbeat.delete' not in line:
                    continue
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                m = e.get('message') or {}
                ts = _ts(e.get('timestamp'))
                if m.get('role') != 'assistant' or not ts or ts < t0:
                    continue
                if any(isinstance(c, dict) and c.get('type') == 'toolCall'
                       and 'rlm_heartbeat.delete' in json.dumps(c.get('arguments')) for c in m.get('content') or []):
                    return True
    except OSError:
        return None
    return False


def _lock_jobs_file(path, wait_s=5.0):
    lock = f'{path}.lock'
    end = time.time() + wait_s
    while True:
        try:
            os.mkdir(lock)
            return lock
        except FileExistsError:
            try:
                if time.time() - os.stat(lock).st_mtime > JOBS_LOCK_STALE_S:
                    os.rmdir(lock)
                    continue
            except OSError:
                continue
            if time.time() >= end:
                return None
            time.sleep(0.05)


def recreate_heartbeat(sid, active_id, h):
    """Re-create one snapshotted rlm heartbeat -> (status, job id, detail).

    'exists': a job with the same label and schedule is already active or paused, nothing written.
    'rearmed': written, and the daemon resumed it (detail is its nextRunAt).
    'paused': written, but the daemon did not resume it (detail is the daemon error).
    'error': nothing written.
    """
    if any(h.get(k) in (None, '') for k in JOB_REQUIRED) or not active_id:
        return 'error', None, 'snapshot lacks ' + ', '.join(k for k in JOB_REQUIRED if h.get(k) in (None, ''))
    path = _jobs_file(sid)
    lock = _lock_jobs_file(path)
    if not lock:
        return 'error', None, f'{path.name}.lock stayed busy'
    try:
        try:
            state = json.loads(path.read_text()) if path.exists() else {'jobs': [], 'dispatches': []}
        except Exception as e:
            return 'error', None, f'{path.name} unreadable: {type(e).__name__}'
        jobs = state.get('jobs')
        if not isinstance(jobs, list):
            return 'error', None, f'{path.name} has no jobs list'
        same = [j for j in _armed(jobs) if _hb_key(j) == _hb_key(h)]
        if same:
            return 'exists', same[0].get('id'), ''
        stamp = dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        job = {k: h[k] for k in JOB_KEYS if h.get(k) is not None}
        job.update(id=str(_uuid.uuid4()), status='paused', source='rlm_heartbeat', activeSessionId=active_id,
                   createdAt=stamp, updatedAt=stamp, runCount=0)
        state['jobs'] = jobs + [job]
        state.setdefault('dispatches', [])
        tmp = path.with_name(f'{path.name}.{os.getpid()}.watchdog.tmp')
        tmp.write_text(json.dumps(state, indent=2) + '\n')
        if path.exists():
            os.chmod(tmp, os.stat(path).st_mode & 0o777)
        os.replace(tmp, path)
    finally:
        try:
            os.rmdir(lock)
        except OSError:
            pass
    r = daemon_call({'type': 'heartbeat_manage', 'activeSessionId': active_id, 'jobId': job['id'],
                     'action': 'resume'}, wait=20.0)
    hb = ((r.get('data') or {}).get('heartbeat') or {}) if isinstance(r, dict) else {}
    if isinstance(r, dict) and r.get('success') is True and hb.get('status') == 'active':
        return 'rearmed', job['id'], hb.get('nextRunAt')
    return 'paused', job['id'], str(r.get('error') if isinstance(r, dict) else r)[:200]


def heartbeats_rearmed_message(when, results):
    """One line for the session: what the watchdog re-created, and the one call left if any stayed paused."""
    done = [h for h, st, _, _ in results if st in ('rearmed', 'exists')]
    paused = [(h, jid) for h, st, jid, _ in results if st == 'paused']
    failed = [h for h, st, _, _ in results if st == 'error']
    m = f"[watchdog] Your rlm heartbeats were cancelled outside this session at {when}."
    if done:
        m += f" I re-created them with the same label, schedule and prompt: {_hb_names(done)}."
    if paused:
        m += (f" These are back but paused because the daemon did not resume them: {_hb_names([h for h, _ in paused])};"
              f" resume each with " + ' and '.join(f"await rlm_heartbeat.update('{j}', status='resume')" for _, j in paused)
              + '.')
    if failed:
        m += (f" I could not re-create {_hb_names(failed)}; the full prompts are in "
              f"~/.prime/agent/watchdog/heartbeats.json, so re-create them with rlm_heartbeat.create.")
    return m + " Check with await rlm_heartbeat.list()."


def heartbeat_rearm(recs, admit, now, dry_run=False):
    """Snapshot each live top-level session's rlm heartbeats; re-create them once when they are lost.

    The snapshot comes from the session's scheduled-jobs.json, the same file the daemon's heartbeat
    list reads, so a slow daemon cannot hide or fake a loss. A loss needs all of: the file is
    readable; the session is live and top-level and has no active or paused rlm heartbeat; the
    snapshot had some; and the session's own transcript has no rlm_heartbeat.delete call since the
    snapshot last saw them. A session that deleted them itself is forgotten without a word.
    """
    actions = []
    state = _load_hb()
    sessions = state['sessions']
    now_iso = now.isoformat()

    def log(e):
        if dry_run:
            return
        e.setdefault('at', dt.datetime.now(dt.timezone.utc).isoformat())
        with open(LOG_F, 'a') as f:
            f.write(json.dumps(e, default=str) + '\n')

    scanned = 0
    for r in recs:
        sid = r.get('sid')
        if not sid or r.get('life') != 'live' or (r.get('depth') or 0) != 0:
            continue
        files = _artifact_jobs(sid)
        if files is None:
            continue            # no readable file: no evidence either way, keep the snapshot
        scanned += 1
        jobs = _armed(files.values())
        snap = sessions.get(sid)
        if jobs:
            # still there or re-created: this is the new snapshot, and any old loss is settled
            sessions[sid] = {'name': r.get('name'), 'active_id': r.get('id'), 'pid': r.get('pid'),
                             'last_seen': now_iso, 'heartbeats': [_hb_entry(j) for j in jobs]}
            continue
        if not snap or not snap.get('heartbeats'):
            continue
        loss = snap.get('loss') or {}
        if loss.get('done_at'):
            continue            # this loss was handled once; wait for the file to list them again
        ids = [h.get('id') for h in snap['heartbeats']]
        cancelled = [files[i] for i in ids if (files.get(i) or {}).get('status') == 'cancelled']
        when = max((j.get('updatedAt') or '' for j in cancelled), default='') or \
            f"some time between {snap.get('last_seen')} and {now_iso}"
        deleted = _deleted_by_session(r.get('file'), snap.get('last_seen'))
        if deleted is None:
            continue
        if deleted:
            log({'kind': 'heartbeats_removed_by_session', 'sid': sid, 'name': r.get('name'), 'ids': ids,
                 'pid': r.get('pid')})
            if not dry_run:
                sessions.pop(sid, None)
            continue
        if dry_run:
            actions.append({'kind': 'heartbeats_lost', 'sid': sid, 'name': r.get('name'), 'cancelled_at': when,
                            'would_rearm': [_hb_key(h) for h in snap['heartbeats']], 'dry_run': True})
            continue
        # Re-creating a schedule costs nothing, so the pressure gate and the wake budget never hold it (ops guy 10-12);
        # only the one-line message, which wakes the session, goes through admit().
        results = []
        for h in snap['heartbeats']:
            try:
                results.append((h,) + recreate_heartbeat(sid, r.get('id'), h))
            except Exception as e:
                results.append((h, 'error', None, f'{type(e).__name__}: {e}'[:200]))
        attempts = int(loss.get('attempts') or 0) + 1
        act = {'kind': 'heartbeats_lost', 'method': 'rearm', 'id': r.get('id'), 'sid': sid, 'name': r.get('name'),
               'cancelled_at': when, 'pid': r.get('pid'), 'attempt': attempts,
               'heartbeats': [{'label': h.get('label'), 'cadence': h.get('cadence'), 'old_id': h.get('id'),
                               'status': st, 'new_id': jid, 'detail': detail} for h, st, jid, detail in results],
               'at': dt.datetime.now(dt.timezone.utc).isoformat()}
        if all(st == 'error' for _, st, _, _ in results) and attempts < HB_REARM_ATTEMPTS:
            snap['loss'] = {'cancelled_at': when, 'detected_at': loss.get('detected_at') or now_iso,
                            'attempts': attempts}
            actions.append(act)
            log(act)
            continue            # nothing written: try again next cycle before telling the session
        msg = heartbeats_rearmed_message(when, results)
        if admit(r, 'HEARTBEATS_LOST'):
            sd = pa('send', sid, msg)
            if sd.returncode != 0:
                time.sleep(5)
                sd = pa('send', sid, msg)
            act.update(send_rc=sd.returncode, send_out=(sd.stdout or sd.stderr).strip()[:160])
        else:
            act.update(send_rc=None, send_out='not sent: wake budget or pressure gate; the heartbeats are re-armed')
        actions.append(act)
        log(act)
        snap['loss'] = {'cancelled_at': when, 'detected_at': loss.get('detected_at') or now_iso,
                        'attempts': attempts, 'done_at': act['at']}
    # forget snapshots not seen for HB_FORGET_DAYS (counted from the last cycle that listed them)
    cut = now - dt.timedelta(days=HB_FORGET_DAYS)
    for sid in [s for s, v in sessions.items() if (_ts(v.get('last_seen')) or now) < cut]:
        sessions.pop(sid, None)
    if not dry_run:
        state.pop('last_list', None)
        state['last_scan'] = {'at': now_iso, 'sessions': scanned}
        state['updated_at'] = now_iso
        tmp = HB_F.with_suffix('.json.tmp')
        tmp.write_text(json.dumps(state, indent=1, default=str))
        os.replace(tmp, HB_F)
    return actions
