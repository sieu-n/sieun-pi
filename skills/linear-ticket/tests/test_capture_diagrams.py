import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from PIL import Image

import linear_ticket


class CaptureDiagramsTests(unittest.IsolatedAsyncioTestCase):
    def browser(self, rendered):
        return SimpleNamespace(
            open_tab=AsyncMock(),
            run=AsyncMock(side_effect=["", json.dumps(rendered)]),
            screenshot=AsyncMock(),
            close_tab=AsyncMock(),
        )

    async def rejected_capture(self, rendered, message):
        browser = self.browser(rendered)
        with tempfile.TemporaryDirectory() as folder, patch.dict(sys.modules, {"aside_browser": browser}):
            with self.assertRaisesRegex(RuntimeError, message):
                await linear_ticket.capture_diagrams("https://example.test/spec", folder)
            self.assertEqual(list(Path(folder).iterdir()), [])
        browser.open_tab.assert_awaited_once_with("https://example.test/spec")
        browser.screenshot.assert_not_awaited()
        browser.close_tab.assert_awaited_once()
        check_script = browser.run.await_args_list[1].args[0]
        self.assertIn("document.querySelectorAll('pre.mermaid')", check_script)
        self.assertIn("el.querySelector('svg')", check_script)
        self.assertIn("rect.width > 0 && rect.height > 0", check_script)

    async def test_no_diagrams_requires_a_rendering_host(self):
        await self.rejected_capture([], "page URL whose host renders a visible SVG")

    async def test_raw_mermaid_source_is_not_screenshot_evidence(self):
        await self.rejected_capture([False], r"build_page\(\) writes an HTML fragment")

    async def test_all_diagrams_are_checked_before_any_screenshot(self):
        for rendered in ([True, False], [False, True]):
            with self.subTest(rendered=rendered):
                await self.rejected_capture(rendered, "No screenshots were taken")

    async def test_invalid_rendering_response_stops_capture(self):
        for rendered in ({"count": 1}, [1], "ready"):
            with self.subTest(rendered=rendered):
                await self.rejected_capture(rendered, "invalid Mermaid rendering check")

    async def test_rendered_diagrams_keep_png_names_and_cropping(self):
        browser = self.browser([True, True])
        rect = json.dumps({"x": 10, "y": 12, "w": 20, "h": 16, "dpr": 1})
        browser.run.side_effect = ["", "[true, true]", rect, rect, ""]

        def screenshot(path):
            with Image.new("RGB", (80, 60), "white") as image:
                image.save(path)

        browser.screenshot.side_effect = screenshot
        with tempfile.TemporaryDirectory() as folder, patch.dict(sys.modules, {"aside_browser": browser}):
            with contextlib.redirect_stdout(io.StringIO()):
                paths = await linear_ticket.capture_diagrams("https://example.test/spec", folder)
            self.assertEqual(paths, [str(Path(folder) / "d1.png"), str(Path(folder) / "d2.png")])
            self.assertEqual(sorted(path.name for path in Path(folder).iterdir()), ["d1.png", "d2.png"])
            for path in paths:
                with Image.open(path) as image:
                    self.assertEqual(image.size, (32, 28))
        self.assertEqual(browser.screenshot.await_count, 2)
        browser.close_tab.assert_awaited_once()
        self.assertIn("style.zoom = ''", browser.run.await_args.args[0])

    async def test_browser_check_failure_closes_only_the_opened_tab(self):
        browser = self.browser([])
        browser.run.side_effect = ["", RuntimeError("synthetic browser check failed")]
        with tempfile.TemporaryDirectory() as folder, patch.dict(sys.modules, {"aside_browser": browser}):
            with self.assertRaisesRegex(RuntimeError, "synthetic browser check failed"):
                await linear_ticket.capture_diagrams("https://example.test/spec", folder)
        browser.open_tab.assert_awaited_once()
        browser.screenshot.assert_not_awaited()
        browser.close_tab.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
