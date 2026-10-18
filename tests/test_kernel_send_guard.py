"""Run-time kernel send guard (owner correction c37): components/global-rules/kernel-guard.py.

Each case runs a fresh Python process that installs a fake `rlm.mcp`, loads the guard the way kernel-guard.ts does, and runs
cells compiled as "<cell-N>". Nothing can leave the machine even if the guard is broken: HTTP goes to httpx.MockTransport or to
a local server with a spoofed Host header, curl and cua-driver are fake scripts first on PATH, and sockets only reach TEST-NET.
Gap rows come from 2204-c37-send-guards/data/map/gap-table.md.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
GUARD = REPO / "components" / "global-rules" / "kernel-guard.py"
CHILD_DIR = REPO / "components" / "global-rules" / "python-child"
CHAT = "01a00000-0000-7000-8000-0000000000c6"
AT = "2026-10-10T00:00:00.000Z"

RUNNER = r"""
import ast, asyncio, inspect, json, linecache, os, sys, types

CALLS = []
SEEN = []
mcp = types.ModuleType("rlm.mcp")
async def call_tool(server, tool, arguments=None):
    CALLS.append(["call_tool", server, tool, arguments])
    return "ok"
async def host_request(method, params=None, *args, **kwargs):
    CALLS.append(["host_request", method, params])
    return {}
mcp.call_tool = call_tool
mcp.host_request = host_request
rlm = types.ModuleType("rlm")
rlm.__path__ = []
rlm.mcp = mcp
sys.modules["rlm"] = rlm
sys.modules["rlm.mcp"] = mcp
sys.path[:0] = [p for p in os.environ.get("EXTRA_PATH", "").split(os.pathsep) if p]

spec = json.loads(sys.stdin.read())
guard = spec["guard"]
exec(compile(open(guard).read(), guard, "exec"), {"__name__": "global_rules_send_guard", "__file__": guard})

def mock_transport():
    import httpx
    def handle(request):
        SEEN.append([request.method, str(request.url)])
        return httpx.Response(200, json={"id": "fake"})
    return httpx.MockTransport(handle)

async def bash(command):
    import subprocess
    return subprocess.run(["bash", "-c", command], capture_output=True, text=True, timeout=30)

def refusal(error):
    seen = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        if type(error).__name__ == "SendRefused":
            return error
        error = error.__cause__ or error.__context__
    return None

import rlm.mcp as kernel_mcp
scope = {"__name__": "__main__", "mcp": kernel_mcp, "mock_transport": mock_transport, "bash": bash, "RESULT": None}
out = {"error": None, "refused": None}
try:
    for n, code in enumerate(spec["cells"], 1):
        name = f"<cell-{n}>"
        linecache.cache[name] = (len(code), None, code.splitlines(True), name)
        value = eval(compile(code, name, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), scope)
        if inspect.iscoroutine(value):
            asyncio.run(value)
except BaseException as error:
    out["error"] = f"{type(error).__name__}: {error}"
    hit = refusal(error)
    if hit is not None:
        out["refused"] = str(hit)
out.update(calls=CALLS, seen=SEEN, result=scope.get("RESULT"), pythonpath=os.environ.get("PYTHONPATH", ""))
print("\n" + json.dumps(out, default=str))
"""

FAKE_TOOL = """#!/bin/sh
printf '%s\\n' "$(basename "$0") $*" >> "$FAKE_LOG"
exit 0
"""


FAKE_RESEND = """
import http.client, json, os

api_key = None


class Emails:
    @staticmethod
    def send(params):
        # Like the resend SDK: one POST to api.resend.com/emails. Here the socket goes to a local server.
        body = json.dumps(params).encode()
        conn = http.client.HTTPConnection("127.0.0.1", int(os.environ["PORT"]), timeout=5)
        conn.putrequest("POST", "/emails", skip_host=True)
        conn.putheader("Host", "api.resend.com")
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", str(len(body)))
        conn.endheaders(body)
        return conn.getresponse().status
"""

LOCAL_POST = """
import http.client, os
conn = http.client.HTTPConnection("127.0.0.1", int(os.environ["PORT"]), timeout=5)
conn.putrequest("{method}", "{path}", skip_host=True)
conn.putheader("Host", "{host}")
conn.putheader("Content-Length", "2")
conn.endheaders(b"{{}}")
RESULT = conn.getresponse().status
"""


def local_post(host, path="/emails", method="POST"):
    """Cell code that writes to `host` through http.client while the socket goes to the local test server."""
    return textwrap.dedent(LOCAL_POST).format(host=host, path=path, method=method)


class Recorder(BaseHTTPRequestHandler):
    def handle_any(self):
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        self.server.hits.append([self.command, self.path, self.headers.get("Host", "")])
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_GET = do_POST = do_PUT = do_PATCH = handle_any

    def log_message(self, *args):
        pass


class KernelGuardBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
        cls.server.hits = []
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.addClassCleanup(cls.server.server_close)
        cls.addClassCleanup(cls.server.shutdown)

    def setUp(self):
        if not shutil.which("node"):
            self.skipTest("the kernel guard judges with node send-check.ts")
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.server.hits.clear()
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        for name in ("curl", "cua-driver"):
            tool = self.bin / name
            tool.write_text(FAKE_TOOL)
            tool.chmod(0o755)
        self.fake_log = self.tmp / "fake-tools.log"
        self.fake_log.write_text("")
        site = self.tmp / "site" / "resend"
        site.mkdir(parents=True)
        (site / "__init__.py").write_text(FAKE_RESEND)
        boards = self.tmp / "chat" / "boards"
        boards.mkdir(parents=True)

        def todo(id, **extra):
            return {"id": id, "text": "Send this reply?", "choices": ["Send it", "Not yet"], "from": "agent", "at": AT, **extra}

        (boards / f"{CHAT}.json").write_text(json.dumps({"v": 2, "rev": 1, "plan": [], "updatedAt": AT, "todos": [
            todo("t1", done=True, reply="Send it", answeredBy="owner"),
            todo("t2", done=True, reply="Not yet", answeredBy="owner"),
        ]}))
        (self.tmp / "home").mkdir()
        self.runner = self.tmp / "runner.py"
        self.runner.write_text(RUNNER)

    def run_cells(self, *cells, env=None, python=(sys.executable,)):
        environ = {k: v for k, v in os.environ.items() if k not in {"PYTHONPATH", "OWNER_OK", "PYTHONSTARTUP", "NODE_COMPILE_CACHE"}}
        environ.update({
            "HOME": str(self.tmp / "home"),
            "GLOBAL_RULES_LOG": str(self.tmp / "global-rules.log"),
            "AGENT_CHAT_DATA_DIR": str(self.tmp / "chat"),
            "PATH": f"{self.bin}{os.pathsep}{os.environ.get('PATH', '')}",
            "PORT": str(self.server.server_address[1]),
            "FAKE_LOG": str(self.fake_log),
            "EXTRA_PATH": str(self.tmp / "site"),
        })
        environ.update(env or {})
        spec = json.dumps({"guard": str(GUARD), "cells": list(cells)})
        proc = subprocess.run([*python, "-B", str(self.runner)], input=spec, capture_output=True, text=True, cwd=self.tmp, env=environ, timeout=180)
        lines = [line for line in proc.stdout.splitlines() if line.startswith("{")]
        self.assertTrue(lines, f"runner gave no result\nstdout: {proc.stdout}\nstderr: {proc.stderr}")
        return json.loads(lines[-1])

    def sends(self):
        path = self.tmp / "chat" / "sends.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def fake_runs(self):
        return [line for line in self.fake_log.read_text().splitlines() if line]

    def assert_refused(self, out, why=None):
        self.assertIsNotNone(out["refused"], f"not refused: {out}")
        self.assertIn("send guard", out["refused"])
        if why:
            self.assertRegex(out["refused"], why)

    def assert_passed(self, out):
        self.assertIsNone(out["error"], out)


class HttpBuiltAtRunTime(KernelGuardBase):
    def test_py3_post_to_a_url_from_the_environment(self):
        out = self.run_cells(
            'import os, urllib.request\n'
            'req = urllib.request.Request(os.environ["MAIL_URL"], data=b"{}", method="POST", headers={"Host": "api.resend.com", "Content-Type": "application/json"})\n'
            'urllib.request.urlopen(req, timeout=5)\n',
            env={"MAIL_URL": f"http://127.0.0.1:{self.server.server_address[1]}/emails"},
        )
        self.assert_refused(out)
        self.assertEqual(self.server.hits, [])

    def test_py4_post_to_an_f_string_url(self):
        out = self.run_cells("import httpx\nhost = 'api.resend.com'\nhttpx.Client(transport=mock_transport()).post(f'https://{host}/emails', json={})\n")
        self.assert_refused(out)
        self.assertEqual(out["seen"], [])

    def test_py6_client_base_url_with_a_relative_post(self):
        out = self.run_cells("import httpx\nc = httpx.Client(base_url='https://api.resend.com', transport=mock_transport())\nc.post('/emails', json={})\n")
        self.assert_refused(out)
        self.assertEqual(out["seen"], [])

    def test_py8_vendor_sdk_send(self):
        out = self.run_cells("import resend\nresend.api_key = 're_x'\nresend.Emails.send({'from': 'a@x.com', 'to': 'b@y.com', 'subject': 'hi', 'html': 'x'})\n")
        self.assert_refused(out)
        self.assertEqual(self.server.hits, [])

    def test_py14_helper_defined_in_an_earlier_cell(self):
        out = self.run_cells(
            "import httpx\n"
            "async def send_vendor_reply(ticket_id, body):\n"
            "    async with httpx.AsyncClient(transport=mock_transport()) as c:\n"
            "        await c.put(f'https://acme.zendesk.com/api/v2/tickets/{ticket_id}.json', json={'ticket': {'comment': {'body': body}}})\n",
            "await send_vendor_reply(ticket_id=42, body='hi')\n",
        )
        self.assert_refused(out)
        self.assertEqual(out["seen"], [])

    def test_py15_exec_of_a_helper_script(self):
        helper = self.tmp / "send_helper.py"
        helper.write_text(local_post("api.sendgrid.com", "/v3/mail/send"))
        out = self.run_cells(f"exec(open({str(helper)!r}).read())\n")
        self.assert_refused(out)
        self.assertEqual(self.server.hits, [])

    def test_smtp_connect_over_a_socket(self):
        for code in (
            "import socket\nsocket.create_connection(('192.0.2.1', 587), timeout=1)\n",
            "import smtplib\nsmtplib.SMTP('192.0.2.1', 25, timeout=1)\n",
        ):
            self.assert_refused(self.run_cells(code))

    def test_gets_and_local_posts_pass(self):
        out = self.run_cells("import httpx\nRESULT = httpx.Client(transport=mock_transport()).get('https://api.resend.com/emails/abc').status_code\n")
        self.assert_passed(out)
        self.assertEqual(out["seen"], [["GET", "https://api.resend.com/emails/abc"]])
        self.assert_passed(self.run_cells(local_post("api.resend.com", "/emails/abc", "GET")))
        self.assert_passed(self.run_cells(local_post("127.0.0.1", "/api/email/send")))
        self.assertEqual([hit[0] for hit in self.server.hits], ["GET", "POST"])


class ShellBuiltAtRunTime(KernelGuardBase):
    def test_py16_bash_with_an_f_string_url(self):
        out = self.run_cells("u = 'https://api.resend.com/emails'\nawait bash(f\"curl -X POST {u} -d @m.json\")\n")
        self.assert_refused(out)
        self.assertEqual(self.fake_runs(), [])

    def test_py17_bash_with_the_command_in_a_variable(self):
        out = self.run_cells("cmd = 'curl -X POST https://api.resend.com/emails -d @m.json'\nawait bash(cmd)\n")
        self.assert_refused(out)
        self.assertEqual(self.fake_runs(), [])

    def test_http8_curl_url_from_an_environment_variable(self):
        for code in (
            "import os, subprocess\nsubprocess.run(['bash', '-c', 'curl -X POST \"$MAIL_API_URL\" -d x'], env={**os.environ, 'MAIL_API_URL': 'https://api.resend.com/emails'})\n",
            "import os, subprocess\nos.environ['MAIL_API_URL'] = 'https://api.resend.com/emails'\nsubprocess.run(['bash', '-c', 'curl -X POST \"$MAIL_API_URL\" -d x'])\n",
        ):
            self.assert_refused(self.run_cells(code))
        self.assertEqual(self.fake_runs(), [])

    def test_a_curl_get_still_runs(self):
        self.assert_passed(self.run_cells("await bash('curl -sS https://api.resend.com/emails/abc')\n"))
        self.assertEqual(len(self.fake_runs()), 1)


class McpBuiltAtRunTime(KernelGuardBase):
    SEND_CLICK = "await page.getByRole('button',{name:'Send'}).click()"

    def test_mcp2_aside_repl_tool_name_in_a_variable(self):
        out = self.run_cells(f"t = 'repl'\nawait mcp.call_tool('aside', t, {{'code': {self.SEND_CLICK!r}}})\n")
        self.assert_refused(out)
        self.assertEqual(out["calls"], [])

    def test_the_10_10_iwebfusion_send_cells_are_refused_through_the_aside_repl(self):
        # The two cells that emailed iWebFusion on 10-10 (05:25:31Z "Hello Ryan", 07:19:18Z "Hi Thomas"), verbatim, sent straight to the Aside
        # repl tool instead of through aside_browser.
        for code in (
            "const recips = await page.evaluate(() => [...document.querySelectorAll('span[email]')].slice(-4).map(e=>e.getAttribute('email')));\n"
            "await page.getByRole('button', {name: /^Send/}).last().click(); await sleep(2500);",
            "await page.getByRole('button',{name:/^Send/}).last().click(); await sleep(3000);\n"
            "return JSON.stringify(await page.evaluate(()=>({sent:document.body.innerText.includes('Message sent'), t:new Date().toISOString()})))",
        ):
            out = self.run_cells(f"await mcp.call_tool('aside', 'repl', {{'code': {code!r}}})\n")
            self.assert_refused(out)
            self.assertEqual(out["calls"], [])

    def test_mcp3_aside_repl_args_built_earlier(self):
        out = self.run_cells(f"args = {{'code': {self.SEND_CLICK!r}}}\n", "await mcp.call_tool('aside', 'repl', args)\n")
        self.assert_refused(out)
        self.assertEqual(out["calls"], [])

    def test_mcp10_gmail_server_in_a_variable(self):
        out = self.run_cells("srv = 'gmail'\nawait mcp.call_tool(srv, 'send_email', {'to': 'bob@x.com'})\n")
        self.assert_refused(out)
        self.assertEqual(out["calls"], [])

    def test_mcp11_call_tool_through_getattr(self):
        out = self.run_cells("f = getattr(mcp, 'call_tool')\nawait f('gmail', 'send_email', {'to': 'bob@x.com'})\n")
        self.assert_refused(out)
        self.assertEqual(out["calls"], [])

    def test_mcp12_raw_host_request(self):
        out = self.run_cells("await mcp.host_request('tools/call', {'connectionId': 'gmail', 'name': 'send_email', 'arguments': {'to': 'bob@x.com'}})\n")
        self.assert_refused(out)
        self.assertEqual(out["calls"], [])

    def test_mcp_reads_and_slack_pass(self):
        out = self.run_cells(
            "await mcp.call_tool('gmail', 'list_messages', {'q': 'from:vendor'})\n"
            "await mcp.call_tool('slack', 'slack_post_message', {'channel': 'C1', 'text': 'hi'})\n"
        )
        self.assert_passed(out)
        self.assertEqual([call[2] for call in out["calls"]], ["list_messages", "slack_post_message"])


class CellApproval(KernelGuardBase):
    def test_an_approved_owner_ok_in_the_cell_lets_the_send_through(self):
        out = self.run_cells(f"# OWNER_OK={CHAT}/t1\n" + local_post("api.resend.com"))
        self.assert_passed(out)
        self.assertEqual(self.server.hits, [["POST", "/emails", "api.resend.com"]])

    def test_a_held_or_unknown_todo_keeps_the_block(self):
        self.assert_refused(self.run_cells(f"# OWNER_OK={CHAT}/t2\n" + local_post("api.resend.com")), "not a go")
        self.assert_refused(self.run_cells(f"# OWNER_OK={CHAT}/t9\n" + local_post("api.resend.com")), "no todo t9")
        self.assertEqual(self.server.hits, [])


RAW_POST = (
    "import os, socket\n"
    "s = socket.create_connection(('127.0.0.1', int(os.environ['PORT'])), timeout=5)\n"
    "s.sendall(b'POST /emails HTTP/1.1\\r\\nHost: api.resend.com\\r\\nContent-Length: 2\\r\\n\\r\\n{}')\n"
    "RESULT = s.recv(64).decode()\n"
)

AIOHTTP_POST = (
    "import aiohttp, os\n"
    "async with aiohttp.ClientSession() as session:\n"
    "    async with session.post(f\"http://127.0.0.1:{os.environ['PORT']}/emails\", json={}, headers={'Host': 'api.resend.com'}) as response:\n"
    "        RESULT = response.status\n"
)


class SendsTheRequestLayersMiss(KernelGuardBase):
    """p345: aiohttp and raw-socket writes left no send log line, because the guard only wrapped httpx, requests and urllib."""

    def assert_one_line(self, decision):
        lines = [line for line in self.sends() if "api.resend.com" in line["target"]]
        self.assertEqual([(line["decision"], line["layer"]) for line in lines], [(decision, "kernel")], self.sends())

    def test_a_raw_socket_post_is_refused_and_logged(self):
        self.assert_refused(self.run_cells(RAW_POST))
        self.assertEqual(self.server.hits, [])
        self.assert_one_line("refused")

    def test_a_raw_socket_post_with_an_approved_owner_ok_leaves_one_allowed_line(self):
        out = self.run_cells(f"# OWNER_OK={CHAT}/t1\n" + RAW_POST)
        self.assert_passed(out)
        self.assertEqual(self.server.hits, [["POST", "/emails", "api.resend.com"]])
        self.assert_one_line("allowed")

    def test_an_http_client_post_with_an_approved_owner_ok_leaves_one_allowed_line(self):
        self.assert_passed(self.run_cells(f"# OWNER_OK={CHAT}/t1\n" + local_post("api.resend.com")))
        self.assert_one_line("allowed")

    def test_a_tls_write_through_ssl_object_is_refused(self):
        # asyncio TLS, which aiohttp and httpx's AsyncClient use over https, writes the plain request through ssl.SSLObject.write.
        out = self.run_cells(
            "import ssl\n"
            "tls = ssl.create_default_context().wrap_bio(ssl.MemoryBIO(), ssl.MemoryBIO(), server_hostname='api.resend.com')\n"
            "tls.write(b'POST /emails HTTP/1.1\\r\\nHost: api.resend.com\\r\\n\\r\\n')\n"
        )
        self.assert_refused(out)
        self.assert_one_line("refused")

    def test_an_aiohttp_post_is_refused_and_logged(self):
        python = ("uv", "run", "--no-project", "--offline", "--quiet", "--with", "aiohttp", "--python", sys.executable, "python")
        if not shutil.which("uv") or subprocess.run([*python, "-c", "import aiohttp"], capture_output=True).returncode:
            self.skipTest("aiohttp is not in the uv cache")
        cache = subprocess.run(["uv", "cache", "dir"], capture_output=True, text=True).stdout.strip()
        out = self.run_cells(AIOHTTP_POST, python=python, env={"UV_CACHE_DIR": cache})
        self.assertIsNotNone(out["error"], out)
        self.assertEqual(self.server.hits, [])
        self.assert_one_line("refused")


CHILD_POST = (
    "import http.client, os\n"
    "c = http.client.HTTPConnection('127.0.0.1', int(os.environ['PORT']), timeout=5)\n"
    "c.putrequest('POST', '/emails', skip_host=True)\n"
    "c.putheader('Host', os.environ['MAIL_HOST'])\n"
    "c.putheader('Content-Length', '2')\n"
    "c.endheaders(b'{}')\n"
    "print(c.getresponse().status)\n"
)

CHILD_CELL = (
    "import os, subprocess, sys\n"
    "env = {{**os.environ, 'MAIL_HOST': 'api.resend.com'{extra}}}\n"
    "p = subprocess.run([sys.executable, {script}], capture_output=True, text=True, env=env, timeout=120)\n"
    "RESULT = {{'code': p.returncode, 'stderr': p.stderr}}\n"
)


class ChildProcesses(KernelGuardBase):
    def child(self, script, extra=""):
        return self.run_cells(CHILD_CELL.format(script=repr(str(script)), extra=extra))

    def write(self, name, text):
        path = self.tmp / name
        path.write_text(text)
        return path

    def test_install_puts_the_child_guard_on_pythonpath(self):
        out = self.run_cells("pass\n")
        self.assertIn(str(CHILD_DIR), out["pythonpath"].split(os.pathsep))

    def test_install_leaves_httpx_unimported_and_caches_node_compiles(self):
        # 10-18: importing httpx at install cost every child Python 0.15 CPU s, and each node send-check.ts run stripped its types again.
        out = self.run_cells("import os, sys\nRESULT = {'httpx': 'httpx' in sys.modules, 'cache': os.environ.get('NODE_COMPILE_CACHE')}\n")
        self.assert_passed(out)
        self.assertEqual(out["result"], {"httpx": False, "cache": str(self.tmp / "home" / ".cache" / "node-compile-cache")})

    def test_httpx_imported_after_install_is_wrapped(self):
        out = self.run_cells("import httpx, httpx._client\nRESULT = [getattr(httpx.Client.send, 'send_guarded', False), getattr(httpx.AsyncClient.send, 'send_guarded', False)]\n")
        self.assert_passed(out)
        self.assertEqual(out["result"], [True, True])

    def test_a_child_python_that_posts_to_a_mail_api_is_refused_inside_the_child(self):
        out = self.child(self.write("child_post.py", CHILD_POST))
        self.assert_passed(out)
        self.assertNotEqual(out["result"]["code"], 0, out)
        self.assertIn("send guard", out["result"]["stderr"])
        self.assertEqual(self.server.hits, [])

    def test_the_same_child_passes_with_an_approved_owner_ok_in_its_env(self):
        out = self.child(self.write("child_post.py", CHILD_POST), extra=f", 'OWNER_OK': '{CHAT}/t1'")
        self.assert_passed(out)
        self.assertEqual(out["result"]["code"], 0, out)
        self.assertEqual(self.server.hits, [["POST", "/emails", "api.resend.com"]])

    def test_cuash3_a_child_that_starts_cua_driver_mcp_is_refused(self):
        out = self.child(self.write("drive_cua.py", "import subprocess\nsubprocess.run(['cua-driver', 'mcp'], input='', text=True, timeout=30)\n"))
        self.assert_passed(out)
        self.assertNotEqual(out["result"]["code"], 0, out)
        self.assertIn("send guard", out["result"]["stderr"])
        self.assertEqual(self.fake_runs(), [])

    def test_cuash3_the_kernel_starting_cua_driver_mcp_is_refused(self):
        out = self.run_cells("import subprocess\nsubprocess.Popen(['cua-driver', 'mcp'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)\n")
        self.assert_refused(out)
        self.assertEqual(self.fake_runs(), [])


NODE_SHIM = """#!/bin/sh
printf '%s\\n' "$*" >> "$NODE_LOG"
exec {real} "$@"
"""

KILL_JUDGE = (
    "import os, signal, time\n"
    "for pid in [p for p in os.listdir('/proc') if p.isdigit()]:\n"
    "    try:\n"
    "        stat = open(f'/proc/{pid}/stat').read().rsplit(')', 1)[1].split()\n"
    "        cmd = open(f'/proc/{pid}/cmdline', 'rb').read()\n"
    "    except OSError:\n"
    "        continue\n"
    "    if int(stat[1]) == os.getpid() and b'--serve' in cmd:\n"
    "        os.kill(int(pid), signal.SIGKILL)\n"
    "        RESULT = 'killed'\n"
)

CURL_GET = "import subprocess\nsubprocess.run(['curl', '-sS', 'https://api.resend.com/emails/abc'])\n"
CURL_POST = "import subprocess\nsubprocess.run(['curl', '-X', 'POST', 'https://api.resend.com/emails', '-d', 'x'])\n"


class OneJudgePerProcess(KernelGuardBase):
    """10-18 on us-metal02: kernels and their child Pythons started a fresh `node send-check.ts` for every check, 8 to 12 a second
    at 0.11 CPU s each, and a sampler's `git ls-files` on paths with .sh, node or http in them made 4 of those a second."""

    def setUp(self):
        super().setUp()
        self.node_log = self.tmp / "node.log"
        self.node_log.write_text("")
        shim = self.bin / "node"
        shim.write_text(NODE_SHIM.format(real=shutil.which("node")))
        shim.chmod(0o755)

    def cells(self, *cells, env=None):
        return self.run_cells(*cells, env={"NODE_LOG": str(self.node_log), **(env or {})})

    def judges(self):
        return [line for line in self.node_log.read_text().splitlines() if "send-check.ts" in line]

    def test_many_checks_share_one_judge_and_a_send_is_still_refused(self):
        out = self.cells(CURL_GET * 5 + CURL_POST)
        self.assert_refused(out, "curl call writes to")
        self.assertEqual(len(self.fake_runs()), 5)
        self.assertEqual(len(self.judges()), 1, self.judges())
        self.assertTrue(self.judges()[0].endswith("send-check.ts --serve"), self.judges())
        self.assertEqual([(line["decision"], line["layer"]) for line in self.sends()], [("refused", "kernel")])

    def test_a_changed_environment_starts_a_fresh_judge(self):
        out = self.cells(CURL_GET + "import os\nos.environ['SOME_FLAG'] = '1'\n" + CURL_GET + CURL_GET)
        self.assert_passed(out)
        self.assertEqual(len(self.judges()), 2, self.judges())

    def test_a_judge_that_dies_is_started_again_and_still_refuses(self):
        if not os.path.isdir("/proc/self"):
            self.skipTest("finds the judge through /proc")
        out = self.cells(CURL_GET, KILL_JUDGE, CURL_POST)
        self.assertEqual(out["result"], "killed")
        self.assert_refused(out)
        self.assertEqual(len(self.fake_runs()), 1)
        self.assertEqual(len(self.judges()), 2, self.judges())

    def test_without_node_a_check_still_falls_open(self):
        (self.bin / "node").write_text("#!/bin/sh\nexit 127\n")
        out = self.cells(CURL_POST)
        self.assert_passed(out)
        self.assertEqual(len(self.fake_runs()), 1)

    def test_plain_git_on_hinted_paths_starts_no_judge(self):
        out = self.cells(
            "import subprocess\n"
            "subprocess.run(['git', 'ls-files', '--', 'deploy.sh', 'node_modules/x.js', 'http_client.py', 'curl-notes.md'], capture_output=True)\n"
            "subprocess.run(['/usr/bin/git', 'status', '--short', 'scripts/post-to-gh.sh'], capture_output=True)\n"
        )
        self.assert_passed(out)
        self.assertEqual(self.judges(), [])

    def test_git_with_shell_syntax_is_still_judged(self):
        for code in (
            "import subprocess\nsubprocess.run(['git', 'log', '--format=x; curl -X POST https://api.resend.com/emails -d x'], capture_output=True)\n",
            "import subprocess\nsubprocess.run('git ls-files a.sh; curl -X POST https://api.resend.com/emails -d x', shell=True)\n",
        ):
            self.assert_refused(self.cells(code))
        self.assertEqual(self.fake_runs(), [])


PLAIN_GIT_TABLE = r"""
import json, subprocess, sys
sys.global_rules_send_guard = True
guard = sys.argv[1]
ns = {"__name__": "global_rules_send_guard", "__file__": guard}
exec(compile(open(guard).read(), guard, "exec"), ns)
rows = []
for executable, argv in json.loads(sys.stdin.read()):
    skip = ns["plain_git"](executable, argv)
    text = ns["shell_text"](argv)
    verdict = ns["one_shot"]({"kind": "shell", "text": text, "cwd": sys.argv[2], "repo": False, "approval": ""})
    rows.append([argv, skip, bool(verdict.get("block"))])
print(json.dumps(rows))
"""


class PlainGitSkipsOnlyPasses(KernelGuardBase):
    """plain_git skips the judge only for argv that send-check.ts always passes; anything that can send is still judged."""

    def test_the_skip_agrees_with_the_judge(self):
        script = self.tmp / "table.py"
        script.write_text(PLAIN_GIT_TABLE)
        hook = self.tmp / "hook.sh"
        hook.write_text("curl -X POST https://api.resend.com/emails -d x\n")
        url = "https://api.resend.com/emails"
        cases = [
            [None, ["git", "ls-files", "deploy.sh", "node/x.ts", "http.py"]],
            [None, ["git", "add", "--", "curl -X POST " + url + " -d x"]],
            [None, ["git", "-c", "alias.s=!curl -X POST " + url + " -d x", "s"]],
            [None, ["git", "log", "--grep", "sendgrid smtp gh issue create"]],
            [None, ["git", "log", "--format=x; curl -X POST " + url + " -d x"]],
            [None, ["git", "show", "$(curl -X POST " + url + " -d x)"]],
            [None, ["curl -X POST " + url + " -d x /git", "ls-files"]],
            ["curl", ["git", "-X", "POST", url, "-d", "x"]],
            [None, ["bash", str(hook)]],
            [None, ["/bin/sh", "-c", "git ls-files; curl -X POST " + url + " -d x"]],
        ]
        proc = subprocess.run([sys.executable, "-B", str(script), str(GUARD), str(self.tmp)], input=json.dumps(cases), capture_output=True, text=True, timeout=180)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rows = json.loads(proc.stdout)
        self.assertEqual([row[1] for row in rows], [True, True, True, True, False, False, False, False, False, False])
        for argv, skip, block in rows:
            if skip:
                self.assertFalse(block, argv)
        self.assertEqual([row[2] for row in rows[4:]], [True, True, True, False, True, True])


if __name__ == "__main__":
    unittest.main()
