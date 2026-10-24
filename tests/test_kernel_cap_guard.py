"""Run-time cap guard (owner rule c107): a cap flag in a command a kernel builds at run time is refused like a literal one.

Each case runs a fresh Python process through test_kernel_send_guard's runner. docker and systemd-run are fake scripts first on PATH, so
nothing here starts a container or a unit even if the guard is broken.
"""

import unittest

from test_kernel_send_guard import FAKE_TOOL, KernelGuardBase


class CapsBuiltAtRunTime(KernelGuardBase):
    def setUp(self):
        super().setUp()
        for name in ("docker", "systemd-run"):
            tool = self.bin / name
            tool.write_text(FAKE_TOOL)
            tool.chmod(0o755)

    def assert_cap_refused(self, out):
        self.assertIsNotNone(out["refused"], f"not refused: {out}")
        self.assertIn("cap guard", out["refused"])
        self.assertIn("c107", out["refused"])

    def test_the_10_24_command_in_a_variable_is_refused(self):
        out = self.run_cells(
            "import shlex\ninner = 'docker run --rm --cpus 8 -e JOBS=8 img bash x.sh'\n"
            "await bash(f\"systemd-run --user --unit=stub-audit --collect sh -c {shlex.quote(inner)}\")\n"
        )
        self.assert_cap_refused(out)
        self.assertEqual(self.fake_runs(), [])

    def test_a_subprocess_argv_with_a_computed_flag_is_refused(self):
        out = self.run_cells("import subprocess\nflag = '--' + 'cpus'\nsubprocess.run(['docker', 'run', flag, '8', 'img'])\n")
        self.assert_cap_refused(out)
        self.assertEqual(self.fake_runs(), [])

    def test_a_run_sized_by_jobs_runs(self):
        self.assert_passed(self.run_cells("n = 8\nawait bash(f'docker run --rm -e JOBS={n} img')\n"))
        self.assertEqual(self.fake_runs(), ["docker run --rm -e JOBS=8 img"])


if __name__ == "__main__":
    unittest.main()
