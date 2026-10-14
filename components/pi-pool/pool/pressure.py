"""Memory pressure on this Mac, read for the turn queue's governor (turns.py).

One reading is three kernel values, read in-process with sysctlbyname and
host_statistics64, so a read forks nothing: kern.memorystatus_vm_pressure_level,
vm.swapusage, and the pages the compressor occupies (vm_stat's "Pages occupied by
compressor"). On 10-14 18:2x KST at load 54 a read took 0.009 ms after a 3 ms
`import ctypes`, where `sysctl -n` took 126 ms, `vm_stat` 69 ms and
`memory_pressure -Q` 171 ms (sessions/2026/10/14/1815-mac-stays-usable/pressure-governor/read_cost.py).
"""
import struct

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
# host_statistics64 flavor HOST_VM_INFO64 (mach/host_info.h).
HOST_VM_INFO64 = 4


def level(reading):
    """ok, high or critical for one reading; a reading of None (no probe) is ok,
    because a broken probe must not hold the Mac's agents."""
    if reading is None:
        return "ok"
    if reading["kernel"] >= KERNEL_CRITICAL or reading["compressor"] >= COMPRESSOR_CRITICAL_SHARE * reading["ram"]:
        return "critical"
    if reading["kernel"] >= KERNEL_WARN:
        return "high"
    return "ok"


def read():
    """{kernel, swap_used, swap_total, compressor, ram} in bytes but kernel, or None
    when a kernel call fails (another OS, a changed struct)."""
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
