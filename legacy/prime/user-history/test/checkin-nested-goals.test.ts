// Crawler VP 10-19: the check-in raised extra_goals in 13 check-ins in a row for 13 open goals, each with a live number and owner, and told the
// chat to fold goals of one area under one area goal. A folded goal lost its number, trend, pace and push step, because goal_gaps, goalNumber
// and the duty readings read only top-level targets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, convergenceMisses } from "../src/chat-checkin.ts";
import { GOAL_PUSH_LINK, goalNumber, goalPushes } from "../src/checkin-goals.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { goalReadingOps } from "../src/goal-readings.ts";
import { openGoals } from "../src/shared/chat-board.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const now = Date.parse("2026-10-19T20:00:00Z");
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const job = (name: string): JobFact => ({ key: `sub-${name}`, name, state: "working", activityAt: now - 60_000 });
const push = (id: string, name: string): PlanItem => ({ id, text: `Push ${name}`, status: "doing", job: name, duty: GOAL_PUSH_LINK, children: [] });
const goal = (id: string, text: string, current: number, children: PlanItem[] = []): PlanItem => ({ id, text, status: "doing", children,
  target: { metric: text, target: 100, unit: "%", current, measuredAt: at(10), source: "a probe", direction: "up" } });
const board = (plan: PlanItem[]): ChatBoard => ({ v: 2, rev: 1, updatedAt: at(5), plan, todos: [] }) as unknown as ChatBoard;

// p1 "Instagram" is an area with no target. p828 sits under it with its own target and push step; p900 is the area's own loose step.
const p828 = goal("p828", "Instagram creators indexed", 40, [push("p833", "census seed order"), { id: "p834", text: "Seed more creators", status: "todo", children: [] }]);
const area: PlanItem = { id: "p1", text: "Instagram", status: "doing", children: [p828, { id: "p900", text: "Tidy the Instagram notes", status: "todo", children: [] }] };

test("a goal with a target under an area goal is a goal of its own, and the area is none", () => {
  assert.deepEqual(openGoals([area]).map(item => item.id), ["p828"]);
});

test("a nested goal keeps its number, trend and push step owner", () => {
  const facts = [job("census seed order")];
  const memory = { at: now - 30 * 60_000, steps: {}, goals: { p828: { readings: [{ value: 30, at: now - 120 * 60_000 }], still: 0 } }, jobs: {} };
  const precheck = checkInPrecheck(memory as never, facts, board([area]), now);
  const [nested, ...rest] = precheck.goals;
  assert.equal(rest.length, 0);
  assert.equal(nested?.goal.id, "p828");
  assert.equal(nested?.number?.value, 40);
  assert.equal(nested?.trend?.kind, "moving");
  assert.equal(nested?.pushStep, "p833");
  assert.equal(nested?.owner?.name, "census seed order");
  assert.equal(precheck.memory.goals?.p828?.readings.at(-1)?.value, 40);
  assert.equal(precheck.steps.find(view => view.item.id === "p833")?.goal?.id, "p828");
  assert.equal(precheck.steps.find(view => view.item.id === "p900")?.goal?.id, "p1");
});

test("a goal with a target over a nested goal keeps its own push step and does not read the nested goal's metric", () => {
  const inner = goal("p20", "Instagram profiles re-read", 50, [{ id: "p21", text: "Fix re-reads", status: "doing", duty: "d4/profiles_reread_pct", children: [] }, push("p22", "reread job")]);
  const outer = goal("p10", "Instagram profiles indexed", 70, [inner, push("p11", "index job")]);
  const views = checkInPrecheck(undefined, [job("reread job"), job("index job")], board([outer]), now).steps;
  const { pushes } = goalPushes(board([outer]), views, undefined, 30 * 60_000, now);
  assert.deepEqual(pushes.map(entry => [entry.goal.id, entry.pushStep, entry.owner?.name]).sort(), [["p10", "p11", "index job"], ["p20", "p22", "reread job"]]);
  const metrics = new Map([["d4/profiles_reread_pct", { value: 90, target: 100, op: ">=" as const, at: now - 60_000 }]]);
  assert.equal(goalNumber(outer, 30 * 60_000, metrics as never)?.value, 70);
  assert.equal(goalNumber(inner, 30 * 60_000, metrics as never)?.value, 90);
});

test("a duty run writes its reading into a nested goal's target", () => {
  const inner = goal("p20", "Instagram profiles re-read", 50, [{ id: "p21", text: "Fix re-reads", status: "doing", duty: "d4/profiles_reread_pct", children: [] }]);
  const plan = [{ ...area, children: [inner] }];
  const ops = goalReadingOps(board(plan), "d4", now, { profiles_reread_pct: { value: 90, target: 100, op: ">=" } } as never);
  assert.deepEqual(ops.map(op => op.op === "plan_update" ? [op.id, op.target?.current] : []), [["p20", 90]]);
});

const thirteen = (lacking?: "number" | "owner"): { plan: PlanItem[]; facts: JobFact[] } => {
  const plan: PlanItem[] = [];
  const facts: JobFact[] = [];
  for (let n = 1; n <= 13; n++) {
    const name = `goal job ${n}`;
    const item = goal(`p${100 + n}`, `Goal number ${n}`, 50, [push(`p${200 + n}`, name)]);
    if (n === 13 && lacking === "number") delete item.target;
    if (n !== 13 || lacking !== "owner") facts.push(job(name));
    // Six of them sit under an area goal, as the Instagram goals would.
    plan.push(item);
  }
  return { plan: [{ id: "p2", text: "Instagram", status: "doing", children: plan.slice(0, 6) }, ...plan.slice(6)], facts };
};
const extra = (lacking?: "number" | "owner") => {
  const { plan, facts } = thirteen(lacking);
  const precheck = checkInPrecheck(undefined, facts, board(plan), now);
  const misses = convergenceMisses("chat", precheck.steps, precheck, {}, 30 * 60_000, now);
  return { goals: precheck.goals.length, flagged: misses.flagged.filter(slice => slice.kind === "extra_goals"), count: misses.metrics.extra_goals };
};

test("13 open goals that all carry a live number and owner raise no extra_goals flag", () => {
  const out = extra();
  assert.equal(out.goals, 13);
  assert.equal(out.count, 0);
  assert.deepEqual(out.flagged, []);
});

test("past 6 open goals, a goal with no number or no live owner is flagged with what to add", () => {
  const none = extra("number");
  assert.equal(none.count, 1);
  assert.equal(none.flagged[0]?.item, "p113");
  assert.match(none.flagged[0]?.excerpt ?? "", /one of 13 open goals, over the target of 6, and has no number: give it a target/);
  const ownerless = extra("owner");
  assert.equal(ownerless.count, 1);
  assert.match(ownerless.flagged[0]?.excerpt ?? "", /no live job owns its number: set one live job on its push step/);
});
