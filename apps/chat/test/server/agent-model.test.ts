/**
 * An agent's threads run on its work thread's model: an agent made on Fable 5.2 at xhigh gets its DM comm thread and its duty jobs on Fable 5.2
 * at xhigh, and an agent on the default model keeps Opus 5.5 at high (c31).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none --test-timeout=120000 test/server/agent-model.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { DutyFile } from "../../server/boards.ts";
import type { AgentSummary } from "../../web/src/lib/api/types.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { start, until, type Running } from "./helpers.ts";

const FABLE = "anthropic/claude-fable-5-2";
let s: Running;
let work: string;
const host = () => s.host as FixtureHost;
const modelOf = (thread: string): [string, string] => {
  const row = host().threadsById.get(thread)!.row;
  return [`${row.provider}/${row.modelId}`, row.thinkingLevel];
};

before(async () => {
  s = await start();
  work = mkdtempSync(join(tmpdir(), "agent-model-"));
});
after(async () => {
  await s.close();
  rmSync(work, { recursive: true, force: true });
});

test("a Fable agent's DM comm thread runs on Fable at its thinking level, and a default agent's on Opus 5.5 high", async () => {
  const fable = (await s.send<AgentSummary & { thread: string }>("POST", "/api/agents", { name: "Fable probe", model: FABLE, thinkingLevel: "xhigh", test: true })).body;
  const plain = (await s.send<AgentSummary & { thread: string }>("POST", "/api/agents", { name: "Opus probe", test: true })).body;
  const commOf = (id: string) => s.app.agents.record(id)?.comm?.[s.app.agents.record(id)!.room];
  await until(async () => [commOf(fable.id), commOf(plain.id)], ([a, b]) => Boolean(a && b));
  assert.deepEqual(modelOf(fable.thread), [FABLE, "xhigh"]);
  assert.deepEqual(modelOf(commOf(fable.id)!), [FABLE, "xhigh"]);
  assert.deepEqual(modelOf(commOf(plain.id)!), ["anthropic/claude-opus-5-5", "high"]);
});

test("a duty job of a Fable agent runs on Fable at its thinking level", async () => {
  const fable = (await s.send<AgentSummary & { thread: string }>("POST", "/api/agents", { name: "Fable duty probe", model: FABLE, thinkingLevel: "xhigh", test: true })).body;
  const now = Date.now();
  const duty = {
    id: "f1", name: "Fable sweep probe", ownerWords: "look it over", goal: "nothing slips", metrics: [{ key: "up", label: "Up", op: ">=", target: 99, headline: true }],
    schedule: { kind: "daily", at: "07:04" }, onMiss: "report it", status: "active", createdAt: now, updatedAt: now, runCount: 0,
    precheck: { command: ["node", "-e", `require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { up: 90 } }))`], cwd: work, timeoutMs: 30_000 },
  };
  await s.app.boards.saveDuties(fable.id, { duties: [duty], runs: {} } as DutyFile);
  assert.equal((await s.send("POST", `/api/threads/${fable.thread}/duties`, { duty: "f1", action: "run" })).status, 200);
  const job = await until(async () => [...host().threadsById.values()].find(t => t.row.name.startsWith("Fable sweep probe duty")), found => Boolean(found));
  assert.deepEqual(modelOf(job!.row.id), [FABLE, "xhigh"]);
});
