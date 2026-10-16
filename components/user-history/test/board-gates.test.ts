import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkInPrecheck, checkInPrecheckText, checkInRecord, convergenceMisses, NO_MISSES } from "../src/chat-checkin.ts";
import { gateFindings, STALL_MS } from "../src/checkin-findings.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { dutyJobBrief } from "../src/chat-duty-job.ts";
import { CHAT_BRIEF } from "../src/chat-brief.ts";
import { AGENT_REPLY_ERROR, applyBoardOp, approves, BoardError, emptyBoard, nextIds, parseBoardOps, stepGo, renderOpenPlan, requirementGaps } from "../src/shared/chat-board.ts";
import { CHECK_IN_DUTY } from "../src/shared/chat-duties.ts";
import type { BoardActor, BoardOp, ChatBoard, PlanItem, Requirement } from "../src/shared/types.ts";
import { releaseGo } from "../src/shared/release-go.ts";

// These tests hold the owner's go on production and merge steps as it runs with the c74 standing go off; release-go-c74.test.ts covers it on.
releaseGo.preapproval = null;

const T0 = "2026-10-09T00:00:00.000Z";
const T1 = "2026-10-09T00:01:00.000Z";
const HOUR = 60 * 60_000;
function run(board: ChatBoard, ops: unknown[], actor: BoardActor = "agent"): ChatBoard {
  for (const op of parseBoardOps(ops)) board = applyBoardOp(board, op as BoardOp, actor, T1, nextIds(board)).board;
  return board;
}
function refused(board: ChatBoard, ops: unknown[], pattern: RegExp, actor: BoardActor = "agent"): void {
  assert.throws(() => run(board, ops, actor), error => error instanceof BoardError && error.kind === "forbidden" && pattern.test(error.message));
}
const MET: Requirement[] = [{ text: '"separate designs in separate implementations"', status: "met", evidence: "apps/demo/variants/<name>/ per variant" }];
const p2Of = (board: ChatBoard): PlanItem => board.plan[0]!.children[0]!;
/** A goal with a Port step that needs the owner's go, a Build step, and an agent todo t1 that asks for the go on p2. */
function gated(): ChatBoard {
  return run(emptyBoard(T0), [
    { op: "plan_add", text: "Ship the demo design" },
    { op: "plan_add", parent: "p1", text: "Port the picked design to the search app", go: "needed" },
    { op: "plan_add", parent: "p1", text: "Build the variant system" },
    { op: "todo_add", text: "Port the 5180 design to 5174 now?", choices: ["Go: port it", "Not yet"], step: "p2" },
  ]);
}

test("owner go: approving answers are a go; holds and refusals are not", () => {
  for (const reply of ["Go: port it", "go ahead", "Ship it", "Approve", "approved", "Yes", "ok", "LGTM", "좋아", "ㄱㄱ", "좋아 진행해"]) assert.equal(approves(reply), true, reply);
  for (const reply of ["Not yet", "wait", "no", "Wait for QA", "don't ship", "Go, but not to production", "hold on", "later", "아직", "아니", "잠깐만", "좋아 근데 아직", "Use Resend"]) {
    assert.equal(approves(reply), false, reply);
  }
  // A tapped choice is judged by its lead: "no fallback" is part of the approved option (10-09, t29 on p234 in the developer environment VP chat).
  const choices = ["Go, 5.5 high with no fallback", "Not yet", "Hold - wait for limits"];
  assert.equal(approves("Go, 5.5 high with no fallback", choices), true);
  assert.equal(approves("Not yet", choices), false);
  assert.equal(approves("Hold - wait for limits", choices), false);
  assert.equal(approves("Go, 5.5 high with no fallback"), false, "typed by hand, the whole reply is read and 'no' holds it");
  const board = run(gated(), [{ op: "todo_add", text: "Put every chat on 5.5 high?", choices, step: "p2" }]);
  const answered = run(board, [{ op: "todo_update", id: "t2", reply: "Go, 5.5 high with no fallback", done: true }], "owner");
  assert.equal(stepGo(answered, p2Of(answered))?.id, "t2", "the tapped first choice is the owner's go");
});

test("owner go: a go-needed step reads the owner's last go-or-hold answer on its todo as its go", () => {
  const board = gated();
  assert.equal(board.plan[0]!.children[0]!.go, "needed");
  assert.equal(board.todos[0]!.step, "p2");
  assert.equal(run(board, [{ op: "plan_add", parent: "p2", text: "Draft the port plan" }]).plan[0]!.children[0]!.children[0]!.status, "todo", "a todo step under it is fine");

  const held = run(board, [{ op: "todo_update", id: "t1", reply: "Not yet", done: true }], "owner");
  assert.equal(held.todos[0]!.answeredBy, "owner");

  const go = run(board, [{ op: "todo_update", id: "t1", reply: "Go: port it", done: true }], "owner");
  assert.equal(stepGo(go, p2Of(go))?.id, "t1");
  const started = run(go, [{ op: "plan_update", id: "p2", status: "doing" }, { op: "plan_add", parent: "p2", text: "Copy the CSS", status: "doing" }]);
  assert.equal(started.plan[0]!.children[0]!.status, "doing");
  assert.match(renderOpenPlan(started), /\[~\] p2 Port the picked design to the search app \(owner's go on t1\)/);

  const takenBack = run(go, [{ op: "todo_add", text: "p2: still port today?", choices: ["Go", "Not yet"] }]);
  const later = run(takenBack, [{ op: "todo_update", id: "t2", reply: "Not yet" }], "owner");
  assert.equal(stepGo(later, p2Of(later)), null, "the last owner answer linked by the step id in the text decides");
  const side = run(go, [{ op: "todo_add", text: "Keep the old p2 history?", choices: ["Leave it in the old history", "Erase it from the history"], step: "p2" }]);
  const sideAnswered = run(side, [{ op: "todo_update", id: "t2", reply: "Leave it in the old history", done: true }], "owner");
  assert.equal(stepGo(sideAnswered, p2Of(sideAnswered))?.id, "t1", "an answer to a side question on the step keeps the go");
});

test("owner go: only the owner answers; the agent cannot write, clear or re-word the owner's go", () => {
  const board = gated();
  refused(board, [{ op: "todo_update", id: "t1", reply: "Go: port it" }], new RegExp(AGENT_REPLY_ERROR.slice(0, 40)));
  refused(board, [{ op: "todo_update", id: "t1", reply: null }], /Only the owner answers a todo/);
  const go = run(board, [{ op: "todo_update", id: "t1", reply: "Go: port it" }], "owner");
  refused(go, [{ op: "todo_update", id: "t1", text: "Port everything to production now?" }], /its question stays as asked/);
  assert.equal(run(go, [{ op: "todo_update", id: "t1", done: true }]).todos[0]!.done, true, "the agent may still check it off");
  assert.equal(run(go, [{ op: "todo_remove", id: "t1" }], "owner").todos.length, 0, "the owner's own actions are never refused");
  const old: ChatBoard = { ...board, todos: [{ ...board.todos[0]!, reply: "Go: port it" }] };
  assert.equal(stepGo(old, p2Of(old)), null, "an answer with no answeredBy predates the field and is no go");
  assert.throws(() => parseBoardOps([{ op: "plan_update", id: "p2", go: null }]), BoardError, "the go mark never clears");
  const kept = run(board, [{ op: "plan_set", items: [{ id: "p1", text: "Ship the demo design", children: [{ id: "p2", text: "Port it" }] }] }]);
  assert.equal(kept.plan[0]!.children[0]!.go, "needed", "plan_set keeps the go of an item that keeps its id");
  const doing = run(emptyBoard(T0), [{ op: "plan_add", text: "Port", status: "doing" }, { op: "plan_update", id: "p1", go: "needed" }]);
  assert.equal(doing.plan[0]!.go, "needed", "marking a step already at work is no move; the check-in flags it");
  assert.throws(() => run(board, [{ op: "todo_add", text: "Go?", choices: ["Go", "No"], step: "p9" }]), error => error instanceof BoardError && error.kind === "unknown");
});

test("requirements check: the board takes a Build step's move whatever its goal's list says, and requirementGaps names what fails for the check-in", () => {
  const board = gated();
  assert.equal(run(board, [{ op: "plan_update", id: "p3", status: "doing" }]).plan[0]!.children[1]!.status, "doing", "no list, no refusal (c81: the c28 rule is text)");
  assert.equal(requirementGaps(board.plan[0]!), "has no requirements list");
  const unmet = run(board, [{ op: "plan_update", id: "p1", requirements: [...MET, { text: '"the picker only shows what applies to the current tab"', status: "unmet" }] }]);
  assert.equal(requirementGaps(unmet.plan[0]!), 'fails its requirements check: line 2 ""the picker only shows what applies to the current tab"" is unmet with no note');
  assert.equal(run(unmet, [{ op: "plan_update", id: "p3", status: "doing" }]).plan[0]!.children[1]!.status, "doing");
  assert.match(requirementGaps({ requirements: [{ text: '"100s of variants"', status: "met" }] })!, /is met with no evidence/);
  const good = run(board, [{ op: "plan_update", id: "p1", requirements: [...MET, { text: '"intelligent picker"', status: "open", note: "the owner put it off to v2" }] }]);
  assert.equal(requirementGaps(good.plan[0]!), null);
  assert.match(renderOpenPlan(good), /Not shown: .*, 1 step notes and requirements\./, "requirements stay in the board file, read with board.get");
  assert.equal(requirementGaps({ requirements: MET }), null);
  assert.throws(() => parseBoardOps([{ op: "plan_update", id: "p1", requirements: [{ text: "x", status: "done" }] }]), BoardError);
  assert.throws(() => parseBoardOps([{ op: "plan_update", id: "p1", requirements: [] }]), BoardError);
});

test("hard gates: the board skill the brief points to and the duty job brief carry both gates", async () => {
  assert.ok(CHAT_BRIEF.some(line => line.includes("SKILL.md before a board write")));
  const skill = await readFile(new URL("../../../skills/board/SKILL.md", import.meta.url), "utf8");
  assert.ok(skill.includes("moves work from a demo or preview to a real app or production") && skill.includes("A go said in chat does not count"));
  assert.ok(skill.includes("quotes each line of the owner's request word for word"));
  const duty = dutyJobBrief({ duty: { ...CHECK_IN_DUTY }, chat: { id: "c1", name: "frontend bro", board: "/b/c1.json" }, job: "check-in frontend bro 14:00", at: 0, measure: "m", findings: "f" });
  assert.match(duty, /a plan or design job's report quotes the original owner request and checks each line of it against the design before build/);
  assert.match(duty, /stop a job that started without it/);
});

const NOW = Date.parse("2026-10-09T12:00:00Z");
const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status, children: [], ...extra });
const boardOf = (plan: PlanItem[], todos: ChatBoard["todos"] = [], updatedAt = new Date(NOW - 3 * HOUR).toISOString()): ChatBoard => ({ v: 2, rev: 1, updatedAt, todos, plan });

test("check-in precheck: go-needed steps waiting for a go are facts; one at work without a go and a Build step with no requirements are flagged", () => {
  const working: JobFact = { key: "k1", name: "porter", state: "working" };
  const plan = boardOf([step("p1", "Ship the demo", "doing", { children: [
    step("p2", "Port to apps/search", "todo", { go: "needed" }),
    step("p3", "Deploy to production", "todo", { go: "needed" }),
    step("p4", "Merge to main", "todo", { go: "needed", job: "porter" }),
    step("p5", "Build the variants", "doing", { job: "porter" })] })],
    [{ id: "t1", text: "Deploy now?", done: false, from: "agent", at: "", choices: ["Go", "Not yet"], step: "p3" }]);
  const precheck = checkInPrecheck(undefined, [working], plan, NOW);
  assert.deepEqual(precheck.facts.filter(line => line.includes("go")), [
    'p2 "Port to apps/search" needs the owner\'s go and For you has no question for it: add one todo with step "p2" and choices, the go first',
    'p3 "Deploy to production" needs the owner\'s go and waits for the answer on t1']);
  assert.deepEqual(gateFindings(plan, [working]).map(gate => `${gate.kind} ${gate.item.id}`), ["go_waiting p2", "go_waiting p3", "go_missing p4", "requirements_missing p1"]);
  const output = convergenceMisses("c1", precheck.steps, precheck, {}, 15 * 60_000, NOW);
  assert.equal(output.metrics.go_missing, 1);
  assert.equal(output.metrics.requirements_missing, 1);
  const text = checkInPrecheckText(precheck, [working], output.flagged, NOW);
  assert.match(text, /### Hard gates broken \(the owner's go, the requirements check\): fix each now\n- p4 "Merge to main" is at work without the owner's go: stop its job/);
  assert.match(text, /- p1 "Ship the demo" has Build step p5 doing and has no requirements list/);
  assert.equal(NO_MISSES.go_missing, 0, "the check-in measure counts go_missing");
  assert.equal(NO_MISSES.requirements_missing, 0, "the check-in measure counts requirements_missing");
  const approved: ChatBoard = { ...plan, todos: [{ id: "t2", text: "Merge p4?", done: true, from: "agent", at: "", reply: "Go", answeredBy: "owner" }],
    plan: [{ ...plan.plan[0]!, requirements: [{ text: '"variants"', status: "met", evidence: "design doc" }] }] };
  assert.deepEqual(gateFindings(approved, [working]).map(gate => `${gate.kind} ${gate.item.id}`), ["go_waiting p2", "go_waiting p3"]);
});

test("check-in precheck: a step on the same wait past 2 h is stalled, one set 30 min ago is not, and a waitUntil pushed later twice is", async () => {
  const until = (hours: number) => new Date(NOW + hours * HOUR).toISOString();
  const waiting = boardOf([step("p1", "Goal", "doing", { children: [
    step("p2", "Renew the cert", "blocked", { waitUntil: until(5) }),
    step("p3", "Merge after CI", "blocked", { waitFor: "the CI slot", waitUntil: until(8) })] })]);
  const first = checkInPrecheck(undefined, [], waiting, NOW);
  assert.deepEqual(first.steps.map(view => view.cls), ["waiting", "waiting"]);
  assert.deepEqual(first.stalled.map(stall => stall.view.item.id), ["p3"], "p3 waits for the CI slot for 3 h; p2 waits only for a fixed date still ahead, never moved (10-10, p168)");
  const output = convergenceMisses("c1", first.steps, first, {}, 15 * 60_000, NOW);
  assert.equal(output.metrics.stalled_steps, 1);
  const passed = checkInPrecheck(undefined, [], boardOf([step("p1", "Goal", "doing", { children: [step("p2", "Renew the cert", "blocked", { waitUntil: until(-1) })] })],
    [], new Date(NOW - 3 * HOUR).toISOString()), NOW);
  assert.equal(passed.stalled.length + passed.steps.filter(view => view.cls === "due").length >= 1, true, "a passed date is not exempt");
  const text = checkInPrecheckText(first, [], output.flagged, NOW);
  assert.match(text, /### Stalled waits \(take one action on each in this run: check whether what it waits for already happened, do the next action yourself, start or steer a job, or add a For you todo; "still waiting" and a later waitUntil are not answers\)/);
  assert.match(text, /- p3 "Merge after CI" waits for "the CI slot" and it has waited on the same thing for 3 h: act on it in this run/);
  assert.equal(NO_MISSES.stalled_steps, 0, "the check-in measure counts stalled_steps");

  const fresh = checkInPrecheck(undefined, [], boardOf(waiting.plan, [], new Date(NOW - 30 * 60_000).toISOString()), NOW);
  assert.deepEqual(fresh.stalled, [], "a wait set 30 min ago is not stalled");
  const reset = checkInPrecheck(first.memory, [], boardOf([step("p1", "Goal", "doing", { children: [step("p3", "Merge after CI", "blocked", { waitFor: "the nightly run" })] })]), NOW + 60_000);
  assert.deepEqual(reset.stalled.map(stall => stall.view.item.id), ["p3"], "c63: a rewritten waitFor keeps the wait's clock");

  const record = checkInRecord(join(await mkdtemp(join(tmpdir(), "stall-")), "check-ins.json"));
  const pushed = (hours: number) => boardOf([step("p1", "Goal", "doing", { children: [step("p2", "Renew the cert", "blocked", { waitUntil: until(hours) })] })], [], new Date(NOW).toISOString());
  let at = NOW;
  for (const hours of [1, 2, 3]) {
    const precheck = checkInPrecheck(await record.get("c1"), [], pushed(hours), at);
    await record.set("c1", precheck.memory);
    at += 10 * 60_000;
  }
  assert.deepEqual((await record.get("c1"))!.steps.p2!.untils, [until(1), until(2), until(3)], "the record keeps the waitUntil values");
  const twice = checkInPrecheck(await record.get("c1"), [], pushed(3), at);
  assert.deepEqual(twice.stalled.map(stall => stall.why), ["its waitUntil was pushed later 2 times"]);
  const once = checkInPrecheck(undefined, [], pushed(1), NOW);
  assert.ok(once.stalled.length === 0 && STALL_MS === 2 * HOUR);
});
