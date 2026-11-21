import assert from "node:assert/strict";
import { test } from "node:test";
import type { Step } from "../../web/src/pages/board/model.ts";
import { NO_FILTER, filterActive, filterPlan, menuCount, pathIds, planOwners, type PlanFilter } from "../../web/src/pages/board/plan-filter.ts";

const step = (id: string, text: string, status: Step["status"], children: Step[] = [], extra: Partial<Step> = {}): Step => ({ id, text, status, children, ...extra });
const plan: Step[] = [
  step("p1", "Move the chat onto pi-host", "doing", [
    step("p2", "Rerun the cross-box test", "todo", [], { job: "relay-tests" }),
    step("p3", "Write the release notes", "done"),
  ]),
  step("p4", "Pick a proxy vendor", "blocked", [], { note: "Waits for the owner." }),
  step("p5", "Archive the old relay", "dropped"),
];
const context = { awaitingGo: new Set(["p4"]), ownerOf: (s: Step) => s.job ?? null };
const ids = (list: readonly Step[]): string[] => list.flatMap(s => [s.id, ...ids(s.children)]);
const filter = (patch: Partial<PlanFilter>): PlanFilter => ({ ...NO_FILTER, ...patch });

test("no filter keeps the whole plan and counts every step", () => {
  const out = filterPlan(plan, NO_FILTER, context);
  assert.deepEqual(ids(out.plan), ["p1", "p2", "p3", "p4", "p5"]);
  assert.equal(out.total, 5);
  assert.equal(filterActive(NO_FILTER), false);
});

test("a word match keeps the step and the path above it, and drops its siblings", () => {
  const out = filterPlan(plan, filter({ query: "CROSS-box" }), context);
  assert.deepEqual(ids(out.plan), ["p1", "p2"]);
  assert.deepEqual([...out.matches], ["p2"]);
  assert.deepEqual(pathIds(out.plan), ["p1"]);
});

test("every word must match, in the text, the id or the owner, and a note does not count", () => {
  assert.deepEqual([...filterPlan(plan, filter({ query: "vendor proxy" }), context).matches], ["p4"]);
  assert.deepEqual(filterPlan(plan, filter({ query: "owner" }), context).plan, []);
  assert.deepEqual([...filterPlan(plan, filter({ query: "p5" }), context).matches], ["p5"]);
  assert.deepEqual([...filterPlan(plan, filter({ query: "relay-tests" }), context).matches], ["p2"]);
  assert.deepEqual(filterPlan(plan, filter({ query: "proxy cutover" }), context).plan, []);
});

test("status, needs your go and owner each narrow the plan", () => {
  assert.deepEqual(ids(filterPlan(plan, filter({ statuses: new Set(["done", "dropped"]) }), context).plan), ["p1", "p3", "p5"]);
  assert.deepEqual(ids(filterPlan(plan, filter({ needsGo: true }), context).plan), ["p4"]);
  assert.deepEqual(ids(filterPlan(plan, filter({ owner: "relay-tests" }), context).plan), ["p1", "p2"]);
  const both = filter({ statuses: new Set(["todo"]), owner: "relay-tests", needsGo: true });
  assert.equal(menuCount(both), 3);
  assert.deepEqual(filterPlan(plan, both, context).plan, []);
});

test("the owner list counts each owner's steps, most first", () => {
  const owners = planOwners([...plan, step("p6", "Another test", "todo", [], { job: "relay-tests" }), step("p7", "Docs", "todo", [], { job: "docs" })], context.ownerOf);
  assert.deepEqual(owners, [{ name: "relay-tests", count: 2 }, { name: "docs", count: 1 }]);
});
