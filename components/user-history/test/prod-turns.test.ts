import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PROD_DEPLOY_OWNERS, PROD_HOLD_MS, firingProdAlerts, prodRecord, runningDeploys, startProdTurns } from "../src/prod-turns.ts";
import type { ProdRecord } from "../src/chat-pool.ts";

const [RELEASE, METAL] = PROD_DEPLOY_OWNERS["promote.yml"]!;
const CRAWLER = "01a115e2-9544-7204-b8db-8ce4d5319048";
/** promote 10 try 3 on 10-15, cut to the fields the ci-runs cache's run object starts with. */
const PROMOTE = { id: 38708750431, name: "promote", node_id: "WFR_x", head_branch: "sieun/dev", head_sha: "355c4f6", path: ".github/workflows/promote.yml",
  display_title: "promote", status: "in_progress", conclusion: null, actor: { id: 1, login: "sieu-n" } };
const cache = (...runs: object[]): string => JSON.stringify({ version: 1, intervalSeconds: 30,
  runs: Object.fromEntries(runs.map(run => [String((run as { id: number }).id), { run, runReadAt: 1, jobs: [] }])) });
const bridge = (...rules: [string, string, number?][]) => ({ v: 2, rules: Object.fromEntries(rules.map(([chat, alertname, resolvedAt], i) =>
  [`${chat}/r${i}`, { chat, step: null, rule: `r${i}`, alertname, startsAt: "x", wokeAt: 0, firstWokeAt: 0, instances: {}, ...(resolvedAt ? { resolvedAt } : {}) }])) });

test("prod turns: a promote run in progress makes both owner trees prod, and a completed run or another workflow makes none", () => {
  assert.deepEqual(prodRecord(cache(PROMOTE), null, 1_000_000)?.trees, { [RELEASE!]: "promote.yml run 38708750431", [METAL!]: "promote.yml run 38708750431" });
  const done = { ...PROMOTE, status: "completed", conclusion: "success" };
  const other = { ...PROMOTE, id: 1, path: ".github/workflows/metal-deploy-tests.yml" };
  assert.equal(prodRecord(cache(done, other), null, 0), null);
  assert.deepEqual([...runningDeploys(cache({ ...PROMOTE, id: 7, path: ".github/workflows/metal-deploy.yml", status: "queued" }), ["metal-deploy.yml"])], [["metal-deploy.yml", ["7"]]]);
  assert.equal(prodRecord('{"runs":{"1":{"run":{"id":1,"path":".github/workflows/promote.yml","status":"in_pro', null, 0), null, "a cut file reads as nothing");
});

test("prod turns: only the bridge's open rules of prod alerts make the woken chat prod", () => {
  assert.deepEqual(firingProdAlerts(bridge([CRAWLER, "Production stream entry waiting over 1 hour"], [CRAWLER, "Staging engage fleet under its serving line"],
    ["chat-b", "B2 influencer-dev inventory missing"], ["chat-c", "B2 influencer-prod inventory missing"], ["chat-d", "Production crawler down", 5])),
  { [CRAWLER]: "alert Production stream entry waiting over 1 hour", "chat-c": "alert B2 influencer-prod inventory missing" });
  assert.deepEqual(firingProdAlerts({ v: 9 }), {});
  const record = prodRecord(null, bridge(["chat-c", "prod ingress closed"]), 10_000);
  assert.deepEqual(record, { trees: {}, sessions: { "chat-c": "alert prod ingress closed" }, until: Math.round((10_000 + PROD_HOLD_MS) / 1000) });
});

test("prod turns: the service sends the record each tick while prod work lasts and one clear when it ends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prod-turns-"));
  const runsFile = join(dir, "ci-runs.json"), bridgeFile = join(dir, "alert-bridge.json");
  await writeFile(runsFile, cache(PROMOTE));
  const sent: (ProdRecord | null)[] = [];
  const settle = () => new Promise(resolve => setTimeout(resolve, 60));
  const stop = startProdTurns({ runsFile, bridgeFile, log: () => {}, set: async record => { sent.push(record); } }, 20);
  await settle();
  assert.ok(sent.length >= 2 && sent.every(record => record?.trees[RELEASE!] === "promote.yml run 38708750431"));
  await writeFile(runsFile, cache({ ...PROMOTE, status: "completed" }));
  await settle();
  const after = sent.slice(sent.findIndex(record => record === null));
  stop();
  assert.deepEqual(after, [null], "one clear, then nothing while nothing is prod");
});
