// Chat 01a140fb (10-22): its 04:16Z check-in missed goal_gaps on p25, the chat closed p25, and every later tick logged "check-in: nothing to
// check" and recorded nothing, so the duty fleet still counted the 04:16Z miss at 08:00Z and AI harness d9 read that chat's check-in as red.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Duties, NOTHING_TO_CHECK } from "../src/chat-duty-run.ts";
import type { DutyJobHost } from "../src/chat-duty-job.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import { missStreak } from "../src/shared/duty-streak.ts";

const CHAT = "01a140fb-77df-703a-b28a-1a9f9a487c22";
const missedAt = Date.parse("2026-10-22T04:16:01Z");
const metric = (value: number) => ({ value, target: 0, op: "<=" as const, met: value <= 0 });
const MISSED = { goal_gaps: metric(1), stuck_steps: metric(0), no_done_line: metric(0), plan_risks: metric(0) };

async function runner() {
  const dir = await mkdtemp(join(tmpdir(), "checkin-clean-"));
  const store = new DutyStore(dir);
  const duties = new Duties(store, { isChat: async () => true, jobs: {} as DutyJobHost, tickMs: 0, log: () => {} });
  return { dir, store, duties };
}

test("a chat with nothing to check after a missed check-in records one met check-in, which ends the miss streak", async () => {
  const { dir, store, duties } = await runner();
  try {
    await store.appendRun(CHAT, { duty: "checkin", at: missedAt, slot: missedAt, trigger: "schedule", ms: 9000, verdict: "missed", metrics: MISSED,
      summary: "goal_gaps 1 (target at most 0)", job: { id: "01a1614c-0000-7000-8000-000000000000", name: "check-in morning report 13:16" } });
    const cleanAt = Date.parse("2026-10-22T05:16:30Z");
    await duties.checkInClean(CHAT, cleanAt, "schedule");
    const [clean] = await store.runs(CHAT);
    assert.equal(clean!.at, cleanAt);
    assert.equal(clean!.verdict, "met");
    assert.deepEqual(Object.values(clean!.metrics).map(result => result.value), [0, 0, 0, 0]);
    assert.ok(clean!.summary.endsWith(NOTHING_TO_CHECK), clean!.summary);
    assert.equal(clean!.job, undefined, "a clean board starts no check-in job");
    assert.equal(missStreak((await store.runs(CHAT)).filter(run => run.duty === "checkin")), 0);

    await duties.checkInClean(CHAT, cleanAt + 30 * 60_000, "schedule");
    assert.equal((await store.runs(CHAT)).length, 2, "the next idle tick writes nothing, since the newest check-in already reads met");
    duties.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a chat with nothing to check and no check-in run yet, or a newest one that reads met after its job, gets no record", async () => {
  const { dir, store, duties } = await runner();
  try {
    await duties.checkInClean(CHAT, missedAt, "schedule");
    assert.deepEqual(await store.runs(CHAT), [], "a chat never measured stays pending");
    await store.appendRun(CHAT, { duty: "checkin", at: missedAt, slot: missedAt, trigger: "schedule", ms: 9000, verdict: "missed", metrics: MISSED,
      summary: "goal_gaps 1 (target at most 0)", after: { at: missedAt + 600_000, verdict: "met", metrics: { ...MISSED, goal_gaps: metric(0) }, summary: "all 4 on target" } });
    await duties.checkInClean(CHAT, missedAt + 3_600_000, "schedule");
    assert.equal((await store.runs(CHAT)).length, 1, "the check-in job fixed its own miss, so its run already reads met");
    duties.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
