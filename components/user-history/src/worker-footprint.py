"""Footprint of Prime worker process trees, for the chat service's Mac usable watch (src/mac-usable-watch.ts).

Reads worker pids, one per line, on stdin. Prints one JSON object: each worker's tree (the worker and every descendant, from
proc_listchildpids) with its pid count, summed phys_footprint in bytes and the worker process's own phys_footprint (`own`) (the memory macOS counts, compressed and swapped pages
included), the host's swap use and, on macOS, its memory pressure level, and this process's own CPU seconds. On macOS it uses libproc and sysctl through ctypes;
on Linux it reads /proc, counts resident plus swapped bytes for phys_footprint and has no pressure level. It starts no other process, so one call costs well under a second of CPU at 1,000 processes.
Each `python -m rlm.repl` kernel in a worker tree is reported with its session and root (from RLM_HARNESS_STATE_DIR), its subtree's bytes,
the kernel process's own bytes (`own`) and its largest non-Prime descendant (`kernels`), and every process that carries RLM_HARNESS_STATE_DIR but sits under no kernel and no Prime process is an
orphan of the root and session that path names (`orphans`): on 10-15 at 00:45Z a deleted job's nohup'd runner.py started a 30 GB script that way.
A shared service (`SHARED`) and every process under it belong to no tree.
`--session <id>[,<id>...]` prints the processes those sessions' kernels left detached (`strays`), which the service stops once their job is deleted or archived (src/job-leftovers.ts); `--started <pid>`
prints a process's start time, and `--inside` prints the processes that run in or hold the dirs it reads on stdin, one per line (`inside`), and a
cleanup keeps a dir any of them uses and signals none of them.
"""
import ctypes
import json
import os
import re
import resource
import sys

# The wrapper Prime's bash() runs each handle in: `/bin/bash -c "...{\n<command>\n} 8>&- 9>&-...prime-agent-complete..."`.
HANDLE = re.compile(r"\{\n(.*?)\n\} 8>&- 9>&-\n.*prime-agent-complete", re.S)
# Prime's own processes, which the guard never names or stops: a kernel, a prime-agent binary (the daemon and its workers), pi-pool's token helper.
PRIME = re.compile(r"rlm\.repl|(^|/)prime-agent( |$)|pi-pool-token")
# Services a session once started that every tree shares, so they count toward no tree and are never stopped, with every process under them. On
# 10-15 they carried a session's RLM_HARNESS_STATE_DIR: two PM2 God Daemons (~/.pm2, and auto-sns-agent/.cache/pm2-dev with the virev-demo vite
# at 1.77 GiB, dev-guard and devstack-sync under it), Aside (/Applications/Aside.app, its helpers and the Aside Daemon) and cua-driver serve.
SHARED = re.compile(r"^PM2 v[\d.]+: God Daemon|/Aside\.app/|^Aside Daemon|(^|/)cua-driver( |$)")
if sys.platform == "darwin":
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
        """phys_footprint in bytes of a process, or None when it is gone."""
        if lib.proc_pid_rusage(pid, RUSAGE_INFO_V4, ctypes.byref(info)) != 0:
            return None
        return info.phys_footprint

    def cpu_of(pid):
        """None: the hung call marks (src/hung-calls.ts) read CPU on Linux only."""
        return None

    def children(pid, buffer=(ctypes.c_int * 4096)()):
        count = lib.proc_listchildpids(pid, buffer, ctypes.sizeof(buffer))
        return list(buffer[:count]) if count > 0 else []

    def allpids(buffer=(ctypes.c_int * 16384)()):
        count = lib.proc_listallpids(buffer, ctypes.sizeof(buffer))
        return [pid for pid in buffer[:count] if pid > 0] if count > 0 else []

    def sysctl(name, value):
        size = ctypes.c_size_t(ctypes.sizeof(value))
        return value if libc.sysctlbyname(name.encode(), ctypes.byref(value), ctypes.byref(size), None, 0) == 0 else None

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

    def swap_used():
        """Swap in use in bytes, or None."""
        swap = sysctl("vm.swapusage", SwapUsage())
        return swap.used if swap else None

    def pressure_level():
        """The kernel's memory pressure level (1 normal, 2 warn, 4 critical), or None."""
        pressure = sysctl("kern.memorystatus_vm_pressure_level", ctypes.c_int())
        return pressure.value if pressure else None
else:
    PROC = "/proc"
    TICKS = os.sysconf("SC_CLK_TCK")
    with open(f"{PROC}/stat") as file:
        BOOT = next(int(line.split()[1]) for line in file if line.startswith("btime "))

    def stat(pid):
        """The fields of /proc/<pid>/stat after the command name, or None when the process is gone."""
        try:
            with open(f"{PROC}/{pid}/stat", "rb") as file:
                return file.read().rsplit(b")", 1)[1].split()
        except (OSError, IndexError):
            return None

    def cpu_of(pid):
        """(own, reaped) CPU seconds of a process from /proc/<pid>/stat (utime plus stime, and cutime plus cstime of the children it reaped), or None."""
        fields = stat(pid)
        if fields is None:
            return None
        return (int(fields[11]) + int(fields[12])) / TICKS, (int(fields[13]) + int(fields[14])) / TICKS

    def footprint(pid):
        """Resident plus swapped bytes, the nearest Linux count to phys_footprint, of a process, or None when it is gone."""
        try:
            with open(f"{PROC}/{pid}/status") as file:
                return sum(int(line.split()[1]) for line in file if line.startswith(("VmRSS:", "VmSwap:"))) * 1024
        except OSError:
            return None

    def children(pid):
        found = []
        try:
            tasks = os.listdir(f"{PROC}/{pid}/task")
        except OSError:
            return found
        for task in tasks:
            try:
                with open(f"{PROC}/{pid}/task/{task}/children") as file:
                    found += [int(child) for child in file.read().split()]
            except OSError:
                pass
        return found

    def allpids():
        return [int(name) for name in os.listdir(PROC) if name.isdigit()]

    def procargs(pid):
        """(argv, env) of a process from /proc/<pid>/cmdline and environ, or None when it is gone or not readable."""
        try:
            with open(f"{PROC}/{pid}/cmdline", "rb") as file:
                argv = file.read()
            with open(f"{PROC}/{pid}/environ", "rb") as file:
                env = file.read()
        except OSError:
            return None
        return [part.decode("utf-8", "replace") for part in argv.split(b"\0") if part], [part.decode("utf-8", "replace") for part in env.split(b"\0") if part]

    def bsdinfo(pid):
        """(ppid, pgid, start time in epoch seconds) from /proc/<pid>/stat, or None when the process is gone."""
        fields = stat(pid)
        return None if fields is None else (int(fields[1]), int(fields[2]), BOOT + int(fields[19]) // TICKS)

    def swap_used():
        """Swap in use in bytes, from /proc/meminfo."""
        with open(f"{PROC}/meminfo") as file:
            kb = {key: int(value.split()[0]) for key, value in (line.split(":", 1) for line in file) if key in ("SwapTotal", "SwapFree")}
        return (kb["SwapTotal"] - kb["SwapFree"]) * 1024

    def pressure_level():
        """None: Linux has no counterpart of macOS's memory pressure level."""
        return None


def started(pid):
    """The process's start time in epoch seconds (`bsdinfo`), or None."""
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


def tree(root, kernels, seen):
    pids, stack, own = [], [(root, None)], 0
    while stack:
        pid, kernel = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        bytes_ = footprint(pid)
        if bytes_ is None:
            continue
        pids.append(bytes_)
        if pid == root:
            own = bytes_
        if kernel is None and pid != root:
            owner = kernel_of(pid, procargs(pid))
            if owner is not None:
                kernel = {"pid": pid, "root": owner[0], "session": owner[1], "pids": 0, "bytes": 0, "own": bytes_, "biggest": None}
                used = cpu_of(pid)
                if used is not None:
                    kernel["cpu_s"], kernel["work_cpu_s"] = used[0], used[1]
                kernels.append(kernel)
        elif kernel:
            args = procargs(pid)
            text = " ".join(args[0]) if args else ""
            if SHARED.search(text):
                stack.extend((child, False) for child in children(pid))
                continue
            used = cpu_of(pid) if "work_cpu_s" in kernel else None
            if used is not None:
                kernel["work_cpu_s"] += used[0] + used[1]
            if not PRIME.search(text) and (kernel["biggest"] is None or bytes_ > kernel["biggest"]["bytes"]):
                kernel["biggest"] = {"pid": pid, "bytes": bytes_, "started": started(pid), "command": command(args)}
        if kernel:
            kernel["pids"] += 1
            kernel["bytes"] += bytes_
        stack.extend((child, kernel) for child in children(pid))
    return {"pids": len(pids), "bytes": sum(pids), "own": own}


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


def shared(table, pid):
    """Whether `pid` or an ancestor is a shared service (`SHARED`)."""
    hops = 0
    while pid > 1 and hops < 64:
        entry = table.get(pid)
        if entry is None:
            return False
        if entry[3] and SHARED.search(" ".join(entry[3][0])):
            return True
        pid, hops = entry[0], hops + 1
    return False


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
             if pid not in inside and detached(table, pid, inside) and not shared(table, pid))
    return [entry for entry in found if entry]


def strays(table, sessions):
    """The processes the kernels of `sessions` left detached: its RLM_HARNESS_STATE_DIR names one of them, or it sits in one of their kernels' process groups, and no kernel or Prime process is above it."""
    groups = {table[pid][1] for pid in table if (owner := kernel_of(pid, table[pid][3])) and owner[1] in sessions}
    found = (process(table, pid, {}) for pid, (_, pgid, _, args) in table.items()
             if args and not PRIME.search(" ".join(args[0])) and ((harness(args[1]) or ("", ""))[1] in sessions or pgid in groups) and detached(table, pid) and not shared(table, pid))
    return [entry for entry in found if entry]


def held_paths(pid):
    """(executable, cwd and open files) of a process from Linux /proc; (None, []) on macOS, where only its arguments and environment are read."""
    if sys.platform == "darwin":
        return None, []
    def link(name):
        try:
            return os.readlink(f"{PROC}/{pid}/{name}")
        except OSError:
            return None
    try:
        fds = os.listdir(f"{PROC}/{pid}/fd")
    except OSError:
        fds = []
    held = [link("cwd")] + [link(f"fd/{fd}") for fd in fds]
    return link("exe"), [path for path in held if path]


def inside(table, dirs):
    """Each process that runs in or holds one of `dirs`: its executable, cwd or an open file lies there, or an argument or environment value names
    a path there (a rig's `HOME=/tmp/p8iso-X/home`, `iso-run.py --root /tmp/p8iso-X`). Each carries the dir, the session its RLM_HARNESS_STATE_DIR
    names (none for a process of the rig itself), whether it is a Prime process outside the rig (a kernel, a worker, the real daemon) and whether
    it is a shared service. One pass over each process's paths, so 1,000 dirs cost what one does."""
    wanted = set(dirs)
    parents = sorted({os.path.dirname(path) for path in wanted}, key=len, reverse=True)
    named = re.compile(r"(?:^|[=:\s,\"'])(" + "|".join(re.escape(parent) for parent in parents) + r")/([^/\s:,\"']+)") if parents else None

    def dir_of(path):
        """The dir of `dirs` a path lies in, or None."""
        for parent in parents:
            if path and path.startswith(parent + "/"):
                top = parent + "/" + path[len(parent) + 1:].split("/", 1)[0]
                return top if top in wanted else None
        return None

    found = []
    for pid, (_, _, _, args) in table.items():
        if pid == os.getpid() or not args or named is None:
            continue
        exe, held = held_paths(pid)
        env = dict(entry.split("=", 1) for entry in args[1] if "=" in entry)
        # A process of the rig itself: it runs from the dir, or its home or harness state lies there (an isolated Prime and its kernels).
        own = {dir_of(exe), dir_of(args[0][0] if args[0] else None), dir_of(env.get("HOME")), dir_of(env.get("RLM_HARNESS_STATE_DIR"))} - {None}
        hits = own | {dir_of(path) for path in held} | {match.group(1) + "/" + match.group(2) for text in args[0] + list(env.values()) for match in named.finditer(text)}
        for path in sorted(hits & wanted):
            rig = path in own
            entry = process(table, pid, {"dir": path, "session": None if rig else (harness(args[1]) or (None, None))[1],
                                         "prime": bool(PRIME.search(" ".join(args[0]))) and not rig, "shared": shared(table, pid)})
            if entry:
                found.append(entry)
    return found


def cpu():
    usage = resource.getrusage(resource.RUSAGE_SELF)
    return round(usage.ru_utime + usage.ru_stime, 3)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--started":
        print(json.dumps(started(int(sys.argv[2]))))
        sys.exit(0)
    if len(sys.argv) == 2 and sys.argv[1] == "--inside":
        print(json.dumps({"inside": inside(scan(), [line.strip() for line in sys.stdin if line.strip().startswith("/")]), "cpu_s": cpu()}))
        sys.exit(0)
    if len(sys.argv) == 3 and sys.argv[1] == "--session":
        print(json.dumps({"strays": strays(scan(), set(sys.argv[2].split(","))), "cpu_s": cpu()}))
        sys.exit(0)
    kernels, seen = [], set()
    workers = {line.strip(): tree(int(line), kernels, seen) for line in sys.stdin if line.strip().isdigit()}
    print(json.dumps({"workers": workers, "kernels": kernels, "orphans": orphans(scan(), seen),
                      "swap_used_bytes": swap_used(), "pressure_level": pressure_level(), "cpu_s": cpu()}))
