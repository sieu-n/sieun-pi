// Guards d4's gate reads. From 2026-10-23 00:41Z every auto-sns-agent land that reached basics failed (runs 39879601040, 39883364238,
// 39885768714 and 39893313784, "land / light" at "basics / search build, types and lint of the squash"), and the staging deploy of staging's head
// 6e71eb0478 failed (run 39856360527, "scope / light" at "gate / staging release.env sets every variable compose requires"). The precheck flagged
// neither, because 53 of the newest 60 land runs were cancelled and it took each branch's newest finished run, and it never read staging-deploy.yml.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Compare, type FailedJob, type Run, measureReach, newestPerBranch, reachMetrics } from "../scripts/duties/fixes-reach-prod.ts";

const NOW = Date.parse("2026-10-23T03:50:00Z");
const HEAD = "6e71eb047898f76ecba23e8e5d002f4a4e018be2";
const COMPARE: Compare = { mainSha: "6cdb32fcb42cdbe074b4996d028241c4ba66a8d3", aheadBy: 1, behindBy: 0,
  commits: [{ sha: HEAD, at: Date.parse("2026-10-22T17:08:03Z"), title: "land 60" }] };
const run = (id: number, conclusion: string, at: string, extra: Partial<Run> = {}): Run =>
  ({ id, status: "completed", conclusion, createdAt: Date.parse(at), branch: "sieun/dev", sha: HEAD, url: `https://github.com/r/${id}`, ...extra });
const LAND_JOBS: FailedJob[] = [{ name: "land / light", steps: ["basics / search build, types and lint of the squash"] }];
const DEPLOY_JOBS: FailedJob[] = [{ name: "scope / light", steps: ["gate / staging release.env sets every variable compose requires"] }];
const kinds = (flagged: { kind: string }[] | undefined) => (flagged ?? []).map(flag => flag.kind);
const line = (flagged: { kind: string; excerpt: string }[] | undefined, kind: string) => (flagged ?? []).find(flag => flag.kind === kind)?.excerpt ?? "";

test("a cancelled newest land over a failed one still flags land_failed with its job and step", () => {
  const lands = [run(39902388842, "cancelled", "2026-10-23T03:49:37Z"), run(39893313784, "failure", "2026-10-23T02:41:00Z"), run(39818038009, "success", "2026-10-22T16:54:41Z")];
  assert.deepEqual(newestPerBranch(lands).map(land => land.id), [39893313784]);
  const output = reachMetrics({ compare: COMPARE, promotes: [], lands, landPassed: lands[2]!, failedJobs: new Map([[39893313784, LAND_JOBS]]), health: [], errors: [] }, NOW);
  assert.match(line(output.flagged, "land_failed"), /run 39893313784 from 2026-10-23T02:41Z, ended failure in land \/ light at step "basics \/ search build, types and lint of the squash"/);
  assert.match(line(output.flagged, "land_last_success"), /run 39818038009 of sieun\/dev from 2026-10-22T16:54Z, 10\.9 h ago, and staging's head 6e71eb0478 landed 2026-10-22T17:08Z, 10\.7 h ago/);
});

test("a branch whose runs were all cancelled gives no land flag", () => {
  const output = reachMetrics({ compare: COMPARE, promotes: [], lands: [run(1, "cancelled", "2026-10-23T03:00:00Z"), run(2, "skipped", "2026-10-23T02:00:00Z")], failedJobs: new Map(), health: [], errors: [] }, NOW);
  assert.ok(!kinds(output.flagged).includes("land_failed"));
});

test("a failed staging deploy of staging's head is flagged with its job and step, and the newest passing sha is named", () => {
  const stagingDeploys = [run(39856360527, "failure", "2026-10-22T21:19:51Z", { branch: "staging" }),
    run(39779371312, "success", "2026-10-22T12:33:50Z", { branch: "staging", sha: "ecd10f3347daf3e49038cba282332aedc61a6508" })];
  const output = reachMetrics({ compare: COMPARE, promotes: [], lands: [], stagingDeploys, failedJobs: new Map([[39856360527, DEPLOY_JOBS]]), health: [], errors: [] }, NOW);
  assert.match(line(output.flagged, "staging_deploy_failed"),
    /run 39856360527 of 6e71eb0478 \(staging's head\) from 2026-10-22T21:19Z, 6\.5 h ago, ended failure in scope \/ light at step "gate \/ staging release.env sets every variable compose requires"/);
  assert.match(line(output.flagged, "staging_deploy_passed"), /^the newest staging sha whose staging deploy passed is ecd10f3347, run 39779371312/);
  assert.deepEqual(Object.keys(output.metrics), ["oldest_fix_wait_h", "failed_promotes_24h", "commits_on_staging_only"]);
});

test("a passing newest staging deploy gives no failure flag", () => {
  const output = reachMetrics({ compare: COMPARE, promotes: [], lands: [], stagingDeploys: [run(5, "cancelled", "2026-10-23T01:00:00Z"), run(4, "success", "2026-10-22T21:00:00Z")], failedJobs: new Map(), health: [], errors: [] }, NOW);
  assert.ok(!kinds(output.flagged).includes("staging_deploy_failed"));
  assert.match(line(output.flagged, "staging_deploy_passed"), /run 4 from/);
});

test("measureReach reads the decided land, the last successful land and the staging deploy, and asks gh for each failed run's jobs", async () => {
  const calls: string[][] = [];
  const rows = (runs: Run[]) => JSON.stringify(runs.map(item => ({ databaseId: item.id, status: item.status, conclusion: item.conclusion,
    createdAt: new Date(item.createdAt).toISOString(), headBranch: item.branch, headSha: item.sha, url: item.url })));
  const exec = async (_file: string, args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    if (args[1]?.startsWith("repos/")) return JSON.stringify({ main: COMPARE.mainSha, ahead: 1, behind: 0, commits: [{ sha: HEAD, at: "2026-10-22T17:08:03Z", title: "land 60" }] });
    if (args[0] === "run" && args[1] === "view") {
      const jobs = args[2] === "39856360527" ? [{ name: "scope / light", conclusion: "failure", steps: [{ name: DEPLOY_JOBS[0]!.steps[0]!, conclusion: "failure" }] }]
        : [{ name: "land / light", conclusion: "failure", steps: [{ name: LAND_JOBS[0]!.steps[0]!, conclusion: "failure" }, { name: "setup", conclusion: "success" }] }];
      return JSON.stringify({ jobs });
    }
    const workflow = args[args.indexOf("--workflow") + 1];
    if (workflow === "promote.yml") return rows([]);
    if (workflow === "staging-deploy.yml") return rows([run(39856360527, "failure", "2026-10-22T21:19:51Z", { branch: "staging" })]);
    if (args.includes("success")) return rows([run(39818038009, "success", "2026-10-22T16:54:41Z")]);
    return rows([run(39902388842, "cancelled", "2026-10-23T03:49:37Z"), run(39893313784, "failure", "2026-10-23T02:41:00Z")]);
  };
  const fetch = (async () => new Response(JSON.stringify({ git_sha: HEAD }))) as typeof globalThis.fetch;
  const output = await measureReach({ exec, fetch, now: () => NOW });
  assert.deepEqual(kinds(output.flagged).filter(kind => ["land_failed", "land_last_success", "staging_deploy_failed", "staging_deploy_passed"].includes(kind)),
    ["land_failed", "land_last_success", "staging_deploy_failed", "staging_deploy_passed"]);
  assert.match(line(output.flagged, "land_failed"), /basics \/ search build/);
  assert.match(line(output.flagged, "staging_deploy_failed"), /gate \/ staging release.env/);
  assert.ok(calls.some(args => args.includes("--branch") && args.includes("staging")));
  assert.ok(calls.some(args => args.includes("--limit") && args.includes("100")));
});
