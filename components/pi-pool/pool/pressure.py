"""Memory pressure on this Mac, read for the turn queue's governor (turns.py).

One reading is three kernel values, read in-process with sysctlbyname and
host_statistics64, so a read forks nothing: kern.memorystatus_vm_pressure_level,
vm.swapusage, and the pages the compressor occupies (vm_stat's "Pages occupied by
compressor"). On 10-14 18:2x KST at load 54 a read took 0.009 ms after a 3 ms
`import ctypes`, where `sysctl -n` took 126 ms, `vm_stat` 69 ms and
`memory_pressure -Q` 171 ms (sessions/2026/10/14/1815-mac-stays-usable/pressure-governor/read_cost.py).
It also reads the chat service's per-tree memory sample (read_tree_memory), so the
governor can hold the turns of a tree that holds over a quarter of RAM.
"""
import datetime, json, os, struct, time

LEVELS = ("ok", "high", "critical")
# kern.memorystatus_vm_pressure_level holds xnu's NOTE_MEMORYSTATUS_PRESSURE_* bits:
# 1 normal, 2 warn, 4 critical.
KERNEL_WARN = 2
KERNEL_CRITICAL = 4
# The compressor holding this share of RAM reads critical even while the kernel
# says warn: at 18:00 KST it held 16 GB of 32 (47%) with kernel_task at 189-268%
# paging, and at 18:20 it held 17.1 GB (50%) with a median 12,000 swap-ins a
# second while the kernel said warn in all 27 samples over 80 s.
COMPRESSOR_CRITICAL_SHARE = 0.45
# Swap this full reads critical too, because macOS kept saying warn through the thrash: at
# 10:21Z on 10-14 ops guy's feed read warn with swap 45.18 of 46.0 GB (98%), 16,191
# swapouts a second, kernel_task at 224% and load 145.
SWAP_CRITICAL_SHARE = 0.95
# Swapouts per second (pages, from the feed) at or above this read critical: 18 feed
# reads at 10:59-11:02Z on 10-14 all read warn while kernel_task paged at 168% to 256%,
# with swapouts from 6,210 to 22,956 a second (sessions/2026/10/14/1815-mac-stays-usable/feed-samples.jsonl).
SWAPOUTS_CRITICAL = 6000
# host_statistics64 flavor HOST_VM_INFO64 (mach/host_info.h).
HOST_VM_INFO64 = 4
# ops guy's machine-wide feed, rewritten every 10 s. A file older than FEED_FRESH_SEC
# (three missed writes) is stale and the kernel read stands alone.
FEED = os.path.join(os.path.expanduser("~"), ".cache", "virev", "mac-pressure.json")
FEED_FRESH_SEC = 30
FEED_LEVELS = {1: 1, 2: 2, 4: 4, "normal": 1, "ok": 1, "warn": 2, "warning": 2, "high": 2, "critical": 4}


def level(reading):
    """ok, high or critical for one reading; a reading of None (no probe) is ok,
    because a broken probe must not hold the Mac's agents."""
    if reading is None:
        return "ok"
    swap_full = reading["swap_total"] > 0 and reading["swap_used"] > SWAP_CRITICAL_SHARE * reading["swap_total"]
    if (reading["kernel"] >= KERNEL_CRITICAL or reading["compressor"] >= COMPRESSOR_CRITICAL_SHARE * reading["ram"]
            or swap_full or reading.get("swapouts", 0) >= SWAPOUTS_CRITICAL):
        return "critical"
    if reading["kernel"] >= KERNEL_WARN:
        return "high"
    return "ok"


def read(feed=FEED, now=None):
    """{kernel, swap_used, swap_total, compressor, ram, source} in bytes but kernel and
    source, or None when the kernel read fails. The feed's level, compressor, swap and swapouts replace the
    kernel's while the feed is fresh and parses (source "feed"); otherwise source is "sysctl"."""
    own = read_kernel()
    if own is None:
        return None
    fed = read_feed(feed, now)
    return dict(own, **fed, source="feed") if fed else dict(own, source="sysctl")


def read_feed(path=FEED, now=None):
    """parse_feed of the feed file, or None when it is missing, stale or unreadable."""
    try:
        if (time.time() if now is None else now) - os.stat(path).st_mtime >= FEED_FRESH_SEC:
            return None
        with open(path) as f:
            return parse_feed(json.load(f))
    except (OSError, ValueError):
        return None


def parse_feed(data):
    """{kernel, compressor, swap_used, swap_total, swapouts} from one schema v1 feed
    record, or None for a record this does not know. Sizes come in GiB and leave in bytes;
    swapouts are pages a second."""
    if not isinstance(data, dict) or data.get("v") != 1:
        return None
    level, mem, swap, swapouts = data.get("pressure_level"), data.get("mem_gb"), data.get("swap_gb"), data.get("swapouts_per_s")
    if isinstance(level, bool) or not isinstance(level, (int, str)) or level not in FEED_LEVELS:
        return None
    if not isinstance(mem, dict) or not isinstance(swap, dict):
        return None
    gbs = [mem.get("compressed"), swap.get("used"), swap.get("total")]
    if not all(gb_ok(gb) for gb in gbs) or not gb_ok(swapouts, 10 ** 9):
        return None
    compressed, used, total = (int(gb * 2 ** 30) for gb in gbs)
    return {"kernel": FEED_LEVELS[level], "compressor": compressed, "swap_used": used, "swap_total": total, "swapouts": swapouts}


# The chat service's per-tree memory sample (components/user-history), rewritten every
# minute: the trees whose processes hold over a quarter of RAM (TREE_SHARE in
# ~/.cache/virev/tree-guard-contract.md). On 10-15 00:40-00:53Z the VP of SEO tree held
# 16 to 25.5 GiB of 32 while the Mac swapped out up to 25,873 pages a second.
TREE_MEMORY = os.path.join(os.path.expanduser("~"), ".cache", "virev", "tree-memory.json")
# A sample this old is stale and holds nothing: three missed one-minute writes, the same
# three-missed-writes rule as FEED_FRESH_SEC.
TREE_MEMORY_FRESH_SEC = 180


def read_tree_memory(path=TREE_MEMORY, now=None):
    """{root session id: its `over` record} from the chat service's tree-memory.json, or {}
    when the file is missing, unreadable, not v 1, or its ts is TREE_MEMORY_FRESH_SEC or more old."""
    try:
        with open(path) as f:
            return parse_tree_memory(json.load(f), time.time() if now is None else now)
    except (OSError, ValueError):
        return {}


def parse_tree_memory(data, now):
    """The `over` records of one v 1 sample by root, {} for a stale sample or one this does not know."""
    if not isinstance(data, dict) or data.get("v") != 1 or not isinstance(data.get("ts"), str) or not isinstance(data.get("over"), list):
        return {}
    at = datetime.datetime.fromisoformat(data["ts"].replace("Z", "+00:00"))
    at = at if at.tzinfo else at.replace(tzinfo=datetime.timezone.utc)
    if now - at.timestamp() >= TREE_MEMORY_FRESH_SEC:
        return {}
    return {o["root"]: o for o in data["over"] if isinstance(o, dict) and isinstance(o.get("root"), str) and o["root"]}


def gb_ok(value, top=1024):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and 0 <= value < top


# Linux PSI (/proc/pressure/memory, or memory.pressure of the cgroup that caps this process) stands in for xnu's
# level. The cutoffs are Android lmkd's defaults for its 1 s PSI window: ro.lmk.psi_partial_stall_ms 70 (some
# tasks stalled 7% of the time) for medium pressure and ro.lmk.psi_complete_stall_ms 700 (all tasks stalled 70%)
# for critical. avg10 is the kernel's 10 s average, in percent.
PSI_SOME_WARN = 7.0
PSI_FULL_CRITICAL = 70.0


def read_kernel():
    """read_mach on macOS, read_linux on Linux."""
    return read_linux() if os.path.exists("/proc/meminfo") else read_mach()


def read_linux(proc="/proc", cgroups="/sys/fs/cgroup"):
    """{kernel, swap_used, swap_total, compressor, ram} from /proc and cgroup v2, or None when they cannot be read.
    ram is the nearest memory.max above this process (a systemd slice's MemoryMax) when it is below MemTotal,
    and the PSI read is that cgroup's, so CI load in another slice does not hold this one's turns."""
    try:
        info = {}
        with open(os.path.join(proc, "meminfo")) as f:
            for line in f:
                key, _, rest = line.partition(":")
                info[key] = int(rest.split()[0]) * 1024
        ram, psi = info["MemTotal"], os.path.join(proc, "pressure", "memory")
        cap = capping_cgroup(proc, cgroups)
        if cap:
            ram = min(ram, cap[1])
            psi = os.path.join(cap[0], "memory.pressure")
        with open(psi) as f:
            stalls = parse_psi(f.read())
        kernel = KERNEL_CRITICAL if stalls["full"] >= PSI_FULL_CRITICAL else KERNEL_WARN if stalls["some"] >= PSI_SOME_WARN else 1
        return {"kernel": kernel, "swap_used": info["SwapTotal"] - info["SwapFree"], "swap_total": info["SwapTotal"],
                "compressor": info.get("Zswap", 0), "ram": ram}
    except (OSError, KeyError, ValueError, IndexError):
        return None


def parse_psi(text):
    """{some, full}: the avg10 percentages of one PSI file; full is 0 where the kernel gives no full line."""
    out = {"some": 0.0, "full": 0.0}
    for line in text.splitlines():
        kind, *fields = line.split()
        if kind in out:
            out[kind] = float(dict(f.split("=", 1) for f in fields)["avg10"])
    return out


def capping_cgroup(proc, cgroups):
    """(folder, bytes) of the nearest cgroup v2 folder at or above this process with a numeric memory.max, or None."""
    with open(os.path.join(proc, "self", "cgroup")) as f:
        rel = next((line[3:].strip() for line in f if line.startswith("0::")), None)
    while rel is not None:
        folder = os.path.join(cgroups, rel.lstrip("/"))
        try:
            with open(os.path.join(folder, "memory.max")) as f:
                value = f.read().strip()
            if value != "max":
                return folder, int(value)
        except FileNotFoundError:
            pass
        if rel in ("", "/"):
            return None
        rel = os.path.dirname(rel.rstrip("/"))
    return None


def read_mach():
    """{kernel, swap_used, swap_total, compressor, ram} from the macOS kernel, or None when a
    kernel call fails (a changed struct)."""
    try:
        import ctypes
        libc = ctypes.CDLL(None)

        def sysctl(name, size):
            buf, n = ctypes.create_string_buffer(size), ctypes.c_size_t(size)
            if libc.sysctlbyname(name.encode(), buf, ctypes.byref(n), None, ctypes.c_size_t(0)) != 0:
                raise OSError(name)
            return buf.raw[:n.value]

        class VmStatistics64(ctypes.Structure):
            _fields_ = ([(k, ctypes.c_uint32) for k in ("free", "active", "inactive", "wire")]
                        + [(k, ctypes.c_uint64) for k in ("zero_fill", "reactivations", "pageins", "pageouts", "faults",
                                                           "cow_faults", "lookups", "hits", "purges")]
                        + [(k, ctypes.c_uint32) for k in ("purgeable", "speculative")]
                        + [(k, ctypes.c_uint64) for k in ("decompressions", "compressions", "swapins", "swapouts")]
                        + [(k, ctypes.c_uint32) for k in ("compressor_pages", "throttled", "external", "internal")]
                        + [("uncompressed_in_compressor", ctypes.c_uint64)])

        kernel = struct.unpack("i", sysctl("kern.memorystatus_vm_pressure_level", 4))[0]
        swap_total, _, swap_used = struct.unpack("QQQ", sysctl("vm.swapusage", 32)[:24])
        ram = struct.unpack("Q", sysctl("hw.memsize", 8))[0]
        page = struct.unpack("Q", sysctl("hw.pagesize", 8))[0]
        vm, count = VmStatistics64(), ctypes.c_uint32(ctypes.sizeof(VmStatistics64) // 4)
        if libc.host_statistics64(libc.mach_host_self(), HOST_VM_INFO64, ctypes.byref(vm), ctypes.byref(count)) != 0:
            raise OSError("host_statistics64")
        return {"kernel": kernel, "swap_used": swap_used, "swap_total": swap_total,
                "compressor": vm.compressor_pages * page, "ram": ram}
    except Exception:
        return None


# The Prime daemon with its workers and every process under them (kernels, bash() handles): the memory a new child
# session adds to, read for the spawn gate (pool/spawns.py). The workers' part is the chat service's Mac usable watch
# sum (`workerGb`, src/worker-footprint.py): at 19:22 KST on 10-15 the workers read 36.28 GiB here in 6 ms where the
# watch read 35.58 GiB. The daemon process itself held 0.66 GiB at 19:50 KST.
PROC_PIDTBSDINFO = 3


def read_workers_gb():
    """GiB of phys_footprint in every prime-agent process whose parent is not one (the daemon) and all its
    descendants, or None when libproc is not there (another OS)."""
    try:
        import ctypes
        lib = ctypes.CDLL("/usr/lib/libproc.dylib")

        class Rusage(ctypes.Structure):
            _fields_ = ([("uuid", ctypes.c_uint8 * 16)] + [(k, ctypes.c_uint64) for k in (
                "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups", "pageins", "wired_size", "resident_size",
                "phys_footprint")] + [("rest", ctypes.c_uint64 * 64)])

        class BsdInfo(ctypes.Structure):
            _fields_ = [(k, ctypes.c_uint32) for k in ("flags", "status", "xstatus", "pid", "ppid")] + [("rest", ctypes.c_uint8 * 116)]

        buf = (ctypes.c_int * 16384)()
        count = lib.proc_listallpids(buf, ctypes.sizeof(buf))
        if count <= 0:
            return None
        name, bsd, usage = ctypes.create_string_buffer(64), BsdInfo(), Rusage()
        names, kids, parent = {}, {}, {}
        for pid in (p for p in buf[:count] if p > 0):
            if lib.proc_name(pid, name, 64) > 0:
                names[pid] = name.value
            if lib.proc_pidinfo(pid, PROC_PIDTBSDINFO, ctypes.c_uint64(0), ctypes.byref(bsd), ctypes.sizeof(bsd)) > 0:
                parent[pid] = bsd.ppid
                kids.setdefault(bsd.ppid, []).append(pid)
        total, stack = 0, [p for p, n in names.items() if n == b"prime-agent" and names.get(parent.get(p)) == b"prime-agent"]
        while stack:
            pid = stack.pop()
            if lib.proc_pid_rusage(pid, 4, ctypes.byref(usage)) == 0:
                total += usage.phys_footprint
            stack += kids.get(pid, [])
        return round(total / 2 ** 30, 2)
    except Exception:
        return None
