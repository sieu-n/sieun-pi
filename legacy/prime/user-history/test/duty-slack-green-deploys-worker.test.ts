// Guards p226 (11-04): the email worker left Railway for us-metal01 (ops guy's p737), so d6 reads main's newest Worker image push from
// slack-green's ci.yml runs and flags the container when it does not run that sha DEPLOY_MINUTES after the push ended.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type CiJob, type CiRun, DEPLOY_MINUTES, type DeployDeps, measureDeploys, WORKER_IMAGE_JOB } from "../scripts/duties/slack-green-deploys.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const MINUTE = 60_000;
const sha = (digit: string) => digit.repeat(40);
const run = (id: number, commit: string, minutesAgo: number, event = "push"): CiRun =>
  ({ id, sha: commit, event, at: NOW - minutesAgo * MINUTE, end: NOW - minutesAgo * MINUTE + 10 * MINUTE, conclusion: "success", url: `https://github.com/sieu-n/slack-green/actions/runs/${id}` });
const image = (conclusion: string, endedMinutesAgo: number): CiJob =>
  ({ name: WORKER_IMAGE_JOB, conclusion, completedAt: new Date(NOW - endedMinutesAgo * MINUTE).toISOString(), url: "https://github.com/sieu-n/slack-green/actions/runs/9/job/99", steps: [] });

function deps(runs: CiRun[], jobs: Record<number, CiJob[]>, viewed: number[] = []): DeployDeps {
  const exec = async (file: string, args: readonly string[]): Promise<string> => {
    if (file === "gh" && args[0] === "run" && args[1] === "list")
      return JSON.stringify(runs.map(item => ({ databaseId: item.id, headSha: item.sha, event: item.event, conclusion: item.conclusion,
        createdAt: new Date(item.at).toISOString(), updatedAt: new Date(item.end).toISOString(), url: item.url })));
    if (file === "gh" && args[0] === "run" && args[1] === "view") { viewed.push(Number(args[2])); return JSON.stringify({ jobs: jobs[Number(args[2])] ?? [] }); }
    if (file === "gh" && args[0] === "api") return "[]";
    return "";
  };
  const fetch = (async () => new Response(JSON.stringify({ targets: { production: { meta: { githubCommitSha: "live" } } }, deployments: [] }))) as typeof globalThis.fetch;
  return { exec, fetch, now: () => NOW, vercelToken: async () => "t" };
}

const RUNS = [run(4, sha("d"), 10), run(3, sha("c"), 60), run(2, sha("b"), 90, "workflow_dispatch"), run(1, sha("a"), 300)];

test("a container one image behind counts as not live once the push is DEPLOY_MINUTES old, and frontend-only runs after it do not matter", async () => {
  const jobs = { 4: [image("skipped", 5)], 3: [image("success", (DEPLOY_MINUTES + 25))], 2: [image("success", 70)] };
  const output = await measureDeploys(deps(RUNS, jobs), sha("a"));
  assert.equal(output.metrics.worker_not_live, 1);
  const slice = (output.flagged ?? []).find(item => item.kind === "worker_not_live");
  assert.match(slice?.excerpt ?? "", new RegExp(`runs aaaaaaa, but main's newest Worker image ccccccc was pushed ${DEPLOY_MINUTES + 25} min ago`));
});

test("a push younger than DEPLOY_MINUTES is pending, a dispatch push counts, and a container on the newest image reads ok", async () => {
  const pending = await measureDeploys(deps(RUNS, { 3: [image("success", DEPLOY_MINUTES - 5)] }), sha("a"));
  assert.equal(pending.metrics.worker_not_live, 0);
  assert.ok((pending.flagged ?? []).some(item => item.kind === "worker_pending"));
  const dispatched = await measureDeploys(deps(RUNS, { 2: [image("success", 70)] }), sha("a"));
  assert.match((dispatched.flagged ?? []).find(item => item.kind === "worker_not_live")?.excerpt ?? "", /bbbbbbb/);
  const viewed: number[] = [];
  const current = await measureDeploys(deps(RUNS, { 3: [image("success", 50)] }, viewed), sha("c"));
  assert.equal(current.metrics.worker_not_live, 0);
  assert.ok((current.flagged ?? []).some(item => item.kind === "worker_ok"));
  assert.deepEqual(viewed, [4], "only the runs newer than the container's own run get their jobs read");
});

test("a container sha no main run built, with no image push in the runs read, is a source error and not a pass", async () => {
  const output = await measureDeploys(deps(RUNS, {}), sha("e"));
  assert.equal(output.metrics.source_errors, 1);
  assert.equal(output.metrics.worker_not_live, 0);
  assert.match((output.flagged ?? []).find(item => item.kind === "source_error")?.excerpt ?? "", /Worker image pushes: none of main's newest 4 CI runs/);
});
