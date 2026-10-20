// Guards the duty fleet share that the Chat system duty (d9) reads.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dutyFleet, readsTheShare } from "../scripts/duties/duty-fleet.ts";
import { DutyStore } from "../src/chat-duty-store.ts";

const duty = (id: string, key: string, op: ">=" | "<=", target: number) => ({ id, name: `duty ${id}`, ownerWords: "keep it working", goal: "It works.",
  metrics: [{ key, label: key, op, target, headline: true }], schedule: { kind: "every", minutes: 60 }, precheck: { command: ["true"] }, onMiss: "Fix it.", status: "active", runCount: 1 });
const run = (id: string, key: string, value: number, target: number, op: ">=" | "<=", met: boolean, at: number) =>
  ({ duty: id, at, slot: at, trigger: "schedule", ms: 1, verdict: met ? "met" : "missed", metrics: { [key]: { value, target, op, met } }, summary: key });

test("the duty that reads duties_green_pct stays out of the share, so it can reach 100 once every other duty is green", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "duty-fleet-"));
  try {
    const harness = "chat-harness", other = "chat-other";
    await writeFile(join(dataDir, "chats.json"), JSON.stringify({ ids: [harness, other] }));
    await mkdir(join(dataDir, "duties"), { recursive: true });
    const d9 = duty("d9", "duties_green_pct", ">=", 100);
    await writeFile(join(dataDir, "duties", `${harness}.json`), JSON.stringify({ version: 1, duties: [d9] }));
    await writeFile(join(dataDir, "duties", `${other}.json`), JSON.stringify({ version: 1, duties: [duty("d1", "errors", "<=", 0)] }));
    const store = new DutyStore(dataDir);
    await store.appendRun(harness, run("d9", "duties_green_pct", 98.3, 100, ">=", false, 1_000) as never);
    await store.appendRun(other, run("d1", "errors", 0, 0, "<=", true, 1_000) as never);
    const fleet = await dutyFleet({ dataDir, now: 2_000, sessions: () => [] });
    assert.equal(readsTheShare(d9), true);
    // The built-in check-ins have no run here, so they are pending and outside the share.
    assert.deepEqual(fleet.duties.filter(entry => entry.duty !== "checkin").map(entry => `${entry.chat}/${entry.duty}`), ["chat-other/d1"]);
    assert.equal(fleet.metrics.duties_green_pct, 100);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
