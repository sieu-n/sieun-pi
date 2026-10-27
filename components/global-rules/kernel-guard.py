"""The run-time half of the global-rules send guard (owner correction c37), for the Prime Python kernel.

The tool_call guard reads a cell's text, so it misses a send whose command, URL or MCP tool is built at run time.
kernel-guard.ts prepends one line to each ipython cell that runs this file once per kernel. From then on the kernel checks
each subprocess, HTTP write, SMTP connect and MCP call as it happens, with the tool_call guard's own rules in send-check.ts.
A call passes when a cell on the stack carries an approved OWNER_OK=<chat id>/<todo id>, the same token the tool_call guard reads.
"""

import contextvars
import json
import linecache
import os
import re
import subprocess
import sys
import threading
import weakref

HERE = os.path.dirname(os.path.realpath(__file__))
CHECK = os.path.join(HERE, "send-check.ts")
CHILD_DIR = os.path.join(HERE, "python-child")
SMTP_PORTS = frozenset({25, 465, 587, 2525})
LOCAL = re.compile(r"^(?:localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0)$")
SHELL_HINT = re.compile(
    r"curl|wget|https?\b|xhs?\b|mail|smtp|swaks|mutt|himalaya|\bgog\b|\bgmi\b|\bgam\b|\bgyb\b|outlook|sendgrid|resend|postmark"
    r"|zendesk|zcli|freshdesk|intercom|helpscout|\bfront\b|osascript|aside|cua-driver|\bgh\b|\bnode\b|tsx|\bbun\b|deno|npx|\.sh\b|\beval\b"
    r"|convex|stripe|vercel|\bvc\b",
    re.I,
)
# A git write, as auto-sns-agent's repo guard reads one (DANGEROUS in its scripts/repo/agent/guards/index.mjs). It goes to that
# guard only when it may touch that repo: the cwd or text names auto-sns-agent, or it pushes, which can name the repo by URL.
# rm, mv, cherry-pick, revert, am, update-ref, symbolic-ref and fetch are the shared-index rule's hazard and branch commands. On
# 2026-10-19 bash(f"cd {R} && git rm -q x") ran in the shared checkout after its full marker went on, because only this half
# sees {R} expanded and this list had no rm. apply is one too unless it has --cached: on 2026-10-20 at 05:50Z a plain git apply
# in the box's shared checkout put 15 stale files in its working tree. clone is one since auto-sns-agent d00d1cd410's git-shallow-fetch
# rule refuses a depth-limited clone into the shared checkout, which a Python subprocess argv list otherwise ran past the judge.
GIT_WRITE = re.compile(
    r"(?:^|[\s;&|`('\"/])git\s[\s\S]*\b(?:stash|reset|checkout|switch|restore|merge|rebase|pull|clean|worktree|push|add|commit|branch|filter-branch|replace"
    r"|rm|mv|cherry-pick|revert|am|update-ref|symbolic-ref|fetch|clone|apply)\b"
)
GIT_PUSH = re.compile(r"\bgit\s[\s\S]*\bpush\b")
# A lint, type check or test run, as that guard's DANGEROUS reads one. The tool_call guard leaves one in a cell to this half,
# because a cell often holds its files in an f-string or a computed list and runs it from the kernel's cwd.
LOCAL_CHECK = re.compile(
    r"\b(?:svelte-check|vitest|tsc|pytest|ruff|mypy|basedpyright|betterleaks|gitleaks|turbo|secrets-scan)\b"
    r"|\bpnpm\s+(?:check|test|verify|lint|ci:)|(?:^|[\s;&|(/])ty\s"
)
# A command that may set a resource cap (owner rule c107), which caps.ts judges: a docker or systemd cap flag or property, or a priority tool.
# It reaches the judge only when the hint matches, so a cell that builds `docker run --cpus 8` in a variable is refused as the literal one is.
CAP_HINT = re.compile(
    r"--cpu|--memory|--kernel-memory|--pids-limit|--blkio|--device-(?:read|write)|(?:docker|podman)\b[\s\S]*\s-[a-zA-Z]*[cm]"
    r"|set-property|--property|-p\s*[A-Z]\w*=|--nice|\b(?:nice|renice|ionice|cpulimit|taskset)\b"
)
MCP_HINT = re.compile(r"send|reply|forward|post|comment|message|submit|create|invite|exec|repl", re.I)
WRITE = frozenset({"POST", "PUT", "PATCH"})
OWN_PACKAGES = ("aside_browser",)
state = threading.local()
WRITING = contextvars.ContextVar("global_rules_send_guard_writing", default=False)
# The OWNER_OK token of the HTTP request a server in this process is answering, from its x-owner-ok header (wrap_asgi).
REQUEST_OK = contextvars.ContextVar("global_rules_send_guard_request_ok", default="")
OWNER_OK_HEADER = b"x-owner-ok"
# An HTTP/1 write request whose head went out before its body, by connection, until the write that completes its body.
PENDING = weakref.WeakKeyDictionary()


def load_targets() -> list:
    with open(os.path.join(HERE, "send-targets.json"), encoding="utf-8") as handle:
        rows = json.load(handle)
    return [
        (
            row["label"],
            re.compile(row["host"]) if row.get("host") else None,
            re.compile(row["path"], re.I if "i" in row.get("flags", "") else 0) if row.get("path") else None,
            re.compile(row["body"]) if row.get("body") else None,
            re.compile(row["unless_path"]) if row.get("unless_path") else None,
            row.get("test_inbox"),
        )
        for row in rows
    ]


TARGETS = load_targets()
RECIPIENT_FIELD = re.compile(r"(?<![\w$-])\\?[\"']?(?:to|cc|bcc)\\?[\"']?[^\S\n]*[:=](?!=)[^\S\n]*", re.I | re.A)
QUOTED_VALUE = re.compile(r"(\\?[\"'])(.*?)\1(?=\s*(?:[,})\]]|$))", re.S)
LIST_VALUE = re.compile(r"\[([^\]]*)\](?=\s*(?:[,})\]]|$))")
BARE_VALUE = re.compile(r"(?!\\?[\"'\[])[^\s,;})\]]+")
ADDRESS = re.compile(r"[\w.+-]+@([\w-]+(?:\.[\w-]+)+)", re.A)
NO_RECIPIENT = re.compile(r"(?:null|None|undefined)")
EDGE_QUOTE = re.compile(r"^\\?[\"']|\\?[\"']$")
NOT_LITERAL = re.compile(r"[{}$`\"'\\]")


def only_test_inboxes(body: str, domain: str) -> bool:
    """send-guard.ts onlyTestInboxes: every to, cc and bcc recipient is a literal address at `domain`, a test inbox (c113)."""
    found = 0

    def literal_at(text: str) -> bool:
        nonlocal found
        inner = EDGE_QUOTE.sub("", text.strip())
        if NOT_LITERAL.search(inner):
            return False
        domains = ADDRESS.findall(inner)
        found += len(domains)
        return bool(domains) and all(d.lower() == domain for d in domains)

    for field in RECIPIENT_FIELD.finditer(body):
        rest = body[field.end():]
        listed = LIST_VALUE.match(rest)
        quoted = None if listed else QUOTED_VALUE.match(rest)
        bare = None if listed or quoted else BARE_VALUE.match(rest)
        if listed:
            if not all(literal_at(item) for item in listed.group(1).split(",") if item.strip()):
                return False
        elif quoted:
            if not literal_at(quoted.group(2)):
                return False
        elif not bare or (not NO_RECIPIENT.fullmatch(bare.group(0)) and not literal_at(bare.group(0))):
            return False
    return found > 0


def target_rows(url: str) -> "tuple[str, list]":
    """The host and the send-targets.json rows a write to `url` may match, whatever its body."""
    m = re.match(r"^(https?|smtps?)://([^/:?#]+)(?::\d+)?([^?#]*)", url, re.I)
    if not m:
        return "", []
    scheme, host, path = m.group(1), m.group(2).lower(), m.group(3)
    if scheme.lower().startswith("smtp"):
        return host, [("SMTP server {host}", None, None)]
    if LOCAL.match(host):
        return host, []
    return host, [
        (label, body_re, test_inbox)
        for label, host_re, path_re, body_re, unless_path, test_inbox in TARGETS
        if (not host_re or host_re.search(host)) and (not path_re or path_re.search(path)) and not (unless_path and unless_path.search(path))
    ]


def send_target(url: str, body: str = "") -> "str | None":
    """send-guard.ts sendTarget over the same send-targets.json, so an HTTP check needs no Node process."""
    host, rows = target_rows(url)
    for label, body_re, test_inbox in rows:
        if (not body_re or body_re.search(body)) and not (test_inbox and only_test_inboxes(body, test_inbox)):
            return label.replace("{host}", host)
    return None


class SendRefused(Exception):
    """An outside send that the owner has not approved on a For you todo."""


def approval() -> str:
    """The source of every cell on the stack, where an OWNER_OK token would be."""
    texts, frame = [], sys._getframe(1)
    while frame is not None:
        name = frame.f_code.co_filename
        if name.startswith("<cell-"):
            texts.append("".join(linecache.getlines(name)))
        frame = frame.f_back
    if os.environ.get("OWNER_OK"):
        texts.append(f"OWNER_OK={os.environ['OWNER_OK']}")
    if REQUEST_OK.get():
        texts.append(f"OWNER_OK={REQUEST_OK.get()}")
    return "\n".join(texts)


def owned_by_skill() -> bool:
    """A call made inside a skill that holds its own page-aware send check, such as aside_browser.run()."""
    frame = sys._getframe(1)
    while frame is not None:
        if str(frame.f_globals.get("__name__", "")).startswith(OWN_PACKAGES):
            return True
        frame = frame.f_back
    return False


VOLATILE_ENV = re.compile(r"^(?:RLM_|PRIME_AGENT_INTERNAL_|PRIME_AGENT_KERNEL_)")


class Judge:
    """One `node send-check.ts --serve-socket <path>` per box for every kernel and child Python with the same rules and environment, started
    by the first check that finds none. On 10-18 at 16:48Z each kernel kept its own `--serve` judge, 88 of them at about 55 MB each (4.8 GB).
    The socket's name hashes the rule files (every .ts and .json next to send-check.ts) and the environment without the per-session
    RLM_*, PRIME_AGENT_INTERNAL_* and PRIME_AGENT_KERNEL_* keys, so a changed rule or environment gets a fresh judge. Each check carries this
    process's whole environment and cwd, which the judge takes on before it judges, so a verdict, its child processes and its send-log line
    read what a fresh `node send-check.ts` here would. The judge exits after 2 minutes with no check from any process. When it cannot be
    reached or started, the check runs one-shot."""

    TIMEOUT = 30
    START_WAIT = 10

    def __init__(self):
        self.started = []

    @staticmethod
    def sources() -> tuple:
        """The rule files a fresh run would load: every .ts and .json file next to send-check.ts."""
        return tuple(sorted(
            (entry.name, entry.stat().st_mtime_ns, entry.stat().st_size)
            for entry in os.scandir(HERE)
            if entry.name.endswith((".ts", ".json"))
        ))

    @staticmethod
    def stable(env: dict) -> dict:
        return {key: value for key, value in env.items() if not VOLATILE_ENV.match(key)}

    def socket_path(self, env: dict) -> str:
        import hashlib
        import tempfile

        digest = hashlib.sha256(json.dumps([CHECK, self.sources(), sorted(self.stable(env).items())]).encode()).hexdigest()[:20]
        return os.path.join(tempfile.gettempdir(), f"global-rules-{os.getuid()}", f"judge-{digest}.sock")

    def forget_after_fork(self) -> None:
        """A forked child does not reap the parent's judges; they are not its children."""
        self.started = []

    def ask(self, check: dict) -> dict:
        """The verdict, or {} when the check could not run. Raises OSError, SubprocessError or ValueError like a one-shot run."""
        self.started = [proc for proc in self.started if proc.poll() is None]
        env = dict(os.environ)
        try:
            cwd = os.getcwd()
        except OSError:
            cwd = None
        path = self.socket_path(env)
        line = json.dumps({"id": 1, "cwd": cwd, "env": env, "check": check}).encode() + b"\n"
        try:
            return self.over(path, line)
        except (FileNotFoundError, ConnectionRefusedError):
            pass
        if self.start(path, env):
            try:
                return self.over(path, line)
            except (FileNotFoundError, ConnectionRefusedError):
                pass
        return one_shot(check)

    def start(self, path: str, env: dict) -> bool:
        """Starts a judge on `path` and waits until it answers; false when it exits or does not answer within START_WAIT seconds."""
        import socket
        import time

        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        proc = subprocess.Popen(
            ["node", CHECK, "--serve-socket", path], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True, env=self.stable({**env, **check_env()}),
        )
        self.started.append(proc)
        deadline = time.monotonic() + self.START_WAIT
        while time.monotonic() < deadline:
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                probe.connect(path)
                return True
            except OSError:
                if proc.poll() is not None:
                    # It also exits at once when another judge took the path first, and that one answers.
                    return os.path.exists(path)
            finally:
                probe.close()
            time.sleep(0.02)
        return False

    def over(self, path: str, line: bytes) -> dict:
        import select
        import socket
        import time

        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.connect(path)
            fd, sent = sock.fileno(), 0
            # os.write, not sock.sendall, which this guard wraps to read HTTP writes.
            while sent < len(line):
                sent += os.write(fd, line[sent:])
            deadline, buffer = time.monotonic() + self.TIMEOUT, b""
            while b"\n" not in buffer:
                left = deadline - time.monotonic()
                if left <= 0 or not select.select([fd], [], [], left)[0]:
                    raise subprocess.TimeoutExpired(CHECK, self.TIMEOUT)
                chunk = os.read(fd, 65536)
                if not chunk:
                    raise OSError("send-check.ts --serve-socket closed the connection")
                buffer += chunk
            reply = json.loads(buffer.split(b"\n", 1)[0])
            return {} if not isinstance(reply, dict) or "error" in reply else reply
        finally:
            sock.close()


def check_env() -> dict:
    """send-check.ts keeps its compiled TypeScript in Node's compile cache: 0.13 CPU s and 96 MB of fresh pages a run without it, 0.04 CPU s
    and 59 MB with it (10-18, about 130 runs a minute). Only the check gets the cache. Set for every Node child of a kernel, it took one entry per
    script path, and the per-commit export, release and job trees gave each run new paths: 1.2 GB on us-metal02 by 16:45Z on 10-18, 19 MB a
    minute after it was emptied."""
    return {**os.environ, "NODE_COMPILE_CACHE": os.path.join(os.path.expanduser("~"), ".cache", "node-compile-cache")}


def one_shot(check: dict) -> dict:
    proc = subprocess.run(["node", CHECK], input=json.dumps(check), capture_output=True, text=True, timeout=30, env=check_env())
    return json.loads(proc.stdout.strip().splitlines()[-1])


JUDGE = Judge()
if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=lambda: JUDGE.forget_after_fork())


def judge(check: dict) -> None:
    """Raises SendRefused when send-check.ts refuses the call. A failure to run the check lets the call through, like the tool_call guard."""
    if getattr(state, "busy", False):
        return
    state.busy = True
    try:
        check["approval"] = approval()
        verdict = JUDGE.ask(check)
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return
    finally:
        state.busy = False
    if verdict.get("block"):
        raise SendRefused(verdict["reason"])


def shell_text(args) -> str:
    if isinstance(args, (str, bytes, os.PathLike)):
        return os.fsdecode(args)
    argv = [os.fsdecode(a) for a in args]
    if len(argv) >= 3 and os.path.basename(argv[0]) in {"sh", "bash", "zsh", "dash"} and argv[1] == "-c":
        return argv[2]
    return " ".join(argv)


def touches_repo(text: str, cwd: str) -> bool:
    """A git write or local check that auto-sns-agent's repo guard should judge with the kernel's real cwd, which an os.chdir hides from the tool_call guard."""
    if not (GIT_WRITE.search(text) or LOCAL_CHECK.search(text)):
        return False
    return "auto-sns-agent" in text or "auto-sns-agent" in os.path.realpath(cwd) or bool(GIT_PUSH.search(text))


GIT_PROGRAM = re.compile(r"(?:[\w.+-]*/)*git")
PLAIN_ARG = re.compile(r"[^\n\r\\'\"`$();&|<>]*")


def plain_git(executable, args) -> bool:
    """An argv list that runs git with no shell syntax in any word. send-check.ts lexes its joined text as one command named git,
    and no send rule judges git (send-guard.ts judgeArgv, cua-guard.ts judgeCuaShell), so its verdict is always a pass. The hint
    still matched such a call on a path: a sampler's `git ls-files` on files named *.sh started 4 node runs a second on 10-18."""
    if isinstance(args, (str, bytes, os.PathLike)) or not args:
        return False
    argv = [os.fsdecode(a) for a in args]
    program = os.fsdecode(executable) if executable is not None else argv[0]
    return (
        bool(GIT_PROGRAM.fullmatch(argv[0]))
        and os.path.basename(program) == "git"
        and all(PLAIN_ARG.fullmatch(a) for a in argv)
    )


def on_shell(args, cwd, env, executable=None) -> None:
    text = shell_text(args)
    where = os.fsdecode(cwd) if cwd else os.getcwd()
    repo = touches_repo(text, where)
    if not (repo or CAP_HINT.search(text) or (SHELL_HINT.search(text) and not plain_git(executable, args))) or owned_by_skill():
        return
    names = env if isinstance(env, dict) else os.environ
    expanded = re.sub(r"\$\{?([A-Za-z_]\w*)\}?", lambda m: os.fsdecode(names.get(m.group(1), m.group(0))), text)
    judge({"kind": "shell", "text": expanded, "cwd": where, "repo": repo})


def on_http_bytes(conn, data) -> None:
    """A socket or TLS write that starts an HTTP/1 request: its request line, Host header and body. When the body comes in later writes, as
    urllib3 and so requests and the Resend SDK send it, the request is judged at the write that completes its Content-Length."""
    if not isinstance(data, (bytes, bytearray, memoryview)):
        return
    pending = PENDING.get(conn)
    if pending is not None:
        method, target, body, length = pending
        if body is None:
            raise SendRefused(target)
        body += bytes(data)
        if len(body) < length:
            PENDING[conn] = (method, target, body, length)
            return
        del PENDING[conn]
        try:
            on_http(method, target, body.decode("utf-8", "replace"))
        except SendRefused as refused:
            # The server holds a request without its last bytes; nothing more goes out on this connection.
            PENDING[conn] = (method, str(refused), None, length)
            raise
        return
    if bytes(data[:4]) not in (b"POST", b"PUT ", b"PATC", b"DELE"):
        return
    head = bytes(data[:8192])
    m = re.match(rb"(POST|PUT|PATCH|DELETE) (\S+) HTTP/", head)
    if not m:
        return
    target = m.group(2).decode("latin-1")
    if not target.startswith("http"):
        host = re.search(rb"\r\nHost: *([^\r\n]+)", head, re.I)
        if not host:
            return
        target = f"https://{host.group(1).decode('latin-1').strip()}{target}"
    method = m.group(1).decode()
    whole = bytes(data)
    headers, _, body = whole.partition(b"\r\n\r\n")
    length = re.search(rb"\r\nContent-Length: *(\d+)", headers, re.I)
    if length and len(body) < int(length.group(1)) and method in WRITE and any(body_re or test_inbox for _, body_re, test_inbox in target_rows(target)[1]):
        PENDING[conn] = (method, target, body, int(length.group(1)))
        return
    on_http(method, target, body.decode("utf-8", "replace"))


def on_http(method: str, url: str, body: str = "") -> None:
    if method.upper() in WRITE and send_target(url, body) and not owned_by_skill():
        judge({"kind": "http", "method": method.upper(), "url": url, "body": body})


def on_connect(address) -> None:
    if isinstance(address, tuple) and len(address) >= 2 and address[1] in SMTP_PORTS and not LOCAL.match(str(address[0])):
        judge({"kind": "http", "method": "POST", "url": f"smtp://{address[0]}:{address[1]}"})


def hook(event: str, args: tuple) -> None:
    if event == "subprocess.Popen":
        on_shell(args[1], args[2], args[3], args[0])
    elif event == "os.system":
        on_shell(args[0], None, None)
    elif event == "socket.connect":
        on_connect(args[1])


def request_body(request) -> str:
    try:
        content = request.content
    except Exception:
        return ""
    return content.decode("utf-8", "replace") if isinstance(content, bytes) else ""


def guarded_send(original, is_async: bool):
    """A transport's handle_request, the point where an httpx request leaves the process. A client on a mock transport, such as a
    mock-mode Vent's ModeTransport answering from its fakes, sends nothing out and is not judged."""
    if is_async:
        async def send(self, request, *args, **kwargs):
            on_http(request.method, str(request.url), request_body(request))
            token = WRITING.set(True)
            try:
                return await original(self, request, *args, **kwargs)
            finally:
                WRITING.reset(token)
    else:
        def send(self, request, *args, **kwargs):
            on_http(request.method, str(request.url), request_body(request))
            token = WRITING.set(True)
            try:
                return original(self, request, *args, **kwargs)
            finally:
                WRITING.reset(token)
    send.send_guarded = True
    return send


def guarded_write(original):
    def write(self, data, *args, **kwargs):
        if WRITING.get():
            return original(self, data, *args, **kwargs)
        token = WRITING.set(True)
        try:
            on_http_bytes(self, data)
            return original(self, data, *args, **kwargs)
        finally:
            WRITING.reset(token)

    write.send_guarded = True
    return write


def wrap_sockets() -> None:
    """Every HTTP/1 write in plain text: http.client and raw sockets through socket and ssl.SSLSocket, and asyncio TLS
    (aiohttp, httpx's AsyncClient) through ssl.SSLObject.write, which gets the request before it is encrypted."""
    import socket
    import ssl

    for cls, names in ((socket.socket, ("send", "sendall")), (ssl.SSLSocket, ("send", "sendall", "write")), (ssl.SSLObject, ("write",))):
        for name in names:
            original = getattr(cls, name)
            if not getattr(original, "send_guarded", False):
                setattr(cls, name, guarded_write(original))


def wrap_http(module) -> None:
    """httpx and httpx2 open raw sockets, so the audit events miss their method and URL; check each request where the network transport
    takes it."""
    for cls_name, method, is_async in (("HTTPTransport", "handle_request", False), ("AsyncHTTPTransport", "handle_async_request", True)):
        cls = getattr(module, cls_name, None)
        original = getattr(cls, method, None)
        if original is not None and not getattr(original, "send_guarded", False):
            setattr(cls, method, guarded_send(original, is_async))


def wrap_asgi(module) -> None:
    """A Starlette or FastAPI server in this process, such as a Vent started from a kernel, judges the sends it makes for a request with
    that request's x-owner-ok header as the approval, so an approved caller's send passes and any other send stays refused."""
    cls = getattr(module, "Starlette", None)
    original = getattr(cls, "__call__", None)
    if original is None or getattr(original, "send_guarded", False):
        return

    async def call(self, scope, receive, send):
        token = dict(scope.get("headers") or ()).get(OWNER_OK_HEADER, b"") if scope.get("type") == "http" else b""
        if not token:
            return await original(self, scope, receive, send)
        reset = REQUEST_OK.set(token.decode("latin-1").strip())
        try:
            return await original(self, scope, receive, send)
        finally:
            REQUEST_OK.reset(reset)

    call.send_guarded = True
    cls.__call__ = call


IMPORT_WRAPS = {"httpx": wrap_http, "httpx2": wrap_http, "starlette.applications": wrap_asgi}


def wrap_mcp() -> None:
    """Checks rlm.mcp.call_tool, and a raw host_request that calls a tool, with the tool_call guard's MCP rules."""
    try:
        import rlm.mcp as mcp
    except ImportError:
        return

    def check(server, tool, arguments) -> None:
        if (server == "aside" or MCP_HINT.search(str(tool))) and not owned_by_skill():
            judge({"kind": "mcp", "server": str(server), "tool": str(tool), "args": json.dumps(arguments or {}, default=str)})

    call_tool = mcp.call_tool
    if not getattr(call_tool, "send_guarded", False):

        async def guarded_call_tool(server, tool, arguments=None):
            check(server, tool, arguments)
            return await call_tool(server, tool, arguments)

        guarded_call_tool.send_guarded = True
        guarded_call_tool.__doc__ = call_tool.__doc__
        mcp.call_tool = guarded_call_tool

    host_request = getattr(mcp, "host_request", None)
    if host_request is not None and not getattr(host_request, "send_guarded", False):

        async def guarded_host_request(request_type, params=None, *args, **kwargs):
            if "call" in str(request_type) and isinstance(params, dict):
                server = params.get("connectionId") or params.get("server") or ""
                check(server, params.get("name") or params.get("tool") or "", params.get("arguments"))
            return await host_request(request_type, params, *args, **kwargs)

        guarded_host_request.send_guarded = True
        mcp.host_request = guarded_host_request


def guard_children() -> None:
    """Python processes this one starts load python-child/sitecustomize.py, which installs this guard in them too."""
    paths = [p for p in os.environ.get("PYTHONPATH", "").split(os.pathsep) if p]
    if CHILD_DIR not in paths:
        os.environ["PYTHONPATH"] = os.pathsep.join([CHILD_DIR, *paths])


class WrapOnImport:
    """Wraps httpx, httpx2 and Starlette when a process imports them. Importing httpx up front cost each child Python 0.15 CPU s (183 of its 186 ms of
    startup, measured with -X importtime on 10-18), and most children never use it."""

    def find_spec(self, name, path=None, target=None):
        if name not in IMPORT_WRAPS:
            return None
        for finder in sys.meta_path:
            if finder is self or not hasattr(finder, "find_spec"):
                continue
            spec = finder.find_spec(name, path, target)
            if spec is not None:
                if spec.loader is not None and hasattr(spec.loader, "exec_module"):
                    spec.loader = WrappingLoader(spec.loader)
                return spec
        return None


class WrappingLoader:
    def __init__(self, inner):
        self.inner = inner

    def __getattr__(self, name):
        return getattr(self.inner, name)

    def create_module(self, spec):
        return self.inner.create_module(spec)

    def exec_module(self, module):
        self.inner.exec_module(module)
        IMPORT_WRAPS[module.__name__](module)


def wrap_http_modules() -> None:
    for name, wrap in IMPORT_WRAPS.items():
        if name in sys.modules:
            wrap(sys.modules[name])
    if not any(isinstance(finder, WrapOnImport) for finder in sys.meta_path):
        sys.meta_path.insert(0, WrapOnImport())


def guard_prime_shutdown() -> None:
    """prime-shutdown.py refuses a `prime-agent shutdown` that could stop the live daemon (10-27 16:55Z and 17:07Z on us-metal02)."""
    path = os.path.join(HERE, "prime-shutdown.py")
    try:
        with open(path, encoding="utf-8") as handle:
            exec(compile(handle.read(), path, "exec"), {"__name__": "global_rules_prime_shutdown", "__file__": path})
    except Exception as error:
        print(f"global-rules: the prime-agent shutdown guard did not load: {error}", file=sys.stderr)


def install() -> None:
    guard_prime_shutdown()
    guard_children()
    wrap_mcp()
    wrap_http_modules()
    wrap_sockets()
    sys.addaudithook(hook)


if not getattr(sys, "global_rules_send_guard", False):
    install()
    sys.global_rules_send_guard = True
