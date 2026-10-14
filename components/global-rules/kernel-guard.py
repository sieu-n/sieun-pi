"""The run-time half of the global-rules send guard (owner correction c37) and CI run guard, for the Prime Python kernel.

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
MCP_HINT = re.compile(r"send|reply|forward|post|comment|message|submit|create|invite|exec|repl", re.I)
WRITE = frozenset({"POST", "PUT", "PATCH"})
GITHUB_REPO = r"^https?://(?:api\.github\.com|[^/?#]+/api/v3)/repos/[^/?#]+/[^/?#]+/"
CI_RUN_POST = re.compile(GITHUB_REPO + r"(?:actions/runs/\d+/(?:cancel|force-cancel|rerun|rerun-failed-jobs)|actions/jobs/\d+/rerun|check-(?:runs|suites)/\d+/rerequest)/?(?:[?#]|$)", re.I)
CI_RUN_DELETE = re.compile(GITHUB_REPO + r"actions/runs/\d+/?(?:[?#]|$)", re.I)
OWN_PACKAGES = ("aside_browser",)
state = threading.local()
WRITING = contextvars.ContextVar("global_rules_send_guard_writing", default=False)


def load_targets() -> list:
    with open(os.path.join(HERE, "send-targets.json"), encoding="utf-8") as handle:
        rows = json.load(handle)
    return [
        (
            row["label"],
            re.compile(row["host"]) if row.get("host") else None,
            re.compile(row["path"], re.I if "i" in row.get("flags", "") else 0) if row.get("path") else None,
            re.compile(row["body"]) if row.get("body") else None,
        )
        for row in rows
    ]


TARGETS = load_targets()


def send_target(url: str, body: str = "") -> "str | None":
    """send-guard.ts sendTarget over the same send-targets.json, so an HTTP check needs no Node process."""
    m = re.match(r"^(https?|smtps?)://([^/:?#]+)(?::\d+)?([^?#]*)", url, re.I)
    if not m:
        return None
    scheme, host, path = m.group(1), m.group(2).lower(), m.group(3)
    if scheme.lower().startswith("smtp"):
        return f"SMTP server {host}"
    if LOCAL.match(host):
        return None
    for label, host_re, path_re, body_re in TARGETS:
        if (not host_re or host_re.search(host)) and (not path_re or path_re.search(path)) and (not body_re or body_re.search(body)):
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
    return "\n".join(texts)


def owned_by_skill() -> bool:
    """A call made inside a skill that holds its own page-aware send check, such as aside_browser.run()."""
    frame = sys._getframe(1)
    while frame is not None:
        if str(frame.f_globals.get("__name__", "")).startswith(OWN_PACKAGES):
            return True
        frame = frame.f_back
    return False


def judge(check: dict) -> None:
    """Raises SendRefused when send-check.ts refuses the call. A failure to run the check lets the call through, like the tool_call guard."""
    if getattr(state, "busy", False):
        return
    state.busy = True
    try:
        check["approval"] = approval()
        proc = subprocess.run(["node", CHECK], input=json.dumps(check), capture_output=True, text=True, timeout=30)
        verdict = json.loads(proc.stdout.strip().splitlines()[-1])
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


def on_shell(args, cwd, env) -> None:
    text = shell_text(args)
    if not SHELL_HINT.search(text) or owned_by_skill():
        return
    names = env if isinstance(env, dict) else os.environ
    expanded = re.sub(r"\$\{?([A-Za-z_]\w*)\}?", lambda m: os.fsdecode(names.get(m.group(1), m.group(0))), text)
    judge({"kind": "shell", "text": expanded, "cwd": os.fsdecode(cwd) if cwd else os.getcwd()})


def on_http_bytes(data) -> None:
    """A socket or TLS write that starts an HTTP/1 request: its request line and Host header."""
    if not isinstance(data, (bytes, bytearray, memoryview)) or bytes(data[:4]) not in (b"POST", b"PUT ", b"PATC", b"DELE"):
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
    body = head.split(b"\r\n\r\n", 1)[1].decode("utf-8", "replace") if b"\r\n\r\n" in head else ""
    on_http(m.group(1).decode(), target, body)


def ci_run_write(method: str, url: str) -> bool:
    """A cancel, rerun or delete of a GitHub Actions run, which send-check.ts refuses outside the CI run keepers' sessions."""
    verb = method.upper()
    return bool((verb == "POST" and CI_RUN_POST.match(url)) or (verb == "DELETE" and CI_RUN_DELETE.match(url)))


def on_http(method: str, url: str, body: str = "") -> None:
    if ((method.upper() in WRITE and send_target(url, body)) or ci_run_write(method, url)) and not owned_by_skill():
        judge({"kind": "http", "method": method.upper(), "url": url, "body": body[:4000]})


def on_connect(address) -> None:
    if isinstance(address, tuple) and len(address) >= 2 and address[1] in SMTP_PORTS and not LOCAL.match(str(address[0])):
        judge({"kind": "http", "method": "POST", "url": f"smtp://{address[0]}:{address[1]}"})


def hook(event: str, args: tuple) -> None:
    if event == "subprocess.Popen":
        on_shell(args[1], args[2], args[3])
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
            on_http_bytes(data)
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


def wrap_http(module_name: str) -> None:
    """httpx and httpx2 open raw sockets, so the audit events miss their method and URL; check each request at Client.send."""
    try:
        module = __import__(module_name)
    except ImportError:
        return
    for cls_name, is_async in (("Client", False), ("AsyncClient", True)):
        cls = getattr(module, cls_name, None)
        original = getattr(cls, "send", None)
        if original is not None and not getattr(original, "send_guarded", False):
            cls.send = guarded_send(original, is_async)


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


def install() -> None:
    guard_children()
    wrap_mcp()
    for name in ("httpx", "httpx2"):
        wrap_http(name)
    wrap_sockets()
    sys.addaudithook(hook)


if not getattr(sys, "global_rules_send_guard", False):
    install()
    sys.global_rules_send_guard = True
