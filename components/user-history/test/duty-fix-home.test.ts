import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBoardOp, emptyBoard, nextIds, openGoals, titleDetail } from "../src/shared/chat-board.ts";
import { fixStepOps, plainStepTitle } from "../src/shared/duty-fixes.ts";
import type { BoardOp, ChatBoard, PlanItem, PlanStatus } from "../src/shared/types.ts";

// 10-15 from 14:38Z the server's fix-step write was refused on every 30 s tick for four stuck duties, so none of them got a fix job:
// 01a115e2 d2 and 01a11ba8 d2 had a done board goal and 3 misses, which became 3 new goals past the limit of 6; 01a11bd7's check-in has no
// board goal and its board held 6 open goals; 01a1180e d1 has a metric label that names "land.yml", which the c61 title rule refuses.

const item = (id: string, status: PlanStatus, children: PlanItem[] = [], extra: Partial<PlanItem> = {}): PlanItem =>
  ({ id, text: `Work ${id}`, status, children, ...extra }) as PlanItem;
const board = (plan: PlanItem[]): ChatBoard => ({ ...emptyBoard("2026-10-15T14:38:00.000Z"), rev: 3, plan });
const apply = (start: ChatBoard, ops: readonly BoardOp[]): ChatBoard =>
  ops.reduce((current, op) => applyBoardOp(current, op, "agent", "2026-10-15T14:39:00.000Z", nextIds(current)).board, start);
const all = (plan: readonly PlanItem[]): PlanItem[] => plan.flatMap(entry => [entry, ...all(entry.children)]);
const job = { id: "01a14000-0000-7000-8000-000000000001", name: "fix geonode proxy use Crawler VP 23:28" };
const miss = (key: string) => ({ key, value: 9.3, target: 5, op: "<=" as const });
const geonode = { id: "d2", name: "GeoNode proxy use", goal: "Census reads ride the proxy without waste.", boardGoal: "p4",
  metrics: [{ key: "retry_extra_s", label: "Seconds one retry adds" }, { key: "hold_min_24h", label: "Minutes a supply hold stopped reads" },
    { key: "capped_exits_24h", label: "Census exits dropped by our read cap" }] };

test("a duty whose board goal is done gets its 3 fix steps under that goal, reopened, instead of 3 new goals past the limit (01a115e2 d2)", () => {
  const start = board([item("p4", "done"), ...["p71", "p146", "p504", "p505", "p506"].map(id => item(id, "doing"))]);
  const after = apply(start, fixStepOps(start, geonode, geonode.metrics.map(metric => miss(metric.key)), job));
  const p4 = after.plan.find(entry => entry.id === "p4")!;
  assert.equal(p4.status, "todo");
  assert.deepEqual(p4.children.map(child => child.duty), ["d2/retry_extra_s", "d2/hold_min_24h", "d2/capped_exits_24h"]);
  assert.equal(openGoals(after.plan).length, 6);
});

test("with no board goal and 6 goals open the steps go under an open goal, the one holding the newest step when no goal shares the area (01a11bd7 check-in)", () => {
  const start = board(["p80", "p83", "p124", "p125", "p126"].map(id => item(id, "doing")).concat(item("p127", "doing", [item("p130", "doing")])));
  const checkin = { id: "checkin", name: "Check-in", goal: "Every open step moves.", metrics: [{ key: "stuck_steps", label: "Stuck steps" }] };
  const after = apply(start, fixStepOps(start, checkin, [{ key: "stuck_steps", value: 10, target: 0, op: "<=" }], job));
  assert.deepEqual(all(after.plan).filter(entry => entry.duty).map(entry => [entry.duty, after.plan.find(goal => goal.children.includes(entry))?.id]), [["checkin/stuck_steps", "p127"]]);
  assert.equal(openGoals(after.plan).length, 6);
});

test("with no board goal and room under the limit the duty gets one goal with every new step under it", () => {
  const start = board([item("p62", "doing"), item("p105", "doing")]);
  const after = apply(start, fixStepOps(start, { id: geonode.id, name: geonode.name, metrics: geonode.metrics }, geonode.metrics.map(metric => miss(metric.key)), job));
  assert.equal(openGoals(after.plan).length, 3);
  const goal = after.plan.at(-1)!;
  assert.equal(goal.text, "GeoNode proxy use duty meets every target");
  assert.equal(goal.children.length, 3);
});

test("a new fix step goes beside the duty's open linked steps, and an open step for the same metric is reused", () => {
  const start = board([item("p71", "doing", [item("p492", "doing", [], { duty: "d2/retry_extra_s" })]), item("p4", "done"),
    ...["p146", "p504", "p505", "p506"].map(id => item(id, "doing"))]);
  const dropped = { ...geonode, boardGoal: "p999" };
  const ops = fixStepOps(start, dropped, [miss("retry_extra_s"), miss("hold_min_24h")], job);
  assert.deepEqual(ops[0], { op: "plan_update", id: "p492", job: job.name, sessionId: job.id });
  const after = apply(start, ops);
  assert.deepEqual(after.plan[0]!.children.map(child => child.duty), ["d2/retry_extra_s", "d2/hold_min_24h"]);
});

test("a metric label with a file name gives a plain step title the board takes (01a1180e d1, land.yml)", () => {
  assert.equal(plainStepTitle("land.yml runs that passed, 7 d, cancelled left out in the CI system duty reaches at least 90%"),
    "land runs that passed, 7 d, cancelled left out in the CI system duty reaches at least 90%");
  assert.equal(plainStepTitle("Runs after ci/dev-123 at c8cb9b4 on apps/web/src/x.ts"), "Runs after dev-123 at on x");
  for (const text of ["ok", "run 38727990287 passed", "see ~/a/b.json and abc1234def"]) assert.equal(titleDetail(plainStepTitle(text)), null);
  const ci = { id: "d1", name: "CI system", boardGoal: "p69", metrics: [{ key: "land_pass_pct_7d", label: "land.yml runs that passed, 7 d, cancelled left out", unit: "%" }] };
  const start = board([item("p60", "doing", [item("p69", "doing")])]);
  const after = apply(start, fixStepOps(start, ci, [{ key: "land_pass_pct_7d", value: 61, target: 90, op: ">=" }], job));
  assert.equal(after.plan[0]!.children[0]!.children[0]!.duty, "d1/land_pass_pct_7d");
});
