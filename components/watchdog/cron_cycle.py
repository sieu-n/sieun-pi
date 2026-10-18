#!/usr/bin/env python3
"""Headless watchdog cycle, run by systemd on Linux and launchd on the Mac, outside every agent session.

Why this exists: watchdog.py was only ever driven by a 30-minute heartbeat that fires INTO
agent session 01a01846 (b4d0f99870e9). On 2026-08-21 that session wedged in the same phantom
turn it exists to clear, its heartbeat prompt queued behind the wedge, and the fleet sat frozen
for an hour with nobody running a cycle. A recovery loop that lives inside a wedgeable session
is a single point of failure.

SELF_SESSION is cleared: nothing needs protecting here because this runner is not a session,
so this is the only caller that can heal the watchdog session itself.
It runs from the installed copy (components/watchdog/install.py), so its own folder is first on sys.path.
Locking is owned by watchdog.cycle(), which takes cycle.lock itself, and this runner must not.
"""
import datetime as dt
import json
import sys

import repl_guard
import watchdog as wd
from wd_common import WATCH

CRONLOG = WATCH / 'cron.jsonl'


def main():
    # NB: do NOT take cycle.lock here. watchdog.cycle() takes that same lock itself and releases
    # it when it returns; flock conflicts between two file descriptors in ONE process, so an outer
    # acquisition here makes cycle() skip and this runner become a silent no-op (seen 2026-08-21:
    # every launchd run printed 'the out-of-process runner holds cycle.lock' and recovered nothing).
    wd.SELF_SESSION = '__no_self__'  # no session to protect: this runner heals the watchdog too
    # (a sentinel, not None: classify() compares sid == SELF_SESSION and a None sid would match)

    # The local kernel revive guard (prime-agent#3447) is lost on every prime-agent update or rollback: re-apply it first.
    try:
        guard = repl_guard.check(send=lambda sid, msg: wd.pa('send', sid, msg))
    except Exception as e:  # the guard check must never stop a cycle
        guard = {'status': 'error', 'why': str(e)[:200]}

    verdicts, actions = wd.cycle()
    live = [x for x in verdicts if x['life'] == 'live' and x['act'] == 'working']
    rec = {'at': dt.datetime.now(dt.timezone.utc).isoformat(),
           'runner': 'launchd',
           'live_working': len(live),
           'repl_guard': guard.get('status'),
           **wd.LAST_COUNTS,
           'verdicts': {x['id']: x['verdict'] for x in live},
           'actions': [{k: v for k, v in a.items() if k in
                        ('id', 'name', 'method', 'why', 'send_out', 'send_rc')} for a in actions]}
    with open(CRONLOG, 'a') as f:
        f.write(json.dumps(rec, default=str) + '\n')
    print(json.dumps(rec, default=str))
    return 0


if __name__ == '__main__':
    sys.exit(main())
