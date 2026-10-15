import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { judge, parseDutyInput } from "../src/shared/chat-duties.ts";
import { type Commit, type Deploy, type DeployDeps, type Side, deployMetrics, measureDeploys, RAILWAY, redeployFor, standing, touchesWatched } from "../scripts/duties/slack-green-deploys.ts";

const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);
const CI_SKIP = "CI check suite failed";
const WATCHED = "No changes to watched files";
/** slack-green main as it stood on 2026-10-14 at 01:40Z, 18 min after #233 merged, oldest first; the worker ran b0e7009. */
const OLD = "b0e7009000000000000000000000000000000000";
const MAIN: Commit[] = [
  { sha: "42060afa0fb2859c39a3472c6ac028715ababa1e", at: at("2026-10-10T01:19:50Z") },
  { sha: "715c39dfca92afee290d3335e437ee94fa8ff736", at: at("2026-10-12T18:17:20Z") },
  { sha: "4222b4b7d62d25ac34fe8e91bde350e8a33a6f08", at: at("2026-10-14T01:22:18Z") },
];
const HEAD = MAIN[2]!.sha;
const FILES: Record<string, string[]> = {
  [MAIN[0]!.sha]: ["packages/frontend/src/app/page.tsx", "packages/backend/pyproject.toml"],
  [MAIN[1]!.sha]: ["packages/frontend/package.json"],
  [HEAD]: ["packages/backend/app/worker.py", "packages/backend/pyproject.toml"],
};
const RAILWAY_1014: Deploy[] = [
  { status: "SKIPPED", at: at("2026-10-14T01:22:20Z"), sha: HEAD, reason: CI_SKIP },
  { status: "SKIPPED", at: at("2026-10-12T18:17:22Z"), sha: MAIN[1]!.sha, reason: WATCHED },
  { status: "SKIPPED", at: at("2026-10-10T01:19:51Z"), sha: MAIN[0]!.sha, reason: WATCHED },
  { status: "SUCCESS", at: at("2026-10-09T18:43:31Z"), sha: OLD },
];
const NOW = at("2026-10-14T01:40:00Z");
const LATER = NOW + 30 * MIN;
const TOML = `[build]\n# Paths are from the repo root.\nwatchPatterns = [\n  "/packages/backend/app/**",\n  "/packages/backend/Dockerfile",\n  "/packages/backend/uv.lock",\n  "/packages/backend/railway.toml",\n]\n`;
const watchedMain = (): Commit[] => MAIN.map(commit => ({ ...commit, watched: FILES[commit.sha]!.some(file => file.startsWith("packages/backend/app/")) }));
const railwaySide = (behind: Commit[] = watchedMain(), deploys: Deploy[] = RAILWAY_1014): Side => ({ live: OLD, deploys, behind });

test("deploys: the worker missing #233 past 20 min is one commit not live, named with Railway's CI skip", () => {
  const { metrics, flagged } = deployMetrics({ railway: railwaySide(), vercel: { live: HEAD, deploys: [], behind: [] }, errors: [] }, LATER);
  assert.equal(metrics.commits_not_live, 1);
  assert.equal(metrics.railway_not_live, 1);
  assert.match(flagged.find(item => item.kind === "railway_not_live")!.excerpt, /runs b0e7009, which lacks 4222b4b \(47 min after its push, SKIPPED: CI check suite failed\)/);
  assert.ok(flagged.some(item => item.kind === "vercel_ok"));
  const verdict = judge([{ key: "commits_not_live", label: "x", op: "<=", target: 0, headline: true }], { metrics });
  assert.equal(verdict.verdict, "missed");
});

test("deploys: frontend-only commits the worker lacks are fine, and a commit under 20 min is pending, not counted", () => {
  const frontend = watchedMain().slice(0, 2);
  assert.deepEqual(standing("railway", frontend, LATER), { late: [], pending: [] });
  assert.equal(standing("railway", watchedMain(), NOW).late.length, 0, "4222b4b is 17 min old at 01:40Z");
  assert.equal(standing("railway", watchedMain(), NOW).pending.length, 1);
  assert.equal(standing("railway", MAIN, LATER).late.length, 3, "a commit whose files could not be read counts as watched");
  assert.equal(standing("vercel", frontend, LATER).late.length, 2, "Vercel runs every commit");
});

test("deploys: a commit late on both sides counts once, and a source failure is a miss with the error flagged", () => {
  const both = deployMetrics({ railway: railwaySide(), vercel: { live: MAIN[1]!.sha, deploys: [{ status: "ERROR", at: MAIN[2]!.at, sha: HEAD }], behind: [MAIN[2]!] }, errors: [] }, LATER);
  assert.deepEqual([both.metrics.commits_not_live, both.metrics.railway_not_live, both.metrics.vercel_not_live], [1, 1, 1]);
  assert.match(both.flagged.find(item => item.kind === "vercel_not_live")!.excerpt, /4222b4b \(47 min after its push, ERROR\)/);
  const broken = deployMetrics({ vercel: { live: HEAD, deploys: [], behind: [] }, errors: ["Railway deployments: railway deployment: Unauthorized"] }, LATER);
  assert.equal(broken.metrics.commits_not_live, 1, "an unmeasured worker never reads as good");
  assert.equal(broken.metrics.source_errors, 1);
  assert.match(broken.flagged.find(item => item.kind === "source_error")!.excerpt, /Unauthorized\. The headline counts this run as a miss/);
});

test("deploys: railway.toml's watch patterns match app code, not a version bump", () => {
  const patterns = [/^packages\/backend\/app\/.*$/, /^packages\/backend\/uv\.lock$/];
  assert.equal(touchesWatched(["packages/backend/pyproject.toml", "packages/frontend/x.ts"], patterns), false);
  assert.equal(touchesWatched(["packages/backend/app/lib/schedule.py"], patterns), true);
  assert.equal(touchesWatched(Array.from({ length: 300 }, (_, index) => `docs/${index}.md`), patterns), true, "GitHub's 300-file cap counts as watched");
});

test("deploys: the precheck redeploys the head once, and not while a deployment of the head is building", () => {
  const side = railwaySide();
  assert.equal(redeployFor(side, LATER, { redeployed: {} }), HEAD);
  assert.equal(redeployFor(side, LATER, { redeployed: { [HEAD]: NOW } }), null);
  assert.equal(redeployFor(side, NOW, { redeployed: {} }), null, "nothing is late yet");
  assert.equal(redeployFor(railwaySide(undefined, [{ status: "BUILDING", at: LATER - MIN, sha: HEAD }, ...RAILWAY_1014]), LATER, { redeployed: {} }), null);
  assert.equal(redeployFor(railwaySide(undefined, [{ status: "WAITING", at: LATER - 25 * MIN, sha: HEAD }, ...RAILWAY_1014]), LATER, { redeployed: {} }), HEAD,
    "a deployment stuck on Railway's CI wait is not a build");
});

/** Fake GitHub, Railway CLI, Vercel and Railway GraphQL; `calls` records each serviceInstanceDeployV2 call. */
function fakeDeps(railway: Deploy[], calls: unknown[], options: { deployStatus?: number; now?: number } = {}): DeployDeps {
  const rows = railway.map(deploy => ({ status: deploy.status, createdAt: new Date(deploy.at).toISOString(), meta: { commitHash: deploy.sha, skippedReason: deploy.reason } }));
  const behind = (live: string) => MAIN.slice(MAIN.findIndex(commit => commit.sha === live) + 1);
  return {
    now: () => options.now ?? LATER,
    railwayToken: async () => "railway-token",
    vercelToken: async () => "vercel-token",
    exec: async (file, args) => {
      const path = args[1] ?? "";
      if (file === "gh" && path.includes("/compare/")) {
        return JSON.stringify(behind(/compare\/(\w+)\.\.\./.exec(path)![1]!).map(commit => ({ sha: commit.sha, at: new Date(commit.at).toISOString() })));
      }
      if (file === "gh" && path.includes("/contents/")) return TOML;
      if (file === "gh" && path.includes("/commits/")) return JSON.stringify(FILES[path.split("/").at(-1)!]);
      if (file === "railway" && args[0] === "deployment") return JSON.stringify(rows);
      return "";
    },
    fetch: (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("backboard.railway.com")) {
        calls.push(JSON.parse(String(init?.body)));
        return new Response(options.deployStatus === 401 ? "{\"errors\":[{\"message\":\"Not Authorized\"}]}" : "{\"data\":{\"serviceInstanceDeployV2\":\"d1\"}}",
          { status: options.deployStatus ?? 200 });
      }
      if (href.includes("/v9/projects/")) return new Response(JSON.stringify({ targets: { production: { meta: { githubCommitSha: HEAD } } } }));
      return new Response(JSON.stringify({ deployments: [{ state: "READY", created: MAIN[2]!.at, meta: { githubCommitSha: HEAD } }] }));
    }) as typeof fetch,
  };
}

test("deploys: a run reads the files of each late commit, redeploys main's head once, and the next run does not redeploy again", async () => {
  const calls: { variables: { s: string; e: string; c: string } }[] = [];
  const first = await measureDeploys(fakeDeps(RAILWAY_1014, calls), { redeployed: {} });
  assert.deepEqual(calls.map(call => call.variables), [{ s: RAILWAY.serviceId, e: RAILWAY.environmentId, c: HEAD }]);
  assert.deepEqual(first.output.metrics, { commits_not_live: 1, railway_not_live: 1, vercel_not_live: 0, source_errors: 0 });
  assert.match(first.output.flagged!.find(item => item.kind === "redeploy")!.excerpt, /deployed main's head 4222b4b to the Railway worker once/);
  assert.deepEqual(first.state.redeployed, { [HEAD]: LATER });
  const second = await measureDeploys(fakeDeps(RAILWAY_1014, calls), first.state);
  assert.equal(calls.length, 1, "one redeploy per head");
  assert.equal(second.output.metrics.commits_not_live, 1, "a head that is still not live stays a miss");
});

test("deploys: after slack-green #253, CI's own worker deploy of the head reads as live, and Railway's cancelled WAITING one does not matter", async () => {
  const calls: unknown[] = [];
  const ci = [{ status: "SUCCESS", at: MAIN[2]!.at + 11 * MIN, sha: HEAD }, { status: "REMOVED", at: MAIN[2]!.at + 2 * MIN, sha: HEAD }, ...RAILWAY_1014.slice(1)];
  const run = await measureDeploys(fakeDeps(ci, calls), { redeployed: {} });
  assert.equal(calls.length, 0);
  assert.equal(run.output.metrics.commits_not_live, 0);
  assert.ok(run.output.flagged!.some(item => item.kind === "railway_ok"));
});

test("deploys: a failed redeploy is flagged and tried again on the next run", async () => {
  const calls: unknown[] = [];
  const run = await measureDeploys(fakeDeps(RAILWAY_1014, calls, { deployStatus: 401 }), { redeployed: {} });
  assert.equal(calls.length, 1);
  assert.match(run.output.flagged!.find(item => item.kind === "redeploy_error")!.excerpt, /HTTP 401/);
  assert.deepEqual(run.state.redeployed, {});
});

test("deploys: the duty file parses, runs daily at 03:00, and has one headline metric", async () => {
  const definition: unknown = JSON.parse(await readFile(join(import.meta.dirname, "../scripts/duties/slack-green-deploys.duty.json"), "utf8"));
  const duty = parseDutyInput(definition, "d-test", NOW);
  assert.deepEqual(duty.schedule, { kind: "daily", at: "03:00" });
  assert.deepEqual(duty.metrics.map(metric => [metric.key, metric.headline]), [["commits_not_live", true]]);
});
