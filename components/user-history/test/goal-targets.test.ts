import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, checkInPrecheckText, convergenceMisses } from "../src/chat-checkin.ts";
import { goalPushes } from "../src/checkin-goals.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { applyBoardOp, BoardError, emptyBoard, nextIds, parseBoardOps, renderOpenPlan, targetState } from "../src/shared/chat-board.ts";
import type { BoardActor, BoardOp, ChatBoard, GoalTarget, PlanItem } from "../src/shared/types.ts";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const EVERY = 15 * MIN;
const iso = (at: number) => new Date(at).toISOString();
function run(board: ChatBoard, ops: unknown[], actor: BoardActor = "agent"): ChatBoard {
  for (const op of parseBoardOps(ops)) board = applyBoardOp(board, op as BoardOp, actor, iso(NOW), nextIds(board)).board;
  return board;
}
const invalid = (board: ChatBoard, ops: unknown[], pattern: RegExp) =>
  assert.throws(() => run(board, ops), error => error instanceof BoardError && error.kind === "invalid" && pattern.test(error.message), String(pattern));

/** A proxy plan case: a 200 Mbps plan used at 8 Mbps on average. */
const PROXY: GoalTarget = { metric: "proxy bandwidth used", target: 200, unit: "Mbps", current: 8, measuredAt: iso(NOW - 10 * MIN), source: "proxy dashboard, 24 h average" };

test("goal target: the reducer sets, keeps, updates and clears a goal's target", () => {
  const board = run(emptyBoard(iso(NOW - HOUR)), [{ op: "plan_add", text: "Use the whole proxy plan", target: PROXY }, { op: "plan_add", parent: "p1", text: "Raise crawler concurrency" }]);
  assert.deepEqual(board.plan[0]!.target, PROXY);
  assert.match(renderOpenPlan(board), /^ {2}\[ \] p1 Use the whole proxy plan \(8 \/ 200 Mbps \(4%\)\)$/m, "the agent reads the target with its percent");
  const kept = run(board, [{ op: "plan_set", items: [{ id: "p1", text: "Use the whole proxy plan", children: [{ id: "p2", text: "Raise crawler concurrency" }] }] }]);
  assert.deepEqual(kept.plan[0]!.target, PROXY, "plan_set keeps a goal's target it leaves out");
  const measured = run(board, [{ op: "plan_update", id: "p1", target: { ...PROXY, current: 150, measuredAt: iso(NOW) } }]);
  assert.equal(measured.plan[0]!.target!.current, 150);
  const unmeasured = run(emptyBoard(iso(NOW)), [{ op: "plan_add", text: "Reply within a day", target: { metric: "replies within 24 h", target: 95, unit: "%" } }]);
  assert.deepEqual(unmeasured.plan[0]!.target, { metric: "replies within 24 h", target: 95, unit: "%" }, "a goal not measured yet has a target and no measurement");
  assert.equal(run(board, [{ op: "plan_update", id: "p1", target: null }]).plan[0]!.target, undefined);
});

test("goal target: the reducer refuses a bad target and a target on a step", () => {
  const board = run(emptyBoard(iso(NOW - HOUR)), [{ op: "plan_add", text: "Use the whole proxy plan" }, { op: "plan_add", parent: "p1", text: "Raise crawler concurrency" }]);
  invalid(board, [{ op: "plan_update", id: "p1", target: { ...PROXY, target: 0 } }], /target\.target must be a positive number/);
  invalid(board, [{ op: "plan_update", id: "p1", target: { ...PROXY, current: -1 } }], /target\.current must be a non-negative number/);
  invalid(board, [{ op: "plan_update", id: "p1", target: { metric: "x", target: 1, unit: "Mbps", current: 8 } }], /all three, or none/);
  invalid(board, [{ op: "plan_update", id: "p1", target: { ...PROXY, measuredAt: "yesterday" } }], /measuredAt must be an ISO date-time/);
  invalid(board, [{ op: "plan_update", id: "p1", target: { ...PROXY, measuredAt: iso(NOW + HOUR) } }], /in the future/);
  invalid(board, [{ op: "plan_update", id: "p1", target: { ...PROXY, cadence: "weekly" } }], /cadence must be "daily"/);
  invalid(board, [{ op: "plan_update", id: "p1", target: "200 Mbps" }], /target must be \{metric, target, unit/);
  invalid(board, [{ op: "plan_update", id: "p2", target: PROXY }], /Only a goal \(a top-level plan item\) carries a target/);
  invalid(board, [{ op: "plan_add", parent: "p1", text: "Step", target: PROXY }], /Only a goal/);
  invalid(board, [{ op: "plan_set", items: [{ text: "Goal", children: [{ text: "Step", target: PROXY }] }] }], /Only a goal/);
});

const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status, children: [], ...extra });
const boardOf = (plan: PlanItem[]): ChatBoard => ({ v: 2, rev: 1, updatedAt: iso(NOW - 3 * HOUR), todos: [], plan });

test("goal pushes: every open goal gets its number and an act; a goal with no live owner needs a start, a stale one with an owner a steer", () => {
  const board = boardOf([
    step("p1", "Use the whole proxy plan", "doing", { target: PROXY, children: [step("p2", "Raise crawler concurrency", "todo", { waitFor: "the proxy pool review" })] }),
    step("p3", "Fast search", "doing", { target: { metric: "queries under 1 s", target: 100, unit: "%", current: 90, measuredAt: iso(NOW - 5 * MIN), source: "ClickHouse p95" },
      children: [step("p4", "Cache facets", "todo")] }),
    step("p5", "Reply within a day", "todo", { target: { metric: "replies within 24 h", target: 95, unit: "%" } }),
    step("p6", "Crawl every account", "doing", { target: { metric: "accounts crawled", target: 1000, unit: "accounts", current: 400, measuredAt: iso(NOW - 2 * HOUR), source: "ops page" },
      children: [step("p7", "Run the backfill", "doing", { job: "backfill", duty: "checkin/goal_gaps" })] }),
    step("p8", "Done goal", "done", { target: { ...PROXY, current: 0 } }),
    step("p9", "Met goal", "doing", { target: { ...PROXY, current: 210 } }),
  ]);
  const live: JobFact = { key: "k1", name: "backfill", state: "working", activityAt: NOW - MIN };
  const precheck = checkInPrecheck(undefined, [live], board, NOW, { everyMs: EVERY });
  assert.deepEqual(precheck.goals.map(push => `${push.goal.id} ${push.act}${push.owner ? ` ${push.owner.name}` : ""}`),
    ["p5 start", "p1 start", "p3 start", "p6 steer backfill", "p9 on_pace"], "starts first, the largest gap first; a done goal is not listed");
  const output = convergenceMisses("c1", precheck.steps, precheck, {}, EVERY, NOW);
  assert.equal(output.metrics.goal_gaps, 4);
  const p1 = output.flagged.find(slice => slice.kind === "goal_gaps" && slice.item === "p1")!;
  assert.match(p1.excerpt, /^p1 proxy bandwidth used 8 of 200 Mbps, first reading, no trend yet; no live job owns it: add a push step under p1 for one job/);
  const p6 = output.flagged.find(slice => slice.item === "p6")!;
  assert.match(p6.excerpt, /400 of 1,000 accounts, first reading, no trend yet, and its last measurement is from 10-09 10:00Z; job backfill owns it and it is off pace: steer it/,
    "2 h is past 2 check-in intervals of 15 min");
  const text = checkInPrecheckText(precheck, [live], output.flagged, NOW);
  assert.ok(text.startsWith("Goals: 4 of 5 open goals are off pace or have no live owner"), text.slice(0, 120));
  assert.ok(text.indexOf("### Goals") < text.indexOf("### Every open step"), "the goals come before the step list");
});

test("goal pushes: the memo gives the trend; a goal that moved fast enough with a live owner is on pace, a still one is off pace", () => {
  const plan = (p1: number, p3: number) => boardOf([
    step("p1", "Use the whole proxy plan", "doing", { target: { ...PROXY, current: p1, measuredAt: iso(NOW + (p1 === 8 ? -10 * MIN : 110 * MIN)) },
      children: [step("p2", "Raise crawler concurrency", "doing", { job: "proxy", duty: "checkin/goal_gaps" })] }),
    step("p3", "Fast search", "doing", { target: { metric: "queries under 1 s", target: 100, unit: "%", current: p3, measuredAt: iso(NOW - 5 * MIN), source: "ClickHouse p95" },
      children: [step("p4", "Cache facets", "doing", { job: "cache", duty: "checkin/goal_gaps" })] }),
  ]);
  const jobs: JobFact[] = [{ key: "k1", name: "proxy", state: "working", activityAt: NOW }, { key: "k2", name: "cache", state: "working", activityAt: NOW }];
  const first = checkInPrecheck(undefined, jobs, plan(8, 90), NOW, { everyMs: HOUR });
  assert.deepEqual(first.goals.map(push => push.act), ["steer", "steer"], "a first reading has no proven pace");
  const later = NOW + 2 * HOUR;
  const second = checkInPrecheck(first.memory, jobs, plan(40, 90), later, { everyMs: HOUR });
  const byId = new Map(second.goals.map(push => [push.goal.id, push]));
  assert.equal(byId.get("p1")!.act, "on_pace");
  assert.deepEqual(byId.get("p1")!.trend, { kind: "moving", delta: 32, since: NOW - 10 * MIN, etaMs: 10 * HOUR });
  assert.equal(byId.get("p3")!.act, "steer");
  assert.deepEqual(byId.get("p3")!.trend, { kind: "still", runs: 1 });
  assert.deepEqual(second.memory.goals!.p1!.readings.map(reading => reading.value), [8, 40]);
});

test("goal pushes: staleness is 2 check-in intervals, or 24 h for a daily metric", () => {
  const stale = (target: GoalTarget, everyMs: number) => { const state = targetState(target, everyMs, NOW); return state.kind === "measured" && state.stale; };
  const target: GoalTarget = { ...PROXY, measuredAt: iso(NOW - 3 * HOUR) };
  assert.equal(stale(target, HOUR), true);
  assert.equal(stale(target, 2 * HOUR), false);
  assert.equal(stale({ ...target, cadence: "daily" }, HOUR), false);
  assert.equal(stale({ ...target, cadence: "daily", measuredAt: iso(NOW - 25 * HOUR) }, HOUR), true);
  assert.deepEqual(goalPushes(boardOf([step("p1", "Goal", "doing", { target: { ...PROXY, current: 200 } })]), [], undefined, EVERY, NOW).pushes.map(push => push.act), ["on_pace"],
    "a measurement at target is on pace");
});

test("goal pushes: a goal that is itself a duty fix step reads its number from that metric (slack green guy p151, 10-16)", () => {
  const p151 = step("p151", "Signups who connect a Slack workspace, 28 days in the Visitors become paying users duty reaches at least 60%, from 31.82% on the last run", "doing",
    { duty: "d1/signup_to_workspace_pct", job: "fix visitors become paying users slack green guy 08:16" });
  const metrics = new Map([["d1/signup_to_workspace_pct", { met: false, at: NOW - HOUR, value: 34.3, target: 60, op: ">=" as const }]]);
  const [push] = goalPushes(boardOf([p151]), [], undefined, EVERY, NOW, metrics).pushes;
  assert.equal(push!.act, "start", "its job is not at work");
  assert.equal(push!.number?.value, 34.3);
  const precheck = checkInPrecheck(undefined, [{ key: "k1", name: "fix visitors become paying users slack green guy 08:16", state: "working", activityAt: NOW }], boardOf([p151]),
    NOW, { everyMs: EVERY, doneFacts: { metrics, prs: new Map() } });
  assert.deepEqual(precheck.goals.map(entry => [entry.act, entry.owner?.name]), [["steer", "fix visitors become paying users slack green guy 08:16"]], "its own fix job owns the number");
});
