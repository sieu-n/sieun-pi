// Replays d9's run of 15:12:22Z on 11-24. It read api portal vp's d2 as stuck on its 11:06Z miss (prod_working_pct 99.4) while d2's verify
// run had measured since 15:08:15Z and recorded met at 15:13:00Z, so the run pushed the chat and counted the duty in redOwners.none.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MEASURING_FRESH_MS, measuringRuns, redOwners, type RedDuty, withoutWorkingRuns } from "../scripts/duties/chat-system.ts";
import { type PlanInputs, planCounts } from "../scripts/duties/whole-system.ts";
import type { DutyRunRecord } from "../src/shared/chat-duties.ts";

const at = (clock: string) => Date.parse(`2026-11-24T${clock}Z`);
const API = "01a1301d-18de-7129-a559-cfb92f9b5fb1";
const NOW = at("15:12:22");
const missed: DutyRunRecord = { duty: "d2", at: at("11:06:00"), trigger: "schedule", ms: 120_000, verdict: "missed", summary: "prod_working_pct 99.4 (target at least 100)",
  metrics: { prod_working_pct: { value: 99.4, target: 100, op: ">=", met: false } } };
const inputs = { now: NOW, chats: [{ id: API, name: "api portal vp", runs: [missed], duties: [{ id: "d2", name: "Portal matches crawler" }], paused: false }],
  boards: new Map([[API, { v: 2, rev: 1, updatedAt: "2026-11-24T11:00:00Z", todos: [], plan: [] }]]), ownerActivity: new Map(), waking: new Set<string>(),
  poolWaiting: new Set<string>(), named: new Map() } as unknown as PlanInputs;

test("d9 leaves a red duty whose own run measures now to that run (api portal vp d2, 15:12:22Z on 11-24)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "d9-measuring-"));
  try {
    const red = planCounts(inputs).redDuties;
    assert.deepEqual(red.map(entry => entry.duty), ["d2"], "the 11:06Z miss reads red with no fix step");
    await mkdir(join(dataDir, "duties", API), { recursive: true });
    await writeFile(join(dataDir, "duties", API, "d2.measuring.json"), JSON.stringify({ at: at("15:08:15"), trigger: "verify", slot: null }));
    const measuring = await measuringRuns(dataDir, red, NOW);
    const stuck = withoutWorkingRuns(red, new Map([[API, [missed]]]), [], NOW, new Set(), new Set(), measuring);
    assert.equal(stuck.length, 0, "stuck_duties reads 0 while d2's verify run measures");
    const fleet = { pct: 98.8, red: [{ chat: API, duty: "d2", name: "Portal matches crawler", green: false, misses: 1, stuck: false } satisfies RedDuty] };
    const owners = redOwners({ fleet, stuckDuties: stuck });
    assert.equal(owners.none, 0);
    assert.equal(owners.ownRuns, 1, "the duty's own run owns the red");
    const stale = await measuringRuns(dataDir, red, at("15:08:15") + MEASURING_FRESH_MS + 1);
    assert.equal(withoutWorkingRuns(red, new Map([[API, [missed]]]), [], NOW, new Set(), new Set(), stale).length, 1, "a marker the server lost counts as stuck again");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
