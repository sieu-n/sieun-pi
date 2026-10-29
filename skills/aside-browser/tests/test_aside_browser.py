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
from unittest.mock import AsyncMock, Mock, patch

import aside_browser as ab

# Error texts copied from live Aside daemon 1.26.1001.14 probes (2026-10-01).
LIVE_DOCUMENT = "Error: ReferenceError: 'document' is not defined\n    at <eval> (repl.js:1:13)\n"
LIVE_WAIT_FOR_TIMEOUT = "Error: TypeError: not a function\n    at <anonymous> (repl.js:1:47)\n"
LIVE_SLEEP_IN_PAGE = (
    "Error: Error: ReferenceError: sleep is not defined\n    at <anonymous>:1:63\n    at <anonymous>:1:82\n"
    "    at AsidePage.evaluate (file:///Aside%20Daemon.app/Contents/MacOS/aside-daemon:3807:22224)\n"
)
LIVE_REDECLARED = "Error: SyntaxError: Identifier 'x' has already been declared\n"
# Live text from Aside daemon 1.26.1022.144 on 2026-10-22, after the owner closed his last Aside window.
LIVE_NOT_CONNECTED = (
    'Aside Browser profile for account u0 \u2014 sieu***@gmail.com ("Profile 0") is not connected to the daemon. '
    "Make sure that profile is running, or pick another account with --account."
)


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

    def test_every_wrapped_call_reports_the_tabs_it_opens(self):
        # 10-28: the owner's Aside held 10 job tabs on localhost:5180 that no record named; a tab opened by a click went unrecorded.
        self.assertIn("__asideBefore", ab.wrap_code("console.log(1)"))
        self.assertIn("__asideBefore", ab.wrap_code("await page.click('a[target=_blank]')"))

    def test_a_tab_a_click_opens_is_owned(self):
        mcp = self.fake('clicked\n' + ab._OPENED_MARK + '["NEWTAB1"]')
        out = self.call(ab.run("await page.click('a[target=_blank]')"))
        self.assertNotIn(ab._OPENED_MARK, out)
        self.assertIn("NEWTAB1", ab._owned_tabs())
        self.assertIn("__asideBefore", mcp.calls[0]["code"])

    def test_run_sends_wrapped_code_and_raw_when_asked(self):
        mcp = self.fake("ok", "ok")
        self.call(ab.run("const x = 1"))
        self.call(ab.run("const x = 1", wrap=False))
        self.assertTrue(mcp.calls[0]["code"].startswith("await (async () => { " + ab._TRACK_HEAD + "const x = 1"))
        raw = mcp.calls[1]["code"]
        self.assertIn("; const x = 1\n", raw)
        self.assertNotIn("async () =>", raw)
        self.assertIn("globalThis.__asideBefore", raw)


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

    def test_a_profile_with_no_open_window_says_why_and_what_not_to_do(self):
        """10-22 01:08Z: the owner closed his last Aside window, the profile bridge dropped, and a job blamed its 1 MB upload."""
        self.fake(RuntimeError(LIVE_NOT_CONNECTED))
        with self.assertRaises(ab.AsideError) as caught:
            self.call(ab.run("return 1"))
        self.assertIn("not connected to the daemon", str(caught.exception))
        self.assertIn("no open window", caught.exception.hint)
        self.assertIn("c103", caught.exception.hint)


# Live text from `aside repl "await sleep(125000)"` on the owner's Mac, 2026-10-28, while Aside and its daemon were up.
LIVE_LIMIT = (
    "fetch failed: other side closed\nAside isn't running on this machine.\n  - Start Aside Browser and retry, or\n"
    "  - control another machine / Aside Cloud instead: run 'aside login' once, then 'aside exec --host <host>' (see 'aside host list')."
)


class CallLimitTests(Base):
    """10-27 13:23Z to 23:44Z: the 5180 jobs read 'Aside isn't running' 104 times while Aside was up, and each one was a REPL call that waited past Aside's 120 s limit."""

    def run_with_clock(self, error, seconds):
        self.fake(RuntimeError(error))
        clock = types.SimpleNamespace(monotonic=Mock(side_effect=[0.0, seconds]))
        with patch.object(ab, "time", clock), self.assertRaises(ab.AsideError) as caught:
            self.call(ab.run("await page.waitForSelector('#late', {timeout: 150000})"))
        return caught.exception

    def test_a_call_closed_at_the_limit_says_aside_is_still_running(self):
        err = self.run_with_clock(LIVE_LIMIT, 120.3)
        self.assertIn("past Aside's 120 s limit", str(err))
        self.assertIn("Aside is still running", str(err))
        self.assertNotIn("isn't running on this machine", str(err))
        self.assertIn("well under 120 s", err.hint)

    def test_a_quick_closed_connection_keeps_aside_s_own_text(self):
        err = self.run_with_clock(LIVE_LIMIT, 3.0)
        self.assertIn("isn't running on this machine", str(err))


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
        self.assertIn('["T1"].includes(__cur)', mcp.calls[1]["code"])
        self.assertNotIn("T1", ab._owned_tabs())

    def test_open_tab_closes_this_sessions_earlier_tabs(self):
        """2026-10-28: jobs held up to 4 Aside tabs each (36 tabs, 8.3 GB) because each open_tab() added one."""
        ab._remember(["T0"], "https://example.com/old")
        mcp = self.fake('{"title":"Example","url":"https://example.com/","targetId":"T1","closed":["T0"]}')
        out = self.call(ab.open_tab("https://example.com", browser="aside"))
        self.assertIn('["T0"].filter(i => i !== __p.targetId)', mcp.calls[0]["code"])
        self.assertIn("runBeforeUnload: true", mcp.calls[0]["code"])
        self.assertEqual(list(ab._owned_tabs()), ["T1"])
        self.assertIn("Closed 1 earlier tab(s)", out)

    def test_open_tab_keep_leaves_earlier_tabs_open(self):
        ab._remember(["T0"], "https://example.com/old")
        mcp = self.fake('{"title":"Example","url":"https://example.com/","targetId":"T1"}')
        out = self.call(ab.open_tab("https://example.com", browser="aside", keep=True))
        self.assertIn("for (const __id of [])", mcp.calls[0]["code"])
        self.assertEqual(sorted(ab._owned_tabs()), ["T0", "T1"])
        self.assertNotIn("earlier tab", out)

    def test_close_own_tabs_keeps_the_record_of_a_tab_that_stayed_open(self):
        ab._remember(["MINE", "STUCK"], "https://example.com/")
        self.fake('{"closed":["MINE"],"left":["STUCK"]}')
        self.assertEqual(self.call(ab.close_own_tabs()), ["MINE"])
        self.assertEqual(list(ab._owned_tabs()), ["STUCK"])

    def test_close_own_tabs_from_a_process_with_no_prime_host_uses_the_cli(self):
        """sieun-rules' aside-tabs.ts closes a job's tabs at its turn end from a fresh kernel-venv python, where rlm.mcp has no host."""
        ab._remember(["MINE"], "https://example.com/")
        try:
            raise RuntimeError("repl runtime is not serving")
        except RuntimeError as cause:
            no_host = RuntimeError("Could not load MCP configuration for 'aside'")
            no_host.__cause__ = cause
        self.fake(no_host)
        ran = subprocess.CompletedProcess([], 0, stdout='[ok | 20ms]\n{"closed":["MINE"],"left":[]}\n', stderr="")
        with patch.object(ab.subprocess, "run", return_value=ran) as cli:
            self.assertEqual(self.call(ab.close_own_tabs()), ["MINE"])
        self.assertEqual(cli.call_args.args[0][1], "repl")
        self.assertIn('["MINE"]', cli.call_args.args[0][2])
        self.assertEqual(ab._owned_tabs(), {})
        self.assertFalse(os.path.exists(ab._registry_path()))

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

    def test_a_tab_that_closetab_only_detached_gets_page_close_and_keeps_its_record_until_gone(self):
        """2026-10-28: Aside's closeTab() of another REPL session's tab only detaches it, so sweeps dropped records of 25 open tabs."""
        gone = self.entry("/sessions/finished-job", self.dead_pid(), {"OLD": "https://example.com/"})
        mcp = self.fake('{"closed":[],"left":["OLD"]}', '{"closed":["OLD"],"left":[]}')
        self.assertEqual(self.call(ab.sweep_stale_tabs()), [])
        self.assertIn("await __t.close({runBeforeUnload: true})", mcp.calls[0]["code"])
        self.assertTrue(os.path.exists(gone))
        self.assertEqual(self.call(ab.sweep_stale_tabs()), ["OLD"])
        self.assertFalse(os.path.exists(gone))

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


class SignInHintTests(Base):
    def test_an_aside_sign_in_page_says_to_click_the_saved_login(self):
        """Owner 10-19 (c129): a job read empty boxes on Cloudflare's sign-in page in Aside and asked him to sign in, while Aside held his saved login."""
        self.fake('{"title":"Cloudflare Dashboard | Manage Your Account","url":"https://dash.cloudflare.com/login","targetId":"T1"}')
        out = self.call(ab.open_tab("https://dash.cloudflare.com/", browser="aside"))
        self.assertIn(ab._ASIDE_SIGN_IN_HINT, out)

    def test_a_signed_in_aside_page_gets_no_hint(self):
        self.fake('{"title":"Cloudflare","url":"https://dash.cloudflare.com/9d0e/home","targetId":"T1"}')
        out = self.call(ab.open_tab("https://dash.cloudflare.com/", browser="aside"))
        self.assertNotIn("[aside-browser hint]", out)


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

    def test_bracketed_ipv6_pages_on_this_host_go_to_the_box(self):
        with patch.object(ab, "box_available", return_value=True):
            for url in ("http://[::1]:5180/", "http://[::1]/configure", "http://[fd7a:115c:a1e0::5]:5180/x"):
                self.assertEqual(ab.browser_for(url), "box", url)
                self.assertIsNone(ab._host_kind(url), url)

    def run_routed(self, code):
        mcp = self.fake("aside out")
        box = AsyncMock(return_value="box out")
        with patch.object(ab, "box_available", return_value=True), patch.object(ab, "_box_call", box):
            out = self.call(ab.run(code))
        return out, mcp.calls, box.await_count

    def test_run_before_any_tab_uses_the_box(self):
        ab._browser = None
        self.assertEqual(self.run_routed("return 1"), ("box out", [], 1))

    def test_run_opens_each_url_in_the_browser_browser_for_picks(self):
        self.assertEqual(self.run_routed("await openTab('http://[::1]:5180/')")[0], "box out")
        self.assertEqual(ab._browser, "box")
        self.assertEqual(self.run_routed('const p = await openTab("https://github.com/settings/tokens")')[0], "aside out")
        self.assertEqual(ab._browser, "aside")

    def test_site_skill_globals_run_in_aside(self):
        ab._browser = "box"
        self.assertEqual(self.run_routed("return await googleDocs.getDocumentHTML(id)")[0], "aside out")

    def test_email_literals_and_hosts_do_not_count_as_site_globals(self):
        for code in (
            "await page.fill('#email', 'sieunpark77@gmail.com')",
            'return "a.b@gmail.com, c@outlook.com, d@notion.so"',
            "await openTab('http://localhost:5182/?to=sieunpark77@gmail.com')",
            "const host = 'slack.green'; return host",
            "await page.fill('#q', 'gmail.com slack.green')",
        ):
            ab._browser = "box"
            self.assertEqual(self.run_routed(code)[0], "box out", code)

    def test_gmail_urls_and_site_global_calls_run_in_aside(self):
        for code in (
            "await openTab('https://gmail.com/')",
            "await openTab('https://mail.google.com/mail/u/0/#inbox')",
            "await page.goto('https://mail.google.com/mail/u/0/#inbox')",
            "await page.goto(`//gmail.com`)",
            "return await gmail.search({query: 'from:sieunpark77@gmail.com'})",
            "return await gmail.messages.list()",
        ):
            ab._browser = "box"
            self.assertEqual(self.run_routed(code)[0], "aside out", code)


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
        self.assertEqual(mcp.calls, [])

    def test_a_second_open_tab_replaces_the_first_on_the_box_unless_keep(self):
        mcp = self.fake()
        async def flow():
            first = await ab.open_tab(self.url)
            second = await ab.open_tab(self.url + "?b")
            after_second = [t["targetId"] for t in await ab.tabs("box")]
            await ab.open_tab(self.url + "?c", keep=True)
            after_keep = [t["targetId"] for t in await ab.tabs("box")]
            await ab.close_tab()
            after_close = [t["targetId"] for t in await ab.tabs("box")]
            return first, second, after_second, after_keep, after_close
        first, second, after_second, after_keep, after_close = self.call(flow())
        self.assertIn('"targetId":"box-1"', first)
        self.assertIn('"closed":["box-1"]', second)
        self.assertEqual(after_second, ["box-2"])
        self.assertEqual(sorted(after_keep), ["box-2", "box-3"])
        self.assertEqual(after_close, ["box-2"])
        self.assertEqual(mcp.calls, [])

    def test_the_box_browser_is_headful_on_its_own_display_and_leaves_nothing_when_killed(self):
        if not os.path.exists(os.path.expanduser("~/.local/opt/xvfb/usr/bin/Xvfb-localxkb")) and not shutil.which("Xvfb"):
            self.skipTest("no Xvfb on this host")
        ab._browser = None
        self.fake()
        async def flow():
            await ab.run(f"await openTab({json.dumps(self.url)})")
            return await ab.run("return await page.evaluate(() => [navigator.userAgent, document.visibilityState].join(' '))")
        agent = self.call(flow())
        self.assertNotIn("Headless", agent)
        self.assertIn("visible", agent)
        runner = ab._box.proc.pid
        kids = subprocess.run(["ps", "-o", "pid=,args=", "--ppid", str(runner)], capture_output=True, text=True).stdout
        self.assertIn("Xvfb", kids)
        self.assertIn("chrome", kids)
        profile = [n for n in os.listdir(tempfile.gettempdir()) if n.startswith(f"aside-box-{runner}-")]
        self.assertEqual(len(profile), 1)
        ab._box.proc.kill()
        ab._box.proc.wait()
        pids = [int(line.split()[0]) for line in kids.splitlines()]
        # measured: on 2026-10-19 Xvfb and Chrome were both gone 2 s after the runner's SIGKILL.
        def running(pid):
            try:
                with open(f"/proc/{pid}/stat") as fh:
                    return fh.read().rsplit(")", 1)[1].split()[0] != "Z"
            except FileNotFoundError:
                return False
        for _ in range(100):
            alive = [p for p in pids if running(p)]
            if not alive:
                break
            asyncio.run(asyncio.sleep(0.1))
        self.assertEqual(alive, [])


class MacRemoteBoxTests(Base):
    """10-29: the Mac read unusable while job tabs on localhost:5180 held up to 5.34 GB of the owner's Aside, so the Mac's box runs on us-metal02."""

    def test_on_the_mac_a_local_app_page_goes_to_a_box_runner_on_us_metal02(self):
        env = {k: v for k, v in os.environ.items() if k not in ("ASIDE_BROWSER_BOX_HOST", "ASIDE_BROWSER_LOOPBACK_HOST")}
        env["ASIDE_BROWSER_BOX"] = "1"
        with patch.dict(os.environ, env, clear=True), patch.object(ab.sys, "platform", "darwin"), patch.object(ab.shutil, "which", return_value="/usr/bin/ssh"):
            self.assertTrue(ab.box_available())
            self.assertEqual(ab.browser_for("http://localhost:5180/app/inbox"), "box")
            self.assertEqual(ab.browser_for("http://cc.localhost:5180/app/inbox"), "box")
            self.assertEqual(ab.browser_for("https://mail.google.com/mail/u/0/#inbox"), "aside")
            command, cwd = ab._BoxRunner()._command()
        self.assertEqual(command[:5], ["ssh", "-T", "-o", "BatchMode=yes", "us-metal02"])
        self.assertIn("BOX_LOOPBACK_VIA=mac exec node box.mjs", command[-1])
        self.assertIsNone(cwd)

    def test_a_linux_box_still_runs_its_runner_here(self):
        env = {k: v for k, v in os.environ.items() if k != "ASIDE_BROWSER_BOX_HOST"}
        with patch.dict(os.environ, env, clear=True), patch.object(ab.sys, "platform", "linux"), patch.object(ab, "_node", return_value="/usr/bin/node"):
            command, cwd = ab._BoxRunner()._command()
        self.assertEqual(command, ["/usr/bin/node", os.path.join(ab.BOX_DIR, "box.mjs")])
        self.assertEqual(cwd, ab.BOX_DIR)


def _ssh_to_self() -> bool:
    if not shutil.which("ssh"):
        return False
    return subprocess.run(["ssh", "-o", "BatchMode=yes", "localhost", "true"], capture_output=True).returncode == 0


@unittest.skipUnless(sys.platform == "linux" and os.path.isdir(os.path.join(ab.BOX_DIR, "node_modules", "playwright-core")) and _ssh_to_self(),
                     "needs the box runner and ssh to localhost")
class RemoteBoxRunnerTests(Base):
    """The Mac's path end to end with localhost standing in for both us-metal02 and the Mac: runner over ssh, page through ssh -D."""

    def setUp(self):
        super().setUp()
        import http.server
        import threading

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<title>Mac app</title><h1>served on the loopback host</h1><button>Go</button>")

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://localhost:{self.server.server_address[1]}/"
        self.remote = patch.dict(os.environ, {"ASIDE_BROWSER_BOX": "1", "ASIDE_BROWSER_BOX_HOST": "localhost", "ASIDE_BROWSER_LOOPBACK_HOST": "localhost"})
        self.remote.start()
        self.dir = patch.object(ab, "REMOTE_BOX_DIR", ab.BOX_DIR)
        self.dir.start()
        ab._browser = None

    def tearDown(self):
        if ab._box.proc:
            ab._box.proc.kill()
            ab._box.proc.wait()
            for pipe in (ab._box.proc.stdin, ab._box.proc.stdout):
                pipe.close()
            ab._box.proc = None
        self.dir.stop()
        self.remote.stop()
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def test_a_local_app_page_renders_in_the_remote_runner_through_the_tunnel(self):
        mcp = self.fake()
        async def flow():
            opened = await ab.open_tab(self.url)
            text = await ab.run("return await page.evaluate(() => document.body.innerText)")
            shot = await ab.screenshot(os.path.join(self.tmp.name, "remote.png"))
            return opened, text, shot
        opened, text, shot = self.call(flow())
        self.assertIn('"targetId":"box-1"', opened)
        self.assertEqual(text.split("\n")[0].strip(), "served on the loopback host")
        with open(shot, "rb") as fh:
            self.assertEqual(fh.read(4), b"\x89PNG")
        self.assertEqual(ab._box.proc.args[:5], ["ssh", "-T", "-o", "BatchMode=yes", "localhost"])
        tunnels = subprocess.run(["pgrep", "-f", "ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -D 127.0.0.1:"], capture_output=True, text=True).stdout
        self.assertTrue(tunnels.strip())
        self.assertEqual(mcp.calls, [])


class IdleParkTests(Base):
    """10-29: 15 of the owner's 17 Aside tabs were live 5180 jobs' and held about 9 GB while his Mac paged, though 74% of the time those
    jobs held a tab fell in gaps over 120 s between their calls."""

    def setUp(self):
        super().setUp()
        self.job = os.path.join(self.tmp.name, "sub-1234abcd")
        os.environ["RLM_SESSION_DIR"] = self.job
        ab._parked.clear()
        self.addCleanup(ab._hold_park)
        self.addCleanup(ab._parked.clear)

    def cli(self, *replies):
        calls = []
        def fake_run(argv, **kwargs):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, stdout=replies[len(calls) - 1], stderr="")
        patcher = patch.object(ab.subprocess, "run", side_effect=fake_run)
        patcher.start()
        self.addCleanup(patcher.stop)
        return calls

    def test_a_job_tab_on_a_local_app_arms_the_idle_close_after_each_call(self):
        self.fake('{"title":"Virev","url":"http://[::1]:5180/app","targetId":"T1"}')
        self.call(ab.open_tab("http://[::1]:5180/app", browser="aside"))
        self.assertIsNotNone(ab._park_timer)
        self.assertEqual(ab._park_timer.interval, ab.PARK_S)

    def test_no_idle_close_for_a_top_level_chat_or_a_page_off_our_local_apps(self):
        ab._remember(["T1"], "https://mail.google.com/mail/u/0/")
        ab._arm_park()
        self.assertIsNone(ab._park_timer)
        os.environ["RLM_SESSION_DIR"] = self.tmp.name
        ab._owned.clear()
        ab._remember(["T2"], "http://localhost:5180/app")
        ab._arm_park()
        self.assertIsNone(ab._park_timer)

    def test_an_idle_tab_closes_and_the_next_screenshot_opens_its_url_again(self):
        ab._remember(["T1"], "http://localhost:5180/app")
        calls = self.cli('{"closed":["T1"],"urls":{"T1":"http://localhost:5180/app/campaigns?world=w1","OWNER":"https://mail.google.com/"}}')
        self.assertEqual(ab._park_idle(ab._park_gen), ["T1"])
        self.assertIn('["T1"].filter(i => !__listed.some(t => t.targetId === i && t.active))', calls[0][2])
        self.assertEqual(ab._owned_tabs(), {})
        mcp = self.fake('{"title":"Virev","url":"http://localhost:5180/app/campaigns?world=w1","targetId":"T2"}', ab._B64_MARK + "aGk=")
        with patch("builtins.print") as printed:
            path = self.call(ab.screenshot(os.path.join(self.tmp.name, "shot.png")))
        self.assertIn('openTab("http://localhost:5180/app/campaigns?world=w1")', mcp.calls[0]["code"])
        self.assertIn("page.screenshot", mcp.calls[1]["code"])
        self.assertTrue(os.path.exists(path))
        self.assertIn("opened http://localhost:5180/app/campaigns?world=w1 again", printed.call_args[0][0])
        self.assertEqual(list(ab._owned_tabs()), ["T2"])

    def test_a_call_after_the_timer_was_armed_keeps_the_tab(self):
        ab._remember(["T1"], "http://localhost:5180/app")
        calls = self.cli()
        armed = ab._park_gen
        ab._hold_park()
        self.assertEqual(ab._park_idle(armed), [])
        self.assertEqual(calls, [])
        self.assertIn("T1", ab._owned_tabs())

    def test_open_tab_after_an_idle_close_opens_only_the_new_page(self):
        ab._parked["T1"] = "http://localhost:5180/app"
        mcp = self.fake('{"title":"Virev","url":"http://localhost:5180/app/outreach","targetId":"T3"}')
        self.call(ab.open_tab("http://localhost:5180/app/outreach", browser="aside"))
        self.assertEqual(len(mcp.calls), 1)
        self.assertNotIn('openTab("http://localhost:5180/app")', "".join(call["code"] for call in mcp.calls))
        self.assertEqual(ab._parked, {})

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
            ("https://github.com/settings/tokens/new?scopes=read:packages", "await page.getByRole('button',{name:'Send a code via email'}).click()"),
        ):
            self.assertIsNone(ab.outside_send(code, url), url)
        self.assertIsNotNone(ab.outside_send("await page.keyboard.press('Enter')", "https://github.com/other/repo/issues/1"))
        self.assertIsNotNone(ab.outside_send("await page.getByRole('button',{name:'Send'}).click()", "https://github.com/settingsx/repo/issues/1"))


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
