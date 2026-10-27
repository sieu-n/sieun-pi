"""pi-pool hookd: one resident Python that answers the token hook and the chat's pool commands, so a
request starts no interpreter. On us-metal02 on 10-18 Prime ran the hook 16 times a second at 0.2 CPU s
each, 0.11 s of it Python start-up, and the chat ran the CLI 3 times a second.

hookd loads vend.py and the pool package once, starts no threads, and listens on <pool dir>/hook.sock
(mode 0600). It forks one child per connection. The child takes the client's argv, environment, cwd and
parent pid, and runs the same code the Python path runs: bin/pi-pool-token's main() for the hook,
vend.main() with --cli for bin/pi-pool. Every decision the pool makes is the same code; only the
interpreter start and the module loads are gone.

Request: b"PPH1\0", then NUL-terminated fields:
    mode ("fd" or "pipe"), ppid (decimal), cwd, script (the absolute path of bin/pi-pool-token or
    bin/pi-pool the client would run on the Python path), argc (decimal), each argument after the
    script, envc (decimal), each "KEY=VALUE".
    In fd mode the client's fds 0, 1 and 2 ride on the sendmsg of the first bytes (SCM_RIGHTS).
Answer, one line:
    "F\n"          fall back: run the Python path yourself; hookd ran nothing.
    "X <code>\n"   fd mode: the run ended with this exit code; its output went to the client's fds.
    "J <json>\n"   pipe mode: {"code": n, "out": "...", "err": "..."}, the shape of /run on pi-pool serve.
A client that closes the socket before the answer, or sends "T", gets its run a SIGTERM, which the
hook logs as it logs Prime's timeout kill today.

hookd answers F when the script is not in the release it loaded, when the client's environment gives
another value to anything the pool or Python reads at start-up (HOME, USER, PI_POOL_DIR,
PI_POOL_SECRETS, any PYTHON* variable but the global-rules folder on PYTHONPATH, a locale that is not UTF-8), or when --release names a link
that no longer resolves to the loaded release; then it exits so systemd starts it on the new code.
"""
import array, atexit, fcntl, gc, importlib.machinery, importlib.util, io, json, os, pwd, signal, socket, sys, threading, time, traceback

from . import base

MAGIC = b"PPH1\0"
SOCKET = "hook.sock"
TOKEN_SCRIPTS = ("pi-pool-token", "pi-pool-token.py")
CLI_SCRIPT = "pi-pool"
# A client that connects and sends nothing holds only its own child; the read gives up after this.
REQUEST_READ_SEC = 30
FD_SPACE = socket.CMSG_SPACE(3 * array.array("i").itemsize)
# Loaded once here, so a child pays for none of them: the pool imports these inside functions.
PRELOAD = ("ctypes", "hmac", "http.client", "http.server", "ssl", "subprocess", "urllib.error", "urllib.parse",
           "urllib.request", "concurrent.futures", "runpy")
# The guard's python-child folder: packages/sieun-rules/src since 10-28, and components/global-rules in a kernel started before that move.
GUARD_DIRS = (os.path.join("packages", "sieun-rules", "src", "python-child"), os.path.join("components", "global-rules", "python-child"))


def socket_path():
    return os.path.join(base.POOL, SOCKET)


def start_env(env):
    """What base.py and Python's start-up read from an environment, as base.py computes it."""
    home = env["HOME"] if "HOME" in env else pwd.getpwuid(os.getuid()).pw_dir
    home = home.rstrip("/") or "/"
    return {"HOME": home, "USER": env.get("USER") or pwd.getpwuid(os.getuid()).pw_name,
            "PI_POOL_DIR": env.get("PI_POOL_DIR") or os.path.join(home, ".config", "pi-pool"),
            "PI_POOL_SECRETS": env.get("PI_POOL_SECRETS") == "file" or not os.path.exists("/usr/bin/security"),
            "PYTHON": sorted((k, python_path(v) if k == "PYTHONPATH" else v) for k, v in env.items()
                             if k.startswith("PYTHON") and not (k == "PYTHONPATH" and not python_path(v)))}


def python_path(value):
    """PYTHONPATH without the global-rules python-child folder. kernel-guard.py puts it on the PYTHONPATH of the
    Prime workers it guards, and its sitecustomize loads the c37 send guard, which the hook needs none of: it sends
    only OAuth refreshes and count_tokens probes. On us-metal02 at 12:40Z on 10-18, 15 of 40 prime-agent processes
    carried it, and their 248 hook calls in 120 s fell back to the Python hook."""
    return ":".join(entry for entry in value.split(":")
                    if not os.path.normpath(entry).endswith(GUARD_DIRS))


def utf8_locale(env):
    """Python's stdio encoding is UTF-8 for a UTF-8 locale and for C or POSIX, which it coerces."""
    name = env.get("LC_ALL") or env.get("LC_CTYPE") or env.get("LANG") or "C"
    return name in ("C", "POSIX") or "utf8" in name.lower().replace("-", "")


class Request:
    def __init__(self, mode, ppid, cwd, script, argv, env, fds):
        self.mode, self.ppid, self.cwd, self.script, self.argv, self.env, self.fds = mode, ppid, cwd, script, argv, env, fds


def read_request(conn):
    """The request on `conn`, or None when it is not a whole, well-formed one. Raises EOFError on a client that left."""
    buf, fds, at = bytearray(), [], 0

    def more():
        data, ancillary, _, _ = conn.recvmsg(65536, FD_SPACE)
        for level, kind, payload in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                got = array.array("i")
                got.frombytes(payload[:len(payload) - len(payload) % got.itemsize])
                fds.extend(got)
        if not data:
            raise EOFError
        buf.extend(data)

    def field():
        nonlocal at
        while (end := buf.find(b"\0", at)) < 0:
            more()
        value, at = os.fsdecode(bytes(buf[at:end])), end + 1
        return value

    while len(buf) < len(MAGIC):
        more()
    if bytes(buf[:len(MAGIC)]) != MAGIC:
        return None
    at = len(MAGIC)
    try:
        mode, ppid, cwd, script = field(), int(field()), field(), field()
        argv = [field() for _ in range(int(field()))]
        env = dict(item.split("=", 1) for item in (field() for _ in range(int(field()))) if "=" in item)
    except ValueError:
        return None
    return Request(mode, ppid, cwd, script, argv, env, fds)


def runner(req, root, vend, hook):
    """The function that runs the request as its Python path would, or None to answer F."""
    script = os.path.realpath(req.script)
    if req.mode not in ("fd", "pipe") or (req.mode == "fd") != (len(req.fds) == 3):
        return None
    if os.path.dirname(script) != os.path.join(root, "bin") or not os.path.isabs(req.script):
        return None
    if start_env(req.env) != start_env(os.environ) or not utf8_locale(req.env) or not os.path.isabs(req.cwd):
        return None
    name = os.path.basename(script)
    if name in TOKEN_SCRIPTS:
        def run_hook():
            sys.argv = [req.script, *req.argv]
            sys.exit(hook.main(vend) or 0)
        return run_hook
    if name == CLI_SCRIPT:
        def run_cli():
            sys.argv = [vend.__file__, "--cli", *req.argv]
            sys.exit(vend.main() or 0)
        return run_cli
    return None


def text_stream(fd, write):
    raw = io.FileIO(fd, "wb" if write else "rb", closefd=False)
    if not write:
        return io.TextIOWrapper(io.BufferedReader(raw), encoding="utf-8", errors="strict")
    tty = raw.isatty()
    return io.TextIOWrapper(io.BufferedWriter(raw), encoding="utf-8", errors="backslashreplace" if fd == 2 else "strict",
                            line_buffering=tty or fd == 2)


def catch_file(name):
    if hasattr(os, "memfd_create"):
        return os.memfd_create(name)
    import tempfile
    fd, path = tempfile.mkstemp(prefix=name + "-")
    os.unlink(path)
    return fd


def take_stdio(req):
    """Point fds 0, 1 and 2 where the client's run writes, and give sys fresh streams on them as a new Python
    would have. Pipe mode returns the two files that catch stdout and stderr."""
    caught = None
    if req.mode == "fd":
        sources = req.fds
    else:
        caught = [catch_file("pi-pool-out"), catch_file("pi-pool-err")]
        sources = [os.open(os.devnull, os.O_RDONLY), *caught]
    for target, fd in enumerate(sources):
        os.dup2(fd, target)
    for fd in sources:
        if fd > 2 and (caught is None or fd not in caught):
            os.close(fd)
    sys.stdin, sys.stdout, sys.stderr = text_stream(0, False), text_stream(1, True), text_stream(2, True)
    return caught


def watch_client(conn):
    """SIGTERM this run when the client sends T or goes away, the way Prime's timeout reaches the hook today."""
    def on_io(signum, frame):
        try:
            seen = conn.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT)
        except (BlockingIOError, InterruptedError):
            return
        except OSError:
            seen = b""
        if seen in (b"", b"T"):
            signal.signal(signal.SIGIO, signal.SIG_IGN)
            os.kill(os.getpid(), signal.SIGTERM)

    signal.signal(signal.SIGIO, on_io)
    fcntl.fcntl(conn, fcntl.F_SETOWN, os.getpid())
    fcntl.fcntl(conn, fcntl.F_SETFL, fcntl.fcntl(conn, fcntl.F_GETFL) | os.O_ASYNC)
    on_io(signal.SIGIO, None)


def exit_code(run):
    """The exit status Python gives `run` as a script: SystemExit's code, its text on stderr, or a traceback."""
    try:
        run()
        code = 0
    except SystemExit as e:
        if e.code is None:
            code = 0
        elif isinstance(e.code, int):
            code = e.code & 0xFF
        else:
            try:
                sys.stderr.write(f"{e.code}\n")
            except Exception:
                pass
            code = 1
    except BaseException:
        try:
            traceback.print_exc()
        except Exception:
            pass
        code = 1
    signal.signal(signal.SIGIO, signal.SIG_IGN)
    for finish in (getattr(threading, "_shutdown", None), atexit._run_exitfuncs):
        try:
            if finish:
                finish()
        except BaseException:
            pass
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:
            code = 120 if code == 0 else code
    return code


def serve_one(conn, root, vend, hook):
    """The forked child: read one request, run it, answer. Returns nothing; the caller exits."""
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    conn.settimeout(REQUEST_READ_SEC)
    try:
        req = read_request(conn)
    except (EOFError, OSError):
        return
    run = runner(req, root, vend, hook) if req else None
    if run:
        try:
            os.chdir(req.cwd)
        except OSError:
            run = None
    if run is None:
        for fd in (req.fds if req else ()):
            os.close(fd)
        conn.sendall(b"F\n")
        return
    conn.settimeout(None)
    os.environ.clear()
    os.environ.update(req.env)
    time.tzset()
    os.getppid = lambda: req.ppid
    caught = take_stdio(req)
    watch_client(conn)
    code = exit_code(run)
    if caught is None:
        answer = f"X {code}\n".encode()
    else:
        out, err = (os.pread(fd, os.fstat(fd).st_size, 0).decode("utf-8", "replace") for fd in caught)
        answer = b"J " + json.dumps({"code": code, "out": out, "err": err}).encode() + b"\n"
    try:
        conn.sendall(answer)
    except OSError:
        pass


def load_file(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_file_location(name, path, loader=loader)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    loader.exec_module(module)
    return module


def cmd_hookd(rest=()):
    release = rest[rest.index("--release") + 1] if "--release" in rest else None
    root = base.CODE_ROOT
    vend = load_file("pi_pool_hookd_vend", os.path.join(root, "vend.py"))
    hook_path = os.path.join(root, "bin", "pi-pool-token.py")
    hook = load_file("pi_pool_hookd_token", hook_path if os.path.exists(hook_path) else os.path.join(root, "bin", "pi-pool-token"))
    for name in vend.pool.LAZY:
        getattr(vend.pool, name)
    for name in PRELOAD:
        importlib.import_module(name)
    path = socket_path()
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    mask = os.umask(0o177)
    try:
        listener.bind(path)
    finally:
        os.umask(mask)
    os.chmod(path, 0o600)
    listener.listen(256)
    signal.signal(signal.SIGCHLD, signal.SIG_IGN)
    base.log("hookd_start", root=root, pid=os.getpid(), socket=path)
    sys.stdout.flush()
    sys.stderr.flush()
    gc.freeze()
    while True:
        conn, _ = listener.accept()
        if release and os.path.realpath(release) != root:
            try:
                conn.sendall(b"F\n")
            except OSError:
                pass
            conn.close()
            base.log("hookd_moved", root=root, now=os.path.realpath(release))
            return 0
        if os.fork() == 0:
            try:
                listener.close()
                serve_one(conn, root, vend, hook)
            finally:
                os._exit(0)
        conn.close()
