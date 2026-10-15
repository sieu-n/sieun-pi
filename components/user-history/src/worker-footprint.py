"""Footprint of Prime worker process trees, for the chat service's Mac usable watch (src/mac-usable-watch.ts).

Reads worker pids, one per line, on stdin. Prints one JSON object: each worker's tree (the worker and every descendant, from
proc_listchildpids) with its pid count and summed phys_footprint in bytes (the memory macOS counts, compressed and swapped pages
included), every waiter (`WAITER`) and every bash() handle (`HANDLE`, with the command it runs) under a job's kernel with the kernel's session and the process's age, the Mac's swap use and memory pressure level, and this process's own CPU seconds. It uses libproc and sysctl through ctypes
and starts no other process, so one call costs well under a second of CPU at 1,000 processes.
Each `python -m rlm.repl` kernel in a worker tree is reported with its session and root (from RLM_HARNESS_STATE_DIR), its subtree's bytes and its
largest non-Prime descendant (`kernels`), and every process that carries RLM_HARNESS_STATE_DIR but sits under no kernel and no Prime process is an
orphan of the root and session that path names (`orphans`): on 10-15 at 00:45Z a deleted job's nohup'd runner.py started a 30 GB script that way.
`--session <id>` prints the processes a session's kernel left detached (`strays`), for the notice of a deleted or archived job; `--started <pid>`
prints a process's start time.
"""
import ctypes
import json
import re
import resource
import sys
import time

lib = ctypes.CDLL("/usr/lib/libproc.dylib")
libc = ctypes.CDLL("/usr/lib/libc.dylib")
RUSAGE_INFO_V4 = 4


class RusageInfo(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
        "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups", "pageins", "wired_size", "resident_size", "phys_footprint")] + [
        ("rest", ctypes.c_uint64 * 64)]


class SwapUsage(ctypes.Structure):
    _fields_ = [("total", ctypes.c_uint64), ("avail", ctypes.c_uint64), ("used", ctypes.c_uint64), ("pagesize", ctypes.c_uint32), ("encrypted", ctypes.c_uint32)]


def footprint(pid, info=RusageInfo()):
    return info.phys_footprint if lib.proc_pid_rusage(pid, RUSAGE_INFO_V4, ctypes.byref(info)) == 0 else None


def children(pid, buffer=(ctypes.c_int * 4096)()):
    count = lib.proc_listchildpids(pid, buffer, ctypes.sizeof(buffer))
    return list(buffer[:count]) if count > 0 else []


def allpids(buffer=(ctypes.c_int * 16384)()):
    count = lib.proc_listallpids(buffer, ctypes.sizeof(buffer))
    return [pid for pid in buffer[:count] if pid > 0] if count > 0 else []


def sysctl(name, value):
    size = ctypes.c_size_t(ctypes.sizeof(value))
    return value if libc.sysctlbyname(name.encode(), ctypes.byref(value), ctypes.byref(size), None, 0) == 0 else None


# The wrapper Prime's bash() runs each handle in: `/bin/bash -c "...{\n<command>\n} 8>&- 9>&-...prime-agent-complete..."`.
HANDLE = re.compile(r"\{\n(.*?)\n\} 8>&- 9>&-\n.*prime-agent-complete", re.S)
# A command that only waits on CI or a clock while it holds its job's kernel and worker; board.wake does the same with no kernel.
WAITER = re.compile(r"(^|/)gh run watch\b|(^|/)gh pr checks\b.*--watch|ci-run-status(\.sh)? \S+ .*--wait|ci-run-status(\.sh)? --wait|(^|/)sleep (\d{3,}|[6-9]\d)(\.\d+)?$")
# Prime's own processes, which the guard never names or stops: a kernel, a prime-agent binary (the daemon and its workers), pi-pool's token helper.
PRIME = re.compile(r"rlm\.repl|(^|/)prime-agent( |$)|pi-pool-token")
CTL_KERN, KERN_PROCARGS2, PROC_PIDTBSDINFO = 1, 49, 3
ARGS = ctypes.create_string_buffer(1 << 18)


def procargs(pid):
    """(argv, env) of a process from KERN_PROCARGS2, or None when it is gone or not readable."""
    size = ctypes.c_size_t(ctypes.sizeof(ARGS))
    mib = (ctypes.c_int * 3)(CTL_KERN, KERN_PROCARGS2, pid)
    if libc.sysctl(mib, 3, ARGS, ctypes.byref(size), None, 0) != 0 or size.value < 4:
        return None
    raw = ARGS.raw[:size.value]
    argc = int.from_bytes(raw[:4], "little")
    parts = [part.decode("utf-8", "replace") for part in raw[4:].split(b"\0") if part]
    return parts[1:1 + argc], parts[1 + argc:]


def bsdinfo(pid, info=ctypes.create_string_buffer(136)):
    """(ppid, pgid, start time in epoch seconds) from proc_bsdinfo, or None when the process is gone."""
    if lib.proc_pidinfo(pid, PROC_PIDTBSDINFO, ctypes.c_uint64(0), info, 136) != 136:
        return None
    raw = info.raw
    return int.from_bytes(raw[16:20], "little"), int.from_bytes(raw[100:104], "little"), int.from_bytes(raw[120:128], "little")


def started(pid):
    """The process's start time in epoch seconds (proc_bsdinfo.pbi_start_tvsec), or None."""
    info = bsdinfo(pid)
    return None if info is None else info[2]


def harness(env):
    """(root, session) from RLM_HARNESS_STATE_DIR: ~/.prime/agent/session-artifacts/<root>/.../<session>/harness, or <root>/harness for a root's own kernel."""
    state = next((entry[22:] for entry in env if entry.startswith("RLM_HARNESS_STATE_DIR=")), "").rstrip("/")
    parts = state.split("/")
    if len(parts) < 2 or parts[-1] != "harness" or "/session-artifacts/" not in state:
        return None
    return state.split("/session-artifacts/", 1)[1].split("/", 1)[0], parts[-2]


def command(args):
    text = " ".join(args[0]) if args else ""
    handle = HANDLE.search(text)
    return (handle.group(1) if handle else text)[:200]


def kernel_of(pid, args):
    """(root, session) of a `python -m rlm.repl` kernel, ("", "") when its env names none, or None when `pid` is no kernel."""
    if not args or "rlm.repl" not in " ".join(args[0]):
        return None
    return harness(args[1]) or ("", "")


def tree(root, waiters, now, handles, kernels, seen):
    pids, stack = [], [(root, None)]
    while stack:
        pid, kernel = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        bytes_ = footprint(pid)
        if bytes_ is None:
            continue
        pids.append(bytes_)
        if kernel is None and pid != root:
            owner = kernel_of(pid, procargs(pid))
            if owner is not None:
                kernel = {"pid": pid, "root": owner[0], "session": owner[1], "pids": 0, "bytes": 0, "biggest": None}
                kernels.append(kernel)
        elif kernel is not None:
            args = procargs(pid)
            text = " ".join(args[0]) if args else ""
            handle = HANDLE.search(text)
            if handle or WAITER.search(text):
                at = started(pid)
                (handles if handle else waiters).append({"pid": pid, "kernel": kernel["pid"], "session": kernel["session"],
                                                         "command": (handle.group(1) if handle else text)[:200], "age_s": None if at is None else max(0, now - at)})
            if not PRIME.search(text) and (kernel["biggest"] is None or bytes_ > kernel["biggest"]["bytes"]):
                kernel["biggest"] = {"pid": pid, "bytes": bytes_, "started": started(pid), "command": command(args)}
        if kernel is not None:
            kernel["pids"] += 1
            kernel["bytes"] += bytes_
        stack.extend((child, kernel) for child in children(pid))
    return {"pids": len(pids), "bytes": sum(pids)}


def scan():
    """Every readable process: pid -> (ppid, pgid, start, argv and env or None)."""
    table = {}
    for pid in allpids():
        info = bsdinfo(pid)
        if info is not None:
            table[pid] = info + (procargs(pid),)
    return table


def detached(table, pid, inside=frozenset()):
    """Whether no ancestor of `pid` is a Prime process (a kernel, a worker, the daemon) or one of `inside`."""
    hops, parent = 0, table[pid][0]
    while parent > 1 and hops < 64:
        entry = table.get(parent)
        if parent in inside or entry is None or (entry[3] and PRIME.search(" ".join(entry[3][0]))):
            return False
        parent, hops = entry[0], hops + 1
    return True


def tagged(table):
    """Each process with RLM_HARNESS_STATE_DIR that is no Prime process: pid -> (root, session)."""
    found = {}
    for pid, (_, _, _, args) in table.items():
        if args and not PRIME.search(" ".join(args[0])):
            owner = harness(args[1])
            if owner:
                found[pid] = owner
    return found


def process(table, pid, extra):
    bytes_ = footprint(pid)
    return None if bytes_ is None else {"pid": pid, "bytes": bytes_, "started": table[pid][2], "command": command(table[pid][3]), **extra}


def orphans(table, inside):
    """Processes with RLM_HARNESS_STATE_DIR under no kernel, no Prime process and none of the measured worker trees, with the root and session it names."""
    found = (process(table, pid, {"root": root, "session": session}) for pid, (root, session) in tagged(table).items()
             if pid not in inside and detached(table, pid, inside))
    return [entry for entry in found if entry]


def strays(table, session):
    """The processes a session's kernel left detached: its RLM_HARNESS_STATE_DIR names `session`, or it sits in the kernel's process group, and no kernel or Prime process is above it."""
    groups = {table[pid][1] for pid in table if (owner := kernel_of(pid, table[pid][3])) and owner[1] == session}
    found = (process(table, pid, {}) for pid, (_, pgid, _, args) in table.items()
             if args and not PRIME.search(" ".join(args[0])) and ((harness(args[1]) or ("", ""))[1] == session or pgid in groups) and detached(table, pid))
    return [entry for entry in found if entry]


def cpu():
    usage = resource.getrusage(resource.RUSAGE_SELF)
    return round(usage.ru_utime + usage.ru_stime, 3)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--started":
        print(json.dumps(started(int(sys.argv[2]))))
        sys.exit(0)
    if len(sys.argv) == 3 and sys.argv[1] == "--session":
        print(json.dumps({"strays": strays(scan(), sys.argv[2]), "cpu_s": cpu()}))
        sys.exit(0)
    waiters, handles, kernels, seen = [], [], [], set()
    workers = {line.strip(): tree(int(line), waiters, int(time.time()), handles, kernels, seen) for line in sys.stdin if line.strip().isdigit()}
    swap = sysctl("vm.swapusage", SwapUsage())
    pressure = sysctl("kern.memorystatus_vm_pressure_level", ctypes.c_int())
    print(json.dumps({"workers": workers, "waiters": waiters, "handles": handles, "kernels": kernels, "orphans": orphans(scan(), seen),
                      "swap_used_bytes": swap.used if swap else None, "pressure_level": pressure.value if pressure else None, "cpu_s": cpu()}))
