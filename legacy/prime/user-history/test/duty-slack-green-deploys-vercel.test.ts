// Guards board step p184 (10-20): Vercel's GitHub app started no production deployment for slack-green main 9db2437 (#298) on 10-19,
// while the same push ran CI. Slack green deploys must count such a commit as not live once it is DEPLOY_MINUTES old.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEPLOY_MINUTES, type DeployDeps, measureDeploys } from "../scripts/duties/slack-green-deploys.ts";

const PUSHED = Date.parse("2026-10-19T21:27:42Z");
const LIVE = "c805b4a0000000000000000000000000000000000";
const MISSED = "9db2437226881a003ee79ebf17987335528cb73d";
const MINUTE = 60_000;

function deps(now: number): DeployDeps {
  const exec = async (file: string, args: readonly string[]): Promise<string> => {
    if (file === "gh" && args[0] === "api" && String(args[1]).includes(`/compare/${LIVE}...main`))
      return JSON.stringify([{ sha: MISSED, at: new Date(PUSHED).toISOString() }]);
    if (file === "gh" && args[0] === "api" && String(args[1]).includes("/compare/")) return "[]";
    if (file === "gh" && args[0] === "run") return "[]";
    if (file === "railway" && args[0] === "deployment")
      return JSON.stringify([{ status: "SUCCESS", createdAt: new Date(PUSHED + MINUTE).toISOString(), meta: { commitHash: MISSED } }]);
    return "";
  };
  const fetch = (async () => new Response(JSON.stringify({ targets: { production: { meta: { githubCommitSha: LIVE } } },
    deployments: [{ state: "READY", created: PUSHED - 36 * MINUTE, meta: { githubCommitSha: LIVE } }] }))) as typeof globalThis.fetch;
  return { exec, fetch, now: () => now, railwayToken: async () => "t", vercelToken: async () => "t" };
}

test("a main commit with no Vercel production deployment counts as not live once it is DEPLOY_MINUTES old", async () => {
  const { output } = await measureDeploys(deps(PUSHED + (DEPLOY_MINUTES + 2) * MINUTE), { redeployed: {} });
  assert.equal(output.metrics.commits_not_live, 1);
  assert.equal(output.metrics.vercel_not_live, 1);
  assert.equal(output.metrics.railway_not_live, 0);
  const slice = (output.flagged ?? []).find(item => item.kind === "vercel_not_live");
  assert.match(slice?.excerpt ?? "", new RegExp(`Vercel production runs c805b4a, which lacks 9db2437 \\(${DEPLOY_MINUTES + 2} min after its push, no deployment\\)`));
});

test("before DEPLOY_MINUTES the same commit is pending and not counted", async () => {
  const { output } = await measureDeploys(deps(PUSHED + (DEPLOY_MINUTES - 5) * MINUTE), { redeployed: {} });
  assert.equal(output.metrics.commits_not_live, 0);
  assert.ok((output.flagged ?? []).some(item => item.kind === "vercel_pending"));
});
