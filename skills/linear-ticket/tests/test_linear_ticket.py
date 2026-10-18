import asyncio
import contextlib
import gc
import inspect
import io
from pathlib import Path
import tempfile
import unittest
import warnings

import linear_ticket


CORE = """- Readers can see which saved accounts need attention.
- This change covers the watchlist page.
- Existing saved accounts stay in their current lists.
- A reader can retry a failed refresh without leaving the page.
"""
DESCRIPTION = CORE + """
## Approach

Keep the account row visible while its refresh runs.

## Success conditions

- A failed refresh shows a retry button beside the account.
- Retrying keeps the account in its original list.
"""


class TicketTests(unittest.TestCase):
    def check(self, text):
        with contextlib.redirect_stdout(io.StringIO()):
            return linear_ticket.check(text)

    def test_core_with_supporting_sections(self):
        self.assertEqual(self.check(DESCRIPTION), [])

    def test_core_only_and_bounds(self):
        for count in (3, 4, 5):
            with self.subTest(count=count):
                self.assertEqual(self.check("- Readers keep their saved accounts.\n" * count), [])

    def test_missing_core(self):
        self.assertTrue(any("core bullets, found 0" in v for v in self.check("## Approach\nKeep the account row visible.")))
        self.assertTrue(any("core bullets, found 0" in v for v in self.check("[Spec](https://example.com)\n" + CORE)))

    def test_six_opening_bullets(self):
        six = CORE + "- Readers keep their saved filters.\n\n- Readers keep their saved searches.\n"
        self.assertTrue(any("core bullets, found 6" in v for v in self.check(six)))

    def test_core_sentence_rules(self):
        for text, expected in [
            (CORE.replace("attention.", "attention"), "core bullet must be one sentence"),
            (CORE.replace("attention.", "attention. Retry works."), "one sentence per line"),
            (CORE.replace("attention.", " ".join(["account"] * 24) + "."), "too long"),
        ]:
            with self.subTest(expected=expected):
                self.assertTrue(any(expected in v for v in self.check(text)))

    def test_language_checks_in_supporting_prose(self):
        for sentence, expected in [
            ("The refresh is robust.", "banned words"),
            ("The refresh runs\u2014the row stays visible.", "long dash"),
            ("The reader sees \u201cRetry\u201d.", "curly quote"),
            ("The result: the row stays visible.", "mid-sentence colon"),
            ("See service.py:68.", "file:line token outside backticks"),
        ]:
            with self.subTest(expected=expected):
                self.assertTrue(any(expected in v for v in self.check(DESCRIPTION + "\n" + sentence)))

    def test_code_and_prose_limits(self):
        code = DESCRIPTION + "\n```\n" + "row\n" * 15 + "```"
        self.assertTrue(any("code block over 14 lines" in v for v in self.check(code)))
        long_prose = DESCRIPTION + "The row stays visible.\n" * 400
        self.assertTrue(any("over 8000 bytes" in v for v in self.check(long_prose)))
        self.assertEqual(self.check(DESCRIPTION + "\n```\nrobust\n```"), [])

    def test_paths_and_optional_images(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            path = Path(folder) / "ticket.md"
            path.write_text(DESCRIPTION + "\n![Proposed retry flow](assets/flow.png)\n")
            self.assertIn("image missing on disk: assets/flow.png", self.check(str(path)))
            (Path(folder) / "assets").mkdir()
            (Path(folder) / "assets/flow.png").write_bytes(b"fixture")
            self.assertEqual(self.check(str(path)), [])

    def test_check_is_synchronous_and_run_still_works(self):
        self.assertFalse(inspect.iscoroutinefunction(linear_ticket.check))
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            path = Path(folder) / "ticket.md"
            path.write_text(DESCRIPTION)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(asyncio.run(linear_ticket.run(str(path))), {"violations": []})

    def test_file_operations_close_handles(self):
        with tempfile.TemporaryDirectory() as folder:
            ticket = Path(folder) / "ticket.md"
            ticket.write_text(DESCRIPTION)
            with warnings.catch_warnings(record=True) as caught, contextlib.redirect_stdout(io.StringIO()):
                warnings.simplefilter("always", ResourceWarning)
                self.assertEqual(linear_ticket.check(str(ticket)), [])
                linear_ticket.build_page(
                    str(ticket), str(Path(folder) / "index.html"), title="Account refresh", summary="Retry refreshes.",
                    apps=[], tags=[], ticket_url="https://linear.app/test/issue/VIR-1", request="Show retries.",
                    mermaid=[], agent_notes=[],
                )
                gc.collect()
            self.assertEqual([str(w.message) for w in caught if issubclass(w.category, ResourceWarning)], [])

    def test_backtick_files(self):
        self.assertEqual(linear_ticket.backtick_files("See service.py and `other.ts`."), "See `service.py` and `other.ts`.")

    def test_build_page_keeps_core_and_supporting_prose(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            page = Path(folder) / "index.html"
            with contextlib.redirect_stdout(io.StringIO()):
                html = linear_ticket.build_page(
                    DESCRIPTION, str(page), title="Account refresh", summary="Retry failed account refreshes.",
                    apps=["search"], tags=[], ticket_url="https://linear.app/test/issue/VIR-1",
                    request="Show retries.", mermaid=[], agent_notes=["See the refresh handler."],
                )
            self.assertEqual(html, page.read_text())
            self.assertIn("<ul>", html)
            self.assertEqual(html.count("<li>"), 7)
            self.assertIn("<p>Keep the account row visible while its refresh runs.</p>", html)
            self.assertIn('<details><summary>Agent notes, low level</summary>', html)
            self.assertNotIn("<details open>", html)
            self.assertNotIn("<th>Size</th>", html)

    def test_build_page_keeps_existing_rendering(self):
        legacy = """Size: M
## Today
1. Readers see an empty row.
![Proposed flow](assets/diagrams/d1.png)
![Observed row](assets/row.png)
| Today | After |
|---|---|
| Empty row | Retry button |
```text
retry
```
"""
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]) as folder:
            with contextlib.redirect_stdout(io.StringIO()):
                html = linear_ticket.build_page(
                    legacy, str(Path(folder) / "index.html"), title="Account refresh", summary="Retry failed account refreshes.",
                    apps=[], tags=[], ticket_url="https://linear.app/test/issue/VIR-1", request="Show retries.",
                    mermaid=["flowchart LR; A-->B"], agent_notes=[],
                )
            for fragment in ['<ol start="1">', "<th>Size</th><td>M</td>", '<pre class="mermaid">',
                             '<figure><img src="assets/row.png"', "<td>Retry button</td>", "<pre><code>retry</code></pre>"]:
                self.assertIn(fragment, html)


if __name__ == "__main__":
    unittest.main()
