"""Footprint of Prime worker process trees, for the chat service's Mac usable watch (src/mac-usable-watch.ts).

Reads worker pids, one per line, on stdin. Prints one JSON object: each worker's tree (the worker and every descendant, from
proc_listchildpids) with its pid count and summed phys_footprint in bytes (the memory macOS counts, compressed and swapped pages
included), the Mac's swap use and memory pressure level, and this process's own CPU seconds. It uses libproc and sysctl through ctypes
and starts no other process, so one call costs well under a second of CPU at 1,000 processes.
"""
import ctypes
import json
import resource
import sys

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


def tree(root):
    pids, stack, seen = [], [root], set()
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        bytes_ = footprint(pid)
        if bytes_ is None:
            continue
        pids.append(bytes_)
        stack.extend(children(pid))
    return {"pids": len(pids), "bytes": sum(pids)}


workers = {line.strip(): tree(int(line)) for line in sys.stdin if line.strip().isdigit()}
swap = sysctl("vm.swapusage", SwapUsage())
pressure = sysctl("kern.memorystatus_vm_pressure_level", ctypes.c_int())
usage = resource.getrusage(resource.RUSAGE_SELF)
print(json.dumps({"workers": workers, "swap_used_bytes": swap.used if swap else None, "pressure_level": pressure.value if pressure else None,
                  "cpu_s": round(usage.ru_utime + usage.ru_stime, 3)}))
