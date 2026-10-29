// Guards duty-fleet's stuck count for a duty red only on quiet windowed counts. At 07:16Z on 10-29 duty-fleet listed the AI harness chat's
// d10 as its one stuck duty: repeat_corrections_7d 10 and repeats_after_fix_7d 7 with no new repeat since 18:02Z on 10-28, so the count only
// ages out by 18:02Z on 11-04, and d9 already said that duty owes no fix job. The run is d10's 06:44Z run on 10-29 with its job left out.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dutyFleet } from "../scripts/duties/duty-fleet.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { CHANGE_APPROACH_MISSES } from "../src/shared/duty-streak.ts";

const RUN = JSON.parse(String.raw`{"duty": "d10", "at": 1793256288048, "slot": 1793256287923, "trigger": "push", "ms": 24038, "verdict": "missed", "metrics": {"repeat_corrections_7d": {"value": 10, "target": 0, "op": "<=", "met": false, "lastEventAt": 1793210569000}, "repeats_after_fix_7d": {"value": 7, "target": 0, "op": "<=", "met": false, "lastEventAt": 1793201438000}, "repeats_no_fix_7d": {"value": 0, "target": 0, "op": "<=", "met": true}}, "summary": ""}`);
const D10 = { id: "d10", name: "owner corrections", ownerWords: "stop repeating", goal: "No repeats.", schedule: { kind: "daily", at: "06:46" },
  precheck: { command: ["true"] }, onMiss: "Fix it.", status: "active", runCount: 1, metrics: [
    { key: "repeat_corrections_7d", label: "repeats", op: "<=", target: 0, headline: true },
    { key: "repeats_after_fix_7d", label: "after fix", op: "<=", target: 0 },
    { key: "repeats_no_fix_7d", label: "no fix", op: "<=", target: 0 }] };
const CLEARS = Date.parse("2026-11-04T18:02:49Z");

async function fleetAt(now: number) {
  const dataDir = await mkdtemp(join(tmpdir(), "duty-fleet-aging-"));
  try {
    const chat = "chat-harness";
    await writeFile(join(dataDir, "chats.json"), JSON.stringify({ ids: [chat] }));
    await mkdir(join(dataDir, "duties"), { recursive: true });
    await writeFile(join(dataDir, "duties", `${chat}.json`), JSON.stringify({ version: 1, duties: [D10] }));
    const store = new DutyStore(dataDir);
    for (let i = CHANGE_APPROACH_MISSES + 1; i > 0; i--) await store.appendRun(chat, { ...RUN, at: RUN.at - i * 3_600_000, slot: RUN.at - i * 3_600_000 } as never);
    return (await dutyFleet({ dataDir, now, sessions: () => [] })).duties.find(entry => entry.duty === "d10")!;
  } finally { await rm(dataDir, { recursive: true, force: true }); }
}

test("d10 of 10-29, red only on 7-day counts with no new repeat, waits on time and is not stuck", async () => {
  const entry = await fleetAt(RUN.at);
  assert.equal(entry.green, false);
  assert.ok(entry.misses >= CHANGE_APPROACH_MISSES);
  assert.equal(entry.agingUntil, CLEARS);
  assert.equal(entry.stuck, false);
});

test("the same duty still red after its counts should have aged out reads stuck", async () => {
  const entry = await fleetAt(CLEARS + 60_000);
  assert.equal(entry.agingUntil, undefined);
  assert.equal(entry.stuck, true);
});
