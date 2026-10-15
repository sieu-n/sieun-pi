import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkInPrecheck, checkInPrecheckText, convergenceMisses } from "../src/chat-checkin.ts";
import { dutyFor, type DutyRef, foldOps, goalsToFold, goalsWithoutDuty, openUnderClosed } from "../src/checkin-findings.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { applyBoardOp, nextIds, openGoals } from "../src/shared/chat-board.ts";
import type { BoardOp, ChatBoard, PlanItem } from "../src/shared/types.ts";

/**
 * c46: a goal whose open steps ride other goals' jobs or a duty folds. The fixture is a synthetic CI thread board with the shape of a check-in
 * that left p15, p72 and p75 open until the thread folded them by hand, with the chat's duties.
 */
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "ci-thread-board.json"), "utf8")) as { board: ChatBoard; duties: DutyRef[] };
const VP = "01a00000-0000-7000-8000-000000000001";
const SELF = new Set([VP, "CI thread"]);
const NOW = Date.parse("2026-10-12T05:19:30Z");
const EVERY = 30 * 60_000;
const board = (): ChatBoard => structuredClone(FIXTURE.board);
const summary = (folds: ReturnType<typeof goalsToFold>) => folds.map(fold => ({ goal: fold.goal.id, duty: fold.duty?.id,
  moves: fold.moves.map(move => `${move.item.id}>${move.home.id}`), left: fold.left.map(item => item.id) }));
const item = (id: string, text: string, extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status: "doing", children: [], ...extra });
const find = (plan: readonly PlanItem[], id: string): PlanItem | undefined => {
  for (const entry of plan) { if (entry.id === id) return entry; const below = find(entry.children, id); if (below) return below; }
  return undefined;
};

test("goals to fold: the CI thread's board folds p15 by its steps' jobs, p72 and p75 by their duties", () => {
  assert.deepEqual(summary(goalsToFold(board(), [], SELF, FIXTURE.duties)), [
    { goal: "p15", duty: undefined, moves: ["p37>p1", "p56>p1"], left: [] },
    { goal: "p72", duty: "d2", moves: ["p73>p1"], left: ["p110"] },
    { goal: "p75", duty: "d3", moves: ["p80>p60", "p84>p1"], left: ["p79", "p81", "p88"] },
  ]);
  assert.deepEqual(summary(goalsToFold(board(), [], SELF, [])).map(fold => fold.goal), ["p15"], "without the duties only p15 folds: p110, p79, p81 and p88 have no home");
});

test("goals to fold: the ops apply on the real board and leave no goal to fold and nothing open under a closed goal", () => {
  const folds = goalsToFold(board(), [], SELF, FIXTURE.duties);
  assert.deepEqual(foldOps(folds[0]!), [
    { op: "plan_update", id: "p37", parent: "p1" },
    { op: "plan_update", id: "p56", parent: "p1" },
    { op: "plan_update", id: "p15", status: "done", note: "Folded (c46): its open steps ride other goals' jobs; p37 moved under p1, p56 moved under p1." },
  ]);
  assert.deepEqual(foldOps(folds[1]!).at(-1), { op: "plan_update", id: "p72", status: "done",
    note: "Folded (c46): the duty d2 \"Git rules\" runs this goal's work; p73 moved under p1." });
  // The check-in places each step with no home itself; these are the thread's own choices from its hand fold.
  const placed: Record<string, BoardOp[]> = { p72: [{ op: "plan_update", id: "p110", parent: "p60" }],
    p75: [{ op: "plan_update", id: "p79", parent: "p62" }, { op: "plan_update", id: "p81", parent: "p19" }] };
  let next = board();
  for (const fold of folds) {
    const ops = foldOps(fold);
    for (const op of [...ops.slice(0, -1), ...placed[fold.goal.id] ?? [], ops.at(-1)!]) next = applyBoardOp(next, op, "agent", "2026-10-12T05:20:00.000Z", nextIds(next)).board;
  }
  next = applyBoardOp(next, { op: "plan_update", id: "p88", parent: null }, "agent", "2026-10-12T05:20:00.000Z", nextIds(next)).board;
  assert.deepEqual(["p15", "p72", "p75"].map(id => find(next.plan, id)?.status), ["done", "done", "done"]);
  assert.deepEqual(["p37", "p56", "p73", "p84"].map(id => find(next.plan, id) === find(find(next.plan, "p1")!.children, id)), [true, true, true, true], "a fold moves steps under a goal, never a step");
  assert.ok(find(find(next.plan, "p19")!.children, "p81"), "the check-in's own placement");
  assert.ok(find(find(next.plan, "p60")!.children, "p80"));
  assert.deepEqual(openUnderClosed(next), []);
  assert.deepEqual(goalsToFold(next, [], SELF, FIXTURE.duties), []);
  assert.deepEqual(openGoals(next.plan).map(goal => goal.id), ["p1", "p10", "p60", "p88"]);
});

test("goals to fold: counted in the check-in duty, listed with the exact ops in the brief, and not again under Look done", () => {
  const precheck = checkInPrecheck(undefined, [], board(), NOW, { self: [...SELF], rows: [], everyMs: EVERY, duties: FIXTURE.duties });
  const output = convergenceMisses(VP, precheck.steps, precheck, {}, EVERY, NOW);
  assert.equal(output.metrics.goals_to_fold, 3);
  assert.deepEqual(output.flagged.filter(slice => slice.kind === "goals_to_fold").map(slice => slice.item), ["p15", "p72", "p75"]);
  assert.ok(!output.flagged.some(slice => slice.kind === "finished_open" && ["p15", "p72", "p75"].includes(slice.item!)), "one source per goal");
  const text = checkInPrecheckText(precheck, [], output.flagged, NOW);
  const section = text.split("\n\n").find(part => part.startsWith("### Goals to fold"))!;
  assert.deepEqual(section.split("\n").slice(1).map(line => line.slice(2, 5)), ["p15", "p72", "p75"]);
  assert.ok(section.includes('p15 "This thread watches how CI is used": every open step under it rides another goal\'s job. Move p37 under p1 (p19 of p1 has its ' +
    'job disk guard rework), p56 under p1 (p19 of p1 has its job disk guard rework): {"op":"plan_update","id":"p37","parent":"p1"}, {"op":"plan_update","id":"p56","parent":"p1"}. ' +
    'Then close the goal: {"op":"plan_update","id":"p15","status":"done","note":"Folded (c46): its open steps ride other goals\' jobs; p37 moved under p1, p56 moved under p1."}'));
  assert.match(section, /p72 .*the duty d2 "Git rules" runs its work\. Move p73 under p1 .*p110 "Fix: the shared folder lags .*" has no home on another goal: move it under the goal/);
  assert.doesNotMatch(text.split("\n\n").find(part => part.startsWith("### Look done")) ?? "", /\bp(15|72|75)\b/);
});

test("goals to fold: a duty matches by its boardGoal or by 3 shared area words that are half the goal's; p10 and p60 share too few", () => {
  const goals = board().plan;
  const unlinked = FIXTURE.duties.map(({ boardGoal: _boardGoal, ...duty }) => duty);
  assert.deepEqual(goals.map(goal => `${goal.id}:${dutyFor(goal, unlinked)?.id ?? "-"}`), ["p1:-", "p10:-", "p15:-", "p60:-", "p72:d2", "p75:d3"]);
  assert.equal(dutyFor(find(goals, "p72")!, FIXTURE.duties)?.id, "d2");
  assert.equal(dutyFor(find(goals, "p72")!, FIXTURE.duties.map(duty => ({ ...duty, status: "paused" as const }))), undefined, "a paused duty runs nothing");
});

test("goals to fold: a goal with its own live job, or with an open step and no job (idle_goals), is not folded", () => {
  const plan = board().plan.filter(goal => goal.id === "p1");
  const own = item("p200", "Find secrets committed anywhere in the repo history", { children: [item("p201", "Wipe the old keys", { job: "secrets in git history" })] });
  const idle = item("p210", "Old chats show in the sidebar again", { children: [item("p211", "Build: the sidebar fix", { status: "todo" })] });
  const live: JobFact[] = [{ key: "k1", name: "secrets in git history", state: "working", activityAt: NOW }];
  const next: ChatBoard = { ...board(), plan: [...plan, own, idle] };
  assert.deepEqual(goalsToFold(next, live, SELF, []), []);
  const precheck = checkInPrecheck(undefined, live, next, NOW, { self: [...SELF], rows: [], everyMs: EVERY });
  const metrics = convergenceMisses(VP, precheck.steps, precheck, {}, EVERY, NOW).metrics;
  assert.deepEqual([metrics.goals_to_fold, metrics.idle_goals], [0, 1]);
});

test("goals to fold: a step with no job of its own rides another goal by a waitFor naming its item or its job; a goal another fold moves into does not fold; a thread is no home", () => {
  const plan = board().plan.filter(goal => goal.id === "p1");
  const byId = item("p300", "Watch CI use", { children: [item("p301", "Dashboard", { job: VP, waitFor: "p21 lands" })] });
  const byJob = item("p310", "Repo rules report", { children: [item("p311", "Rules report", { waitFor: "promote gates rework push, about 09:25Z" })] });
  assert.deepEqual(summary(goalsToFold({ ...board(), plan: [...plan, byId, byJob] }, [], SELF, [])), [
    { goal: "p300", duty: undefined, moves: ["p301>p1"], left: [] }, { goal: "p310", duty: undefined, moves: ["p311>p1"], left: [] }]);
  const own = item("p370", "Wipe the keys", { children: [item("p371", "Wipe", { job: "secrets in git history", waitFor: "p21 lands" })] });
  assert.deepEqual(goalsToFold({ ...board(), plan: [...plan, own] }, [], SELF, []), [], "a step with its own job stays, whatever it waits for");
  const a = item("p320", "Area A", { children: [item("p321", "A step", { job: "shared job" })] });
  const b = item("p330", "Area B", { children: [item("p331", "B step", { job: "shared job" })] });
  assert.deepEqual(summary(goalsToFold({ ...board(), plan: [a, b] }, [], SELF, [])).map(fold => fold.goal), ["p320"]);
  const thread: JobFact[] = [{ key: "thread:01a0e1da-0000-7000-8000-000000000000", name: "release owner", state: "working" }];
  const held = (job: string) => item("p340", "Held", { children: [item("p341", "Held step", { job })] });
  const other = item("p350", "Other", { children: [item("p351", "Other step", { job: "01a0e1da-0000-7000-8000-000000000000" })] });
  assert.deepEqual(goalsToFold({ ...board(), plan: [held("01a0e1da-0000-7000-8000-000000000000"), other] }, thread, SELF, []), []);
  assert.deepEqual(goalsToFold({ ...board(), plan: [held(VP), item("p360", "Mine", { children: [item("p361", "Mine step", { job: VP })] })] }, [], SELF, []), []);
});

/*
 * ops guy 10-16: the 01:08 KST check-in was told to fold p259 and p260 by moving their steps under p138, a step of p45 "This Mac and the M1 and
 * M2 Airs stay healthy", because p138 has the job ops train. A fold moves steps under an open goal, never a step. p192 is the goal ops train
 * lands everything through, and its steps ride its own job, so it does not fold (the live board read "fold p192 into p138" after 01:08).
 */
test("goals to fold: a home is an open goal, never a step, and a step on its own goal's job is home already (ops guy 10-16, p259 and p138)", () => {
  const mac = () => item("p45", "This Mac and the M1 and M2 Airs stay healthy with alerts", { children: [
    item("p138", "Fix: the M1 Air's Docker memory chart has gaps", { job: "ops train" }), item("p183", "The M1 reboots on its own", { job: "m1 reboots" })] });
  const lands = () => item("p192", "Everything this chat built lands on sieun/dev and reaches staging", { job: "ops train", children: [item("p55", "Land the Grafana stack", { job: "ops train" })] });
  const vent = () => item("p259", "Vent runs on staging and prod", { children: [item("p126", "Vent on staging", { job: "ops train" }), item("p127", "Vent on prod", { job: "ops train" })] });
  const folds = goalsToFold({ ...board(), plan: [mac(), vent(), lands()] }, [], SELF, []);
  assert.deepEqual(summary(folds), [{ goal: "p259", duty: undefined, moves: ["p126>p192", "p127>p192"], left: [] }], "the goal with the job, not p138");
  assert.deepEqual(folds[0]!.moves.map(move => move.why), ["p192 has its job ops train", "p192 has its job ops train"]);
  assert.deepEqual(summary(goalsToFold({ ...board(), plan: [mac(), vent()] }, [], SELF, [])), [{ goal: "p259", duty: undefined, moves: ["p126>p45", "p127>p45"], left: [] }],
    "with only a step on the job, the goal that holds the step");
  assert.deepEqual(goalsToFold({ ...board(), plan: [mac(), lands()] }, [], SELF, []), [], "p192's steps ride its own job");
});

test("goals without duty: a chat's open goals count while it has no active duty, in its own check-in too; the built-in check-in is no duty", () => {
  const open = board().plan.filter(goal => goal.status !== "done" && goal.status !== "dropped").map(goal => goal.id);
  assert.deepEqual(goalsWithoutDuty(board(), FIXTURE.duties), [], "the CI thread's active duties cover it");
  assert.deepEqual(goalsWithoutDuty(board(), []).map(goal => goal.id), open);
  assert.deepEqual(goalsWithoutDuty(board(), FIXTURE.duties.map(duty => ({ ...duty, status: "paused" as const }))).map(goal => goal.id), open, "a paused duty runs nothing");
  assert.deepEqual(goalsWithoutDuty(board(), [{ id: "checkin", name: "Check-in", goal: "", status: "active" }]).map(goal => goal.id), open);
  assert.deepEqual(goalsWithoutDuty(null, []), []);
  const bare = checkInPrecheck(undefined, [], board(), NOW, { self: [...SELF], rows: [], everyMs: EVERY, duties: [] });
  const output = convergenceMisses(VP, bare.steps, bare, {}, EVERY, NOW);
  assert.equal(output.metrics.goals_without_duty, 1, "one per chat, however many goals");
  assert.deepEqual(output.flagged.filter(slice => slice.kind === "goals_without_duty").map(slice => slice.item), [open[0]]);
  assert.match(checkInPrecheckText(bare, [], output.flagged, NOW), /### Open goals and no duty\n- 6 open goals \(p1 /);
  const unknown = checkInPrecheck(undefined, [], board(), NOW, { self: [...SELF], rows: [], everyMs: EVERY });
  assert.equal(convergenceMisses(VP, unknown.steps, unknown, {}, EVERY, NOW).metrics.goals_without_duty, 0, "duties not given (a read error): no count");
});
