"""Run-time CI run guard: components/global-rules/kernel-guard.py with send-check.ts.

A cancel, rerun or delete of a GitHub Actions run built at run time is refused in a session outside the release owner's and Fable's
trees (auto-sns-agent repo/git-workflow SKILL.md step 7). gh is a fake script first on PATH and HTTP goes to httpx.MockTransport or the
local test server, so nothing reaches GitHub.
"""

import unittest

from test_kernel_send_guard import FAKE_TOOL, KernelGuardBase, local_post

AGENT = "/Users/sieunpark/.prime/agent"
CHECK_IN = f"{AGENT}/session-artifacts/01a13b00-9ebb-73f9-80cc-138349f4bc7d"
FABLE_CHILD = f"{AGENT}/session-artifacts/01a0cc5e-0ca4-762a-90e6-566c310bd50a/sub-5e6f7a8b"
RELEASE_OWNER = f"{AGENT}/session-artifacts/01a10810-34b5-710f-88fe-3d369f89a8c9"
RUNS = "https://api.github.com/repos/sieu-n/auto-sns-agent/actions/runs"

COMPUTED_CANCEL = "import subprocess\nrid = 38578797512 + 1\nsubprocess.run(['gh', 'run', 'cancel', str(rid)], check=True)\n"
JOINED_CANCELS = "old = [38578415248, 38578797513]\nawait bash('; '.join(f'gh run cancel {r}' for r in old))\n"
HTTPX_RERUN = f"import httpx\nhttpx.Client(transport=mock_transport()).post('{RUNS}/' + '38492712967' + '/rerun-failed-jobs')\n"


class CiRunAtRunTime(KernelGuardBase):
    def setUp(self):
        super().setUp()
        gh = self.bin / "gh"
        gh.write_text(FAKE_TOOL)
        gh.chmod(0o755)

    def run_as(self, session_dir, *cells):
        return self.run_cells(*cells, env={"RLM_SESSION_DIR": session_dir})

    def assert_ci_refused(self, out):
        self.assertIsNotNone(out["refused"], f"not refused: {out}")
        self.assertIn("CI run guard: refused", out["refused"])
        self.assertIn("push a fresh run", out["refused"])

    def test_a_computed_gh_run_cancel_is_refused_in_a_check_in(self):
        out = self.run_as(CHECK_IN, COMPUTED_CANCEL)
        self.assert_ci_refused(out)
        self.assertEqual(self.fake_runs(), [])

    def test_cancels_joined_at_run_time_are_refused(self):
        out = self.run_as(CHECK_IN, JOINED_CANCELS)
        self.assert_ci_refused(out)
        self.assertEqual(self.fake_runs(), [])

    def test_an_httpx_rerun_is_refused(self):
        out = self.run_as(CHECK_IN, HTTPX_RERUN)
        self.assert_ci_refused(out)
        self.assertEqual(out["seen"], [])

    def test_a_socket_delete_of_a_run_is_refused(self):
        out = self.run_as(CHECK_IN, local_post("api.github.com", "/repos/sieu-n/auto-sns-agent/actions/runs/38578797513", "DELETE"))
        self.assert_ci_refused(out)
        self.assertEqual(self.server.hits, [])

    def test_reads_pass_in_a_check_in(self):
        out = self.run_as(CHECK_IN, "import subprocess\nrid = '38578797513'\nsubprocess.run(['gh', 'run', 'view', rid])\nsubprocess.run(['gh', 'run', 'watch', rid])\n")
        self.assert_passed(out)
        self.assertEqual(self.fake_runs(), ["gh run view 38578797513", "gh run watch 38578797513"])

    def test_other_repos_pass_and_auto_sns_agent_is_refused_by_name(self):
        rid = "38544915449"
        out = self.run_as(
            CHECK_IN,
            f"import subprocess, httpx\nrepo = 'sieu-n/' + 'slack-green'\nsubprocess.run(['gh', 'run', 'rerun', '{rid}', '--repo', repo, '--failed'])\n"
            f"httpx.Client(transport=mock_transport()).post(f'https://api.github.com/repos/{{repo}}/actions/runs/{rid}/cancel')\n",
        )
        self.assert_passed(out)
        self.assertEqual(self.fake_runs(), [f"gh run rerun {rid} --repo sieu-n/slack-green --failed"])
        self.assertEqual(len(out["seen"]), 1)
        out = self.run_as(CHECK_IN, "import subprocess\nsubprocess.run(['gh', 'run', 'cancel', '38578797513', '-R', 'sieu-n/' + 'auto-sns-agent'])\n")
        self.assert_ci_refused(out)

    def test_the_keepers_trees_pass(self):
        for session_dir in (FABLE_CHILD, RELEASE_OWNER):
            self.fake_log.write_text("")
            out = self.run_as(session_dir, COMPUTED_CANCEL, HTTPX_RERUN)
            self.assert_passed(out)
            self.assertEqual(self.fake_runs(), ["gh run cancel 38578797513"])
            self.assertEqual(len(out["seen"]), 1)


if __name__ == "__main__":
    unittest.main()
