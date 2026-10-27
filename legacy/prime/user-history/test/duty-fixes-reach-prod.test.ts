// Guards d4's gate reads. From 2026-10-23 00:41Z every auto-sns-agent land that reached basics failed (runs 39879601040, 39883364238,
// 39885768714 and 39893313784, "land / light" at "basics / search build, types and lint of the squash"), and the staging deploy of staging's head
// 6e71eb0478 failed (run 39856360527, "scope / light" at "gate / staging release.env sets every variable compose requires"). The precheck flagged
// neither, because 53 of the newest 60 land runs were cancelled and it took each branch's newest finished run, and it never read staging-deploy.yml.
// On 10-24 the release owner corrected d4's "every gate is green" twice (01:44Z and about 07:00Z), because runs read staging_deploy_passed on 3b0fcfee0b
// as release clearance while its full verify, verify-dev run 40067724892, had failed in crawler, search / e2e and three more jobs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Compare, type FailedJob, type HeadStatuses, type Run, measureReach, newestPerBranch, reachMetrics, readFailedJobs } from "../scripts/duties/fixes-reach-prod.ts";

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
  assert.match(line(output.flagged, "staging_deploy_passed"), /^staging deploy passed \(not release clearance\): the newest staging sha whose staging deploy passed is ecd10f3347, run 39779371312/);
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
    if (args[1]?.includes("/statuses")) return JSON.stringify([{ context: "verify-dev/probe", state: "failure", url: "https://github.com/sieu-n/auto-sns-agent/actions/runs/40067724892" },
      { context: "deploy/staging", state: "success", url: "https://github.com/sieu-n/auto-sns-agent/actions/runs/39856360527/attempts/1" }]);
    if (args[1]?.startsWith("repos/")) return JSON.stringify({ main: COMPARE.mainSha, ahead: 1, behind: 0, commits: [{ sha: HEAD, at: "2026-10-22T17:08:03Z", title: "land 60" }] });
    if (args[0] === "run" && args[1] === "view" && args[2] === "40067724892")
      return JSON.stringify({ databaseId: 40067724892, status: "in_progress", conclusion: "", createdAt: "2026-10-23T03:30:00Z", headBranch: "staging", headSha: HEAD,
        url: "https://github.com/r/40067724892", displayTitle: `probe ${HEAD}` });
    if (args[0] === "run" && args[1] === "view") {
      const jobs = args[2] === "39856360527" ? [{ name: "scope / light", conclusion: "failure", steps: [{ name: DEPLOY_JOBS[0]!.steps[0]!, conclusion: "failure" }] }]
        : [{ name: "land / light", conclusion: "failure", steps: [{ name: LAND_JOBS[0]!.steps[0]!, conclusion: "failure" }, { name: "setup", conclusion: "success" }] }];
      return JSON.stringify({ jobs });
    }
    const workflow = args[args.indexOf("--workflow") + 1];
    if (workflow === "promote.yml") return rows([]);
    if (workflow === "verify-dev.yml") return rows([]);
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
  assert.ok(calls.some(args => args[0] === "api" && args[1] === `repos/sieu-n/auto-sns-agent/commits/${HEAD}/statuses?per_page=100`));
  assert.ok(calls.some(args => args[0] === "run" && args[1] === "view" && args[2] === "40067724892"));
  assert.match(line(output.flagged, "no_promotable_staging_sha"), /its full verify, run 40067724892, is in_progress/);
});

test("a job gh lists with no conclusion but a failed step still names that step", async () => {
  const exec = async (): Promise<string> => JSON.stringify({ jobs: [
    { name: "land / light", conclusion: "", steps: [{ name: "pick / the newest tested tree of each dev branch, merged onto staging", conclusion: "failure" }] },
    { name: "land / push", conclusion: "skipped", steps: [] }] });
  const jobs = await readFailedJobs({ exec, fetch: globalThis.fetch, now: () => NOW }, 39915261080);
  assert.deepEqual(jobs, [{ name: "land / light", steps: ["pick / the newest tested tree of each dev branch, merged onto staging"] }]);
});

const VERIFIED = "3b0fcfee0ba8d84de520d381beb6cec85344906c";
const VERIFIED_COMPARE: Compare = { ...COMPARE, commits: [{ sha: VERIFIED, at: Date.parse("2026-10-24T05:41:00Z"), title: "land: dev/sieun-mac-mail-warmup fe1762da8" }] };
const verifyRun = (id: number, conclusion: string, sha = VERIFIED): Run =>
  run(id, conclusion, "2026-10-24T05:48:54Z", { branch: "staging", sha, title: `probe ${sha}` });
const statuses = (verify: string): HeadStatuses => ({ sha: VERIFIED,
  deploy: { state: "success", url: "https://github.com/sieu-n/auto-sns-agent/actions/runs/40067355666/attempts/1" },
  verify: { state: verify, url: "https://github.com/sieu-n/auto-sns-agent/actions/runs/40067724892" } });
const VERIFY_JOBS: FailedJob[] = ["macos (tasks)", "crawler", "search / e2e", "linux (rest)", "linux (demo)"].map(name => ({ name, steps: [] }));

test("a green staging deploy with a red full verify reads no promotable staging sha with the verify's red jobs, never promotable", () => {
  const stagingDeploys = [run(40067355666, "success", "2026-10-24T05:43:00Z", { branch: "staging", sha: VERIFIED })];
  const output = reachMetrics({ compare: VERIFIED_COMPARE, promotes: [], lands: [], stagingDeploys, headStatuses: statuses("failure"),
    fullVerifies: [verifyRun(40067724892, "failure")], failedJobs: new Map([[40067724892, VERIFY_JOBS]]), health: [], errors: [] }, Date.parse("2026-10-24T07:00:00Z"));
  assert.ok(!kinds(output.flagged).includes("promotable"));
  assert.match(line(output.flagged, "staging_deploy_passed"), /^staging deploy passed \(not release clearance\): .* is 3b0fcfee0b, run 40067355666/);
  assert.equal(line(output.flagged, "no_promotable_staging_sha"), "no promotable staging sha: promote.yml ships only staging's head 3b0fcfee0b, and its full verify, run 40067724892, " +
    "ended failure; the newest finished full verify is run 40067724892 of 3b0fcfee0b from 2026-10-24T05:48Z, which ended failure in macos (tasks); crawler; " +
    "search / e2e; linux (rest); linux (demo): https://github.com/r/40067724892");
});

test("staging's head reads promotable only when its deploy/staging status and its own full verify both passed", () => {
  const read = (headStatuses: HeadStatuses, fullVerifies: Run[]) => reachMetrics({ compare: VERIFIED_COMPARE, promotes: [], lands: [], headStatuses, fullVerifies,
    failedJobs: new Map(), health: [], errors: [] }, NOW);
  const green = read(statuses("success"), [verifyRun(40067724892, "success")]);
  assert.match(line(green.flagged, "promotable"), /^promotable: staging's head 3b0fcfee0b has a successful deploy\/staging status and its full verify, run 40067724892/);
  assert.ok(!kinds(green.flagged).includes("no_promotable_staging_sha"));
  const otherSha = read(statuses("success"), [verifyRun(40067724892, "success", HEAD)]);
  assert.match(line(otherSha.flagged, "no_promotable_staging_sha"), /names run 40067724892, which tested 6e71eb0478/);
  const noVerify = read({ sha: VERIFIED, deploy: { state: "pending", url: "" } }, []);
  assert.match(line(noVerify.flagged, "no_promotable_staging_sha"), /its newest deploy\/staging status is pending, and it has no full verify yet/);
});

test("a failed promote that a later green promote followed leaves failed_promotes_24h", () => {
  const at = Date.parse("2026-10-25T22:25:00Z");
  const promotes = [run(40191052854, "success", "2026-10-25T11:57:00Z"), run(40170404510, "failure", "2026-10-25T06:48:00Z"), run(40169054833, "failure", "2026-10-25T06:25:00Z")];
  const output = reachMetrics({ compare: COMPARE, promotes, lands: [], failedJobs: new Map(), health: [], errors: [] }, at);
  assert.equal(output.metrics.failed_promotes_24h, 0);
  assert.equal(output.lastEventAt, undefined);
  assert.match(line(output.flagged, "promote_failed_24h"), /promote run 40191052854 passed its gates after it/);
  const later = reachMetrics({ compare: COMPARE, promotes: [run(40200000000, "failure", "2026-10-25T20:00:00Z"), ...promotes], lands: [], failedJobs: new Map(), health: [], errors: [] }, at);
  assert.equal(later.metrics.failed_promotes_24h, 1);
  assert.deepEqual(later.lastEventAt, { failed_promotes_24h: Date.parse("2026-10-25T20:00:00Z") });
});
