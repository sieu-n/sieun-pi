import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, checkInPrecheckText, convergenceMisses } from "../src/chat-checkin.ts";
import { countedGap, goalGaps } from "../src/checkin-findings.ts";
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

test("goal gaps: 8 of 200 Mbps with no live job is a 96% gap and counts; a goal at 90% is listed, not counted; a missing or stale measurement is listed", () => {
  const board = boardOf([
    step("p1", "Use the whole proxy plan", "doing", { target: PROXY, children: [step("p2", "Raise crawler concurrency", "todo", { waitFor: "the proxy pool review" })] }),
    step("p3", "Fast search", "doing", { target: { metric: "queries under 1 s", target: 100, unit: "%", current: 90, measuredAt: iso(NOW - 5 * MIN), source: "ClickHouse p95" },
      children: [step("p4", "Cache facets", "todo")] }),
    step("p5", "Reply within a day", "todo", { target: { metric: "replies within 24 h", target: 95, unit: "%" } }),
    step("p6", "Crawl every account", "doing", { target: { metric: "accounts crawled", target: 1000, unit: "accounts", current: 400, measuredAt: iso(NOW - 2 * HOUR), source: "ops page" },
      children: [step("p7", "Run the backfill", "doing", { job: "backfill" })] }),
    step("p8", "Done goal", "done", { target: { ...PROXY, current: 0 } }),
    step("p9", "Met goal", "doing", { target: { ...PROXY, current: 210 } }),
  ]);
  const live: JobFact = { key: "k1", name: "backfill", state: "working", activityAt: NOW - MIN };
  const precheck = checkInPrecheck(undefined, [live], board, NOW, { everyMs: EVERY });
  assert.deepEqual(precheck.goals.map(gap => `${gap.goal.id} ${gap.state.kind === "measured" ? gap.state.percent + "%" : "unmeasured"}${gap.live ? " live" : ""}`),
    ["p5 unmeasured", "p1 4%", "p6 40% live", "p3 90%"], "largest gap first; a met goal and a done goal are not listed");
  assert.deepEqual(precheck.goals.filter(countedGap).map(gap => gap.goal.id), ["p1"], "only p1 is more than 50% short with no live job");
  const output = convergenceMisses("c1", precheck.steps, precheck, {}, EVERY, NOW);
  assert.equal(output.metrics.goal_gaps, 1);
  const [flag] = output.flagged.filter(slice => slice.kind === "goal_gaps");
  assert.equal(flag!.item, "p1");
  assert.match(flag!.excerpt, /^p1 "Use the whole proxy plan": proxy bandwidth used 8 \/ 200 Mbps \(4%\), 96% short, measured .* by "proxy dashboard, 24 h average"; no live job$/);
  const text = checkInPrecheckText(precheck, [live], output.flagged, NOW);
  const section = text.split("\n\n").find(part => part.startsWith("### Goal gaps"))!;
  assert.match(section, /push the next concrete step that closes the gap in this run: start or steer a job, pull a slot forward; confirming that steps are waiting is not an answer/);
  const lines = section.split("\n").slice(1);
  assert.match(lines[0]!, /^- p5 "Reply within a day": replies within 24 h target 95%, not measured; no live job: measure it in this run$/);
  assert.match(lines[1]!, /^- p1 .*96% short/);
  assert.match(lines[2]!, /^- p6 .*400 \/ 1,000 accounts \(40%\), 60% short at its last measurement, not measured since .*; a job of it is live: measure it again in this run$/,
    "2 h is past 2 check-in intervals of 15 min");
  assert.match(lines[3]!, /^- p3 .*10% short/);
  assert.ok(text.indexOf("### Goal gaps") < text.indexOf("### Every open step"), "the gaps come before the step list");
});

test("goal gaps: staleness is 2 check-in intervals, or 24 h for a daily metric", () => {
  const stale = (target: GoalTarget, everyMs: number) => { const state = targetState(target, everyMs, NOW); return state.kind === "measured" && state.stale; };
  const target: GoalTarget = { ...PROXY, measuredAt: iso(NOW - 3 * HOUR) };
  assert.equal(stale(target, HOUR), true);
  assert.equal(stale(target, 2 * HOUR), false);
  assert.equal(stale({ ...target, cadence: "daily" }, HOUR), false);
  assert.equal(stale({ ...target, cadence: "daily", measuredAt: iso(NOW - 25 * HOUR) }, HOUR), true);
  assert.deepEqual(goalGaps(boardOf([step("p1", "Goal", "doing", { target: { ...PROXY, current: 200 } })]), [], EVERY, NOW), [], "a fresh measurement at target is no gap");
});
