// 10-27 07:03Z: d9 read stuck_steps_all 4 from sep launch!!'s 06:49Z check-in run, skipped while its 06:33Z check-in job waited in pi-pool's
// turn queue. That job held the 4 steps it flagged: it steered their jobs at 07:10Z, and its after-job measure at 07:11Z read 0. A skipped
// run's reading counts only once the job it was skipped behind has ended and measured nothing newer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type PlanInputs, planCounts, stuckReading } from "../scripts/duties/whole-system.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const SEP = "01a15427-145f-751d-ba15-d27b6c30f65f";
const at = (clock: string): number => Date.parse(`2026-10-27T${clock}Z`);
const ids = ["p105", "p106", "p107", "p108"];
const stuck = (value: number) => ({ stuck_steps: { value, target: 0, op: "<=", met: value === 0 } });
const flagged = (time: number) => ids.map(item => ({ chat: SEP, at: time, kind: "stuck_steps", excerpt: `${item} is stuck (release)`, item }));
const job = { id: "01a17c10-e3f7-72ae-878e-ab5cae4bc5e4", name: "check-in sep launch!! 15:33" };
const jobRun = (after?: number) => ({ duty: "checkin", at: at("06:33:59"), verdict: "missed", metrics: stuck(4), flagged: flagged(at("06:33:59")), job,
  ...after === undefined ? {} : { after: { at: after, verdict: "met", metrics: stuck(0), summary: "" } } });
const skipped = { duty: "checkin", at: at("06:49:04"), verdict: "skipped", metrics: stuck(4), flagged: flagged(at("06:49:04")),
  summary: "skipped: previous run still working (job check-in sep launch!! 15:33 waits 61 of 113 in pi-pool's turn queue)" };
const step = (id: string): PlanItem => ({ id, text: `step ${id}`, status: "todo", children: [], waitFor: "the next prod promote (p980)" });
const board = { v: 2, rev: 1, updatedAt: "2026-10-27T06:20:00Z", todos: [], plan: [{ ...step("p104"), children: ids.map(step) }] } as unknown as ChatBoard;
const input = (runs: unknown[], now: number) => ({ now, boards: new Map([[SEP, board]]), named: new Map(), poolWaiting: new Set<string>(),
  waking: new Set<string>(), ownerActivity: new Map(), chats: [{ id: SEP, name: "sep launch!!", runs, everyMs: 3_600_000, paused: false, duties: [] }] }) as unknown as PlanInputs;

test("a check-in run skipped behind a check-in job still at work counts none of the steps that job flagged", () => {
  const runs = [skipped, jobRun()];
  assert.equal(stuckReading(runs as never[]), runs[1]);
  assert.deepEqual(planCounts(input(runs, at("07:03:51"))).stuck, [], "sep launch!!'s 06:33Z job still waited in pi-pool's queue at 07:03:51Z");
});

test("once that job ends, its after-job measure counts over the skipped run's older reading", () => {
  const runs = [skipped, jobRun(at("07:11:46"))];
  assert.equal(stuckReading(runs as never[]), runs[1]);
  assert.deepEqual(planCounts(input(runs, at("07:12:00"))).stuck, [], "the 07:11:46Z after-job measure read 0");
  const left = [skipped, { ...jobRun(at("07:11:46")), after: { at: at("07:11:46"), verdict: "missed", metrics: stuck(1), summary: "" } }];
  assert.equal(planCounts(input(left, at("07:12:00"))).stuck[0]?.value, 1, "an after-job measure that left a step stuck counts it");
});

test("a skipped run still counts when no check-in job stands before it, or the run before it has no job", () => {
  const met = { duty: "checkin", at: at("06:18:58"), verdict: "met", metrics: stuck(0) };
  assert.equal(stuckReading([skipped, met] as never[]), skipped);
  assert.equal(stuckReading([skipped] as never[]), skipped);
  const counts = planCounts(input([skipped, met], at("06:55:00")));
  assert.deepEqual(counts.stuck.flatMap(entry => entry.items), ids);
});
