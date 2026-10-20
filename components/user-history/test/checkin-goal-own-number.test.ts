// AI harness 10-20 02:19Z: the check-in flagged p717 "agent sessions GB on us-metal02 after 15 quiet minutes" as goals_off_pace with "no live job
// owns it" and told the chat to steer p769's job, asleep on d7/clean_min_30, while p779's thread worked on d7/quiet_agent_gb under p717.
// p779's own target carried a 5.61 GB reading that named the Mac. A goal reads its own target or its own duty metric, never a step's target, and a
// live job on any open step under it owns it, one on the goal's own metric first.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MetricFact } from "../src/checkin-done.ts";
import { goalGap, goalLine, goalNumber, goalPushes } from "../src/checkin-goals.ts";
import { classifyBoard, type JobFact } from "../src/checkin-steps.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const now = Date.parse("2026-10-20T02:40:00Z");
const every = 30 * 60_000;
const gb = (current: number, at: string, metric = "agent sessions GB on us-metal02 after 15 quiet minutes") =>
  ({ metric, target: 5, unit: "GB", current, measuredAt: at, source: "a read", direction: "down" as const });
const item = (id: string, fields: Partial<PlanItem>): PlanItem => ({ id, text: `Work on ${id}`, status: "doing", children: [], ...fields });

const stretch = item("p779", { duty: "d7/quiet_agent_gb", job: "d7 quiet agent GB pool-wait stretch 10-20", target: gb(5.61, "2026-10-20T02:22:00Z", "quiet_agent_gb") });
const cpu = item("p769", { duty: "d7/clean_min_30", job: "d7 clean minutes cpu share 10-20",
  target: { metric: "clean_min_30", target: 30, unit: "min", current: 3, measuredAt: "2026-10-19T21:58:00Z", source: "a read", direction: "up" } });
const idle = (goalTarget: ReturnType<typeof gb>, children: PlanItem[]): PlanItem =>
  item("p717", { text: "Idle agents free their memory", duty: "d7/quiet_agent_gb", job: "d7 quiet agent GB per idle tree 10-20", target: goalTarget, children });
const facts: JobFact[] = [
  { key: "thread:per-tree", name: "d7 quiet agent GB per idle tree 10-20", state: "ended", activityAt: now - 4 * 60 * 60_000 },
  { key: "thread:cpu", name: "d7 clean minutes cpu share 10-20", state: "working", activityAt: now - 18 * 60_000, wake: "a board.wake at 02:21Z" },
  { key: "thread:stretch", name: "d7 quiet agent GB pool-wait stretch 10-20", state: "working", activityAt: now },
];
const ended = (fact: JobFact): JobFact => { const { wake: _wake, ...rest } = fact; return { ...rest, state: "ended" }; };
const boardOf = (plan: PlanItem[]) => ({ v: 2, rev: 1, updatedAt: "2026-10-20T02:00:00Z", plan, todos: [] }) as unknown as ChatBoard;
const pushOf = (plan: PlanItem[], metrics: ReadonlyMap<string, MetricFact> = new Map(), jobs = facts) => {
  const board = boardOf(plan);
  const views = classifyBoard(board, jobs, () => now - 60 * 60_000, new Set(["AI harness"]), [], now, new Set());
  const memos = { p717: { readings: [{ value: 0.48, at: now - 3 * 60 * 60_000, basis: "agent sessions GB on us-metal02 after 15 quiet minutes|GB|<=" }], still: 0 } };
  return goalPushes(board, views, memos, every, now, metrics).pushes.find(push => push.goal.id === "p717")!;
};

test("a goal reads its own reading over a step's target that is off", () => {
  const goal = idle(gb(0.6, "2026-10-20T02:36:00Z"), [cpu, stretch]);
  assert.equal(goalNumber(goal, every, new Map())?.value, 0.6);
  const d7 = new Map<string, MetricFact>([["d7/quiet_agent_gb", { met: true, at: Date.parse("2026-10-20T02:38:00Z"), value: 0.59, target: 5, op: "<=" }]]);
  assert.equal(goalNumber(goal, every, d7)?.value, 0.59, "its own duty metric, read after its target, is the newer measure");
  const push = pushOf([goal], d7);
  assert.equal(push.number?.value, 0.59);
  assert.equal(push.act, "on_pace");
});

test("a goal below with an off target keeps its number to itself", () => {
  const { duty: _duty, ...rest } = stretch;
  const below: PlanItem = { ...rest, children: [item("p790", { job: "d7 quiet agent GB pool-wait stretch 10-20" })] };
  const goal = idle(gb(0.6, "2026-10-20T02:36:00Z"), [cpu, below]);
  assert.equal(goalNumber(goal, every, new Map())?.value, 0.6);
  assert.equal(goalNumber(below, every, new Map())?.value, 5.61);
});

test("a live job on a step under the goal owns it, the one on the goal's own metric first", () => {
  const push = pushOf([idle(gb(5.61, "2026-10-20T02:05:54Z"), [cpu, stretch])]);
  assert.equal(push.owner?.name, "d7 quiet agent GB pool-wait stretch 10-20");
  assert.equal(push.act, "steer");
  assert.equal(goalGap(push), false);
  assert.match(goalLine(push), /pool-wait stretch .*owns it and it is off pace/);
  assert.doesNotMatch(goalLine(push), /no live job owns it/);
});

test("a live job under a goal below counts as the goal's owner", () => {
  const below = item("p800", { target: gb(0.6, "2026-10-20T02:36:00Z", "quiet trees per host"), children: [stretch] });
  const push = pushOf([idle(gb(5.61, "2026-10-20T02:05:54Z"), [cpu, below])], new Map(), facts.map(fact => fact.key === "thread:cpu" ? ended(fact) : fact));
  assert.equal(push.owner?.name, "d7 quiet agent GB pool-wait stretch 10-20");
  assert.equal(goalGap(push), false);
});

test("a goal with no live job on any open step under it is a gap", () => {
  const push = pushOf([idle(gb(5.61, "2026-10-20T02:05:54Z"), [cpu, stretch])], new Map(), facts.map(ended));
  assert.equal(push.owner, undefined);
  assert.equal(push.act, "start");
  assert.equal(goalGap(push), true);
});
