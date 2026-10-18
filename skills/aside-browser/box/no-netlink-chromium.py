#!/usr/bin/env python3
# Chromium aborts every in-flight request with ERR_NETWORK_CHANGED when any host interface changes address, and this
# box's CI VMs add and drop cig-N tap interfaces all day, so a Vite page with hundreds of modules never loads. This
# wrapper makes socket(AF_NETLINK, *, NETLINK_ROUTE) fail with EACCES, so Chromium cannot watch addresses and treats
# the network as fixed, then execs the real Chromium named by BOX_CHROMIUM.
import ctypes, os, struct, sys

AF_NETLINK, NETLINK_ROUTE, SYS_socket, EACCES = 16, 0, 41, 13
AUDIT_ARCH_X86_64 = 0xC000003E
RET_ALLOW, RET_ERRNO = 0x7FFF0000, 0x00050000
LD_W_ABS, JEQ_K, RET_K = 0x20, 0x15, 0x06


def op(code, jt, jf, k):
    return struct.pack("HBBI", code, jt, jf, k)


prog = b"".join([
    op(LD_W_ABS, 0, 0, 4), op(JEQ_K, 0, 7, AUDIT_ARCH_X86_64),
    op(LD_W_ABS, 0, 0, 0), op(JEQ_K, 0, 5, SYS_socket),
    op(LD_W_ABS, 0, 0, 16), op(JEQ_K, 0, 3, AF_NETLINK),
    op(LD_W_ABS, 0, 0, 32), op(JEQ_K, 0, 1, NETLINK_ROUTE),
    op(RET_K, 0, 0, RET_ERRNO | EACCES),
    op(RET_K, 0, 0, RET_ALLOW),
])
buf = ctypes.create_string_buffer(prog)
fprog = struct.pack("HxxxxxxQ", len(prog) // 8, ctypes.addressof(buf))
libc = ctypes.CDLL(None, use_errno=True)
PR_SET_NO_NEW_PRIVS, PR_SET_SECCOMP, SECCOMP_MODE_FILTER = 38, 22, 2
if libc.prctl(PR_SET_NO_NEW_PRIVS, ctypes.c_ulong(1), ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0)) != 0:
    sys.exit(f"prctl no_new_privs: {os.strerror(ctypes.get_errno())}")
fbuf = ctypes.create_string_buffer(fprog)
if libc.prctl(PR_SET_SECCOMP, ctypes.c_ulong(SECCOMP_MODE_FILTER), ctypes.c_void_p(ctypes.addressof(fbuf)), ctypes.c_ulong(0), ctypes.c_ulong(0)) != 0:
    sys.exit(f"prctl seccomp: {os.strerror(ctypes.get_errno())}")
real = os.environ["BOX_CHROMIUM"]
os.execv(real, [real, *sys.argv[1:]])
