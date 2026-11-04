"""Run-time Mac heavy check note (global rule 6): a whole-project check the kernel starts on the owner's Mac runs, and the kernel prints a note.

On 11-04 at 16:20:55 KST a job's `pnpm check` in auto-sns-agent apps/search, started by its kernel's bash() on the Mac, grew to 7.52 GB in a
minute. Each case runs a fresh Python process through test_kernel_send_guard's runner with GLOBAL_RULES_PLATFORM=darwin, and pnpm is a
fake script first on PATH, so nothing here runs a type check.
"""

import json
import unittest

from test_kernel_send_guard import FAKE_TOOL, KernelGuardBase

CAPTURE = (
    "import contextlib, io\n"
    "buf = io.StringIO()\n"
    "with contextlib.redirect_stderr(buf):\n"
    "    await bash({command!r})\n"
    "RESULT = buf.getvalue()\n"
)


class HeavyCheckOnTheMac(KernelGuardBase):
    def setUp(self):
        super().setUp()
        tool = self.bin / "pnpm"
        tool.write_text(FAKE_TOOL)
        tool.chmod(0o755)
        self.app = self.tmp / "auto-sns-agent" / "apps" / "search"
        self.app.mkdir(parents=True)
        (self.tmp / "auto-sns-agent" / ".git").mkdir()
        (self.app / "package.json").write_text(json.dumps({"scripts": {"test": "vitest run"}}))

    def run_command(self, command, platform):
        return self.run_cells(CAPTURE.format(command=command), env={"GLOBAL_RULES_PLATFORM": platform})

    def test_a_full_vitest_run_the_kernel_starts_runs_with_a_note(self):
        out = self.run_command(f"cd {self.app} && pnpm test", "darwin")
        self.assert_passed(out)
        self.assertIn("Mac heavy check", out["result"])
        self.assertIn("vitest runs every test file", out["result"])
        self.assertIn("7.52 GB", out["result"])
        self.assertEqual(self.fake_runs(), ["pnpm test"])

    def test_a_named_test_file_runs_with_no_note(self):
        out = self.run_command(f"cd {self.app} && pnpm exec vitest run tests/unit/a.test.ts", "darwin")
        self.assert_passed(out)
        self.assertNotIn("Mac heavy check", out["result"])

    def test_on_us_metal02_the_run_has_no_note(self):
        out = self.run_command(f"cd {self.app} && pnpm test", "linux")
        self.assert_passed(out)
        self.assertNotIn("Mac heavy check", out["result"])
        self.assertEqual(self.fake_runs(), ["pnpm test"])


if __name__ == "__main__":
    unittest.main()
