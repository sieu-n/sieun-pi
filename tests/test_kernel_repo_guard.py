"""Run-time auto-sns-agent repo guard: components/global-rules/kernel-guard.py with send-check.ts and auto-sns-agent.ts.

A kernel's os.chdir is invisible to the tool_call guard. On 2026-10-14 at 14:40Z a job started in /Users/sieunpark ran
bash("git push origin 7ac6657831...:refs/heads/sieun/dev") after os.chdir into the auto-sns-agent checkout, and no guard saw it.
Here the kernel judges each git write with its real cwd. The checkout is a fixture holding a copy of the live checkout's
scripts/repo/agent/guards, and git is a fake script first on PATH, so nothing reaches GitHub.
"""

import json
import shutil
import subprocess
import unittest
from pathlib import Path

from test_kernel_send_guard import FAKE_TOOL, KernelGuardBase

SOURCE = Path.home() / "Documents/Github/auto-sns-agent/scripts/repo/agent/guards"
AGENT = "/Users/sieunpark/.prime/agent"
CRAWLER_OPS = f"{AGENT}/session-artifacts/01a115e2-9544-7204-b8db-8ce4d5319048/sub-ffb64cb8"
RELEASE_OWNER = f"{AGENT}/session-artifacts/01a10810-34b5-710f-88fe-3d369f89a8c9"
REAL_PUSH = "git push origin 7ac665783133be3e74975a5a117d213ff26d54dc:refs/heads/sieun/dev 2>&1 | tail -3; git ls-remote origin refs/heads/sieun/dev"


@unittest.skipUnless(SOURCE.is_dir(), "no auto-sns-agent checkout on this machine")
class RepoGuardAtRunTime(KernelGuardBase):
    def setUp(self):
        super().setUp()
        git = self.bin / "git"
        git.write_text(FAKE_TOOL)
        git.chmod(0o755)
        self.checkout = self.tmp.resolve() / "auto-sns-agent"
        shutil.copytree(SOURCE, self.checkout / "scripts/repo/agent/guards", ignore=shutil.ignore_patterns("*.test.mjs"))
        subprocess.run(["/usr/bin/git", "init", "-q", "-b", "sieun/dev", str(self.checkout)], check=True)
        subprocess.run(["/usr/bin/git", "-C", str(self.checkout), "remote", "add", "origin", "https://github.com/sieu-n/auto-sns-agent"], check=True)
        self.repo_log = self.tmp / "repo-guard.jsonl"

    def run_in_checkout(self, session_dir, command):
        cell = f"import os\nos.chdir({str(self.checkout)!r})\nr = await bash({command!r})\n"
        env = {"RLM_SESSION_DIR": session_dir, "GLOBAL_RULES_AUTO_SNS_AGENT": str(self.checkout), "REPO_GUARD_LOG": str(self.repo_log)}
        return self.run_cells(cell, env=env)

    def logged(self):
        return [json.loads(line) for line in self.repo_log.read_text().splitlines()] if self.repo_log.exists() else []

    def test_the_10_14_push_is_refused_after_os_chdir(self):
        out = self.run_in_checkout(CRAWLER_OPS, REAL_PUSH)
        self.assertIsNotNone(out["refused"], f"not refused: {out}")
        self.assertIn("repo guard (git-push-sieun-dev)", out["refused"])
        self.assertEqual(self.fake_runs(), [])
        self.assertEqual([(l["rule"], l["verdict"], l["cwd"]) for l in self.logged()], [("git-push-sieun-dev", "block", str(self.checkout))])

    def test_the_release_owner_push_runs(self):
        out = self.run_in_checkout(RELEASE_OWNER, "git push -q origin HEAD:refs/heads/sieun/dev")
        self.assert_passed(out)
        self.assertEqual(self.fake_runs(), ["git push -q origin HEAD:refs/heads/sieun/dev"])
        self.assertEqual(self.logged()[-1]["verdict"], "owner-allow")

    def test_a_ci_push_runs(self):
        out = self.run_in_checkout(CRAWLER_OPS, "git push origin HEAD:refs/heads/ci/guard-everywhere")
        self.assert_passed(out)
        self.assertEqual(self.fake_runs(), ["git push origin HEAD:refs/heads/ci/guard-everywhere"])

    def test_a_shared_checkout_hazard_is_refused_after_os_chdir(self):
        out = self.run_in_checkout(CRAWLER_OPS, "git stash")
        self.assertIn("repo guard (git-hazard)", out["refused"] or "")
        self.assertEqual(self.fake_runs(), [])

    def run_check_in_app(self, command):
        app = self.checkout / "apps/crawler-v3"
        (app / "src").mkdir(parents=True, exist_ok=True)
        (app / "src/a.py").write_text("x = 1\n")
        ruff = self.bin / "ruff"
        ruff.write_text(FAKE_TOOL)
        ruff.chmod(0o755)
        cell = f"import os\nos.chdir({str(app)!r})\nfs = 'src/a.py'\nr = await bash({command})\n"
        return self.run_cells(cell, env={"RLM_SESSION_DIR": CRAWLER_OPS, "GLOBAL_RULES_AUTO_SNS_AGENT": str(self.checkout), "REPO_GUARD_LOG": str(self.repo_log)})

    def test_a_cell_check_on_files_in_an_f_string_runs_from_the_kernel_cwd(self):
        # On 10-18 from 08:46Z the tool_call guard refused cells like this one, whose files it could not see.
        out = self.run_check_in_app('f"ruff check {fs}"')
        self.assert_passed(out)
        self.assertEqual(self.fake_runs(), ["ruff check src/a.py"])

    def test_a_cell_check_on_a_directory_is_refused_at_run_time(self):
        out = self.run_check_in_app('f"ruff check {os.path.dirname(fs)}"')
        self.assertIn("repo guard (local-check)", out["refused"] or "")
        self.assertIn("names the directory src", out["refused"])
        self.assertEqual(self.fake_runs(), [])

    def test_a_git_write_in_another_repo_runs(self):
        other = self.tmp / "other"
        other.mkdir()
        cell = f"import os\nos.chdir({str(other)!r})\nr = await bash('git stash')\n"
        out = self.run_cells(cell, env={"RLM_SESSION_DIR": CRAWLER_OPS, "GLOBAL_RULES_AUTO_SNS_AGENT": str(self.checkout), "REPO_GUARD_LOG": str(self.repo_log)})
        self.assert_passed(out)
        self.assertEqual(self.fake_runs(), ["git stash"])
        self.assertEqual(self.logged(), [])


if __name__ == "__main__":
    unittest.main()
