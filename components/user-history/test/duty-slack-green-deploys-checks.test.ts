// Guards board step p180 (10-19): main's checks broke four times from Oct 9 to Oct 18, so Slack green deploys counts each main push whose CI
// run failed in the last 24 h (main_checks_failed_24h) and says whether the runner or the repo owns the fix.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type CiJob, type CiRun, type DeployDeps, measureDeploys } from "../scripts/duties/slack-green-deploys.ts";

const NOW = Date.parse("2026-10-19T16:30:00Z");
const HOUR = 3_600_000;
const run = (id: number, sha: string, hoursAgo: number, conclusion: string): CiRun =>
  ({ id, sha, at: NOW - hoursAgo * HOUR, conclusion, url: `https://github.com/sieu-n/slack-green/actions/runs/${id}` });
const step = (name: string, conclusion: string) => ({ name, conclusion });
const JOBS: Record<number, CiJob[]> = {
  // 39282206405 on 10-19: the job-started hook refused the job because the M1 Air was under its disk floor.
  1: [{ name: "Checks", conclusion: "failure", url: "https://github.com/sieu-n/slack-green/actions/runs/1/job/11",
    steps: [step("Set up job", "success"), step("Set up runner", "failure"), step("Run actions/checkout@v4", "skipped")] },
    { name: "Backend", conclusion: "skipped", steps: [] }],
  2: [{ name: "Checks", conclusion: "success", steps: [step("Set up runner", "success")] },
    { name: "Frontend", conclusion: "failure", url: "https://github.com/sieu-n/slack-green/actions/runs/2/job/22",
      steps: [step("Set up runner", "success"), step("Test", "failure")] }],
  3: [{ name: "Frontend", conclusion: "cancelled", steps: [step("Set up runner", "success"), step("Build", "cancelled")] }],
};

function deps(runs: CiRun[], failRunList = false): DeployDeps {
  const exec = async (file: string, args: readonly string[]): Promise<string> => {
    if (file === "gh" && args[0] === "run" && args[1] === "list") {
      if (failRunList) throw new Error("gh run list: HTTP 502");
      return JSON.stringify(runs.map(item => ({ databaseId: item.id, headSha: item.sha, conclusion: item.conclusion, createdAt: new Date(item.at).toISOString(), url: item.url })));
    }
    if (file === "gh" && args[0] === "run" && args[1] === "view") return JSON.stringify({ jobs: JOBS[Number(args[2])] ?? [] });
    if (file === "gh" && args[0] === "api" && String(args[1]).includes("/compare/")) return "[]";
    if (file === "railway" && args[0] === "deployment") return JSON.stringify([{ status: "SUCCESS", createdAt: new Date(NOW - HOUR).toISOString(), meta: { commitHash: "live" } }]);
    return "";
  };
  const fetch = (async () => new Response(JSON.stringify({ targets: { production: { meta: { githubCommitSha: "live" } } }, deployments: [] }))) as typeof globalThis.fetch;
  return { exec, fetch, now: () => NOW, railwayToken: async () => "t", vercelToken: async () => "t" };
}

test("a failed main run of the last 24 h counts once per commit, with the runner or the repo named as the fix's owner", async () => {
  const runs = [run(1, "aaaaaaa1", 0.5, "failure"), run(2, "bbbbbbb2", 3, "failure"), run(3, "bbbbbbb2", 2, "cancelled"), run(4, "ccccccc3", 5, "success"),
    run(5, "ddddddd4", 30, "failure"), run(6, "eeeeeee5", 0.1, "")];
  const { output } = await measureDeploys(deps(runs), { redeployed: {} });
  assert.equal(output.metrics.main_checks_failed_24h, 2);
  assert.equal(output.metrics.commits_not_live, 0);
  const checks = (output.flagged ?? []).filter(slice => slice.kind.startsWith("main_checks_"));
  assert.deepEqual(checks.map(slice => slice.kind), ["main_checks_runner", "main_checks_repo", "main_checks_repo"]);
  assert.match(checks[0]!.excerpt, /aaaaaaa's CI run 1 ended failure: job Checks failed at step "Set up runner"; runner side, so VP of CI fixes it\. https:\/\/github\.com\/sieu-n\/slack-green\/actions\/runs\/1\/job\/11/);
  assert.match(checks[1]!.excerpt, /job Frontend failed at step "Build"; repo side/);
});

test("all green main runs read 0 with an ok flag, and a run list that fails is a miss and a source error", async () => {
  const green = await measureDeploys(deps([run(4, "ccccccc3", 5, "success")]), { redeployed: {} });
  assert.equal(green.output.metrics.main_checks_failed_24h, 0);
  assert.ok((green.output.flagged ?? []).some(slice => slice.kind === "main_checks_ok"));
  const broken = await measureDeploys(deps([], true), { redeployed: {} });
  assert.equal(broken.output.metrics.main_checks_failed_24h, 1);
  assert.equal(broken.output.metrics.source_errors, 1);
});
