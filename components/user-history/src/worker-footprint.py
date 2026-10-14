"""Footprint of Prime worker process trees, for the chat service's Mac usable watch (src/mac-usable-watch.ts).

Reads worker pids, one per line, on stdin. Prints one JSON object: each worker's tree (the worker and every descendant, from
proc_listchildpids) with its pid count and summed phys_footprint in bytes (the memory macOS counts, compressed and swapped pages
included), every waiter (`WAITER`) running under a job's kernel with the kernel's session and the waiter's age, the Mac's swap use and memory pressure level, and this process's own CPU seconds. It uses libproc and sysctl through ctypes
and starts no other process, so one call costs well under a second of CPU at 1,000 processes.
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


def sysctl(name, value):
    size = ctypes.c_size_t(ctypes.sizeof(value))
    return value if libc.sysctlbyname(name.encode(), ctypes.byref(value), ctypes.byref(size), None, 0) == 0 else None


# A command that only waits on CI or a clock while it holds its job's kernel and worker; board.wake does the same with no kernel.
WAITER = re.compile(r"(^|/)gh run watch\b|(^|/)gh pr checks\b.*--watch|ci-run-status(\.sh)? \S+ .*--wait|ci-run-status(\.sh)? --wait|(^|/)sleep (\d{3,}|[6-9]\d)(\.\d+)?$")
CTL_KERN, KERN_PROCARGS2, KERN_ARGMAX, PROC_PIDTBSDINFO = 1, 49, 8, 3


def procargs(pid):
    """(argv, env) of a process from KERN_PROCARGS2, or None when it is gone or not readable."""
    size = ctypes.c_size_t(1 << 18)
    buffer = ctypes.create_string_buffer(size.value)
    mib = (ctypes.c_int * 3)(CTL_KERN, KERN_PROCARGS2, pid)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0 or size.value < 4:
        return None
    raw = buffer.raw[:size.value]
    argc = int.from_bytes(raw[:4], "little")
    parts = [part.decode("utf-8", "replace") for part in raw[4:].split(b"\0") if part]
    return parts[1:1 + argc], parts[1 + argc:]


def started(pid, info=ctypes.create_string_buffer(136)):
    """The process's start time in epoch seconds (proc_bsdinfo.pbi_start_tvsec), or None."""
    if lib.proc_pidinfo(pid, PROC_PIDTBSDINFO, ctypes.c_uint64(0), info, 136) != 136:
        return None
    return int.from_bytes(info.raw[120:128], "little")


def kernel_session(pid):
    """The Prime session a `python -m rlm.repl` kernel serves, from RLM_HARNESS_STATE_DIR (<...>/session-artifacts/<session>/harness or
    <...>/<session>/harness for a root), or None when `pid` is no kernel."""
    args = procargs(pid)
    if not args or "rlm.repl" not in args[0]:
        return None
    env = dict(entry.split("=", 1) for entry in args[1] if "=" in entry)
    state = env.get("RLM_HARNESS_STATE_DIR", "").rstrip("/")
    parts = state.split("/")
    return parts[-2] if len(parts) >= 2 and parts[-1] == "harness" else ""


def tree(root, waiters, now):
    pids, stack, seen = [], [(root, None)], set()
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
            session = kernel_session(pid)
            if session is not None:
                kernel = (pid, session)
        elif kernel is not None:
            args = procargs(pid)
            command = " ".join(args[0]) if args else ""
            if WAITER.search(command):
                at = started(pid)
                waiters.append({"pid": pid, "kernel": kernel[0], "session": kernel[1], "command": command[:200],
                                "age_s": None if at is None else max(0, now - at)})
        stack.extend((child, kernel) for child in children(pid))
    return {"pids": len(pids), "bytes": sum(pids)}


if __name__ == "__main__":
    waiters = []
    workers = {line.strip(): tree(int(line), waiters, int(time.time())) for line in sys.stdin if line.strip().isdigit()}
    swap = sysctl("vm.swapusage", SwapUsage())
    pressure = sysctl("kern.memorystatus_vm_pressure_level", ctypes.c_int())
    usage = resource.getrusage(resource.RUSAGE_SELF)
    print(json.dumps({"workers": workers, "waiters": waiters, "swap_used_bytes": swap.used if swap else None, "pressure_level": pressure.value if pressure else None,
                      "cpu_s": round(usage.ru_utime + usage.ru_stime, 3)}))
