import asyncio
import importlib.util
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import urllib.parse
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
THREAD = "230bbdbf-4d84-475f-95d2-63db2f90ca34"
PAGE = "domains/devops/ci-cd-pipeline/dev-push-checks.html"


def load_wiki():
    spec = importlib.util.spec_from_file_location("wiki_under_test", REPO / "skills/wiki/src/wiki/__init__.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeChat(BaseHTTPRequestHandler):
    """Records each request and answers like the :5184 workspace and /wiki routes."""

    calls: list = []

    def log_message(self, *args):
        pass

    def _answer(self):
        size = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(size) if size else b""
        FakeChat.calls.append({"method": self.command, "path": self.path, "conversation": self.headers.get("x-pi-conversation"),
                               "type": self.headers.get("content-type"), "body": body.decode("utf-8", "replace")})
        if self.path.endswith("/workspace"):
            out = {"id": "agents/vent/jobs/2026/11/03/1250-x", "path": "agents/vent/jobs/2026/11/03/1250-x/index.html", "conversation": f"{THREAD}:7"}
        elif self.path == "/wiki/api/agent/sessions":
            out = {"id": "sessions/2026/11/03/1250-x", "path": "sessions/2026/11/03/1250-x/index.html", "version": 1}
        elif "/sessions/" in self.path and self.path.endswith("/close") and b"graduated_to" not in body and b"no_durable" not in body:
            self.send_response(422)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "close needs graduated_to, gaps_created or no_durable_knowledge"}).encode())
            return
        elif self.command == "PATCH" and b'"old_string": "missing"' in body:
            self.send_response(422)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "edit 0: old_string not found"}).encode())
            return
        elif "format=md" in self.path:
            self.send_response(200)
            self.send_header("content-type", "text/markdown")
            self.end_headers()
            self.wfile.write(b"# Page\n")
            return
        else:
            out = {"ok": True}
        data = json.dumps(out).encode()
        self.send_response(201)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_PATCH = _answer


class WikiSkillTests(unittest.TestCase):
    def setUp(self):
        FakeChat.calls = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeChat)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def env(self, **extra):
        clean = {k: v for k, v in os.environ.items() if k not in ("PI_HOST_THREAD", "PI_HOST_CONVERSATION", "WIKI_AUTHOR", "RLM_SESSION_DIR")}
        return patch.dict(os.environ, {**clean, "PI_HOST_CHAT_URL": self.url, **extra}, clear=True)

    def test_a_pi_host_job_names_its_conversation_and_writes_under_its_folder(self):
        session = Path(self.tmp.name) / ".prime/agent/pi-host/durable/session-artifacts" / f"{THREAD}-7"
        session.mkdir(parents=True)
        with self.env(RLM_SESSION_DIR=str(session)):
            wiki = load_wiki()
            self.assertEqual(wiki.conversation(), f"{THREAD}:7")
            wiki.write("plan.html", "<h1>Plan</h1>")
            wiki.edit("plan.html", [("Plan", "The plan")])
            wiki.publish("apps/vent/index.html", "<h1>Vent</h1>")
            wiki.log("did a thing")
            wiki.close("done")
        paths = [(c["method"], c["path"]) for c in FakeChat.calls]
        self.assertEqual(paths, [
            ("POST", f"/api/c/{THREAD}%3A7/workspace"),
            ("PUT", "/wiki/agents/vent/jobs/2026/11/03/1250-x/plan.html"),
            ("PATCH", "/wiki/agents/vent/jobs/2026/11/03/1250-x/plan.html"),
            ("PUT", "/wiki/apps/vent/index.html"),
            ("POST", "/wiki/api/agent/verify"),
            ("POST", f"/api/c/{THREAD}%3A7/workspace/events"),
            ("POST", f"/api/c/{THREAD}%3A7/workspace/close"),
        ])
        self.assertTrue(all(c["conversation"] == f"{THREAD}:7" for c in FakeChat.calls))
        self.assertEqual(json.loads(FakeChat.calls[-1]["body"]), {"outcome": "done", "graduated_to": ["apps/vent/index.html"]})
        self.assertNotIn("author", FakeChat.calls[1]["body"])

    def test_a_prime_session_writes_with_the_author_it_is_given(self):
        session = Path(self.tmp.name) / ".prime/agent/session-artifacts/01a19f7a-7cbd-730b-8da0-6bff3249de0c"
        session.mkdir(parents=True)
        with self.env(RLM_SESSION_DIR=str(session)):
            wiki = load_wiki()
            self.assertIsNone(wiki.conversation())
            with self.assertRaises(ValueError):
                wiki.write("plan.html", "<h1>Plan</h1>")
            opened = wiki.workspace("Check the skill", author="prime job check")
            self.assertEqual(opened["folder"], "sessions/2026/11/03/1250-x/")
            wiki.write("plan.html", "<h1>Plan</h1>")
            source = Path(self.tmp.name) / "run.log"
            source.write_text("ok\n")
            wiki.put("data/run.log", source)
            self.assertEqual(wiki.read("sessions/2026/11/03/1250-x/plan.html"), "# Page\n")
            with self.assertRaises(wiki.WikiError) as refused:
                wiki.close("done")
            self.assertEqual(refused.exception.status, 422)
            wiki.close("done", no_durable_knowledge=True)
        calls = FakeChat.calls
        self.assertTrue(all(c["conversation"] is None for c in calls))
        self.assertEqual(json.loads(calls[0]["body"])["agent"], "prime job check")
        self.assertEqual(json.loads(calls[1]["body"]), {"path": "sessions/2026/11/03/1250-x/plan.html", "content": "<h1>Plan</h1>", "author": "prime job check"})
        self.assertEqual(calls[2]["path"], "/wiki/api/agent/assets")
        self.assertIn('name="path"\r\n\r\nsessions/2026/11/03/1250-x/data/run.log', calls[2]["body"])
        self.assertEqual(calls[-1]["path"], "/wiki/api/agent/sessions/sessions/2026/11/03/1250-x/close")
        self.assertFalse(json.loads((session / "wiki-workspace.json").read_text()).get("workspace"))

    def test_an_edit_is_safe_to_await_and_a_missed_old_string_names_the_html_read(self):
        with self.env(RLM_SESSION_DIR=self.tmp.name, WIKI_AUTHOR="prime job check"):
            wiki = load_wiki()

            async def awaited():
                return await wiki.edit("apps/x/a.html", [("a", "b")]), await wiki.read("apps/x/a.html")

            edited, page = asyncio.run(awaited())
            self.assertEqual((edited["ok"], edited["path"], page), (True, "apps/x/a.html", "# Page\n"))
            with self.assertRaises(wiki.WikiError) as refused:
                wiki.edit("apps/x/a.html", [("missing", "b")])
            self.assertEqual(refused.exception.status, 422)
            self.assertIn("wiki.read(path, html=True)", str(refused.exception))

    def test_a_disk_prefixed_path_is_refused(self):
        with self.env(RLM_SESSION_DIR=self.tmp.name):
            wiki = load_wiki()
            with self.assertRaises(ValueError):
                wiki.write("apps/llm-wiki/content/apps/x.html", "<h1>x</h1>")


class VersionedChat(BaseHTTPRequestHandler):
    """One page with a revision log, answering like the :5184 /wiki routes and the engine's stale-base 409."""

    page = {}
    calls: list = []

    def log_message(self, *args):
        pass

    def _send(self, status, out, kind="application/json"):
        data = out.encode() if isinstance(out, str) else json.dumps(out).encode()
        self.send_response(status)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _answer(self):
        size = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(size).decode() if size else ""
        url = urllib.parse.urlsplit(self.path)
        query = dict(urllib.parse.parse_qsl(url.query))
        VersionedChat.calls.append((self.command, url.path, query, body))
        page = VersionedChat.page
        current = page["revisions"][-1]["version"]
        if self.command == "GET" and url.path == "/wiki/api/agent/diff":
            rows = [r for r in page["revisions"] if int(query["from"]) < r["version"] <= int(query["to"])]
            return self._send(200, {"current": current, "revisions": rows})
        if self.command == "GET" and url.path == "/wiki/api/agent/page":
            return self._send(200, {"path": query["path"], "version": current, "content": page["html"][:5]})
        if self.command == "GET":
            if query.get("format") == "html":
                return self._send(200, page["html"], "text/html")
            return self._send(200, f'---\npath: "{PAGE}"\nversion: {current}\ntitle: "Dev push checks"\n---\n\n# Page\n', "text/markdown")
        sent = json.loads(body) if body.startswith("{") else {}
        base = sent.get("baseVersion", query.get("baseVersion"))
        if base is not None and int(base) != current:
            return self._send(409, {"error": f"stale: baseVersion {base} != current {current}"})
        page["revisions"].append({"version": current + 1, "author": "writer", "ts": "2026-11-04T18:20:00.000Z"})
        return self._send(200, {"path": PAGE, "version": current + 1, "changed": True})

    do_GET = do_POST = do_PUT = do_PATCH = _answer


class ReadVersionTests(unittest.TestCase):
    def setUp(self):
        VersionedChat.calls = []
        VersionedChat.page = {"html": "<h1>Dev push checks</h1>", "revisions": [{"version": 114, "author": "a", "ts": "t"}]}
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), VersionedChat)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def env(self, **extra):
        clean = {k: v for k, v in os.environ.items() if k not in ("PI_HOST_THREAD", "PI_HOST_CONVERSATION", "WIKI_AUTHOR", "RLM_SESSION_DIR")}
        return patch.dict(os.environ, {**clean, "PI_HOST_CHAT_URL": self.url, "RLM_SESSION_DIR": self.tmp.name,
                                       "WIKI_AUTHOR": "prime job check", **extra}, clear=True)

    def another_job_saves(self):
        version = VersionedChat.page["revisions"][-1]["version"] + 1
        VersionedChat.page["revisions"].append({"version": version, "author": "push-verdict-legs-wiki", "ts": "2026-11-04T18:06:52.909Z"})

    def bases(self):
        return [json.loads(body).get("baseVersion") if body.startswith("{") else query.get("baseVersion")
                for method, _path, query, body in VersionedChat.calls if method in ("POST", "PUT", "PATCH")]

    def test_a_full_write_after_a_read_refuses_a_change_saved_since_and_names_it(self):
        with self.env():
            wiki = load_wiki()
            wiki.read(PAGE)
            self.another_job_saves()
            with self.assertRaises(wiki.WikiError) as refused:
                wiki.write(PAGE, "<h1>Dev push checks</h1><p>mine</p>")
            self.assertEqual(refused.exception.status, 409)
            self.assertIn("after v114, the version this write builds on: v115 by push-verdict-legs-wiki at 2026-11-04T18:06:52.909Z", str(refused.exception))
            self.assertIn(f"wiki.read('{PAGE}') again", str(refused.exception))
            with self.assertRaises(wiki.WikiError):
                wiki.write(PAGE, "<h1>Dev push checks</h1><p>mine</p>")
            wiki.read(PAGE)
            self.assertEqual(wiki.write(PAGE, "<h1>Dev push checks</h1><p>mine</p>")["version"], 116)
            wiki.edit(PAGE, [("mine", "ours")])
        self.assertEqual(self.bases(), [114, 114, 115, 116])

    def test_an_html_read_asks_the_version_first_and_an_unread_page_or_a_given_base_keeps_today(self):
        with self.env():
            wiki = load_wiki()
            wiki.write(PAGE, "<h1>Dev push checks</h1>")
            wiki = load_wiki()
            wiki.read(PAGE, html=True)
            self.assertEqual([c[1] for c in VersionedChat.calls[-2:]], ["/wiki/api/agent/page", f"/wiki/{PAGE}"])
            self.another_job_saves()
            with self.assertRaises(wiki.WikiError):
                wiki.edit(PAGE, [("Dev", "The dev")])
            wiki.edit(PAGE, [("Dev", "The dev")], base_version=116)
        self.assertEqual(self.bases(), [None, 115, 116])

    def test_a_second_dream_write_of_one_page_needs_a_reason_and_names_the_first(self):
        with self.env():
            wiki = load_wiki()
            wiki.read(PAGE)
            wiki.write(PAGE, "<h1>Dev push checks</h1><p>a.</p>", summary="wiki-dream: checked 47cbf1db62")
            with self.assertRaises(ValueError) as refused:
                wiki.edit(PAGE, [("a.", "a")], summary="wiki-dream: drop a stray period")
            self.assertIn("already saved it as v115", str(refused.exception))
            wiki.edit(PAGE, [("a.", "a")], summary="job: drop a stray period")
            wiki.edit(PAGE, [("a", "b")], summary="wiki-dream: restore a fact", again="v116 dropped a fact")
        sent = [json.loads(body).get("summary") for method, _path, _query, body in VersionedChat.calls if method == "PATCH"]
        self.assertEqual(sent, ["job: drop a stray period", "wiki-dream: restore a fact (again: v116 dropped a fact)"])

    def test_a_pi_host_job_sends_the_read_version_on_its_put(self):
        session = Path(self.tmp.name) / ".prime/agent/pi-host/durable/session-artifacts" / f"{THREAD}-7"
        session.mkdir(parents=True)
        with self.env(RLM_SESSION_DIR=str(session)):
            wiki = load_wiki()
            wiki.read(PAGE, section="legs")
            wiki.write(PAGE, "<h1>Dev push checks</h1>")
        self.assertEqual(self.bases(), ["114"])


if __name__ == "__main__":
    unittest.main()
