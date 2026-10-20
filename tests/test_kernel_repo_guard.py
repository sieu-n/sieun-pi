"""Run-time auto-sns-agent repo guard: components/global-rules/kernel-guard.py with send-check.ts and auto-sns-agent.ts.

A kernel's os.chdir is invisible to the tool_call guard. On 2026-10-14 at 14:40Z a job started in /Users/sieunpark ran
bash("git push origin 7ac6657831...:refs/heads/sieun/dev") after os.chdir into the auto-sns-agent checkout, and no guard saw it.
Here the kernel judges each git write with its real cwd. The checkout is a fixture holding a copy of the live checkout's
scripts/repo/agent/guards, and git is a fake script first on PATH, so nothing reaches GitHub.
"""

import json
import shutil
import subprocess
import threading
import time
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
        # guards/agent-branch.mjs loads the dev-branch rule from HEAD's scripts/ci/branches.mjs, and guards/commands.mjs loads
        # scripts/ci/land-dispatch.mjs the same way since auto-sns-agent b73a860092.
        (self.checkout / "scripts/ci").mkdir(parents=True)
        for name in ("branches.mjs", "land-dispatch.mjs"):
            if (SOURCE.parents[2] / "ci" / name).exists():
                shutil.copy(SOURCE.parents[2] / "ci" / name, self.checkout / "scripts/ci" / name)
        subprocess.run(["/usr/bin/git", "init", "-q", "-b", "sieun/dev", str(self.checkout)], check=True)
        subprocess.run(["/usr/bin/git", "-C", str(self.checkout), "remote", "add", "origin", "https://github.com/sieu-n/auto-sns-agent"], check=True)
        self.commit_guards()
        self.repo_log = self.tmp / "repo-guard.jsonl"

    def commit_guards(self):
        """The guard loads from the checkout's HEAD, so the fixture commits its guard files."""
        git = ["/usr/bin/git", "-C", str(self.checkout), "-c", "user.name=t", "-c", "user.email=t@t"]
        subprocess.run([*git, "add", "-A", "scripts/repo/agent/guards", "scripts/ci"], check=True)
        subprocess.run([*git, "commit", "-q", "--allow-empty", "-m", "guards"], check=True)

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

    def test_a_probe_ref_push_runs(self):
        # Since 2026-10-19 a probe goes to refs/probe/<sha>, and a push to a ci/ branch is refused.
        out = self.run_in_checkout(CRAWLER_OPS, "git push origin HEAD:refs/probe/guard-everywhere")
        self.assert_passed(out)
        self.assertEqual(self.fake_runs(), ["git push origin HEAD:refs/probe/guard-everywhere"])

    def test_a_shared_checkout_hazard_is_refused_after_os_chdir(self):
        out = self.run_in_checkout(CRAWLER_OPS, "git stash")
        self.assertIn("repo guard (git-hazard)", out["refused"] or "")
        self.assertEqual(self.fake_runs(), [])

    def mark_shared(self):
        """The full marker: HEAD holds the shared-index rule and .git/agent-shared-checkout holds the checkout's path."""
        rule = self.checkout / "scripts/repo/agent/shared-index.mjs"
        shutil.copy(SOURCE.parent / "shared-index.mjs", rule)
        git = ["/usr/bin/git", "-C", str(self.checkout), "-c", "user.name=t", "-c", "user.email=t@t"]
        subprocess.run([*git, "add", str(rule)], check=True)
        subprocess.run([*git, "commit", "-q", "-m", "rule"], check=True)
        (self.checkout / ".git/agent-shared-checkout").write_text(f"{self.checkout}\n")

    def run_from_home(self, command):
        """A cell that names the checkout only inside an f-string, as bash(f"cd {R} && ..."), with the kernel left in the home dir."""
        cell = f"R = {str(self.checkout)!r}\nr = await bash(f{('cd {R} && ' + command)!r})\n"
        return self.run_cells(cell, env={"RLM_SESSION_DIR": CRAWLER_OPS, "GLOBAL_RULES_AUTO_SNS_AGENT": str(self.checkout), "REPO_GUARD_LOG": str(self.repo_log)})

    def test_git_rm_in_the_marked_checkout_is_refused_and_points_at_a_scratch_tree(self):
        # 10-19 21:58Z: bash(f"cd {R} && git rm -q x") ran in the shared checkout after its full marker went on.
        self.mark_shared()
        out = self.run_from_home("git rm -q a.txt")
        self.assertIn("repo guard (git-shared-index-hazard)", out["refused"] or "")
        self.assertIn("your own scratch tree", out["refused"])
        self.assertEqual(self.fake_runs(), [])

    def test_git_merge_file_on_loose_files_in_the_marked_checkout_is_refused(self):
        self.mark_shared()
        out = self.run_from_home("git merge-file /tmp/x/ours /tmp/x/base /tmp/x/theirs")
        self.assertIn("repo guard (git-shared-index-hazard)", out["refused"] or "")
        self.assertIn("git merge-file -p", out["refused"])
        self.assertEqual(self.fake_runs(), [])

    def test_git_apply_without_cached_in_the_marked_checkout_is_refused_and_points_at_a_scratch_tree(self):
        # 10-20 05:50Z: a plain git apply in the box's shared checkout put 15 stale files in its working tree.
        self.mark_shared()
        for command in ("git apply /tmp/land.patch", "git apply --3way /tmp/land.patch"):
            out = self.run_from_home(command)
            self.assertIn("repo guard (git-shared-index-hazard)", out["refused"] or "", command)
            self.assertIn("~/scratch/<job>/<name>", out["refused"])
        self.assertEqual(self.fake_runs(), [])

    def test_git_apply_check_runs_in_the_marked_checkout(self):
        self.mark_shared()
        self.assert_passed(self.run_from_home("git apply --check /tmp/land.patch"))
        self.assertEqual(self.fake_runs(), ["git apply --check /tmp/land.patch"])

    def test_git_rm_cached_and_merge_file_p_run_in_the_marked_checkout(self):
        self.mark_shared()
        self.assert_passed(self.run_from_home("git merge-file -p ours base theirs"))
        self.assertEqual(self.fake_runs(), ["git merge-file -p ours base theirs"])

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

    def test_a_kernel_started_before_a_guard_change_judges_its_bash_with_the_new_guard(self):
        # 10-18: 'search flows end to end' ran await bash('npx vitest run ...') at 11:44Z under a guard cached before c84c6c646e.
        # Each kernel check starts a fresh node, so a kernel that is already running follows the guard HEAD holds.
        old = subprocess.run(["/usr/bin/git", "-C", str(SOURCE.parents[3]), "archive", "b9a88ff4d7^", "scripts/repo/agent/guards"],
                             capture_output=True, check=False)
        if old.returncode != 0:
            self.skipTest("no b9a88ff4d7 in the auto-sns-agent checkout")
        guards = self.checkout / "scripts/repo/agent/guards"
        shutil.rmtree(guards)
        subprocess.run(["tar", "-x", "-C", str(self.checkout)], input=old.stdout, check=True)
        self.commit_guards()
        app = self.checkout / "apps/crawler-v3"
        (app / "src").mkdir(parents=True)
        (app / "src/a.py").write_text("x = 1\n")
        ruff = self.bin / "ruff"
        ruff.write_text(FAKE_TOOL)
        ruff.chmod(0o755)
        asked, swapped = self.tmp / "asked", self.tmp / "swapped"

        def land_the_current_guard():
            while not asked.exists():
                time.sleep(0.05)
            shutil.rmtree(guards)
            shutil.copytree(SOURCE, guards, ignore=shutil.ignore_patterns("*.test.mjs"))
            self.commit_guards()
            swapped.write_text("")

        landing = threading.Thread(target=land_the_current_guard, daemon=True)
        landing.start()
        run = f"os.chdir({str(app)!r})\ntry:\n    await bash('ruff check src/a.py')\n    RESULT.append('ran')\nexcept Exception as error:\n    RESULT.append(str(error))\n"
        wait = f"import pathlib, time\npathlib.Path({str(asked)!r}).write_text('')\nwhile not pathlib.Path({str(swapped)!r}).exists():\n    time.sleep(0.05)\n"
        env = {"RLM_SESSION_DIR": CRAWLER_OPS, "GLOBAL_RULES_AUTO_SNS_AGENT": str(self.checkout), "REPO_GUARD_LOG": str(self.repo_log)}
        out = self.run_cells("import os\nRESULT = []\n", run, wait, run, env=env)
        landing.join(timeout=60)
        self.assert_passed(out)
        before, after = out["result"]
        self.assertRegex(before, r"repo guard \(local-check\)")
        self.assertEqual(after, "ran")
        self.assertEqual(self.fake_runs(), ["ruff check src/a.py"])

    def test_an_uncommitted_guard_edit_does_not_change_the_kernel_half(self):
        (self.checkout / "scripts/repo/agent/guards/prime.mjs").write_text("export const onToolCall = () => undefined;\n")
        out = self.run_in_checkout(CRAWLER_OPS, "git stash")
        self.assertIn("repo guard (git-hazard)", out["refused"] or "")
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
