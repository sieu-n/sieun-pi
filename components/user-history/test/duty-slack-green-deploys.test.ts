import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import { type Commit, type Deploy, type DeployDeps, deployMetrics, measureDeploys, railwayStanding, RAILWAY, vercelStanding } from "../scripts/duties/slack-green-deploys.ts";

const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);
const CI_SKIP = "CI check suite failed";
const WATCHED = "No changes to watched files";
/** slack-green main and the worker's Railway deployments as they stood on 2026-10-14 at 01:40Z, 18 min after #233 merged. */
const MAIN: Commit[] = [
  { sha: "4222b4b7d62d25ac34fe8e91bde350e8a33a6f08", at: at("2026-10-14T01:22:18Z") },
  { sha: "715c39dfca92afee290d3335e437ee94fa8ff736", at: at("2026-10-12T18:17:20Z") },
  { sha: "42060afa0fb2859c39a3472c6ac028715ababa1e", at: at("2026-10-10T01:19:50Z") },
  { sha: "b0e7009000000000000000000000000000000000", at: at("2026-10-09T18:43:30Z") },
];
const RAILWAY_1014: Deploy[] = [
  { status: "SKIPPED", at: at("2026-10-14T01:22:20Z"), sha: MAIN[0]!.sha, reason: CI_SKIP },
  { status: "SKIPPED", at: at("2026-10-12T18:17:22Z"), sha: MAIN[1]!.sha, reason: WATCHED },
  { status: "SKIPPED", at: at("2026-10-10T01:19:51Z"), sha: MAIN[2]!.sha, reason: WATCHED },
  { status: "SUCCESS", at: at("2026-10-09T18:43:31Z"), sha: MAIN[3]!.sha },
];
const NOW = at("2026-10-14T01:40:00Z");
const frontendPush = (minutesAgo: number): Commit => ({ sha: "f".repeat(40), at: NOW - minutesAgo * MIN });

test("deploys: Railway's CI skip of #233 is a miss, and it is flagged", () => {
  const standing = railwayStanding(MAIN, RAILWAY_1014, NOW);
  assert.equal(standing.kind, "skipped");
  const { metrics, flagged } = deployMetrics({ commits: MAIN, railway: RAILWAY_1014, errors: [] }, NOW);
  assert.equal(metrics.railway_off_main, 1, "a skipped worker deploy must count as off main");
  assert.match(flagged.find(item => item.kind === "railway_skipped")!.excerpt, /runs b0e7009; 4222b4b ended SKIPPED \(CI check suite failed\)/);
});

test("deploys: a later frontend-only push does not hide an earlier skipped backend commit", () => {
  const commits = [frontendPush(5), ...MAIN];
  const railway = [{ status: "SKIPPED", at: NOW - 5 * MIN, sha: commits[0]!.sha, reason: WATCHED }, ...RAILWAY_1014];
  assert.deepEqual(railwayStanding(commits, railway, NOW), { kind: "skipped", sha: MAIN[0]!.sha, status: `SKIPPED (${CI_SKIP})`, live: MAIN[3]!.sha });
});

test("deploys: watched-files skips are fine, a deploy waiting for CI is pending, then stuck after 20 min", () => {
  const live = { status: "SUCCESS", at: NOW - 60 * MIN, sha: MAIN[1]!.sha };
  assert.equal(railwayStanding(MAIN.slice(1), [{ ...live }], NOW).kind, "ok");
  const watchedOnly = [{ status: "SKIPPED", at: NOW - 5 * MIN, sha: MAIN[0]!.sha, reason: WATCHED }, live];
  assert.equal(railwayStanding(MAIN, watchedOnly, NOW).kind, "ok");
  const commits = [{ ...MAIN[0]!, at: NOW - 12 * MIN }, ...MAIN.slice(1)];
  const waiting = [{ status: "WAITING", at: NOW - 12 * MIN, sha: MAIN[0]!.sha }, live];
  assert.equal(railwayStanding(commits, waiting, NOW).kind, "pending");
  assert.equal(railwayStanding(commits, waiting, NOW + 9 * MIN).kind, "stuck");
  assert.equal(deployMetrics({ commits, railway: waiting, errors: [] }, NOW + 9 * MIN).metrics.railway_off_main, 1);
  assert.equal(railwayStanding(commits, [{ status: "FAILED", at: NOW - 3 * MIN, sha: MAIN[0]!.sha }, live], NOW).kind, "failed");
  assert.equal(railwayStanding(commits, [live], NOW).kind, "pending", "no record yet, 12 min after the push");
  assert.equal(railwayStanding(commits, [live], NOW + 9 * MIN).kind, "missing");
});

test("deploys: Vercel production is ok on the head, and a failed, stuck or unpromoted head is a miss", () => {
  const head = MAIN[0]!;
  const old = MAIN[1]!.sha;
  assert.equal(vercelStanding(MAIN, head.sha, [], NOW).kind, "ok");
  assert.equal(vercelStanding(MAIN, old, [{ status: "BUILDING", at: head.at, sha: head.sha }], head.at + 5 * MIN).kind, "pending");
  assert.equal(vercelStanding(MAIN, old, [{ status: "BUILDING", at: head.at, sha: head.sha }], head.at + 25 * MIN).kind, "stuck");
  assert.equal(vercelStanding(MAIN, old, [{ status: "ERROR", at: head.at, sha: head.sha }], head.at + 5 * MIN).kind, "failed");
  const unpromoted = vercelStanding(MAIN, old, [{ status: "READY", at: head.at, sha: head.sha }], head.at + 21 * MIN);
  assert.equal(unpromoted.kind, "stuck");
  assert.equal(vercelStanding(MAIN, old, [], head.at + 21 * MIN).kind, "missing");
  const { metrics } = deployMetrics({ commits: MAIN, vercel: { production: old, deploys: [{ status: "ERROR", at: head.at, sha: head.sha }] }, errors: [] }, NOW);
  assert.equal(metrics.vercel_off_main, 1);
});

/** Fake GitHub, Railway CLI, Vercel and Railway GraphQL; `deploys` records each serviceInstanceDeployV2 call. */
function fakeDeps(railway: Deploy[], deploys: unknown[], deployStatus = 200): DeployDeps {
  const rows = railway.map(deploy => ({ status: deploy.status, createdAt: new Date(deploy.at).toISOString(), meta: { commitHash: deploy.sha, skippedReason: deploy.reason } }));
  return {
    now: () => NOW,
    railwayToken: async () => "railway-token",
    vercelToken: async () => "vercel-token",
    exec: async (file, args) => {
      if (file === "gh") return JSON.stringify(MAIN.map(commit => ({ sha: commit.sha, at: new Date(commit.at).toISOString() })));
      if (file === "railway" && args[0] === "deployment") return JSON.stringify(rows);
      return "";
    },
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("backboard.railway.com")) {
        deploys.push(JSON.parse(String(init?.body)));
        return new Response(deployStatus === 200 ? "{\"data\":{\"serviceInstanceDeployV2\":\"d1\"}}" : "{\"errors\":[{\"message\":\"Not Authorized\"}]}", { status: deployStatus });
      }
      if (href.includes("/v9/projects/")) return new Response(JSON.stringify({ targets: { production: { meta: { githubCommitSha: MAIN[0]!.sha } } } }));
      return new Response(JSON.stringify({ deployments: [{ state: "READY", created: MAIN[0]!.at, meta: { githubCommitSha: MAIN[0]!.sha } }] }));
    }) as typeof fetch,
  };
}

test("deploys: a CI skip redeploys main's head to the worker once, and the next run does not redeploy again", async () => {
  const calls: { variables: { s: string; e: string; c: string } }[] = [];
  const first = await measureDeploys(fakeDeps(RAILWAY_1014, calls), { redeployed: {} });
  assert.deepEqual(calls.map(call => call.variables), [{ s: RAILWAY.serviceId, e: RAILWAY.environmentId, c: MAIN[0]!.sha }]);
  assert.equal(first.output.metrics.railway_off_main, 1);
  assert.equal(first.output.metrics.vercel_off_main, 0);
  assert.equal(first.output.metrics.source_errors, 0);
  assert.match(first.output.flagged!.find(item => item.kind === "redeploy")!.excerpt, /Railway skipped 4222b4b, so this check deployed main's head 4222b4b/);
  assert.deepEqual(first.state.redeployed, { [MAIN[0]!.sha]: NOW });
  const second = await measureDeploys(fakeDeps(RAILWAY_1014, calls), first.state);
  assert.equal(calls.length, 1, "one redeploy per skipped commit");
  assert.equal(second.output.metrics.railway_off_main, 1, "a skip that is still not live stays a miss");
});

test("deploys: a failed redeploy is flagged and tried again on the next run", async () => {
  const calls: unknown[] = [];
  const run = await measureDeploys(fakeDeps(RAILWAY_1014, calls, 401), { redeployed: {} });
  assert.equal(calls.length, 1);
  assert.match(run.output.flagged!.find(item => item.kind === "redeploy_error")!.excerpt, /HTTP 401/);
  assert.deepEqual(run.state.redeployed, {});
});

test("deploys: the duty file parses and runs daily at 03:00", async () => {
  const definition: unknown = JSON.parse(await readFile(join(import.meta.dirname, "../scripts/duties/slack-green-deploys.duty.json"), "utf8"));
  const duty = parseDutyInput(definition, "d-test", NOW);
  assert.deepEqual(duty.schedule, { kind: "daily", at: "03:00" });
  assert.deepEqual(duty.metrics.map(metric => metric.key), ["railway_off_main", "vercel_off_main", "source_errors"]);
});
