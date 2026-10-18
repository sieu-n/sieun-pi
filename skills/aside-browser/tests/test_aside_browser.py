"""Unit tests for aside_browser. No browser: `rlm.mcp` is a fake. Live checks are separate."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch

import aside_browser as ab

# Error texts copied from live Aside daemon 1.26.1001.14 probes (2026-10-01).
LIVE_DOCUMENT = "Error: ReferenceError: 'document' is not defined\n    at <eval> (repl.js:1:13)\n"
LIVE_WAIT_FOR_TIMEOUT = "Error: TypeError: not a function\n    at <anonymous> (repl.js:1:47)\n"
LIVE_SLEEP_IN_PAGE = (
    "Error: Error: ReferenceError: sleep is not defined\n    at <anonymous>:1:63\n    at <anonymous>:1:82\n"
    "    at AsidePage.evaluate (file:///Aside%20Daemon.app/Contents/MacOS/aside-daemon:3807:22224)\n"
)
LIVE_REDECLARED = "Error: SyntaxError: Identifier 'x' has already been declared\n"


class FakeMcp:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls: list[dict] = []

    async def call_tool(self, server, tool, arguments):
        self.calls.append(arguments)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {
            "RLM_SESSION_DIR": self.tmp.name,
            "GLOBAL_RULES_SEND_LOG": os.path.join(self.tmp.name, "sends.jsonl"),
            "ASIDE_BROWSER_STATE": os.path.join(self.tmp.name, "owners"),
            "ASIDE_BROWSER_BOX": "0",
        })
        self.env.start()
        ab._owned.clear()
        ab._browser = "aside"

    def sends(self) -> list[dict]:
        try:
            with open(os.environ["GLOBAL_RULES_SEND_LOG"], encoding="utf-8") as handle:
                return [json.loads(line) for line in handle if line.strip()]
        except FileNotFoundError:
            return []

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()
        ab._owned.clear()

    def fake(self, *replies):
        mcp = FakeMcp(replies)
        module = types.ModuleType("rlm")
        module.mcp = mcp
        patcher = patch.dict(sys.modules, {"rlm": module})
        patcher.start()
        self.addCleanup(patcher.stop)
        return mcp

    def call(self, coro):
        return asyncio.run(coro)


class WrapTests(Base):
    def test_user_code_starts_on_line_one_inside_async_function(self):
        wrapped = ab.wrap_code("const x = 1;\nconsole.log(x)")
        first, second = wrapped.split("\n")[:2]
        self.assertTrue(first.startswith("await (async () => { "))
        self.assertTrue(first.endswith("const x = 1;"))
        self.assertEqual(second, "console.log(x)")
        self.assertIn("})().then(", wrapped)

    def test_trailing_line_comment_does_not_swallow_the_closer(self):
        wrapped = ab.wrap_code("console.log(1) // done")
        self.assertIn("// done\n", wrapped)

    def test_tab_tracking_only_when_code_opens_a_tab(self):
        self.assertNotIn("__asideBefore", ab.wrap_code("console.log(1)"))
        self.assertIn("__asideBefore", ab.wrap_code("const p = await openTab('https://example.com')"))

    def test_run_sends_wrapped_code_and_raw_when_asked(self):
        mcp = self.fake("ok", "ok")
        self.call(ab.run("const x = 1"))
        self.call(ab.run("const x = 1", wrap=False))
        self.assertTrue(mcp.calls[0]["code"].startswith("await (async () => { const x = 1"))
        self.assertEqual(mcp.calls[1]["code"], "const x = 1")


class ExplainTests(unittest.TestCase):
    def test_document_outside_evaluate(self):
        hint = ab.explain(LIVE_DOCUMENT)
        self.assertIn("page.evaluate", hint)

    def test_old_unquoted_format(self):
        self.assertIn("page.evaluate", ab.explain("ReferenceError: window is not defined"))

    def test_not_a_function_is_located_from_repl_position(self):
        sent = "await (async () => { await page.waitForTimeout(100); })();"
        hint = ab.explain(LIVE_WAIT_FOR_TIMEOUT, sent)
        self.assertIn("waitForTimeout", hint)
        self.assertIn("sleep(ms)", hint)

    def test_not_a_function_on_a_later_line(self):
        sent = ab.wrap_code("const h = await page.locator('a')\n  .allInnerTexts();")
        col = sent.split("\n")[1].index("(") + 1
        hint = ab.explain(f"Error: TypeError: not a function\n    at <anonymous> (repl.js:2:{col})\n", sent)
        self.assertIn("evaluateAll", hint)

    def test_old_named_format(self):
        hint = ab.explain("TypeError: page.getByRole(...).getByRole is not a function")
        self.assertIn("page.getByRole(role, {name})", hint)

    def test_set_viewport_size(self):
        self.assertIn("viewportSize()", ab.explain("TypeError: page.setViewportSize is not a function"))

    def test_page_selector_shortcut(self):
        self.assertIn("page.locator(selector).innerText", ab.explain("TypeError: t.innerText is not a function"))

    def test_repl_helper_inside_page_evaluate(self):
        hint = ab.explain(LIVE_SLEEP_IN_PAGE)
        self.assertIn("runs in the web page", hint)
        self.assertIn("setTimeout", hint)

    def test_redeclared(self):
        self.assertIn("globalThis", ab.explain(LIVE_REDECLARED))

    def test_name_from_an_earlier_call_points_to_global_this(self):
        hint = ab.explain("Error: ReferenceError: 'p' is not defined\n    at <anonymous> (repl.js:1:30)\n")
        self.assertIn("globalThis.p = value", hint)

    def test_unknown_error_has_no_hint(self):
        self.assertIsNone(ab.explain("Error: Selector \"h1\" not found"))


class ErrorTranslationTests(Base):
    def test_run_adds_hint_and_keeps_original_text(self):
        self.fake(RuntimeError(LIVE_DOCUMENT))
        with self.assertRaises(ab.AsideError) as caught:
            self.call(ab.run("console.log(document.title)"))
        self.assertIn("'document' is not defined", str(caught.exception))
        self.assertIn("[aside-browser hint]", str(caught.exception))
        self.assertIn("page.evaluate", caught.exception.hint)

    def test_run_locates_missing_method_in_wrapped_code(self):
        code = "await page.waitForTimeout(100);"
        col = ab.wrap_code(code).split("\n")[0].index("(100)") + 1
        self.fake(RuntimeError(f"Error: TypeError: not a function\n    at <anonymous> (repl.js:1:{col})\n"))
        with self.assertRaises(ab.AsideError) as caught:
            self.call(ab.run(code))
        self.assertIn("await sleep(ms)", caught.exception.hint)


class TabOwnershipTests(Base):
    def test_open_tab_records_and_close_tab_allows_own_tab(self):
        mcp = self.fake(
            '{"title":"Example Domain","url":"https://example.com/","targetId":"T1"}',
            '{"targetId":"T1","closed":true,"left":0}',
        )
        self.call(ab.open_tab("https://example.com"))
        self.assertIn("T1", ab._owned_tabs())
        self.assertEqual(self.call(ab.close_tab()), "closed T1 - tabs left in this REPL: 0")
        self.assertEqual(len(mcp.calls), 2)
        self.assertIn('closeTab', mcp.calls[1]["code"])
        self.assertIn('["T1"].includes(__id)', mcp.calls[1]["code"])
        self.assertNotIn("T1", ab._owned_tabs())

    def test_close_tab_refuses_foreign_tab_without_sending_close(self):
        mcp = self.fake('{"targetId":"OTHER","closed":false,"left":1}')
        with self.assertRaises(ab.AsideError) as caught:
            self.call(ab.close_tab())
        self.assertIn("Refused", str(caught.exception))
        self.assertEqual(len(mcp.calls), 1)
        with self.assertRaises(ab.AsideError):
            self.call(ab.close_tab("OTHER"))
        self.assertEqual(len(mcp.calls), 1)

    def test_force_closes_foreign_tab(self):
        mcp = self.fake("closed OTHER")
        self.call(ab.close_tab("OTHER", force=True))
        self.assertIn('"OTHER"', mcp.calls[0]["code"])

    def test_close_own_tabs_skips_other_tabs_and_forgets_closed_ones(self):
        ab._remember(["MINE", "GONE"], "https://example.com/")
        mcp = self.fake('{"closed":["MINE"]}')
        self.assertEqual(self.call(ab.close_own_tabs()), ["MINE"])
        self.assertEqual(len(mcp.calls), 1)
        self.assertIn('["MINE", "GONE"]', mcp.calls[0]["code"])
        self.assertEqual(ab._owned_tabs(), {})

    def test_close_own_tabs_with_no_owned_tab_makes_no_call(self):
        mcp = self.fake()
        self.assertEqual(self.call(ab.close_own_tabs()), [])
        self.assertEqual(mcp.calls, [])

    def test_tabs_opened_inside_run_become_owned_and_marker_is_hidden(self):
        self.fake("hello\n__ASIDE_OPENED__:[\"T9\"]")
        out = self.call(ab.run("const p = await openTab('https://example.com'); console.log('hello')"))
        self.assertEqual(out, "hello")
        self.assertIn("T9", ab._owned_tabs())

    def test_tabs_opened_before_an_error_are_still_owned(self):
        self.fake(RuntimeError("Error: TypeError: not a function\n    at <anonymous> (repl.js:1:5)\n__ASIDE_OPENED__:[\"T7\"]"))
        with self.assertRaises(ab.AsideError) as caught:
            self.call(ab.run("await openTab('https://example.com'); await page.nope()"))
        self.assertIn("T7", ab._owned_tabs())
        self.assertNotIn("__ASIDE_OPENED__", str(caught.exception))

    def test_ownership_survives_a_kernel_restart_and_is_per_session(self):
        ab._remember(["T1"], "https://example.com/")
        ab._owned.clear()
        self.assertIn("T1", ab._owned_tabs())
        with tempfile.TemporaryDirectory() as other, patch.dict(os.environ, {"RLM_SESSION_DIR": other}):
            self.assertNotIn("T1", ab._owned_tabs())

    def test_bulk_close_loop_is_refused_unless_forced(self):
        mcp = self.fake("ok")
        for code in (
            "for (const t of tabs) await t.close()",
            "for (const t of await listBrowserTabs()) await closeTab(t)",
            "tabs.forEach(t => closeTab(t))",
        ):
            with self.assertRaises(ab.AsideError):
                self.call(ab.run(code))
        self.assertEqual(mcp.calls, [])
        self.call(ab.run("for (const t of tabs) await t.close()", force=True))
        self.assertEqual(len(mcp.calls), 1)


class StaleTabSweepTests(Base):
    def entry(self, owner: str, pid: int, tabs: dict) -> str:
        path = ab._registry_path(owner)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"owner": owner, "host": ab.socket.gethostname(), "pid": pid, "start": ab._process_start(pid), "tabs": tabs}, fh)
        return path

    def dead_pid(self) -> int:
        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        proc.wait()
        return proc.pid

    def test_records_name_the_kernel_that_opened_the_tab(self):
        ab._remember(["T1"], "https://example.com/")
        with open(ab._registry_path(), encoding="utf-8") as fh:
            entry = json.load(fh)
        self.assertEqual((entry["pid"], entry["tabs"]), (os.getpid(), {"T1": "https://example.com/"}))
        self.assertTrue(ab._alive(entry))

    def test_tabs_of_an_exited_kernel_close_and_its_record_goes(self):
        gone = self.entry("/sessions/finished-job", self.dead_pid(), {"OLD1": "https://example.com/", "OLD2": "about:blank"})
        live = self.entry("/sessions/working-job", os.getpid(), {"LIVE": "https://example.com/"})
        mcp = self.fake('{"closed":["OLD1"]}')
        self.assertEqual(self.call(ab.sweep_stale_tabs()), ["OLD1"])
        self.assertEqual(len(mcp.calls), 1)
        self.assertIn('["OLD1", "OLD2"]', mcp.calls[0]["code"])
        self.assertNotIn("LIVE", mcp.calls[0]["code"])
        self.assertFalse(os.path.exists(gone))
        self.assertTrue(os.path.exists(live))

    def test_a_reused_pid_counts_as_exited(self):
        path = self.entry("/sessions/old-kernel", os.getpid(), {"OLD": "https://example.com/"})
        with open(path, encoding="utf-8") as fh:
            entry = json.load(fh)
        entry["start"] = "1"
        self.assertEqual(ab._alive(entry), not ab._process_start(os.getpid()))

    def test_nothing_stale_makes_no_browser_call(self):
        self.entry("/sessions/working-job", os.getpid(), {"LIVE": "https://example.com/"})
        mcp = self.fake()
        self.assertEqual(self.call(ab.sweep_stale_tabs()), [])
        self.assertEqual(mcp.calls, [])

    def test_open_tab_sweeps_first(self):
        self.entry("/sessions/finished-job", self.dead_pid(), {"OLD": "https://example.com/"})
        mcp = self.fake('{"closed":["OLD"]}', '{"title":"Gmail","url":"https://mail.google.com/","targetId":"T1"}')
        self.call(ab.open_tab("https://mail.google.com/"))
        self.assertIn("sweep stale tabs", mcp.calls[0]["title"])
        self.assertIn("openTab", mcp.calls[1]["code"])
        self.assertEqual(list(ab._owned_tabs()), ["T1"])


class BrowserRoutingTests(Base):
    def test_pages_that_need_no_login_go_to_the_box(self):
        with patch.object(ab, "box_available", return_value=True):
            for url in (
                "http://localhost:5176/page/domains/devops/duty-failures-2026-10-18.html",
                "https://us-metal02-dev.tail0c093d.ts.net/c96df5bd/#01a14d31",
                "http://100.83.139.73:25190/",
                "https://www.primeintellect.ai/blog",
                "https://example.com/?a",
            ):
                self.assertEqual(ab.browser_for(url), "box", url)

    def test_pages_with_the_owners_login_stay_in_aside(self):
        with patch.object(ab, "box_available", return_value=True):
            for url in (
                "https://mail.google.com/mail/u/0/#inbox",
                "https://search.google.com/search-console?resource_id=sc-domain%3Avirev.ai",
                "https://github.com/settings/apps/virev-ci-ctl",
                "https://app.geonode.com/unlimited-proxies?tab=statistics",
                "https://my.iwebfusion.net/clientarea.php?action=services",
                "https://www.reddit.com/r/Music/",
                "https://us.posthog.com/project/226805/experiments/476339",
                "chrome-extension://fjdhphbdlfjogobdofoaagnlnkoibdge/main.html",
                "about:blank",
            ):
                self.assertEqual(ab.browser_for(url), "aside", url)

    def test_box_off_sends_everything_to_aside(self):
        self.assertEqual(ab.browser_for("https://example.com/"), "aside")


@unittest.skipUnless(shutil.which("node") and os.path.isdir(os.path.join(ab.BOX_DIR, "node_modules", "playwright-core")), "box runner not installed")
class BoxBrowserTests(Base):
    def setUp(self):
        super().setUp()
        import http.server
        import threading

        page = b"<title>Box page</title><h1>Hello</h1><button onclick=\"document.title='clicked'\">Go</button>"

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(page)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/"
        os.environ["ASIDE_BROWSER_BOX"] = "1"

    def tearDown(self):
        if ab._box.proc:
            ab._box.proc.kill()
            ab._box.proc.wait()
            for pipe in (ab._box.proc.stdin, ab._box.proc.stdout):
                pipe.close()
            ab._box.proc = None
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def test_an_own_app_page_renders_on_the_box_with_the_repl_api_and_never_reaches_aside(self):
        mcp = self.fake("[]")
        async def flow():
            opened = await ab.open_tab(self.url)
            tree = await ab.snapshot()
            ref = [w for w in tree.split() if w.startswith("[ref=") and "Go" in tree.split("\n")[[i for i, l in enumerate(tree.split("\n")) if w in l][0]]][0][5:-1]
            await ab.run(f"await page.locator('{ref}').click()")
            title = await ab.run("return await page.title()")
            shot = await ab.screenshot(os.path.join(self.tmp.name, "box.png"))
            listed = await ab.tabs()
            closed = await ab.close_own_tabs()
            return opened, title, shot, listed, closed
        opened, title, shot, listed, closed = self.call(flow())
        self.assertIn("[aside-browser box]", opened)
        self.assertIn('"targetId":"box-1"', opened)
        self.assertEqual(title, "clicked")
        with open(shot, "rb") as fh:
            self.assertEqual(fh.read(4), b"\x89PNG")
        self.assertEqual([(t["targetId"], t["browser"], t["owned"]) for t in listed if t["browser"] == "box"], [("box-1", "box", True)])
        self.assertEqual(closed, ["box-1"])
        self.assertEqual([c["title"] for c in mcp.calls], ["list tabs"])


if __name__ == "__main__":
    unittest.main()


INCIDENT = (
    "const recips = await page.evaluate(() => [...document.querySelectorAll('span[email]')].slice(-4).map(e=>e.getAttribute('email')));\n"
    "await page.getByRole('button', {name: /^Send/}).last().click(); await sleep(2500);"
)
# The second send, "Hi Thomas" at 2026-10-10 07:19:18Z, nine minutes after c37 was recorded: the cell the "iwf ticket chase" child ran, verbatim
# (session 01a1245e, child sub-5bbdac13, line 29). INCIDENT above is the first send, "Hello Ryan" at 05:25:31Z (session 01a12443, line 62).
INCIDENT_2 = (
    "await page.getByRole('button',{name:/^Send/}).last().click(); await sleep(3000);\n"
    "return JSON.stringify(await page.evaluate(()=>({sent:document.body.innerText.includes('Message sent'), t:new Date().toISOString()})))"
)
GMAIL = '{"u": "https://mail.google.com/mail/u/0/#inbox/FMfcgzQXKWdRxl"}'
CHAT = "01a00000-0000-7000-8000-000000000001"


class BoardBase(Base):
    def setUp(self):
        super().setUp()
        board = {"v": 2, "rev": 1, "plan": [], "updatedAt": "2026-10-10T00:00:00Z", "todos": [
            {"id": "t1", "text": "Send this reply to support@vendor.example?", "done": True, "choices": ["Send it", "Not yet"],
             "from": "agent", "at": "2026-10-10T00:00:00Z", "reply": "Send it", "answeredBy": "owner"},
            {"id": "t2", "text": "Send this reply?", "done": True, "choices": ["Send it", "Not yet"],
             "from": "agent", "at": "2026-10-10T00:00:00Z", "reply": "Not yet", "answeredBy": "owner"},
            {"id": "t3", "text": "Send this reply?", "done": False, "choices": ["Send it", "Not yet"], "from": "agent", "at": "2026-10-10T00:00:00Z"},
        ]}
        os.makedirs(os.path.join(self.tmp.name, "chat", "boards"))
        with open(os.path.join(self.tmp.name, "chat", "boards", CHAT + ".json"), "w") as fh:
            json.dump(board, fh)
        data = patch.dict(os.environ, {"AGENT_CHAT_DATA_DIR": os.path.join(self.tmp.name, "chat")})
        data.start()
        self.addCleanup(data.stop)


class OutsideSendTests(BoardBase):
    def test_the_iwebfusion_send_click_is_refused_without_reaching_the_browser(self):
        mcp = self.fake(GMAIL)
        with self.assertRaises(ab.AsideError) as caught:
            self.call(ab.run(INCIDENT))
        self.assertIn("presses Send on a webmail page", str(caught.exception))
        self.assertIn("For you todo", str(caught.exception))
        self.assertEqual(len(mcp.calls), 1)
        self.assertNotIn("getByRole", mcp.calls[0]["code"])

    def test_the_second_iwebfusion_send_click_is_refused_without_reaching_the_browser(self):
        mcp = self.fake(GMAIL)
        with self.assertRaises(ab.AsideError) as caught:
            self.call(ab.run(INCIDENT_2))
        self.assertIn("presses Send on a webmail page", str(caught.exception))
        self.assertEqual(len(mcp.calls), 1)
        self.assertNotIn("getByRole", mcp.calls[0]["code"])

    def test_both_iwebfusion_send_clicks_leave_a_refused_line_in_the_send_log(self):
        # c37 reopened 10-12: VP of CI told the owner "no agent sent iWebFusion anything" because no record of these two clicks existed.
        thread = '{"u": "https://mail.google.com/mail/u/0/#search/iWF-457924/FMfcgzQhWnwcNVGhDhWXfbKkcGbTxJfj", "t": "Re: [Ticket ID: iWF-457924] - Gmail", "to": ["sieunpark77@gmail.com", "support@iwebfusion.net"]}'
        session = os.path.join(self.tmp.name, ".prime", "agent", "session-artifacts", "01a1245e-d97d-73c4-9eff-977bd5e1c827", "sub-5bbdac13")
        with patch.dict(os.environ, {"RLM_SESSION_DIR": session}):
            for code in (INCIDENT, INCIDENT_2):
                self.fake(thread)
                with self.assertRaises(ab.AsideError):
                    self.call(ab.run(code))
        lines = self.sends()
        self.assertEqual([line["decision"] for line in lines], ["refused", "refused"])
        for line in lines:
            self.assertEqual(line["layer"], "aside-browser")
            self.assertEqual(line["chat"], "01a1245e-d97d-73c4-9eff-977bd5e1c827")
            self.assertEqual(line["session"], "01a1245e-d97d-73c4-9eff-977bd5e1c827/sub-5bbdac13")
            self.assertIn("support@iwebfusion.net", line["target"])
            self.assertIn("mail.google.com", line["target"])
            self.assertIn("presses Send on a webmail page", line["reason"])
            self.assertIsNone(line["ownerOk"])

    def test_an_approved_send_leaves_an_allowed_line_with_its_owner_ok(self):
        self.fake(GMAIL, "sent")
        self.call(ab.run(INCIDENT, owner_ok=f"{CHAT}/t1"))
        self.assertEqual([(line["decision"], line["ownerOk"]) for line in self.sends()], [("allowed", f"{CHAT}/t1")])

    def test_a_token_that_does_not_count_is_logged_as_refused_with_the_token(self):
        self.fake(GMAIL)
        with self.assertRaises(ab.AsideError):
            self.call(ab.run(INCIDENT, owner_ok=f"{CHAT}/t2"))
        self.assertEqual([(line["decision"], line["ownerOk"]) for line in self.sends()], [("refused", f"{CHAT}/t2")])

    def test_a_call_with_owner_ok_that_the_page_check_cannot_read_still_gets_an_allowed_line(self):
        # 10-12 06:41Z, GeoNode support chat: the owner-approved note went out by page.mouse.click(1378,775) in the Intercom frame.
        self.fake('{"u": "https://app.geonode.com/dashboard", "t": "Geonode", "to": []}', "sent")
        self.call(ab.run("await page.mouse.click(1378,775); await sleep(4000); return 'sent'", owner_ok=f"{CHAT}/t1"))
        lines = self.sends()
        self.assertEqual([(line["decision"], line["ownerOk"]) for line in lines], [("allowed", f"{CHAT}/t1")])
        self.assertIn("app.geonode.com", lines[0]["target"])

    def test_cell_sends_finds_the_send_in_the_code_a_cell_passes_to_aside_browser(self):
        gmail = "https://mail.google.com/mail/u/0/#inbox"
        self.assertIn("presses Send", ab.cell_sends(f'r=await aside_browser("""{INCIDENT}""")\nprint(r)', gmail))
        self.assertIn("presses Send", ab.cell_sends(f'code = """{INCIDENT_2}"""\nawait aside_browser.run(code)', gmail))
        self.assertIn("asks the Aside agent to send", ab.cell_sends('await aside_browser.agent("Reply to the vendor email and send it.")'))
        self.assertIsNone(ab.cell_sends(f'test_src = """{INCIDENT}"""\nprint(ab.outside_send(test_src, "{gmail}"))', gmail), "quoted send code is no send")
        self.assertIsNone(ab.cell_sends('await aside_browser("await page.getByRole(\'button\', {name: \'Reply\'}).click()")', gmail))
        self.assertIn("passed owner_ok", ab.cell_sends('await aside_browser.run("await page.mouse.click(1378,775)", owner_ok=tok)'))
        self.assertIsNone(ab.cell_sends('await aside_browser.run("await page.mouse.click(1,2)", owner_ok=None)'))
        self.assertIsNone(ab.cell_sends('note = "pass owner_ok=tok to aside_browser.run"\nprint(note)'), "a cell that only names owner_ok is no send")

    def test_keyboard_send_shortcut_on_gmail_is_refused(self):
        self.fake(GMAIL)
        with self.assertRaises(ab.AsideError):
            self.call(ab.run("await page.keyboard.press('Meta+Enter')"))

    def test_send_on_a_composer_from_the_gmail_global_is_refused(self):
        self.fake('{"u": ""}')
        with self.assertRaises(ab.AsideError):
            self.call(ab.run("const r = await gmail.openReplyComposer(0, {threadId: 't'}); await r.locator('div[aria-label^=\"Send\"]').click()"))

    def test_submit_on_a_vendor_ticket_page_is_refused(self):
        self.fake('{"u": "https://clients.iwebfusion.net/viewticket.php?tid=457924"}')
        with self.assertRaises(ab.AsideError) as caught:
            self.call(ab.run("await page.getByRole('button', {name: 'Submit'}).click()"))
        self.assertIn("support ticket page", str(caught.exception))

    def test_aside_agent_task_that_sends_is_refused(self):
        mcp = self.fake()
        with self.assertRaises(ab.AsideError):
            self.call(ab.agent("In Gmail, reply to the vendor ticket email with this text and send it."))
        self.assertEqual(mcp.calls, [])

    def test_reading_and_drafting_gmail_pass(self):
        mcp = self.fake(GMAIL, "opened", "filled")
        self.call(ab.run("await page.getByRole('button', {name: 'Reply'}).last().click()"))
        self.call(ab.run("await page.locator('div[aria-label=\"Message Body\"]').last().click(); await page.keyboard.type('draft')"))
        self.assertEqual(len(mcp.calls), 3)
        mcp.replies.extend(["title", "thread text"])
        self.call(ab.run("return await page.evaluate(() => document.title)"))
        self.assertEqual(self.call(ab.agent("Read the vendor ticket thread. Do not send, reply or change anything.")), "thread text")

    def test_send_button_on_our_own_app_passes(self):
        mcp = self.fake('{"u": "http://localhost:5173/app/chat"}', "sent")
        self.assertEqual(self.call(ab.run("await page.getByRole('button', {name: 'Send'}).click()")), "sent")
        self.assertEqual(len(mcp.calls), 2)

    def test_approved_todo_lets_the_send_through(self):
        mcp = self.fake(GMAIL, "sent")
        self.assertEqual(self.call(ab.run(INCIDENT, owner_ok=f"{CHAT}/t1")), "sent")
        self.assertIn("getByRole", mcp.calls[1]["code"])

    def test_unapproved_or_unanswered_todo_is_refused(self):
        for token, why in ((f"{CHAT}/t2", "not a go"), (f"{CHAT}/t3", "not answered"), (f"{CHAT}/t9", "no todo"), ("junk", "is not")):
            self.fake(GMAIL)
            with self.assertRaises(ab.AsideError) as caught:
                self.call(ab.run(INCIDENT, owner_ok=token))
            self.assertIn(why, str(caught.exception), token)


class PageFakeMcp(FakeMcp):
    """Answers the send check's page URL probe with the tab URL and every other call with the given reply."""

    def __init__(self, url, reply):
        super().__init__([])
        self.url, self.reply = url, reply

    async def call_tool(self, server, tool, arguments):
        self.calls.append(arguments)
        if "JSON.stringify({u:" in str(arguments.get("code", "")):
            return json.dumps({"u": self.url})
        return self.reply


class OutsideSendGapTests(BoardBase):
    """Gap rows from the c37 gap table: chat, social, contact-form and ticket sends the run-time check must refuse."""


    def page(self, url, reply="sent"):
        mcp = PageFakeMcp(url, reply)
        module = types.ModuleType("rlm")
        module.mcp = mcp
        patcher = patch.dict(sys.modules, {"rlm": module})
        patcher.start()
        self.addCleanup(patcher.stop)
        return mcp

    def sent_code(self, mcp):
        return [c["code"] for c in mcp.calls if "code" in c and "JSON.stringify({u:" not in c["code"]]

    def assert_refused(self, code, url, call="run"):
        mcp = self.page(url)
        with self.assertRaises(ab.AsideError) as caught:
            if call == "_repl":
                self.call(ab._repl(code, "t"))
            else:
                self.call(ab.run(code))
        self.assertIn("For you todo", str(caught.exception), code)
        self.assertFalse(any(code in sent for sent in self.sent_code(mcp)), f"{code} reached the browser")

    def test_ab9_whmcs_reply_button_on_a_ticket_page(self):
        self.assert_refused("await page.fill('#inputMessage','hi'); await page.click('#btnReply')", "https://my.geonode.com/viewticket.php?tid=ABC")

    def test_ab11_enter_on_a_zendesk_request_page(self):
        self.assert_refused("await page.fill('textarea','hi'); await page.keyboard.press('Enter')", "https://acme.zendesk.com/hc/requests/123")

    def test_ab12_intercom_messenger_on_a_vendor_dashboard(self):
        self.assert_refused(
            "await page.frameLocator('iframe[name=intercom-messenger-frame]').locator('textarea').fill('hi'); await page.keyboard.press('Enter')",
            "https://app.geonode.com/dashboard",
        )

    def test_ab13_contact_form_submit(self):
        self.assert_refused(
            "await page.fill('#email','me@x.com'); await page.fill('#msg','hi'); await page.click('button[type=submit]')",
            "https://www.vendor.com/contact",
        )

    def test_ab16_discord_web_enter(self):
        self.assert_refused("await page.keyboard.type('hi'); await page.keyboard.press('Enter')", "https://discord.com/channels/1/2")

    def test_ab17_linkedin_skill_send_message_and_invitation(self):
        self.assert_refused("await linkedin.sendMessage({recipients:['johndoe'], text:'Hi'})", "https://www.linkedin.com/feed/")
        self.assert_refused("await linkedin.sendInvitation({profile:'johndoe', note:'Hi'})", "https://example.com/")

    def test_ab18_x_post_button(self):
        self.assert_refused("await page.getByTestId('tweetButtonInline').click()", "https://x.com/home")
        self.assert_refused("await page.getByRole('button', {name: 'Post'}).click()", "https://x.com/compose/post")

    def test_ab19_imessage_skill_send(self):
        self.assert_refused("await imessage.send({to:'+14155551212', text:'hi'})", "https://example.com/")

    def test_ab21_private_repl_also_refuses_a_send(self):
        self.assert_refused("await page.getByRole('button',{name:'Send'}).click()", "https://mail.google.com/mail/u/0/#inbox?compose=new", call="_repl")

    def test_agent_task_to_dm_on_linkedin_is_refused(self):
        mcp = self.fake()
        with self.assertRaises(ab.AsideError):
            self.call(ab.agent("DM Jane Doe on LinkedIn and tell her we can start the campaign next week."))
        self.assertEqual(mcp.calls, [])

    def test_approved_todo_lets_a_discord_send_through(self):
        mcp = self.page("https://discord.com/channels/1/2")
        self.assertEqual(self.call(ab.run("await page.keyboard.type('hi'); await page.keyboard.press('Enter')", owner_ok=f"{CHAT}/t1")), "sent")
        self.assertTrue(any("keyboard.press" in sent for sent in self.sent_code(mcp)))

    def test_ab23_slack_stays_allowed(self):
        self.page("")
        self.assertEqual(self.call(ab.agent("Message Alex on Slack that the invoice is paid.")), "sent")
        self.page("https://app.slack.com/client/T05/C0")
        self.assertEqual(self.call(ab.run("await page.locator('.ql-editor').fill('hi'); await page.keyboard.press('Enter')")), "sent")
        self.page("")
        self.assertEqual(self.call(ab.run("const c = await slack.getClient('T05'); await c.chat.postMessage({channel:'C0', text:'hi'})")), "sent")

    def test_typing_on_chat_and_social_pages_without_a_send_passes(self):
        for url, code in (
            ("https://discord.com/channels/1/2", "await page.keyboard.type('draft')"),
            ("https://x.com/home", "return await page.evaluate(() => document.title)"),
            ("https://www.linkedin.com/feed/", "await page.getByRole('link', {name: 'Messaging'}).click()"),
            ("https://www.vendor.com/contact", "await page.fill('#msg','draft')"),
        ):
            self.page(url, "ok")
            self.assertEqual(self.call(ab.run(code)), "ok", url)

    def test_github_sign_in_pages_pass_and_other_github_pages_stay_checked(self):
        """Owner 10-14 (c4): agents start and finish GitHub sign-ins in Aside themselves, `gh auth login --web` included."""
        for url, code in (
            ("https://github.com/login", "await page.fill('#login_field','x'); await page.keyboard.press('Enter')"),
            ("https://github.com/login/device", "await page.fill('#user-code-0','ABCD'); await page.getByRole('button', {name: 'Continue'}).click()"),
            ("https://github.com/login/device/confirmation", "await page.keyboard.press('Enter')"),
            ("https://github.com/login/oauth/authorize?client_id=x", "await page.click('button[type=submit]')"),
            ("https://github.com/sessions/two-factor/app", "await page.fill('#app_totp','123456'); await page.keyboard.press('Enter')"),
        ):
            self.assertIsNone(ab.outside_send(code, url), url)
        self.assertIsNotNone(ab.outside_send("await page.keyboard.press('Enter')", "https://github.com/other/repo/issues/1"))


CLICK_PAGE = """
class Mouse {
  constructor(p) { this.p = p; }
  async move(x, y) { this.p.log.push(["move", x, y]); }
  async down() { this.p.log.push(["down"]); }
  async up() { this.p.log.push(["up"]); }
  async click(x, y) { await this.move(x, y); await this.down(); await this.up(); }
}
const spec = JSON.parse(process.argv[process.argv.length - 1]);
const p = {log: [], url: () => spec.url, evaluate: async (fn, arg) => ({title: "T", frame: spec.frame || "", label: spec.label || ""})};
p.mouse = new Mouse(p);
globalThis.page = p;
globalThis.tabs = [p];
(async () => {
  const out = {};
  try { await eval("(async () => { " + spec.code + " })()"); } catch (e) { out.error = String(e); }
  out.log = p.log.map((e) => e[0]);
  console.log(JSON.stringify(out));
})();
"""


@unittest.skipUnless(shutil.which("node"), "the click guard runs in a JS REPL")
class CoordinateClickTests(BoardBase):
    """p345: page.mouse.click(x, y) on a Send button with no owner_ok left no send log line, because the page check reads only the code."""

    def click(self, url, label="", frame="", code="await page.mouse.click(5, 6);"):
        spec = json.dumps({"url": url, "label": label, "frame": frame, "code": ab.guard_clicks(code)})
        proc = subprocess.run(["node", "-e", CLICK_PAGE, spec], capture_output=True, text=True, timeout=60)
        return json.loads(proc.stdout.strip().splitlines()[-1])

    def assert_click_refused(self, out, why):
        self.assertIn(ab._CLICK_MARK, out.get("error", ""), out)
        self.assertIn(why, out["error"])
        self.assertEqual(out["log"], [])

    def test_send_on_gmail_by_coordinates_is_refused_before_the_mouse_goes_down(self):
        self.assert_click_refused(self.click("https://mail.google.com/mail/u/0/#inbox?compose=new", "Send \u202a(\u2318Enter)\u202c"), "clicks Send by coordinates on a webmail page")

    def test_submit_on_a_ticket_page_and_a_click_into_an_intercom_frame_are_refused(self):
        self.assert_click_refused(self.click("https://my.geonode.com/viewticket.php?tid=ABC", "Submit"), "support ticket page")
        self.assert_click_refused(self.click("https://app.geonode.com/dashboard", frame="intercom-messenger-frame  https://js.intercomcdn.com/x"), "support chat widget")

    def test_a_mouse_down_at_the_point_of_a_mouse_move_is_checked_on_any_tab(self):
        out = self.click("https://mail.google.com/mail/u/0/#inbox", "Send", code="const t = tabs[0]; await tabs[0].mouse.move(5, 6); await t.mouse.down();")
        self.assertIn("clicks Send by coordinates", out.get("error", ""), out)
        self.assertEqual(out["log"], ["move"])

    def test_other_clicks_pass(self):
        for url, label in (("https://mail.google.com/mail/u/0/#inbox", "Inbox"), ("http://localhost:5182/", "Send"), ("https://app.example.com/", "Send"),
                           ("https://github.com/login/oauth/authorize?client_id=x", "Submit")):
            self.assertEqual(self.click(url, label), {"log": ["move", "down", "up"]}, url)
        self.assertEqual(ab.guard_clicks("return page.url()"), "return page.url()")
        self.assertIn("social or chat site", self.click("https://github.com/other/repo/pull/1", "Submit").get("error", ""))

    def test_run_sends_the_guard_and_logs_a_refused_click(self):
        line = ab._CLICK_MARK + json.dumps({"reason": "it clicks Send by coordinates on a webmail page (https://mail.google.com/mail/u/0/)", "target": "https://mail.google.com/mail/u/0/ | Gmail | clicked \"Send\" at (1378, 775)"})
        mcp = self.fake(RuntimeError(f"Error: Error: {line}\n    at <anonymous> (repl.js:1:82)\n{line}"))
        with self.assertRaises(ab.AsideError) as caught:
            self.call(ab.run("await page.mouse.click(1378, 775)"))
        self.assertIn("Refused: it clicks Send by coordinates", str(caught.exception))
        self.assertIn("globalThis.__asideSendClick.mouse(page).click(1378, 775)", mcp.calls[0]["code"])
        lines = self.sends()
        self.assertEqual([(l["decision"], l["layer"], l["ownerOk"]) for l in lines], [("refused", "aside-browser", None)])
        self.assertIn("at (1378, 775)", lines[0]["target"])

    def test_an_approved_owner_ok_leaves_the_click_unchecked(self):
        mcp = self.fake('{"u": "https://app.geonode.com/dashboard", "t": "Geonode", "to": []}', "sent")
        self.call(ab.run("await page.mouse.click(1378,775)", owner_ok=f"{CHAT}/t1"))
        self.assertNotIn("__asideSendClick", mcp.calls[1]["code"])

    def test_a_token_that_does_not_count_keeps_the_click_check_and_logs_no_allowed_line(self):
        mcp = self.fake('{"u": "https://app.geonode.com/dashboard", "t": "Geonode", "to": []}', "ok")
        self.call(ab.run("await page.mouse.click(1378,775)", owner_ok=f"{CHAT}/t2"))
        self.assertIn("__asideSendClick.mouse(page).click(", mcp.calls[1]["code"])
        self.assertEqual(self.sends(), [])

    def test_code_without_a_mouse_call_gets_no_guard(self):
        mcp = self.fake("ok")
        self.call(ab.run("return page.url()"))
        self.assertNotIn("__asideSendClick", mcp.calls[0]["code"])
