/**
 * A red duty is read again between its slots, as Prime's chat does (`Duties.push` and `boardChanged` in legacy/prime/user-history):
 * 1. A red duty that is not due, with no job at work on it, gets a push run a check-in interval after its newest run, which starts a duty job
 *    and leaves the schedule where it was.
 * 2. A miss whose fix step waits on an open For you todo gets no push run.
 * 3. A fix step of the duty that closes starts a verify run at once.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/duty-push.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Duty, DutyRunRecord } from "../../web/src/lib/api/shared/chat-duties.ts";
import type { DutyFile } from "../../server/boards.ts";
import { FIXTURE_AGENTS as agents } from "../../server/fixture/seed.ts";
import { start, until, type Running } from "./helpers.ts";

const HOUR = 3_600_000;
const fileOf = (s: Running): DutyFile => s.app.boards.dutyFile(agents.vent);

/** A duty that runs once a week and whose precheck misses, with one red run `age` ago that started no job. */
async function seedRedDuty(s: Running, work: string, age: number): Promise<Duty> {
  const now = Date.now();
  const duty = {
    id: "d1", name: "Push duty", ownerWords: "keep it up", goal: "it stays up", metrics: [{ key: "up", label: "Up", op: ">=", target: 99, headline: true }],
    schedule: { kind: "every", minutes: 7 * 24 * 60 }, onMiss: "fix it", status: "active", createdAt: now - 10 * 24 * HOUR, updatedAt: now, lastRunAt: now - age, runCount: 1,
    precheck: { command: ["node", "-e", `require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ metrics: { up: 90 } }))`], cwd: work, timeoutMs: 30_000 },
  } as Duty;
  const red: DutyRunRecord = {
    duty: "d1", at: now - age, trigger: "schedule", ms: 1, verdict: "missed", metrics: { up: { value: 90, target: 99, op: ">=", met: false } }, summary: "up 90 (target at least 99)",
  };
  await s.app.boards.saveDuties(agents.vent, { duties: [duty], runs: { d1: [red] } } as DutyFile);
  return duty;
}

async function withServer(body: (s: Running, work: string) => Promise<void>): Promise<void> {
  const s = await start();
  const work = mkdtempSync(join(tmpdir(), "duty-push-"));
  try {
    await body(s, work);
  } finally {
    await s.close();
    rmSync(work, { recursive: true, force: true });
  }
}

test("a red duty with no job on it gets a push run a check-in interval after its newest run, with a job, and keeps its schedule", () => withServer(async (s, work) => {
  const duty = await seedRedDuty(s, work, 25 * HOUR);
  await s.app.boards.tick();
  const file = await until(() => Promise.resolve(fileOf(s)), f => (f.runs.d1?.length ?? 0) === 2 && !!f.runs.d1![0]!.job);
  const [push] = file.runs.d1!;
  assert.equal(push!.trigger, "push");
  assert.equal(push!.verdict, "missed");
  assert.equal(file.duties[0]!.lastRunAt, duty.lastRunAt, "a push run leaves the schedule where it was");
  // Its job still works, so the next tick pushes nothing.
  await s.app.boards.tick();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(fileOf(s).runs.d1!.length, 2);
}));

test("a red duty whose newest run is younger than the check-in interval gets no push run", () => withServer(async (s, work) => {
  await seedRedDuty(s, work, 60_000);
  await s.app.boards.tick();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(fileOf(s).runs.d1!.length, 1);
}));

test("a miss whose fix step waits on an open For you todo gets no push run", () => withServer(async (s, work) => {
  await seedRedDuty(s, work, 25 * HOUR);
  await s.app.boards.apply(agents.vent, [{ op: "plan_add", text: "Bring uptime back", duty: "d1/up" }], "agent");
  const step = (await s.app.boards.board(agents.vent))!.plan.find(item => item.duty === "d1/up")!.id;
  await s.app.boards.apply(agents.vent, [{ op: "todo_add", text: "Pick the new host for the uptime fix.", step }], "agent");
  await s.app.boards.tick();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(fileOf(s).runs.d1!.length, 1);
}));

test("a fix step of the duty that closes starts a verify run at once", () => withServer(async (s, work) => {
  const duty = await seedRedDuty(s, work, 60_000);
  await s.app.boards.apply(agents.vent, [{ op: "plan_add", text: "Bring uptime back", duty: "d1/up" }], "agent");
  const step = (await s.app.boards.board(agents.vent))!.plan.find(item => item.duty === "d1/up")!.id;
  await s.app.boards.apply(agents.vent, [{ op: "plan_update", id: step, status: "done" }], "agent");
  const file = await until(() => Promise.resolve(fileOf(s)), f => (f.runs.d1?.length ?? 0) === 2);
  assert.equal(file.runs.d1![0]!.trigger, "verify");
  assert.equal(file.duties[0]!.lastRunAt, duty.lastRunAt);
}));
