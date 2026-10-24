"""prime-agent frozen-session watchdog (host-side).

Detects live 'working' sessions that stopped making progress and recovers them
with the verified procedure: `prime-agent stop <id>` then `prime-agent send <id> <msg>`.
The process readings live in wd_procs, the daemon and UI drivers in wd_daemon, the heartbeat
re-arm in wd_heartbeats and the model probe in wd_probe.
"""
import datetime as dt
import json
import os
import re
import time

from wd_common import (LOG_F, STATE_F, WATCH, _rp, _run, _tail_events, _ts, chat_ids, chat_jobs, credential_wait_at, gone_reason, log, outbox_notice,
                       pa, pending_wake, pool_queued, stop_reason, tree_root, work_done)
from wd_daemon import daemon_call, ui_retry, unwedge
from wd_heartbeats import heartbeat_rearm
from wd_probe import probe_model, probe_verdict
from wd_procs import (_children, _descendants, _fd1_is_pipe, _ps_table, _tls_confirmed, _tls_count, kill_stuck_cell,
                      parked_shells, pressure, session_busy_tools, shell_belongs_to, stuck_cell_procs, unblock)

SELF_SESSION = '01a01846-1bcc-732d-b587-dcfccf752d68'   # this watchdog session; never touch

# thresholds (minutes)
OK_MIN = 12          # below this: healthy
TURN_FREEZE = 25     # no tool running, no assistant turn produced
TOOL_FREEZE = 35     # tool "running" but no process burning CPU
BUSY_TOOL_MAX = 120  # a genuinely running tool this long is still a wedge
CHILD_EXTRA = 15     # subagents get a longer leash

# Resume budget: after a reboot every session wakes at once and swap fills (2026-10-09). The 5 per cycle stays the only gate.
MAX_RESUMES_PER_CYCLE = 5
# Soft pressure targets (owner rule c98): an overrun is logged and the action goes through. As hard gates they stopped every recovery on
# us-metal02: from 10-19 16:53Z to 10-24 08:46Z 14,649 actions were skipped at 16 to 80 GiB swap used while 132 GiB RAM sat free and the load
# sat near 200 on 80 cores, and stalled tools in two code cut 3 jobs burned 3.7 cores for over an hour with no notice to their parent.
SWAP_CAP_GIB = 16.0  # ops guy 2026-10-10: the Mac target; at 8 nothing woke for hours
LOAD_CAP = 30.0
LAST_COUNTS = {}     # resumed/skipped counts of the latest cycle, read by cron_cycle.py

# The custom messages that wake the agent (components/user-history/src/shared/turns.ts PROMPT_TYPES). Every other custom message is a note
# no turn answers: on 10-18 at 00:11Z a harness_digest from the 23:40Z resume woke the paused chats SEO guy and spec and monitoring system,
# and on 10-22 the correction refine's notes after gpt sol (metal 02)'s answered turn read as input owed since 00:58:56Z, and the cycle at
# 01:47:55Z sent it "dropped 48.2 minutes ago".
PROMPT_TYPES = ('agent_message', 'heartbeat_prompt', 'async_bash_completion', 'goal_context', 'rlm_child_terminal_notice', 'rlm_child_failure',
                'prime-agent.update_restart')


# Owner input, replies and silent turns are read by resume_paused.py's one rule (from_owner, replied, said_something), which the job sweep's
# work_owed uses too, so a session reads the same here and there.
def said_something(m):
    return _rp().said_something(m)


def replied(m):
    return _rp().replied(m)


def from_owner(e):
    return _rp().from_owner(e)


def owed_input(evs):
    """-> (last_input, owed_since, owner_owed): the time of the newest input, of the first input no turn has answered yet (None when nothing
    is owed), and whether an owed input is an owner message with no reply.

    An input is a user message, a tool result or a custom message of PROMPT_TYPES. A turn answers its inputs when the assistant said
    something, or when it ended normally (stopReason "stop") with no owner message among them:
    a chat may end a turn on an agent message, a check-in or a notice with no words. gpt sol (01a15f90-afb8-7434-814a-2e5fbcafb1ec) did that on
    the Mac on 10-21, and each silent end read as a dropped turn, so the watchdog woke it at 20:08Z, 20:43Z, 21:19Z and 22:18Z with "the input
    was never answered", and each wake ended silent again. An owner message stays owed until the chat replies in text or through tell_owner, and a turn
    cut by an error, an abort, the length limit or a worker death leaves its inputs owed. `owed_since` keys the one resume notice per input.
    """
    last_input = owed_since = None
    owner_owed = False
    for e in evs:
        t, m = e.get('type'), (e.get('message') or {})
        role, ts = m.get('role'), _ts(e.get('timestamp'))
        if t == 'message' and role == 'assistant':
            said, done = said_something(m), m.get('stopReason') == 'stop'
            if said or (done and not owner_owed):
                owed_since = None
            if m.get('stopReason') in ('stop', 'toolUse') and replied(m):
                owner_owed = False
        elif (t == 'message' and role in ('user', 'toolResult')) or (t == 'custom_message' and e.get('customType') in PROMPT_TYPES):
            last_input = ts
            owed_since = owed_since or ts
            owner_owed = owner_owed or from_owner(e)
    return (last_input, owed_since, owner_owed) if owed_since else (last_input, None, False)


def told_parent(evs):
    """Whether the session called agent_message.send to its parent after its last prompt (a user message or a custom message of PROMPT_TYPES)."""
    for e in reversed(evs):
        m = e.get('message') or {}
        if (e.get('type') == 'message' and m.get('role') == 'user') or (e.get('type') == 'custom_message' and e.get('customType') in PROMPT_TYPES):
            return False
        if e.get('type') == 'message' and m.get('role') == 'assistant' and any(
                isinstance(c, dict) and c.get('type') == 'toolCall' and 'agent_message.send' in (a := json.dumps(c.get('arguments'))) and 'parent' in a
                for c in (m.get('content') or [])):
            return True
    return False


def child_waits(r):
    """Why a silent subagent is waiting on purpose, else None, read when its parent's notice would go out, since a cycle takes minutes.

    checkin pushes goals (01a14d7c-1a93-7008-bc1e-bde0d047eaf9) on us-metal02, 10-24: its parent's prompt at 19:05:27Z sat 105th in pi-pool's
    turn queue, its board.wake for 10:40Z on 10-25 was pending, and it reported to its parent at 19:33:50Z. The cycle that read it at 19:33Z
    sent its parent "[watchdog] Your subagent 'checkin pushes goals' has produced nothing for 137.9 minutes ... Cancel that child" at 19:35:33Z."""
    wake = pending_wake(r['sid'])
    if wake:
        return f'its board.wake {wake} is pending'
    if pool_queued(r['sid']):
        return "its run waits in pi-pool's turn queue"
    if r.get('file') and told_parent(_tail_events(r['file'])):
        return 'it sent its parent a message after its last prompt'
    return None


def snapshot():
    """One reading of every session + process/journal evidence."""
    sessions = json.loads(pa('list', '--all', '--json').stdout)['sessions']
    now = dt.datetime.now(dt.timezone.utc)
    archived, test_chats = chat_ids('archived-chats.json'), chat_ids('clean-room-chats.json')
    recs, table = [], None
    for s in sessions:
        f = s.get('sessionFile')
        evs = _tail_events(f) if f and os.path.exists(f) else []
        last_msg = next((e for e in reversed(evs) if e.get('type') == 'message'), None)
        last_asst = None
        for e in evs:
            m = e.get('message') or {}
            if e.get('type') == 'message' and m.get('role') == 'assistant' and said_something(m):
                last_asst = _ts(e.get('timestamp'))
        last_input, owed_since, owner_owed = owed_input(evs)
        awaiting = round((now - last_input).total_seconds() / 60, 1) if owed_since else None
        lm = (last_msg or {}).get('message') or {}
        limited = lm.get('role') == 'assistant' and lm.get('stopReason') == 'error' and (
            'pi-pool' in (lm.get('errorMessage') or '') or
            credential_wait_at(lm) is not None or
            any((d.get('details') or {}).get('kind') == 'rate_limit' for d in (lm.get('diagnostics') or []) if isinstance(d, dict)))
        last_asst_min = round((now - last_asst).total_seconds() / 60, 1) if last_asst else None
        # A pending cell that deliberately sleeps/polls (pipeline watching, log tailing) looks
        # identical to a wedge from the outside: read the code before calling it frozen.
        sleepy = False
        for e in reversed(evs):
            m = (e.get('message') or {})
            if e.get('type') == 'message' and m.get('role') == 'assistant':
                code = ' '.join(json.dumps(c.get('arguments', {})) for c in (m.get('content') or [])
                                if isinstance(c, dict) and c.get('type') == 'toolCall')
                sleepy = any(k in code for k in ('time.sleep(', 'sleep ', 'tail -f', '--follow',
                                                 'watch ', 'asyncio.sleep('))
                break
        cand = [t for t in ((_ts(evs[-1].get('timestamp')) if evs else None),
                            (dt.datetime.fromtimestamp(os.path.getmtime(f), dt.timezone.utc)
                             if f and os.path.exists(f) else None),
                            _ts(s.get('lastActivityAt')), _ts(s.get('modified'))) if t]
        last_any = max(cand) if cand else None
        busy, tls, own_busy = [], None, []
        if s['lifecycle'] == 'live' and s['activity'] == 'working':
            table = _ps_table() if table is None else table
            busy = [d for d in _descendants(s.get('workerPid'), table=table) if d[1].startswith('R') or d[3] > 5.0]
            if s.get('rlmDepth', 0) > 0:
                own_busy = session_busy_tools(s.get('workerPid'), s.get('sessionId'), table)
            # An open TLS socket means a provider request is genuinely in flight: a slow turn,
            # not a wedged one. Never interrupt those.
            tls = _tls_count(s.get('workerPid'))
        recs.append(dict(
            id=s['id'], sid=s.get('sessionId'), name=(s.get('sessionName') or '').strip(),
            life=s['lifecycle'], act=s['activity'], depth=s.get('rlmDepth', 0), kind=s.get('runtimeKind'),
            model=(s.get('model') or {}).get('id'), msgs=s.get('messageCount'),
            clients=s.get('attachedClients'), tools=bool(s.get('isRunningTools')),
            bash=bool(s.get('isBashRunning')), compact=bool(s.get('isCompacting')),
            kids=bool(s.get('hasRunningRlmChildren')), unfinished=s.get('unfinishedActionCount'),
            streaming=bool(s.get('isStreaming')), queued=(s.get('sessionActions') or {}).get('queuedCount', 0),
            parent_sid=s.get('parentSessionId'), pid=s.get('workerPid'), wstate=s.get('workerState'),
            file=f, last_role=(last_msg or {}).get('message', {}).get('role'),
            last_type=(evs[-1].get('type') if evs else None),
            stale_min=round((now - last_any).total_seconds() / 60, 1) if last_any else None,
            awaiting_min=awaiting,
            owed_since=owed_since.isoformat() if owed_since else None,
            owner_owed=owner_owed,
            limited=limited,
            last_asst_min=last_asst_min,
            sleepy=sleepy,
            busy_procs=[f'{c[4][:60]} cpu={c[2]:.0f}s {c[3]}%' for c in busy],
            own_busy=[f'pid {p} ({cmd[:80]}, {secs / 60:.0f} CPU-min in {et})' for p, secs, et, cmd in own_busy],
            tls=tls,
            stopped=stop_reason(s.get('sessionId'), f, archived, test_chats),
        ))
    # Attribute a parked shell to a session: a deliberate wait sleeps INSIDE the kernel, so a
    # shell child alive for as long as the session has been silent is that session's wedge.
    cache = {}
    for r in recs:
        r['stuck_cell'] = []
        if r['life'] != 'live' or r['act'] != 'working' or not (r['tools'] or r['bash']):
            continue
        st = r['stale_min'] or 0
        if st < 10:
            continue
        if 'all' not in cache:
            cache['all'] = parked_shells(min_age_min=10)
        # attribution: the shell has been parked exactly as long as this session has been silent
        r['stuck_cell'] = [c for c in cache['all']
                           if abs(c['age_min'] - st) <= 5 and shell_belongs_to(c['pid'], r['pid'])]
    return now, recs


def read_log(hours=3):
    """-> (session-uuid -> count of watchdog recoveries in the last `hours`, the (session-uuid, owed_since) pairs that got their resume notice).

    A notice whose send failed counts too: on the Mac from 10-20 to 10-22, box-takeover, douyin duty box sync, vite-mem, discover page errors and
    limits-flagged-10-16 got 1011 notices, every send failed with "Unknown active session", and their retries took the cycle's resume budget.
    """
    if not LOG_F.exists():
        return {}, set()
    cut = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours)
    out, noticed = {}, set()
    for ln in LOG_F.read_text().splitlines():
        try:
            e = json.loads(ln)
        except Exception:
            continue
        if e.get('owed_since') and e.get('sid') and e.get('skip') in (None, 'work_done'):
            noticed.add((e['sid'], e['owed_since']))
        t = _ts(e.get('at'))
        if t and t >= cut and e.get('sid') and not e.get('skip'):
            out[e['sid']] = out.get(e['sid'], 0) + 1
    return out, noticed


REPEAT_FREEZE = 12   # a session the watchdog already unstuck gets a shorter leash


HOLD = set()   # sessions under manual diagnosis: the watchdog must not touch them



def _is_self(r):
    """Only a real, matching session id is 'me'.

    A caller that overrides SELF_SESSION (the out-of-process runner does, so it can heal this
    session) must not be able to wave through records that merely have no sid.
    """
    return bool(SELF_SESSION) and isinstance(r.get('sid'), str) and r['sid'] == SELF_SESSION


def classify(r, prev, repeats=None):
    if _is_self(r):
        return 'SELF', 'watchdog session'
    if r['sid'] in HOLD:
        return 'HELD', 'under manual diagnosis, watchdog hands off'
    if r.get('stopped') and r['life'] == 'live':
        return 'ARCHIVED', r['stopped']
    """-> (verdict, reason). Verdicts: SELF, HELD, ARCHIVED, NOTICED, WORK_DONE, OK, BUSY_TOOL, SUSPECT, FROZEN_TURN, FROZEN_TOOL, STUCK_TOOL."""
    if r['life'] == 'live' and r['act'] == 'idle' and (r.get('awaiting_min') or 0) >= 30 and r.get('limited'):
        # The turn ended on a 429 or a pi-pool slot refusal, and the chat service's idle unload stops such a session while the pool holds
        # its tree. resume_paused.py and the chat revive continue it once `pi-pool who` admits the tree. From 06:51Z to 08:31Z on 10-19
        # this cycle sent 40 such sessions resume_queue and a message (SEO guy 609 min after its 429), each loaded a worker and a kernel
        # again and met the same limit, and the unload stopped it 15 min later.
        return 'POOL_WAIT', 'last turn failed on a provider rate limit or a pi-pool hold; the resume sweep continues it once the pool admits its tree'
    if r['life'] == 'live' and r['act'] == 'idle' and (r.get('awaiting_min') or 0) >= 30 and r.get('noticed'):
        return 'NOTICED', f"input owed since {r['owed_since']} already got its one resume notice"
    if r['life'] == 'live' and r['act'] == 'idle' and (r.get('awaiting_min') or 0) >= 30 and r.get('work_done'):
        return 'WORK_DONE', r['work_done']
    if r['life'] == 'live' and r['act'] == 'idle' and (r.get('awaiting_min') or 0) >= 30:
        # Idle with input that never got an answer = a turn dropped (machine sleep, worker
        # restart). A session genuinely waiting on its user ends with an ASSISTANT message,
        # so awaiting_min is None for those and they are never touched.
        return 'DROPPED_TURN', (f"idle with input delivered {r['awaiting_min']}m ago and no answer "
                                f"(turn lost, not waiting on its user)")
    if r['life'] != 'live' or r['act'] != 'working':
        return 'OK', f"{r['life']}/{r['act']}"
    st = r['stale_min'] or 0
    leash = CHILD_EXTRA if r['depth'] > 0 else 0
    if r['compact']:
        # a hung /compact looks 'busy' forever: no TLS socket + no events is the tell
        if not r.get('tls') and st >= 20:
            return 'FROZEN_TURN', f'compaction stuck {st}m with no open provider request'
        return 'OK', 'compacting'
    if st < OK_MIN + leash and (r.get('awaiting_min') is None or r['awaiting_min'] < OK_MIN + leash):
        # staleness alone lies: agent_status/session_state housekeeping keeps ticking while a
        # turn stays unanswered, which is how a 37h dropped turn once looked "active 0.4m ago".
        return 'OK', f'active {st}m ago'
    if r['busy_procs'] and r['depth'] == 0:
        if st > BUSY_TOOL_MAX:
            return 'STUCK_TOOL', f"tool burning CPU for {st}m: {r['busy_procs'][0]}"
        return 'BUSY_TOOL', f"tool running: {r['busy_procs'][0]}"
    p = (prev or {}).get(r['id'])
    same = bool(p) and p.get('msgs') == r['msgs']
    aw = r.get('awaiting_min')
    rep = (repeats or {}).get(r['sid'], 0)
    # TLS/CPU signals are read from the worker process, which a subagent SHARES with its
    # parent and siblings: only trust them for a top-level session.
    if r.get('tls') and r['depth'] == 0 and st <= 45:
        # One lsof read is racy: a closing socket from the previous attempt looks like an
        # in-flight request and buys a wedged session another 45 minutes of immunity.
        # Silence outranks the socket: a session that has said nothing for 20+ minutes is never
        # excused by lsof, however many sockets the worker holds (peer session d0721779446f saw
        # tls=1 on a session silent 71.9m whose worker had zero :443 sockets 90s later).
        if (r.get('last_asst_min') is None or r['last_asst_min'] < 20) and \
                (st < OK_MIN or _tls_confirmed(r['pid'])):
            return 'IN_FLIGHT', f'provider request open across samples, silent only {st}m'
    # Phantom turn: the runtime still says "streaming" but no request is open, no tool is
    # running and nothing has been written for a long time. Every later message queues behind
    # it forever. Fixed in place by daemon abort + resume_queue, at any depth.
    if (r.get('streaming') and not (r['tools'] or r['bash']) and not r.get('tls')
            and (r.get('last_asst_min') is None or r['last_asst_min'] >= 20)
            and (r.get('awaiting_min') is None or r['awaiting_min'] >= 10)):
        return 'PHANTOM_TURN', (f"runtime says streaming but no request is open and nothing written for "
                                f"{r.get('last_asst_min')}m; {r.get('queued', 0)} message(s) queued behind it")
    if r['depth'] > 0 and (r.get('last_asst_min') or 0) >= 45 and r.get('own_busy'):
        return 'CHILD_WEDGED', (f'subagent silent {r.get("last_asst_min")}m in one tool call burning CPU: {r["own_busy"][0]} -- '
                                f'its parent owns the fix (stop that process or the child)')
    if r['depth'] > 0 and (r.get('last_asst_min') or 0) >= 45 and not stuck_cell_procs(r['pid'], 20):
        return 'CHILD_WEDGED', (f'subagent silent {r.get("last_asst_min")}m with no shell to kill -- '
                                f'its parent owns the fix (cancel/respawn the child)')
    if aw is not None and not (r['tools'] or r['bash']):
        if aw >= TURN_FREEZE + leash:
            return 'FROZEN_TURN', f'input delivered {aw}m ago, no model turn since'
        if rep and aw >= REPEAT_FREEZE + leash:
            return 'FROZEN_TURN', f'froze again {aw}m ago after {rep} recovery/ies in the last 3h'
    if r['tools'] or r['bash']:
        if r.get('stuck_cell') and st >= 15:
            c = r['stuck_cell'][0]
            return 'FROZEN_TOOL', (f"shell parked under the kernel {c['age_min']}m (matches this session's "
                                   f"silence): {', '.join(c['child_cmds'])[:90]}")
        if r.get('sleepy') and st < 90:
            return 'BUSY_TOOL', f'pending cell sleeps/polls on purpose ({st}m in)'
        if st >= TOOL_FREEZE + leash:
            return 'FROZEN_TOOL', f'tool marked running {st}m with no live process'
        return 'SUSPECT', f'tool running {st}m, no CPU (prev-cycle msgs {"unchanged" if same else "changed"})'
    if st >= TURN_FREEZE + leash:
        return 'FROZEN_TURN', f'input delivered, no model turn for {st}m (last={r["last_role"]})'
    return 'SUSPECT', f'quiet {st}m (prev-cycle msgs {"unchanged" if same else "changed"})'


NUDGE = (
    "[watchdog] This session was wedged for {mins} minutes: {why}. I stopped the stuck worker "
    "and restarted you. Your conversation history is intact; only the unanswered turn was lost "
    "(IPython kernel variables may need rebuilding). Do this now: 1) scroll back and answer any "
    "user message that never got a reply; 2) re-check the state of your last step before trusting "
    "it -- a tool result may be missing or stale; 3) continue the task to completion and commit "
    "your work per AGENTS.md. If a shell or HTTP call hung, re-run it with an explicit timeout, "
    "and never background a process with `&` under subprocess capture_output -- the shell keeps "
    "the pipe open and the call blocks forever (use start_new_session/DEVNULL or `setsid ... </dev/null >log 2>&1 &`)."
)


def nudge(r, why, shared_worker=False, repeats=0, dry_run=False):
    """Recover one wedged session.

    Own worker  -> `prime-agent stop <runtime-id>` then `prime-agent send <session-uuid>`
                   (after stop the runtime id is gone; the UUID resumes the archived session).
    Shared worker (subagents run inside their parent's worker) -> never stop: that would kill
                   the healthy parent and siblings. Kill the orphaned shell wedging the tool
                   call, else steer the child session.
    """
    mins = int(r['stale_min'] or 0)
    msg = NUDGE.format(mins=mins, why=why)
    out = {'id': r['id'], 'sid': r['sid'], 'name': r['name'], 'depth': r['depth'],
           'stale_min': r['stale_min'], 'why': why, 'shared_worker': shared_worker,
           'at': dt.datetime.now(dt.timezone.utc).isoformat()}
    if dry_run:
        out['dry_run'] = True
        return out
    if repeats >= 1 and not (r['tools'] or r['bash']) and not shared_worker:
        # stop+send already failed on this session: drive the real UI instead
        out['method'] = 'ui-retry (attach + ESC + retype)'
        out.update(ui_retry(r['id'], 'continue: ' + (r['name'] or 'your task') +
                            ' -- state your current step in one line, then finish the task and commit.'))
        with open(LOG_F, 'a') as f:
            f.write(json.dumps(out) + '\n')
        return out
    if r.get('stuck_cell'):
        out['method'] = 'kill-attributed-cell'
        out['killed'] = []
        for c in r['stuck_cell']:
            # Kill ONLY processes that still hold the blocking pipe: the parked shell and any
            # pipeline filter reading/writing it. A child the agent backgrounded on purpose
            # (a dev server, an API) writes to a file or /dev/null -- killing it destroys work.
            targets = [c['pid']]
            for k in c['children']:
                if _fd1_is_pipe(k):
                    targets.append(k)
                    for g in _children(k, _ps_table()):
                        if _fd1_is_pipe(g):
                            targets.append(g)
            out['spared'] = [k for k in c['children'] if k not in targets]
            _run('kill', *targets)
            out['killed'].append({'shell': c['pid'], 'age_min': c['age_min'], 'cmds': c['child_cmds']})
        with open(LOG_F, 'a') as f:
            f.write(json.dumps(out) + '\n')
        return out
    if shared_worker and r.get('streaming') and not (r['tools'] or r['bash']):
        out['method'] = 'daemon abort + resume_queue (subagent, worker untouched)'
        out.update(unwedge(r['id'], msg))
        with open(LOG_F, 'a') as f:
            f.write(json.dumps(out, default=str) + '\n')
        return out
    if shared_worker:
        cands, killed = unblock(r['pid'])
        out['method'] = 'unblock-pipe-holder'
        out['blockers'] = cands
        out['killed'] = [c['pid'] + ' ' + c['cmd'][:60] for c in killed]
        if not killed:
            # second shape: the cell's shell is still parked under the kernel with a
            # never-exiting streamer (convex logs / vite dev / tail -f) in its pipeline
            cell = kill_stuck_cell(r['pid'], min_age_min=20)
            if cell:
                out['method'] = 'kill-stuck-cell'
                out['killed'] = cell
                killed = cell
        if not killed:
            st = pa('send', '--steer', r['sid'] or r['id'], msg)
            out['method'] = 'steer'
            out['send_rc'] = st.returncode
            out['send_out'] = (st.stdout or st.stderr).strip()[:200]
    else:
        # First: clear a phantom turn in place. This is what actually works, and unlike
        # stop+send it loses nothing -- no worker restart, no kernel state rebuild.
        if r.get('streaming') and not (r['tools'] or r['bash']):
            out['method'] = 'daemon abort + resume_queue'
            out.update(unwedge(r['id'], msg))
            with open(LOG_F, 'a') as f:
                f.write(json.dumps(out, default=str) + '\n')
            return out
        stop = pa('stop', r['id'], timeout=45)
        import time as _t
        _t.sleep(3)
        if stop.returncode != 0 and r['pid']:
            # `stop` times out when the worker is wedged mid-request; kill it directly, but only
            # when this session is the sole tenant of that worker (subagents share their parent's).
            tenants = [z for z in json.loads(pa('list', '--all', '--json').stdout)['sessions']
                       if z.get('workerPid') == r['pid'] and z.get('sessionId') != r['sid']]
            # safe to kill when nobody else is using this worker, or only this session's idle children
            sole = all(z.get('activity') == 'idle' for z in tenants)
            if sole:
                _run('kill', str(r['pid']))
                out['killed_worker'] = r['pid']
                _t.sleep(10)
        send = pa('send', r['sid'] or r['id'], msg)
        if send.returncode != 0:
            _t.sleep(5)
            send = pa('send', r['sid'] or r['id'], msg)
        out['method'] = 'stop+send'
        out['stop_rc'] = stop.returncode
        out['stop_out'] = (stop.stdout or stop.stderr).strip()[:200]
        out['send_rc'] = send.returncode
        out['send_out'] = (send.stdout or send.stderr).strip()[:200]
    with open(LOG_F, 'a') as f:
        f.write(json.dumps(out) + '\n')
    return out


LOCK_F = WATCH / 'cycle.lock'



def cycle(dry_run=False, verbose=True):
    """Take the same exclusive lock the launchd runner uses, so two runners can never act at once."""
    import fcntl
    fh = open(LOCK_F, 'a+')
    deadline = time.time() + 90     # a runner cycle takes well under this; wait it out, don't skip
    while True:
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except OSError:
            if time.time() >= deadline:
                if verbose:
                    print('== watchdog: cycle.lock held for 90s by the out-of-process runner; skipping')
                fh.close()
                return [], []
            time.sleep(3)
    try:
        return _cycle(dry_run=dry_run, verbose=verbose)
    finally:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        fh.close()


def _cycle(dry_run=False, verbose=True):
    prev = {}
    if STATE_F.exists():
        try:
            prev = json.load(open(STATE_F)).get('by_id', {})
        except Exception:
            prev = {}
    now, recs = snapshot()
    repeats, noticed = read_log()
    life = {r['sid']: r['life'] for r in recs}
    shown = jobs = None
    for r in recs:
        r['noticed'] = (r['sid'], r.get('owed_since')) in noticed
        if r['stopped'] or r['life'] != 'live' or not (r['act'] == 'working' or (r.get('awaiting_min') or 0) >= 30):
            continue
        if shown is None:
            chats, threads = chat_ids('chats.json'), chat_ids('threads.json')
            shown = (chats | threads) if chats is not None and threads is not None else False
        root = tree_root(r.get('file'))
        r['stopped'] = root and gone_reason(r['file'], life.get(root), shown if shown is not False else None)
        if not r['stopped'] and r['act'] == 'idle' and not r['noticed']:
            if jobs is None:
                jobs = chat_jobs() or {}
            r['work_done'] = work_done(r['sid'], r.get('file'), _tail_events(r['file']) if r.get('file') else [], jobs, shown or None)
    swap, load = pressure()
    over = [o for o in (('swap', swap, SWAP_CAP_GIB), ('load', load, LOAD_CAP)) if o[1] > o[2]]
    counts = {'resumed': 0, 'skipped_budget': 0, 'over_pressure': 0, 'swap_gib': swap, 'load_1m': load}
    LAST_COUNTS.clear()
    LAST_COUNTS.update(counts)

    def admit(r, verdict):
        """Spend one wake from this cycle's budget, or log that the session waits for a later cycle. A pressure overrun is logged and admitted."""
        if counts['resumed'] < MAX_RESUMES_PER_CYCLE:
            counts['resumed'] += 1
            for reason, value, cap in over:
                counts['over_pressure'] += 1
                with open(LOG_F, 'a') as f:
                    f.write(json.dumps({'over': reason, 'value': value, 'cap': cap, 'id': r['id'], 'sid': r['sid'], 'name': r['name'],
                                        'verdict': verdict, 'dry_run': dry_run, 'at': dt.datetime.now(dt.timezone.utc).isoformat()}) + '\n')
            return True
        counts['skipped_budget'] += 1
        with open(LOG_F, 'a') as f:
            f.write(json.dumps({'skip': 'budget', 'value': counts['resumed'], 'cap': MAX_RESUMES_PER_CYCLE, 'id': r['id'], 'sid': r['sid'],
                                'name': r['name'], 'verdict': verdict, 'stale_min': r['stale_min'],
                                'dry_run': dry_run, 'at': dt.datetime.now(dt.timezone.utc).isoformat()}) + '\n')
        return False
    # A whole model cohort going silent at once is a provider stall, not a per-session wedge:
    # stopping/steering those sessions only burns their turns, so report and leave them alone.
    live_working = [x for x in recs if x['life'] == 'live' and x['activity_working']] \
        if recs and 'activity_working' in recs[0] else [x for x in recs if x['life'] == 'live' and x['act'] == 'working']
    probes = {}
    for m in sorted({x['model'] for x in live_working}, key=str):
        cohort = [x for x in live_working if x['model'] == m]
        silent = [x for x in cohort if (x.get('last_asst_min') is None or x['last_asst_min'] >= 15)]
        # One probe per suspect model per cycle decides it: a throwaway session that cannot get a
        # word out of the model proves the sessions are fine and the provider is not.
        if silent:
            probes[m] = probe_model(m)
            if not dry_run:
                log({'kind': 'model_probe', **probes[m]})
    LAST_COUNTS['probes'] = {m: p['outcome'] for m, p in probes.items()}
    verdicts, actions = [], []
    for r in sorted(recs, key=lambda x: x['stale_min'] if x['stale_min'] is not None else float('inf')):
        v, why = probe_verdict(*classify(r, prev, repeats), r['model'], probes)
        r['verdict'], r['why'] = v, why
        verdicts.append(r)
        if v in ('DROPPED_TURN', 'PHANTOM_TURN', 'FROZEN_TURN', 'FROZEN_TOOL', 'STUCK_TOOL') and not admit(r, v):
            continue
        if v == 'WORK_DONE' and not dry_run:
            with open(LOG_F, 'a') as f:
                f.write(json.dumps({'skip': 'work_done', 'id': r['id'], 'sid': r['sid'], 'name': r['name'], 'owed_since': r.get('owed_since'),
                                    'why': why, 'at': dt.datetime.now(dt.timezone.utc).isoformat()}) + '\n')
        if v == 'DROPPED_TURN' and not dry_run:
            daemon_call({'type': 'resume_queue', 'activeSessionId': r['id']})
            m = (f"[watchdog] Your last turn was dropped {r.get('awaiting_min')} minutes ago (machine sleep or "
                 f"worker restart) and the input was never answered. Nothing in your history was lost. "
                 f"Re-check the state of your last step before trusting it, then continue the task and commit.")
            sd = pa('send', r['sid'], m)
            act = {'id': r['id'], 'sid': r['sid'], 'name': r['name'], 'method': 'resume_queue + send',
                   'why': why, 'owed_since': r.get('owed_since'), 'send_rc': sd.returncode, 'send_out': (sd.stdout or sd.stderr).strip()[:120],
                   'at': dt.datetime.now(dt.timezone.utc).isoformat()}
            if sd.returncode != 0:
                # The daemon refuses a uuid it holds no worker for ("Unknown active session": an unloaded subagent, a stale live row). The
                # chat service's outbox relays to the parent or opens the root from its file. From 10-20 to 10-22 the Mac retried 1203 such sends.
                act['method'] = 'resume_queue + outbox'
                act['outbox'] = outbox_notice(r['sid'], tree_root(r.get('file')), m)
            actions.append(act)
            with open(LOG_F, 'a') as f:
                f.write(json.dumps(act, default=str) + '\n')
        if v == 'PHANTOM_TURN' and not dry_run:
            m = (f"[watchdog] Your session was wedged in a phantom streaming turn for "
                 f"{r.get('last_asst_min')} minutes: nothing dispatched and every message queued behind it. "
                 f"I cleared it in place -- history and kernel state are intact. State your current step in "
                 f"one line, then continue the task and commit.")
            act = {'id': r['id'], 'sid': r['sid'], 'name': r['name'], 'depth': r['depth'],
                   'method': 'daemon abort + resume_queue', 'why': why,
                   'at': dt.datetime.now(dt.timezone.utc).isoformat()}
            act.update(unwedge(r['id'], m))
            actions.append(act)
            with open(LOG_F, 'a') as f:
                f.write(json.dumps(act, default=str) + '\n')
        elif v == 'PHANTOM_TURN':
            actions.append({'id': r['id'], 'name': r['name'], 'would_unwedge': why, 'dry_run': True})
        if v in ('FROZEN_TURN', 'FROZEN_TOOL', 'STUCK_TOOL'):
            # A parent that owns the worker may be restarted when its only co-tenants are its own
            # idle children; a subagent never may, and a parent with a working child never may.
            co = [x for x in recs if x['pid'] and x['pid'] == r['pid'] and x['life'] == 'live'
                  and x['id'] != r['id']]
            shared = bool(co) and not (r['depth'] == 0 and all(
                c['parent_sid'] == r['sid'] and c['act'] == 'idle' for c in co))
            actions.append(nudge(r, why, shared_worker=shared,
                                 repeats=repeats.get(r['sid'], 0), dry_run=dry_run))
    # Wedged children: notify the PARENT once (it owns cancel/respawn). When several children of
    # one live parent are stuck together the parent is usually monopolising the worker's turn slot,
    # so send one grouped note per parent per hour instead of one per child per cycle.
    if not dry_run:
        cut = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)
        noted = set()
        if LOG_F.exists():
            for ln in LOG_F.read_text().splitlines():
                try:
                    e = json.loads(ln)
                except Exception:
                    continue
                t = _ts(e.get('at'))
                if e.get('method') == 'notify-parent' and t and t >= cut:
                    noted.add(e.get('parent_sid'))
        groups = {}
        for r in verdicts:
            if r['verdict'] != 'CHILD_WEDGED':
                continue
            waits = child_waits(r)
            if waits:
                r['verdict'], r['why'] = 'OK', f'subagent waits on purpose: {waits}'
                with open(LOG_F, 'a') as f:
                    f.write(json.dumps({'skip': 'child_waits', 'id': r['id'], 'sid': r['sid'], 'name': r['name'], 'why': waits,
                                        'at': dt.datetime.now(dt.timezone.utc).isoformat()}) + '\n')
                continue
            groups.setdefault(r['parent_sid'], []).append(r)
        for psid, kids in sorted(groups.items(), key=lambda g: next(
                (x['stale_min'] or 0 for x in recs if x['sid'] == g[0]), float('inf'))):
            par = next((x for x in recs if x['sid'] == psid), None)
            if not par or par['life'] != 'live' or par.get('stopped') or psid in noted or not admit(par, 'CHILD_WEDGED'):
                continue
            names = ', '.join(f"{k['name']} ({k.get('last_asst_min')}m)" for k in kids)
            if len(kids) >= 2:
                m = (f"[watchdog] {len(kids)} of your subagents have produced nothing for 40+ minutes while you "
                     f"kept turning: {names}. Either they are wedged or they are queued behind your own turns on "
                     f"the shared worker. Check in on them (agent_message), and cancel + respawn any that cannot "
                     f"tell you their current step.")
            elif kids[0].get('own_busy'):
                k = kids[0]
                m = (f"[watchdog] Your subagent '{k['name']}' has produced nothing for {k.get('last_asst_min')} minutes while one "
                     f"tool call of its own burns CPU: {'; '.join(k['own_busy'][:3])}. Stop that pid (kill <pid>) so the call returns "
                     f"and the child goes on, or cancel the child (rlm.delete_subagent).")
            else:
                k = kids[0]
                m = (f"[watchdog] Your subagent '{k['name']}' has produced nothing for {k.get('last_asst_min')} "
                     f"minutes: its turn never dispatched and there is no shell process left to unblock. Cancel "
                     f"that child (rlm.delete_subagent) and either redo its slice yourself or respawn it with a "
                     f"narrower task and explicit timeouts on every network call.")
            sm = pa('send', psid, m)
            if sm.returncode != 0:
                import time as _t
                _t.sleep(5)
                sm = pa('send', psid, m)
            act = {'method': 'notify-parent', 'parent': par['name'], 'parent_sid': psid,
                   'children': [k['name'] for k in kids], 'send_rc': sm.returncode,
                   'send_out': (sm.stdout or sm.stderr).strip()[:160],
                   'at': dt.datetime.now(dt.timezone.utc).isoformat()}
            actions.append(act)
            with open(LOG_F, 'a') as f:
                f.write(json.dumps(act) + '\n')

    # Restarts cancel rlm heartbeats silently: snapshot them and re-create them once when they vanish.
    try:
        actions.extend(heartbeat_rearm([r for r in recs if not r.get('stopped')], admit, now, dry_run=dry_run))
    except Exception as e:  # the heartbeat check must never stop a recovery cycle
        with open(LOG_F, 'a') as f:
            f.write(json.dumps({'kind': 'heartbeats_error', 'error': f'{type(e).__name__}: {e}'[:300],
                                'at': dt.datetime.now(dt.timezone.utc).isoformat()}) + '\n')

    LAST_COUNTS.update(counts)
    json.dump({'at': now.isoformat(),
               'by_id': {r['id']: {'msgs': r['msgs'], 'stale_min': r['stale_min'],
                                   'verdict': r['verdict'], 'sid': r['sid']} for r in recs}},
              open(STATE_F, 'w'), indent=1)
    if verbose:
        print(f'== watchdog {now.isoformat(timespec="seconds")}')
        order = {'FROZEN_TURN': 0, 'FROZEN_TOOL': 0, 'STUCK_TOOL': 0, 'SUSPECT': 1,
                 'PHANTOM_TURN': 0, 'DROPPED_TURN': 0, 'NOTICED': 1, 'WORK_DONE': 1, 'MODEL_STALL': 1, 'POOL_WAIT': 1, 'CHILD_WEDGED': 1, 'BUSY_TOOL': 2, 'IN_FLIGHT': 2,
                 'HELD': 2, 'ARCHIVED': 3, 'OK': 3, 'SELF': 4}
        for r in sorted([x for x in verdicts if x['verdict'] not in ('OK', 'SELF', 'IN_FLIGHT')],
                        key=lambda x: (order[x['verdict']], -(x['stale_min'] or 0))):
            print(f"  {r['verdict']:<12} d{r['depth']} {r['id']} {str(r['stale_min']):>6}m msgs={r['msgs']:<5} "
                  f"{r['model']} {r['name'][:45]!r} :: {r['why'][:90]}")
        live = [x for x in verdicts if x['life'] == 'live' and x['act'] == 'working']
        print(f"  live working: {len(live)} | healthy: {sum(1 for x in live if x['verdict'] in ('OK','SELF'))} "
              f"| busy tool: {sum(1 for x in live if x['verdict']=='BUSY_TOOL')} "
              f"| suspect: {sum(1 for x in live if x['verdict']=='SUSPECT')} "
              f"| recovered: {len([a for a in actions if not a.get('dry_run')])}")
        for a in actions:
            print('  ACTION', json.dumps({k: v for k, v in a.items() if k != 'blockers'})[:400])
    return verdicts, actions
