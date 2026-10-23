// Guards sep launch!!'s one_session_load finding of 10-23: 8 check-ins in a row flagged goal p2 for its per-area threads on us-metal02, while at
// 17:52Z "5180 into the real app on metal" ran 8 working subagents for its 9 steps, "data model on metal" 3 for 8 and "mail integrations on
// metal" 2 for 4.
import assert from "node:assert/strict";
import { test } from "node:test";
import { oneSessionLoad, sessionLoadLine } from "../src/checkin-load.ts";
import type { StepView } from "../src/checkin-steps.ts";
import type { ChildAgent, ChildStatus } from "../src/shared/types.ts";

const GOAL = { id: "p2", text: "The 5180 app works for real on local and staging" };
const APP = "01a1692b-4f09-70ef-9466-edfeccc45fb6";
const DATA = "01a1692c-9f57-7562-b7e7-f57c0252fcbc";
const MAIL = "01a1692f-10de-7495-9311-a2e6857d0ef8";
const THREADS: [string, string, string[]][] = [
  [APP, "5180 into the real app on metal", ["p35", "p36", "p37", "p38", "p39", "p40", "p41", "p42", "p57"]],
  [DATA, "data model on metal", ["p70", "p71", "p72", "p73", "p74", "p75", "p76", "p77"]],
  [MAIL, "mail integrations on metal", ["p81", "p87", "p88", "p94"]],
];

const view = (id: string, thread?: { id: string; name: string }): StepView => ({
  item: { id, text: id, status: "todo", children: [] }, changedAt: 0, mine: thread === undefined, openTodos: [], cls: "live", goal: GOAL,
  ...thread ? { owner: { key: `thread:${thread.id}`, name: thread.name, state: "working" } } : {},
});
const views: StepView[] = [...THREADS.flatMap(([id, name, steps]) => steps.map(step => view(step, { id, name }))), view("p58"), view("p59")];
const children = (running: number, done: number): ChildAgent[] =>
  [...Array<ChildStatus>(running).fill("running"), ...Array<ChildStatus>(done).fill("done")].map((status, index) => ({ id: `sub-${index}`, label: `job ${index}`, status }));

test("a per-area thread with one working subagent per 3 of its steps is not one session's load", () => {
  const roster = new Map([[APP, children(8, 2)], [DATA, children(3, 3)], [MAIL, children(2, 2)]]);
  assert.deepEqual(oneSessionLoad(views, [], roster), []);
});

test("a thread that works its steps alone, or with too few working subagents, is still flagged with its working count", () => {
  const roster = new Map([[APP, children(0, 10)], [DATA, children(2, 4)], [MAIL, children(2, 0)]]);
  const load = oneSessionLoad(views, [], roster);
  assert.deepEqual(load.map(entry => [entry.thread.id, entry.steps.length, entry.working]), [[APP, 9, 0], [DATA, 8, 2]]);
  assert.match(sessionLoadLine(load[1]!), /has 8 of its 23 open steps on the data model on metal thread \(thread:01a1692c-9f57-7562-b7e7-f57c0252fcbc\), which runs 2 working jobs of its own: p70/);
  assert.deepEqual(oneSessionLoad(views).map(entry => entry.thread.name), THREADS.map(([, name]) => name));
});
