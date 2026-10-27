// Guards sep launch!!'s one_session_load finding of 10-23: 8 check-ins in a row flagged goal p2 for its per-area threads on us-metal02, while at
// 17:52Z "5180 into the real app on metal" ran 8 working subagents for its 9 steps, "data model on metal" 3 for 8 and "mail integrations on
// metal" 2 for 4.
import assert from "node:assert/strict";
import { test } from "node:test";
import { oneSessionLoad, type SessionLoad, sessionLoadLine, sessionLoadSig } from "../src/checkin-load.ts";
import { sentAfter, unsentFindings } from "../src/checkin-repeats.ts";
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

test("a subagent queued in pi-pool's turn queue or asleep on a wake works, and a step that waits on purpose is no load", () => {
  // 10-23 16:00Z: the six builders of data model on metal all sat in pi-pool's turn queue, so the roster listed none as running.
  const builders = children(0, 6).map((child, index) => ({ ...child, sessionId: `01a16974-000${index}` }));
  const roster = new Map([[APP, children(8, 2)], [DATA, builders], [MAIL, children(2, 2)]]);
  const live = new Set(builders.slice(0, 3).map(child => child.sessionId));
  assert.deepEqual(oneSessionLoad(views, [], roster, live), []);
  assert.deepEqual(oneSessionLoad(views, [], roster, new Set()).map(entry => [entry.thread.id, entry.working]), [[DATA, 0]]);
  // p73, p75 and p76 wait for the land of one branch and p77 for a time, so the thread holds 4 steps, which 2 queued builders cover.
  const waiting = views.map(view => ["p73", "p75", "p76"].includes(view.item.id) ? { ...view, item: { ...view.item, waitFor: "the land of dev/sieun-mac-schema-unify" } }
    : view.item.id === "p77" ? { ...view, item: { ...view.item, waitUntil: "2026-10-24T00:00:00Z" } } : view);
  assert.deepEqual(oneSessionLoad(waiting, [], roster, new Set(builders.slice(0, 2).map(child => child.sessionId))), []);
  assert.equal(oneSessionLoad(views, [], roster, new Set(builders.slice(0, 2).map(child => child.sessionId))).length, 1);
});

test("a thread whose finished subagents carried their parts in the last 6 h is no load while the thread itself works", () => {
  // 10-23 20:21Z: data model on metal merged the branches of its five builders, which last acted from 17:18Z to 18:54Z, while one more worked.
  const now = Date.parse("2026-10-23T20:21:00Z");
  const ended = ["17:18", "17:51", "17:57", "18:46", "18:54"].map((at, index) =>
    ({ id: `builder-${index}`, label: `builder ${index}`, status: "done" as const, lastActivityAt: Date.parse(`2026-10-23T${at}:00Z`) }));
  const roster = new Map([[APP, children(8, 2)], [DATA, [...ended, { id: "merge", label: "merge", status: "running" as const }]], [MAIL, children(2, 2)]]);
  assert.deepEqual(oneSessionLoad(views, [], roster, new Set(), now), []);
  const idle = views.map(view => view.owner?.key === `thread:${DATA}` ? { ...view, owner: { ...view.owner, state: "ended" as const } } : view);
  const load = oneSessionLoad(idle, [], roster, new Set(), now);
  assert.deepEqual(load.map(entry => [entry.thread.id, entry.working, entry.carried]), [[DATA, 1, 0]], "a thread that does not work folds nothing in");
  const later = oneSessionLoad(views, [], roster, new Set(), now + 4.5 * 60 * 60_000);
  assert.deepEqual(later.map(entry => [entry.thread.id, entry.working, entry.carried]), [[DATA, 1, 1]], "builders done over 6 h ago carry nothing");
  assert.match(sessionLoadLine(later[0]!), /which runs 1 working job of its own and 1 that finished in the last 6 h: p70/);
});

test("a load finding goes out once, and again only when its steps or counts change or it comes back", () => {
  const roster = new Map([[APP, children(8, 2)], [DATA, children(1, 0)], [MAIL, children(2, 2)]]);
  const slices = (load: SessionLoad[]) => load.map(entry => ({ kind: "one_session_load", item: entry.goal.id, excerpt: sessionLoadLine(entry), sig: sessionLoadSig(entry) }));
  const run1 = slices(oneSessionLoad(views, [], roster));
  const other = { kind: "stuck_steps", item: "p58", excerpt: "p58 is stuck" };
  assert.equal(unsentFindings(undefined, [...run1, other]).length, 2);
  const sent = sentAfter(undefined, run1, true);
  assert.deepEqual(unsentFindings(sent, [...run1, other]), [other], "the same thread, steps and counts are not sent again; a finding with no sig still is");
  const fewer = slices(oneSessionLoad(views.filter(view => view.item.id !== "p77"), [], roster));
  assert.equal(unsentFindings(sent, fewer).length, 1, "a step that left the thread is a new situation");
  const busier = slices(oneSessionLoad(views, [], new Map([...roster, [DATA, children(2, 0)]])));
  assert.equal(unsentFindings(sent, busier).length, 1, "a new working count is a new situation");
  assert.deepEqual(sentAfter(sent, run1, false), sent, "a run whose job did not start keeps what was sent");
  assert.deepEqual(sentAfter(sent, [other], false), {}, "a finding that cleared is forgotten");
  assert.equal(unsentFindings(sentAfter(sent, [other], false), run1).length, 1, "so it goes out again when it comes back");
});
