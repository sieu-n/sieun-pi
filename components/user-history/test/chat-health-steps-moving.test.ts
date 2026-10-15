import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stuckPastCheckIn, stuckStepHours } from "../scripts/duties/checkin-quality.ts";

const NOW = Date.parse("2026-10-15T09:00:00Z");
const MIN = 60_000;
const EVERY = { everyMs: 15 * MIN };
const run = (minutesAgo: number, stuck: string[], verdict = "missed") => ({ duty: "checkin", at: NOW - minutesAgo * MIN, slot: NOW - minutesAgo * MIN, trigger: "schedule", ms: 0, verdict,
  metrics: {}, summary: "s", classes: { live: 10 - stuck.length, "stale-chase": stuck.length },
  ...(stuck.length ? { flagged: stuck.map(item => ({ kind: "stuck_steps", item, excerpt: `${item} is stuck (release)` })) } : {}) });

async function dataDir(runs: Record<string, ReturnType<typeof run>[]>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "steps-moving-"));
  await mkdir(join(dir, "duties"), { recursive: true });
  for (const [chat, list] of Object.entries(runs)) await writeFile(join(dir, "duties", `${chat}.runs.jsonl`), list.map(line => JSON.stringify(line)).join("\n") + "\n");
  return dir;
}

test("steps kept moving: a step counts as stuck from the second check-in in a row that finds it stuck, over the day's open step-hours", async () => {
  // Launch main bro 10-14: p56 flagged at 15:36 and 15:51 KST, moved by 16:06; Crawler VP 10-14: 36 steps flagged at 12:32Z and 12:54Z.
  const dir = await dataDir({ c1: [run(60, ["p1"]), run(45, ["p1", "p2"]), { ...run(40, ["p1", "p2"], "skipped") }, run(30, ["p2"]), run(15, [])] });
  try {
    const day = await stuckStepHours(dir, "c1", EVERY, NOW - 24 * 60 * MIN, NOW);
    assert.equal(day.openHours, 10, "10 open steps for an hour");
    assert.equal(day.stuckHours, 0.5, "p1 from the 45 min run to the 30 min run, p2 from the 30 min run to the 15 min run; a skipped run did not look");
    assert.deepEqual(day.steps.map(step => [step.item, step.hours, step.since]), [["p1", 0.25, NOW - 45 * MIN], ["p2", 0.25, NOW - 30 * MIN]]);
    const late = await stuckStepHours(dir, "c1", EVERY, NOW - 40 * MIN, NOW);
    assert.equal(Math.round(late.stuckHours * 60), 25, "the window start cuts the first stuck stretch to 10 min, plus p2's 15 min");
    assert.deepEqual(await stuckStepHours(dir, "c1", { ...EVERY, pausedUntil: "forever", pausedBy: "owner" }, NOW - 24 * 60 * MIN, NOW), { openHours: 0, stuckHours: 0, steps: [] },
      "a chat whose check-in the owner paused has no step-hours");
    const none = await stuckStepHours(dir, "missing", EVERY, NOW - 24 * 60 * MIN, NOW);
    assert.equal(none.openHours, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("steps kept moving: on the board now, a step stuck since the last check-in is its next check-in's work, and a check-in that stopped leaves every stuck step counted", async () => {
  const dir = await dataDir({ c2: [run(35, []), run(20, ["p3"]), run(5, ["p3", "p4"])], c3: [run(50, ["p5"])] });
  try {
    assert.deepEqual(await stuckPastCheckIn(dir, "c2", ["p3", "p4"], EVERY, NOW), { stand: "running", lastAt: NOW - 5 * MIN, left: [{ item: "p3", since: NOW - 20 * MIN, runs: 2 }] },
      "p4 went stuck after the 20 min check-in (10-15: the owner answered t28 at 08:40Z and 14 steps read stuck until the next check-in)");
    assert.deepEqual(await stuckPastCheckIn(dir, "c3", ["p5", "p6"], EVERY, NOW), { stand: "not_running", lastAt: NOW - 50 * MIN,
      left: [{ item: "p5", since: NOW - 50 * MIN, runs: 0 }, { item: "p6", since: NOW - 50 * MIN, runs: 0 }] }, "no measured check-in for over two intervals plus 15 min");
    assert.deepEqual(await stuckPastCheckIn(dir, "c3", ["p5"], { ...EVERY, pausedUntil: "forever", pausedBy: "owner" }, NOW), { stand: "owner_paused", left: [] });
    assert.equal((await stuckPastCheckIn(dir, "c3", ["p5"], { ...EVERY, pausedUntil: "forever", pausedBy: "agent" }, NOW)).stand, "not_running", "an agent's pause does not hide stuck steps");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
