/**
 * A duty job's brief names the board key it works for by its kind: an agent id `ag_<slug>` as an agent, and a root chat's thread id as a
 * thread. Until 11-23 every brief called the key a thread, so an agent's duty job read "(thread ag_agent-factory)".
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/duty-brief.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { dutyJobBrief } from "../../server/duty-run.ts";
import type { Duty, DutyRunRecord } from "../../web/src/lib/api/shared/chat-duties.ts";

const duty = { id: "d1", name: "Probe", ownerWords: "keep it up", goal: "it stays up", onMiss: "fix it", metrics: [{ key: "up", label: "Up", op: ">=", target: 1, headline: true }],
  schedule: { kind: "daily", at: "07:00" }, precheck: { command: ["node", "probe.ts"], cwd: "/tmp", timeoutMs: 30_000 } } as unknown as Duty;
const record = { duty: "d1", at: 0, slot: 0, trigger: "schedule", ms: 1, verdict: "missed", metrics: {}, summary: "up 0" } as DutyRunRecord;
const brief = (id: string) => dutyJobBrief({ duty, chat: { id, name: "Probe chat" }, at: 0, measure: "up 0", findings: "f", misses: [], record, boardApi: "http://x/board" });

test("a duty brief calls an agent id an agent and a root chat's id a thread", () => {
  assert.match(brief("ag_agent-factory"), /\(agent ag_agent-factory\)/);
  assert.doesNotMatch(brief("ag_agent-factory"), /thread ag_/);
  assert.match(brief("01a14210-4e7d-72c3-aa67-e3d476f4e728"), /\(thread 01a14210-4e7d-72c3-aa67-e3d476f4e728\)/);
});
