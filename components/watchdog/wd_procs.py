"""Process and pipe readings: one ps table, per-pid lsof, swap and load, and the shells that wedge a tool call."""
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from wd_common import _run

MEMINFO = Path('/proc/meminfo')


def swap_used_gib():
    """Swap in use, from sysctl on macOS and /proc/meminfo on Linux, where sysctl has no vm.swapusage."""
    if sys.platform == 'darwin':
        out = subprocess.run(['sysctl', '-n', 'vm.swapusage'], capture_output=True, text=True).stdout
        m = re.search(r'used = ([\d.]+)([MG])', out)
        return (float(m.group(1)) / (1024 if m.group(2) == 'M' else 1)) if m else 0.0
    kb = {k: int(v.split()[0]) for k, v in (ln.split(':', 1) for ln in MEMINFO.read_text().splitlines())
          if k in ('SwapTotal', 'SwapFree')}
    return (kb['SwapTotal'] - kb['SwapFree']) / 1024 / 1024


def pressure():
    """-> (swap used in GiB, 1-minute load average)."""
    return round(swap_used_gib(), 2), round(os.getloadavg()[0], 2)


def _ps_table():
    """pid -> (ppid, stat, etime, cputime, pct, command) for every process, from one ps read."""
    out = {}
    for ln in _run('ps', '-A', '-o', 'pid=,ppid=,stat=,etime=,time=,%cpu=,command=').splitlines():
        f = ln.split(None, 6)
        if len(f) >= 6:
            out[f[0]] = (f[1], f[2], f[3], f[4], f[5], f[6] if len(f) > 6 else '')
    return out


def _children(pid, table):
    return sorted((p for p, row in table.items() if row[0] == str(pid)), key=int)


def _lsof(pid):
    """lsof lines of one process, header dropped."""
    return _run('lsof', '-nP', '-p', str(pid)).splitlines()[1:]


def _tls_count(pid):
    return sum(1 for ln in _lsof(pid) if re.search(r'TCP.*:443', ln))


def _fd1(pid):
    return [p[4] if len(p) > 4 else '' for p in (ln.split() for ln in _lsof(pid))
            if len(p) > 3 and re.fullmatch(r'1[uw]?', p[3])]


def _descendants(pid, depth=3, table=None):
    """Return [(pid, stat, cpu_seconds, pct, cmd)] for pid's descendants."""
    if not pid:
        return []
    table = _ps_table() if table is None else table
    out, frontier = [], [str(pid)]
    for _ in range(depth):
        kids = [k for p in frontier for k in _children(p, table)]
        if not kids:
            break
        for p in sorted(kids, key=int):
            _, stat, _, tm, pct, cmd = table[p]
            mm = tm.split(':')
            try:
                secs = float(mm[-1]) + 60 * int(mm[-2]) + (3600 * int(mm[-3]) if len(mm) > 2 else 0)
            except Exception:
                secs = 0.0
            out.append((p, stat, secs, float(pct or 0), cmd))
        frontier = kids
    return out


def _tls_confirmed(pid, samples=3, gap=4):
    """A provider request only counts as in flight if more than one sample sees the socket."""
    hits = 0
    for i in range(samples):
        hits += 1 if _tls_count(pid) > 0 else 0
        if hits >= 2:
            return True
        if i < samples - 1:
            time.sleep(gap)
    return False


def _etime_min(et):
    """`ps -o etime` (dd-hh:mm:ss / hh:mm:ss / mm:ss) -> minutes."""
    days = 0
    if '-' in et:
        d, et = et.split('-', 1)
        days = int(d)
    parts = [int(p) for p in et.split(':')]
    while len(parts) < 3:
        parts.insert(0, 0)
    h, m, s = parts[-3], parts[-2], parts[-1]
    return days * 1440 + h * 60 + m + s / 60.0


# ---- hung-tool surgery: an orphaned shell holding the tool's stdout pipe ----

def _kernel_pids(worker_pid, table=None):
    table = _ps_table() if table is None else table
    return [p for p in _children(worker_pid, table) if 'ipykernel' in table[p][5]]


def pipe_blockers(worker_pid, min_age_min=15):
    """Processes outside the worker tree that hold a pipe the session's kernels are reading.

    The classic case is `bash -lc '... &'` orphaned to PPID 1: it never exits, so
    subprocess.run(capture_output=True) never sees EOF and the tool call hangs forever.
    """
    kpids = _kernel_pids(worker_pid)
    if not kpids:
        return []
    addrs = {}
    for kp in kpids:
        for ln in (x for x in _lsof(kp) if 'PIPE' in x):
            parts = ln.split()
            try:
                fd = int(''.join(ch for ch in parts[3] if ch.isdigit()) or -1)
            except Exception:
                continue
            if fd >= 3 and len(parts) > 5:
                addrs.setdefault(parts[5], set()).add(kp)
    if not addrs:
        return []
    tree = set(kpids) | {str(worker_pid)}
    # Only this user's processes: lsof run without root cannot read another user's fds anyway, and the
    # whole-system read cost 12 s CPU on us-metal02 (2026-10-18).
    lso = _run('lsof', '-nP', '-u', str(os.getuid()))
    hits = {}
    for ln in (x for x in lso.splitlines() if 'PIPE' in x):
        parts = ln.split()
        if len(parts) < 6:
            continue
        pid, addr = parts[1], parts[5]
        if addr in addrs and pid not in tree:
            hits.setdefault(pid, set()).add(addr)
    out, table = [], _ps_table()
    for pid in hits:
        if pid not in table:
            continue
        ppid, stat, etime, tm, pct, cmd = table[pid]
        cpu = sum(x * float(y) for x, y in zip([1, 60, 3600][::-1][-len(tm.split(':')):], tm.split(':')))
        orphan = ppid == '1'
        idle = cpu < 2.0
        # An age floor keeps the watchdog off a SIBLING session's freshly launched job:
        # a real wedge is always older than the freeze threshold.
        old_enough = _etime_min(etime) >= min_age_min
        shellish = cmd.split()[0].endswith(('bash', 'sh', 'zsh')) or cmd.startswith('nohup')
        out.append(dict(pid=pid, ppid=ppid, stat=stat, etime=etime, age_min=round(_etime_min(etime), 1),
                        cpu_s=cpu, pct=pct, cmd=cmd[:200],
                        safe_to_kill=bool(orphan and idle and shellish and old_enough)))
    return out


def unblock(worker_pid, dry_run=False):
    """Kill only the orphaned idle shells wedging a session's tool call. Their
    background children are NOT killed (kill by pid, never by process group)."""
    cands = pipe_blockers(worker_pid)
    killed = []
    for c in cands:
        if c['safe_to_kill'] and not dry_run:
            _run('kill', c['pid'])
            killed.append(c)
    return cands, killed


def stuck_cell_procs(worker_pid, min_age_min=20):
    """Shells still parked under a session kernel long after the tool should have finished.

    A `%%bash` cell that shells out to a never-exiting streamer (`convex logs`, `vite dev`,
    `tail -f`) leaves its bash + pipeline alive forever; the kernel blocks reading the pipe.
    """
    out, table = [], _ps_table()
    for kp in _kernel_pids(worker_pid, table):
        for c in _children(kp, table):
            _, _, etime, _, pct, cmd = table[c]
            age = _etime_min(etime)
            pct = float(pct or 0)
            sub = _children(c, table)
            subcmds = [table[s][5].strip()[:70] for s in sub]
            # Only a shell whose stdout is still a PIPE can be blocking the kernel's read.
            # A background job the agent deliberately polls writes to a file or /dev/null.
            blocking = 'PIPE' in _fd1(c)
            if age >= min_age_min and pct < 5.0 and blocking:
                out.append(dict(kernel=kp, pid=c, age_min=round(age, 1), pct=pct, cmd=cmd[:80],
                                children=sub, child_cmds=subcmds))
    return out


def kill_stuck_cell(worker_pid, min_age_min=20, dry_run=False):
    """Kill the wedged cell's shell + its pipeline, never the kernel and never the worker."""
    procs = stuck_cell_procs(worker_pid, min_age_min)
    killed, table = [], _ps_table()
    for p in procs:
        deep = [g for c in p['children'] for g in _children(c, table)]
        targets = deep + p['children'] + [p['pid']]
        if not dry_run:
            _run('kill', *targets)
        killed.append({'shell': p['pid'], 'age_min': p['age_min'], 'cmds': p['child_cmds'], 'targets': targets})
    return killed


def _pipe_addrs(pid, fds=('1',)):
    out = set()
    for ln in (x for x in _lsof(pid) if 'PIPE' in x):
        parts = ln.split()
        if len(parts) < 6:
            continue
        fd = ''.join(ch for ch in parts[3] if ch.isdigit())
        if fds is None or fd in fds:
            out.add(parts[5])
    return out


def _ancestors(pid, limit=6, table=None):
    table = _ps_table() if table is None else table
    out, cur = [], str(pid)
    for _ in range(limit):
        ppid = table[cur][0] if cur in table else ''
        if not ppid or ppid == '0':
            break
        out.append(ppid)
        cur = ppid
    return out


def shell_belongs_to(shell_pid, worker_pid):
    """Is this parked shell actually blocking THIS session?

    Age matching alone is not attribution: an unrelated `pnpm dev` started at the same minute
    once matched a session that was deliberately running `await asyncio.sleep(1500)`, and the
    watchdog killed it. A shell belongs to a session only if it descends from that session's
    worker, or its stdout pipe is the very pipe one of that worker's kernels is reading.
    """
    if not worker_pid:
        return False
    table = _ps_table()
    if str(worker_pid) in _ancestors(shell_pid, table=table):
        return True
    mine = _pipe_addrs(shell_pid, fds=('1',))
    if not mine:
        return False
    for k in _children(worker_pid, table):
        if mine & _pipe_addrs(k, fds=None):
            return True
    return False


def _fd1_is_pipe(pid):
    """Is this process still holding the blocking pipe on stdout?"""
    return 'PIPE' in _fd1(pid)


def parked_shells(min_age_min=10):
    """Every shell anywhere on the box that is still holding a pipe open and doing nothing.

    Covers both shapes: a shell that is still a child of the session kernel, and one orphaned to
    PPID 1 by `nohup ... &` (invisible to a kernel-children scan). fd 1 still being a PIPE is what
    separates a blocking `subprocess.run(capture_output=True)` from a job the agent backgrounded
    to a file on purpose.
    """
    out, table = [], _ps_table()
    for pid, (ppid, _, etime, tm, pct, cmd) in table.items():
        if not re.search(r'(bash|/bin/sh|zsh) -', cmd) or 'grep' in cmd:
            continue
        try:
            age = _etime_min(etime)
        except Exception:
            continue
        if age < min_age_min or float(pct or 0) >= 5.0:
            continue
        if 'PIPE' not in _fd1(pid):
            continue
        kids = _children(pid, table)
        kid_cmds = [table[k][5].strip()[:70] for k in kids]
        out.append(dict(pid=pid, ppid=ppid, age_min=round(age, 1), pct=float(pct or 0), cmd=cmd[:120],
                        children=kids, child_cmds=kid_cmds))
    return out
