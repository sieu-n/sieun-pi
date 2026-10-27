// From 10-23 07:00Z to 10-24 07:00Z the check-ins started 211 jobs, and 181 of them on runs that read met, most with a prompt that said
// "Nothing is due: every goal moves on pace with a live owner. End in one short turn." Each job waited in pi-pool's turn line, where turns
// waited a median 872 s from 05:40Z to 06:41Z on 10-24 (73 queued on average behind 12 working), ahead of the red duties' fix jobs.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInIdle } from "../src/chat-checkin.ts";
import { Duties, NOTHING_DUE } from "../src/chat-duty-run.ts";
import { DutyStore } from "../src/chat-duty-store.ts";
import type { GoalPush } from "../src/checkin-goals.ts";
import type { PlanItem } from "../src/shared/types.ts";

const CHAT = "01a15427-145f-751d-ba15-d27b6c30f65f";
const MIN = 60_000;
const goal = (id: string): PlanItem => ({ id, text: `goal ${id}`, status: "doing", children: [] });
const owner = { key: "sub-1", name: "metal agent queue", state: "working" } as const;
const number = { metric: "hours held", target: 2, unit: "hours", op: ">=" as const, value: 0, measuredAt: 0, source: "", staleMs: 3_600_000 };
const push = (extra: Partial<GoalPush>): GoalPush => ({ goal: goal("p22"), words: [], paraphrased: [], stale: false, act: "on_pace", number, ...extra }) as GoalPush;

test("a check-in with nothing due is idle; a due steer, a job push, a stuck step or a met item to close is not", () => {
  const quiet = push({ act: "steer", owner, trend: { kind: "still", runs: 3 }, quiet: { pushedAt: 0, nextAt: 3_600_000 } });
  assert.equal(checkInIdle({ goals: [push({ trend: { kind: "moving", delta: 1, since: 0, etaMs: 1 } }), quiet], end: [] }, null), true);
  assert.equal(checkInIdle({ goals: [push({ act: "steer", owner, trend: { kind: "still", runs: 3 } })], end: [] }, null), false, "a steer is due");
  assert.equal(checkInIdle({ goals: [], end: [] }, "Check-in: nudged job x."), false, "the server pushed a job");
  assert.equal(checkInIdle({ goals: [], end: [{ state: "stuck" } as never] }, null), false, "a step has no live owner");
  assert.equal(checkInIdle({ goals: [push({ trend: { kind: "met" } })], end: [] }, null), false, "a goal at target closes this run");
});

test("an idle check-in that reads met records its run and starts no job; a missed one still starts its job", async () => {
  const dir = await mkdtemp(join(tmpdir(), "checkin-idle-"));
  try {
    const store = new DutyStore(dir);
    let now = Date.parse("2026-10-24T06:00:00Z");
    const started: string[] = [];
    const duties = new Duties(store, {
      isChat: async () => true, now: () => now, tickMs: 0, node: process.execPath,
      jobs: {
        chat: async id => ({ id, name: "sep launch!!", cwd: dir, board: id }),
        working: async () => false,
        retire: async () => {},
        start: async (_chat, name) => { started.push(name); return { id: `job-${started.length}`, name }; },
      },
    });
    const run = (metrics: Record<string, number>) => duties.checkIn(CHAT, { at: now, trigger: "schedule", everyMs: 15 * MIN, classes: {}, findings: "", idle: true,
      output: { metrics, flagged: [] } });
    await run({ goal_gaps: 0, stuck_steps: 0, no_done_line: 0, plan_risks: 0 });
    assert.deepEqual(started, []);
    const [record] = await store.runs(CHAT);
    assert.equal(record!.verdict, "met");
    assert.ok(record!.summary.endsWith(NOTHING_DUE), record!.summary);
    now += 15 * MIN;
    await run({ goal_gaps: 1, stuck_steps: 0, no_done_line: 0, plan_risks: 0 });
    await duties.settled();
    assert.equal(started.length, 1, "a missed run starts its job even with no due line");
    duties.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
