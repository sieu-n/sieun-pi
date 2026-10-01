"""Unit tests for aside_browser. No browser: `rlm.mcp` is a fake. Live checks are separate."""

from __future__ import annotations

import asyncio
import json
import os
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
        self.env = patch.dict(os.environ, {"RLM_SESSION_DIR": self.tmp.name})
        self.env.start()
        ab._owned.clear()

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
            '{"targetId":"T1"}',
            "closed T1",
        )
        self.call(ab.open_tab("https://example.com"))
        self.assertIn("T1", ab._owned_tabs())
        self.call(ab.close_tab())
        self.assertIn("closeTab", mcp.calls[2]["code"])
        self.assertNotIn("T1", ab._owned_tabs())

    def test_close_tab_refuses_foreign_tab_without_sending_close(self):
        mcp = self.fake('{"targetId":"OTHER"}')
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
        listing = json.dumps([
            {"targetId": "MINE", "active": False, "title": "a", "url": "https://example.com/"},
            {"targetId": "THEIRS", "active": True, "title": "b", "url": "https://slack.com/"},
        ])
        mcp = self.fake(listing, "closed MINE")
        self.assertEqual(self.call(ab.close_own_tabs()), ["MINE"])
        self.assertEqual(len(mcp.calls), 2)
        self.assertNotIn("THEIRS", mcp.calls[1]["code"])
        self.assertEqual(ab._owned_tabs(), {})

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


if __name__ == "__main__":
    unittest.main()
