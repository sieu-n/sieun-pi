#!/usr/bin/env python3
"""Fleet triage for every live prime-agent session. Read-only unless --apply.

Used by the 30-minute RLM heartbeat. It complements the launchd watchdog
(com.sieun.prime-agent-watchdog, cron_cycle.py), which clears phantom turns
every 10 min. This script adds what the watchdog does not decide:
provider/account errors (switch the pi-pool account, same model), network
errors, turns that ended after a tool result, and replies that look cut off.

Verdicts per session (transcript decides, not the list's activity flag):
  WORKING      streaming or running tools, recent output
  FROZEN       streaming, no tools, no real assistant output >= FROZEN_MIN
  ACCOUNT_ERR  last turn ended in an auth/quota/rate/overload provider error
  NET_ERR      last turn ended in a connection error
  DROPPED      idle, last record is a toolResult or user input, >= DROP_MIN old
  CUT_OFF      last assistant turn stopped with 'length', or 'error' after text
  MAYBE_CUT    last assistant text stops mid-sentence (needs a human-style read)
  ABORTED      last turn 'aborted' (Esc, parent, or a watchdog clear)
  DONE         last assistant turn ended normally
  STALE        last record older than STALE_H hours: not touched

Usage:
  fleet_triage.py                 # table
  fleet_triage.py --json          # machine-readable
  fleet_triage.py --apply         # run safe actions (see ACTIONS below)
"""
import json, os, re, subprocess, sys, time, datetime as dt
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wd_common import chat_ids, stop_reason  # noqa: E402

WATCH = Path.home() / '.prime/agent/watchdog'
STATE_F = WATCH / 'triage_state.json'
LOG_F = WATCH / 'triage.jsonl'
ENV = dict(os.environ); ENV.pop('FORCE_COLOR', None); ENV['NO_COLOR'] = '1'
ENV['PATH'] = '/Users/sieunpark/.nvm/versions/node/v25.9.0/bin:/opt/homebrew/bin:/Users/sieunpark/.local/bin:' + ENV.get('PATH', '')

FROZEN_MIN = 20
DROP_MIN = 10
STALE_H = 12
RENUDGE_MIN = 55      # do not nudge the same session twice inside this window
MAX_NUDGES = 3        # per session per problem signature; then escalate to the user
CHILD_MAX_H = 3       # a stuck subagent older than this is left to its head (it has moved on)

ACCOUNT_RE = re.compile(r'\b(401|403|429|529)\b|permission_error|authentication|oauth|rate.?limit|usage limit|'
                        r'quota|overloaded|credit|billing|pi-pool-token|api key|unauthori[sz]ed|forbidden|'
                        r'exceeded|capacity', re.I)
NET_RE = re.compile(r'connection error|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|terminated|network|'
                    r'EAI_AGAIN|ENOTFOUND|other side closed|stream (ended|closed)', re.I)
END_OK = re.compile(r'[.!?:)\]`"\'*>|/]\s*$|```\s*$|\d\s*$|https?://\S+\s*$')


def now():
    return dt.datetime.now(dt.timezone.utc)


def ts(x):
    try:
        return dt.datetime.fromisoformat(str(x).replace('Z', '+00:00'))
    except Exception:
        return None


def pa(*args, timeout=120):
    return subprocess.run(['prime-agent', *args], capture_output=True, text=True, env=ENV, timeout=timeout)


def list_sessions():
    r = pa('list', '--json')
    return json.loads(r.stdout)['sessions']


def tail_events(path, nbytes=800_000):
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2); sz = f.tell(); f.seek(max(0, sz - nbytes)); ch = f.read().decode('utf-8', 'ignore')
    except OSError:
        return []
    out = []
    for ln in ch.splitlines()[1:]:
        try:
            out.append(json.loads(ln))
        except Exception:
            pass
    return out


def real_asst(m):
    return m.get('role') == 'assistant' and any(
        isinstance(c, dict) and c.get('type') in ('text', 'toolCall', 'thinking') and (c.get('text') or c.get('thinking') or c.get('name'))
        for c in (m.get('content') or []))


def text_of(m):
    return '\n'.join(c.get('text', '') for c in (m.get('content') or []) if isinstance(c, dict) and c.get('type') == 'text')


def head_of(s, by):
    cur, seen = s, set()
    while cur.get('parentActiveSessionId') or cur.get('parentSessionId'):
        p = by.get(cur.get('parentActiveSessionId')) or by.get(cur.get('parentSessionId'))
        if not p or p['sessionId'] in seen:
            break
        seen.add(p['sessionId']); cur = p
    return cur


def classify(s, t, archived=frozenset(), test_chats=frozenset()):
    evs = tail_events(s['sessionFile']) if s.get('sessionFile') and os.path.exists(s['sessionFile']) else []
    msgs = [e for e in evs if e.get('type') == 'message']
    last = msgs[-1] if msgs else None
    lm = (last or {}).get('message', {})
    la = next((e for e in reversed(msgs) if real_asst(e['message'])), None)
    last_age = (t - ts(last['timestamp'])).total_seconds() / 60 if last else None
    asst_age = (t - ts(la['timestamp'])).total_seconds() / 60 if la else None
    busy = bool(s.get('isRunningTools') or s.get('isBashRunning') or s.get('isCompacting'))
    stream = bool(s.get('isStreaming'))
    role, stop, err = lm.get('role'), lm.get('stopReason'), (lm.get('errorMessage') or '')
    txt = text_of(lm) if role == 'assistant' else ''
    recent = '\n'.join(text_of(e['message']) for e in [e for e in msgs if e['message'].get('role') == 'assistant'][-4:])
    r = dict(id=s['id'], sid=s['sessionId'], active=s.get('activeSessionId'), name=s.get('sessionName') or '',
             depth=s.get('rlmDepth', 0), model=(s.get('model') or {}).get('id'),
             provider=(s.get('model') or {}).get('provider'), act=s.get('activity'), stream=stream, busy=busy,
             kids=bool(s.get('hasRunningRlmChildren')), last_role=role, stop=stop, err=err[:200],
             last_age=round(last_age, 1) if last_age is not None else None,
             asst_age=round(asst_age, 1) if asst_age is not None else None, tail=txt[-240:], recent=recent[-6000:],
             stopped=stop_reason(s.get('sessionId'), s.get('sessionFile'), archived, test_chats))
    if last_age is None:
        v = 'UNKNOWN'
    elif last_age > STALE_H * 60 and not stream:
        v = 'STALE'
    elif stream or busy:
        if busy:
            v = 'WORKING'
        elif asst_age is not None and asst_age >= FROZEN_MIN and last_age >= FROZEN_MIN:
            v = 'FROZEN'
        else:
            v = 'WORKING'
    elif role == 'assistant' and stop == 'error':
        if ACCOUNT_RE.search(err):
            v = 'ACCOUNT_ERR'
        elif NET_RE.search(err) or not err:
            v = 'NET_ERR'
        elif txt.strip():
            v = 'CUT_OFF'
        else:
            v = 'NET_ERR'
    elif role == 'assistant' and stop == 'length':
        v = 'CUT_OFF'
    elif role == 'assistant' and stop == 'aborted':
        v = 'ABORTED'
    elif role == 'assistant' and stop == 'toolUse':
        v = 'DROPPED' if last_age >= DROP_MIN else 'WORKING'
    elif role in ('toolResult', 'user', 'custom') or (role and role != 'assistant'):
        v = 'DROPPED' if last_age >= DROP_MIN else 'WORKING'
    elif role == 'assistant' and stop == 'stop':
        last_tok = txt.strip().split()[-1] if txt.strip() else ''
        v = 'MAYBE_CUT' if txt.strip() and not END_OK.search(txt.strip()[-60:]) and '/' not in last_tok else 'DONE'
    else:
        v = 'DONE'
    r['verdict'] = v
    return r


def pool_best(provider):
    """Best usable pi-pool account for the provider, or None."""
    try:
        d = json.loads(subprocess.run(['pi-pool', 'ls', '--json', '--provider', provider], capture_output=True,
                                      text=True, env=ENV, timeout=60).stdout)
    except Exception:
        return None
    rows = [x for x in d.get('rows', []) if x.get('usable')]
    rows.sort(key=lambda x: (x.get('score') is None, -(x.get('score') or 0), x.get('gated_pct') or 0))
    return rows[0]['email'] if rows else None


def triage():
    t = now()
    ss = list_sessions()
    by = {}
    for s in ss:
        for k in (s.get('id'), s.get('sessionId'), s.get('activeSessionId')):
            if k:
                by[k] = s
    selfs = {os.environ.get('FLEET_TRIAGE_SELF'), os.environ.get('PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID')} - {None, ''}
    archived, test_chats = chat_ids('archived-chats.json'), chat_ids('clean-room-chats.json')
    out = []
    for s in ss:
        if s.get('lifecycle') != 'live' or s['sessionId'] in selfs or s.get('activeSessionId') in selfs:
            continue
        r = classify(s, t, archived, test_chats)
        h = head_of(s, by)
        r['stopped'] = r['stopped'] or stop_reason(h['sessionId'], h.get('sessionFile'), archived, test_chats)
        r['head_sid'], r['head_name'] = h['sessionId'], h.get('sessionName') or ''
        r['head_active'] = h.get('activeSessionId')
        out.append(r)
    return out


def load_state():
    try:
        return json.loads(STATE_F.read_text())
    except Exception:
        return {}


def send(sid, msg):
    r = pa('send', '--json', sid, msg)
    return r.returncode, (r.stdout or r.stderr).strip()[:300]


def unwedge(active_id, msg):
    import importlib.util
    spec = importlib.util.spec_from_file_location('pa_watchdog', str(WATCH / 'watchdog.py'))
    wd = importlib.util.module_from_spec(spec); spec.loader.exec_module(wd)
    return wd.unwedge(active_id, msg)


def daemon_resume_queue(active_id):
    import importlib.util
    spec = importlib.util.spec_from_file_location('pa_watchdog', str(WATCH / 'watchdog.py'))
    wd = importlib.util.module_from_spec(spec); spec.loader.exec_module(wd)
    try:
        return wd.daemon_call({'type': 'resume_queue', 'activeSessionId': active_id})
    except Exception as e:
        return {'error': str(e)}


NUDGE = {
    'NET_ERR': 'Your last turn ended on a network error ("{err}"). Nothing in your history was lost. '
               'Re-check the state of your last step, then continue the task.',
    'ACCOUNT_ERR': 'Your last turn ended on a provider account error ("{err}"). The fleet heartbeat moved this '
                   'session tree to another pool account ({acct}); the model is unchanged. Re-check the state of '
                   'your last step, then continue the task.',
    'DROPPED': 'Your last turn stopped after a tool result {age} min ago with no reply (dropped by a worker '
               'restart or stall). Nothing in your history was lost. Re-check the state of your last step, then continue.',
    'CUT_OFF': 'Your last reply was cut off ({why}). Re-read what you last wrote, then either finish it or confirm '
               'the task is done and give the final summary.',
    'FROZEN': 'The fleet heartbeat cleared a stalled model turn ({age} min with no output). Nothing in your '
              'history was lost. Re-check the state of your last step, then continue.',
}
CHILD_NOTE = ('Fleet heartbeat: your subagent "{name}" ({sid}) is stuck: {verdict}, last record {age} min ago{err}. '
              'Check it and re-drive it or close it. If your own work is done, say so.')


def apply(rows, dry=False):
    st = load_state(); t = time.time(); acts = []
    heads = {}
    for r in rows:
        v = r['verdict']
        if v not in ('FROZEN', 'ACCOUNT_ERR', 'NET_ERR', 'DROPPED', 'CUT_OFF') or r.get('stopped'):
            continue
        sig = f"{r['sid']}:{v}:{r['last_age'] and round(t/60 - r['last_age'])}"
        key = r['sid']
        rec = st.get(key, {})
        if rec.get('sig_base') == f"{v}:{r['stop']}:{r['err'][:40]}" and t - rec.get('at', 0) < RENUDGE_MIN * 60:
            continue
        if rec.get('sig_base') == f"{v}:{r['stop']}:{r['err'][:40]}" and rec.get('n', 0) >= MAX_NUDGES:
            acts.append(dict(sid=key, name=r['name'], verdict=v, action='ESCALATE', note=f"{rec['n']} nudges without recovery"))
            continue
        is_child = r['depth'] > 0 and r.get('head_sid') and r['head_sid'] != r['sid']
        if is_child and v != 'FROZEN' and ((r['last_age'] or 0) > CHILD_MAX_H * 60 or rec.get('sig_base') == f"{v}:{r['stop']}:{r['err'][:40]}"):
            continue  # old, or already reported once to its head
        hrow = next((x for x in rows if x['sid'] == r.get('head_sid')), None)
        tok = r['name'].split('-')[0] if re.search(r'\d', r['name'].split('-')[0]) else r['name']
        if is_child and v != 'FROZEN' and hrow and tok and re.search(r'\b' + re.escape(tok) + r'\b', hrow.get('recent') or '') \
                and (hrow['last_age'] or 0) < (r['last_age'] or 0):
            continue  # the head already wrote about this child after it stopped
        a = dict(sid=key, name=r['name'], verdict=v, depth=r['depth'])
        if v == 'ACCOUNT_ERR' and r['provider'] in ('anthropic', 'openai-codex'):
            acct = pool_best(r['provider'])
            a['account'] = acct
            if acct and not dry:
                p = subprocess.run(['pi-pool', 'use', acct, '--provider', r['provider'], '--session', r['head_sid']],
                                   capture_output=True, text=True, env=ENV, timeout=60)
                a['pool'] = (p.stdout or p.stderr).strip()[:200]
        if v == 'FROZEN':
            if not dry and r['active']:
                a['unwedge'] = str(unwedge(r['active'], NUDGE['FROZEN'].format(age=r['asst_age'])))[:300]
            a['action'] = 'unwedge'
        elif not is_child:
            msg = NUDGE[v].format(err=r['err'][:120], acct=a.get('account') or 'the pool pick',
                                  age=r['last_age'], why=r['stop'] or 'error')
            if not dry:
                if r['active']:
                    a['resume_queue'] = str(daemon_resume_queue(r['active']))[:160]
                a['send'] = send(r['sid'], msg)
            a['action'] = 'continue->self'
        else:
            heads.setdefault(r['head_sid'], []).append(r)
            a['action'] = 'reported->head'
        if not dry:
            st[key] = dict(sig_base=f"{v}:{r['stop']}:{r['err'][:40]}", at=t, n=rec.get('n', 0) + 1
                           if rec.get('sig_base') == f"{v}:{r['stop']}:{r['err'][:40]}" else 1)
        acts.append(a)
    # children: one message per head (user rule: resume heads, heads re-drive children)
    by_head = {r['sid']: r for r in rows}
    for hsid, kids in heads.items():
        h = by_head.get(hsid)
        if h and h['verdict'] in ('WORKING',) and h['stream']:
            note = 'head is working; it will see this at its next turn boundary'
        else:
            note = ''
        lines = [CHILD_NOTE.format(name=k['name'], sid=k['sid'], verdict=k['verdict'], age=k['last_age'],
                                   err=(', error "' + k['err'][:100] + '"') if k['err'] else '') for k in kids]
        msg = '\n'.join(lines)
        a = dict(sid=hsid, name=h['name'] if h else '', verdict='HEAD_OF_STUCK', action='notify head', note=note,
                 children=[k['sid'] for k in kids])
        if not dry:
            a['send'] = send(hsid, msg)
        acts.append(a)
    if not dry:
        STATE_F.write_text(json.dumps(st, indent=1))
        with open(LOG_F, 'a') as f:
            f.write(json.dumps({'at': now().isoformat(), 'actions': acts}, default=str) + '\n')
    return acts


def main():
    args = sys.argv[1:]
    rows = triage()
    if '--apply' in args or '--dry-run' in args:
        acts = apply(rows, dry='--dry-run' in args)
        print(json.dumps(acts, indent=1, default=str))
        return 0
    if '--json' in args:
        for r in rows:
            r.pop('recent', None)
        print(json.dumps(rows, indent=1, default=str)); return 0
    order = ['FROZEN', 'ACCOUNT_ERR', 'NET_ERR', 'DROPPED', 'CUT_OFF', 'MAYBE_CUT', 'ABORTED', 'WORKING', 'DONE', 'STALE', 'UNKNOWN']
    rows.sort(key=lambda r: (order.index(r['verdict']), r['last_age'] or 0))
    from collections import Counter
    print('counts:', dict(Counter(r['verdict'] for r in rows)))
    for r in rows:
        if r['verdict'] == 'STALE':
            continue
        print(f"{r['verdict']:<11} d{r['depth']} {r['last_age'] or 0:>7.1f}m {r['sid'][-12:]} {r['name'][:38]:<38} "
              f"{r['model'] or '':<18} head={r['head_name'][:24]!r} {r['err'][:70]}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
