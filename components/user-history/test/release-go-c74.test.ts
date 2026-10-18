// Guards owner rule c74 (2026-10-15): on 10-15 the board refused slack green guy's merge step p71 for want of a For you go that c74 had already given.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gateFindings } from "../src/checkin-findings.ts";
import { applyBoardOp, BoardError, emptyBoard, needsGo, nextIds, parseBoardOps, preApproved, renderOpenPlan } from "../src/shared/chat-board.ts";
import { C74, releaseGo } from "../src/shared/release-go.ts";
import type { BoardActor, BoardOp, ChatBoard, PlanItem } from "../src/shared/types.ts";

// Owner rule c74 (2026-10-15): "Until the proper launch, the owner pre-approves every prod promote, merge or push to main. Never put a promote,
// merge or push go on For you and never wait for one." The case is slack green guy's p71 on 10-15: the board refused it to doing with no
// answered For you todo, so todo t21 stayed up as the only path the gate took.
const T0 = "2026-10-15T00:00:00.000Z";
const T1 = "2026-10-15T00:01:00.000Z";
const P71 = "Ship: merge #225, #250, #252, #253, #254 and #255 after the owner's go on t21, then turn the reminder on in production and check one real Add to Chrome return for #250";
const T21 = "Six merges, all passing their checks. #225 turns on the 24 hour reminder email you said yes to. #252 makes main's checks finish in minutes. " +
  "#253 lets backend changes go live by themselves. #254 keeps our tests hidden until you start them. #255 shows our prices right after people connect Slack. " +
  "#250 opens the Chrome store in a small window and says 'Welcome back' when people return. #255 and #250 stay off until you start them. Merge all six?";
const RESEND = "Make a new Resend key, switch the app to it, cancel the old one and email the team the new setup";

function run(board: ChatBoard, ops: unknown[], actor: BoardActor = "agent"): ChatBoard {
  for (const op of parseBoardOps(ops)) board = applyBoardOp(board, op as BoardOp, actor, T1, nextIds(board)).board;
  return board;
}
function refused(board: ChatBoard, ops: unknown[], pattern: RegExp): void {
  assert.throws(() => run(board, ops), error => error instanceof BoardError && error.kind === "forbidden" && pattern.test(error.message));
}
const stepOf = (board: ChatBoard, id: string): PlanItem => board.plan[0]!.children.find(item => item.id === id)!;
/** Slack green guy's launch goal p1 with p2, its p71 merge step marked go needed, and p3, a step that emails people outside. */
function slackGreen(): ChatBoard {
  return run(emptyBoard(T0), [
    { op: "plan_add", text: "Launch slack.green" },
    { op: "plan_add", parent: "p1", text: P71, go: "needed", status: "blocked" },
    { op: "plan_add", parent: "p1", text: RESEND, go: "needed" },
  ]);
}
function withSwitch<T>(preapproval: typeof releaseGo.preapproval, body: () => T): T {
  const saved = releaseGo.preapproval;
  releaseGo.preapproval = preapproval;
  try { return body(); } finally { releaseGo.preapproval = saved; }
}

test("c74: the switch holds the rule's words and date and is on", () => {
  assert.equal(releaseGo.preapproval, C74);
  assert.equal(C74.rule, "c74");
  assert.equal(C74.date, "2026-10-15");
  assert.match(C74.words, /^Until the proper launch, the owner pre-approves every prod promote, merge or push to main\. Never put a promote, merge or push go on For you/);
});

test("c74: slack green guy's merge step naming six PRs moves to doing and done with no For you todo", () => {
  const board = slackGreen();
  assert.equal(needsGo(stepOf(board, "p2")), false);
  const doing = run(board, [{ op: "plan_update", id: "p2", status: "doing" }]);
  assert.equal(stepOf(doing, "p2").status, "doing");
  assert.equal(stepOf(run(doing, [{ op: "plan_update", id: "p2", status: "done" }]), "p2").status, "done");
  for (const text of ["gh pr merge 254 --squash", "Push the fix to main", "Promote staging to prod", "Enable auto-merge on PR #126"]) {
    assert.equal(stepOf(run(board, [{ op: "plan_add", parent: "p1", text, status: "doing" }]), "p4").status, "doing", text);
  }
  assert.doesNotMatch(renderOpenPlan(board), /p2 [^\n]*needs owner's go/);
  assert.deepEqual(gateFindings(run(board, [{ op: "plan_update", id: "p2", status: "done" }]), []).filter(gate => gate.item.id === "p2"), [], "no merges_without_go breach");
});

test("c74: with the switch off the step needs the owner's go on a todo naming each PR", () => {
  withSwitch(null, () => {
    const board = slackGreen();
    assert.equal(needsGo(stepOf(board, "p2")), true);
    const asked = run(board, [{ op: "todo_add", text: T21, choices: ["Go: merge all six", "Not yet"], step: "p2" }]);
    const answered = run(asked, [{ op: "todo_update", id: "t1", reply: "Go: merge all six", done: true }], "owner");
    assert.equal(stepOf(run(answered, [{ op: "plan_update", id: "p2", status: "doing" }]), "p2").status, "doing");
  });
});

test("c74 control: a step that sends an email still needs its todo, and an email ask stays allowed", () => {
  const board = slackGreen();
  assert.equal(preApproved(RESEND), false);
  assert.equal(needsGo(stepOf(board, "p3")), true);
  const asked = run(board, [{ op: "todo_add", text: "Can I make a new Resend key and email the team the new setup?", choices: ["Go: make a new one", "Not yet"], step: "p3" }]);
  const answered = run(asked, [{ op: "todo_update", id: "t1", reply: "Go: make a new one", done: true }], "owner");
  assert.equal(stepOf(run(answered, [{ op: "plan_update", id: "p3", status: "doing" }]), "p3").status, "doing");
  assert.equal(preApproved("Publish the extension to the Chrome web store"), false, "a public release keeps its todo");
});
