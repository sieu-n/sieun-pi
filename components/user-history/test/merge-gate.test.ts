import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { checkInPrecheck, checkInPrecheckText, convergenceMisses, NO_MISSES } from "../src/chat-checkin.ts";
import { gateFindings } from "../src/checkin-findings.ts";
import { dutyJobBrief } from "../src/chat-duty-job.ts";
import { CHAT_BRIEF, jobReplyGuideline } from "../src/chat-brief.ts";
import { applyBoardOp, BoardError, emptyBoard, MERGE_RULE, MERGE_RULE_SHORT, mergeStep, namesPr, needsGo, nextIds, parseBoardOps, prNumbers, pushBranch, renderOpenPlan, stepGo } from "../src/shared/chat-board.ts";
import { CHECK_IN_DUTY } from "../src/shared/chat-duties.ts";
import type { BoardActor, BoardOp, ChatBoard, PlanItem } from "../src/shared/types.ts";
import { C74, preApprovalText, releaseGo } from "../src/shared/release-go.ts";

// Owner 10-12 (c49): "never auto merge anything without my approval this is one of your duty repo rules are enforced."
// These tests hold the c49 gate as it runs with the c74 standing go off (release-go.ts); release-go-c74.test.ts covers the switch on.
releaseGo.preapproval = null;
const T0 = "2026-10-12T00:00:00.000Z";
const T1 = "2026-10-12T00:01:00.000Z";
function run(board: ChatBoard, ops: unknown[], actor: BoardActor = "agent"): ChatBoard {
  for (const op of parseBoardOps(ops)) board = applyBoardOp(board, op as BoardOp, actor, T1, nextIds(board)).board;
  return board;
}
function refused(board: ChatBoard, ops: unknown[], pattern: RegExp): void {
  assert.throws(() => run(board, ops), error => error instanceof BoardError && error.kind === "forbidden" && pattern.test(error.message));
}
const stepOf = (board: ChatBoard, id: string): PlanItem => {
  let found: PlanItem | undefined;
  const visit = (items: readonly PlanItem[]) => { for (const item of items) { if (item.id === id) found = item; visit(item.children); } };
  visit(board.plan);
  return found!;
};
/** A goal p1 with merge steps p2 (PR #123) and p3 (PR #124), and a step p4 about merge conflicts. */
function merges(): ChatBoard {
  return run(emptyBoard(T0), [
    { op: "plan_add", text: "Ship the pool scheduler" },
    { op: "plan_add", parent: "p1", text: "Merge PR #123 once checks pass" },
    { op: "plan_add", parent: "p1", text: "gh pr merge 124 --squash" },
    { op: "plan_add", parent: "p1", text: "Fix merge conflicts on PR #123" },
  ]);
}

test("merge gate: a step whose text merges a PR or a branch, turns on auto-merge or lands code is a merge step", () => {
  for (const text of ["Merge PR #123", "merge PR 123", "Merge the branch into main", "merge it to staging", "Enable auto-merge on PR 45", "Turn on automerge",
    "gh pr merge 77 --squash", "Land PR #12", "land the fix", "Landing the pool branch", "Merge once checks pass", "Merge after CI", "Ship: merge to main",
    "PR 226 merged", "merged https://github.com/o/r/pull/9 into dev", "Merge #88"]) assert.equal(mergeStep(text), true, text);
  for (const text of ["Fix merge conflicts on PR #12", "Get PR #12 merge-ready", "Plan: merge train proposal for 30 to 50 parallel devs (batched merges)",
    "Build: move the merged Staging versions into the real app", "Redesign the landing page", "Fix the landing page code", "Review PR #12", "Port the picked design to apps/search",
    "Open a PR to staging"]) assert.equal(mergeStep(text), false, text);
  assert.deepEqual(prNumbers("Merge PR #123 and https://github.com/o/r/pull/124, then pull request 7"), ["123", "124", "7"]);
  assert.deepEqual(prNumbers("gh pr merge 124 --squash"), ["124"]);
  assert.equal(needsGo({ text: "Merge PR #1" }), true);
  assert.equal(needsGo({ text: "Review PR #1" }), false);
});

test("merge gate: the agent cannot move a merge step to doing or done without the owner's go on a todo that names its PR", () => {
  const board = merges();
  refused(board, [{ op: "plan_update", id: "p2", status: "doing" }], /p2 "Merge PR #123 once checks pass" cannot move to doing: it needs the owner's go\..*on a todo that names #123; a standing "merge once checks pass" go does not/);
  refused(board, [{ op: "plan_update", id: "p3", status: "done" }], /cannot move to done/);
  refused(board, [{ op: "plan_add", parent: "p1", text: "Merged PR #125", status: "done" }], /needs the owner's go/);
  refused(board, [{ op: "plan_add", parent: "p1", text: "Enable auto-merge on PR #126", status: "doing" }], /needs the owner's go/);
  assert.equal(stepOf(run(board, [{ op: "plan_update", id: "p4", status: "doing" }]), "p4").status, "doing", "a merge-conflict step is no merge step");
  assert.equal(stepOf(board, "p2").go, "needed", "the reducer marks a merge step, so the mark stays");
  assert.match(renderOpenPlan(board), /\[ \] p2 Merge PR #123 once checks pass \(needs owner's go\)/);

  const vague = run(board, [{ op: "todo_add", text: "Merge it once checks pass?", choices: ["Go", "Not yet"], step: "p2" }]);
  const vagueGo = run(vague, [{ op: "todo_update", id: "t1", reply: "Go", done: true }], "owner");
  assert.equal(stepGo(vagueGo, stepOf(vagueGo, "p2")), null, "a go on a todo that does not name the PR is no go for that merge");
  refused(vagueGo, [{ op: "plan_update", id: "p2", status: "doing" }], /needs the owner's go/);

  const asked = run(board, [{ op: "todo_add", text: "Merge PR #123 now?", choices: ["Go: merge #123", "Not yet"], step: "p2" }]);
  const go = run(asked, [{ op: "todo_update", id: "t1", reply: "Go: merge #123", done: true }], "owner");
  assert.equal(stepGo(go, stepOf(go, "p2"))?.id, "t1");
  const merged = run(go, [{ op: "plan_update", id: "p2", status: "done", note: "merged at 4f1c2a" }]);
  assert.equal(stepOf(merged, "p2").status, "done");
  refused(go, [{ op: "plan_update", id: "p3", status: "doing" }], /p3 "gh pr merge 124 --squash" cannot move to doing/);

  const typed = run(board, [{ op: "todo_add", text: "p2: ok to merge?", choices: ["Go", "Not yet"] }]);
  const named = run(typed, [{ op: "todo_update", id: "t1", reply: "yes, merge #123", done: true }], "owner");
  assert.equal(stepGo(named, stepOf(named, "p2")), null, "the PR must be in the todo's text, as the merge guard reads it; naming it in the answer is not enough");
  const unchecked = run(asked, [{ op: "todo_update", id: "t1", reply: "Go: merge #123" }], "owner");
  assert.equal(stepGo(unchecked, stepOf(unchecked, "p2")), null, "a go that is not checked off is no merge go, as in owner-ok.ts");
  const heldBack = run(run(go, [{ op: "todo_add", text: "p2: hold every merge?", choices: ["Hold", "Merge"] }]), [{ op: "todo_update", id: "t2", reply: "Hold", done: true }], "owner");
  assert.equal(stepGo(heldBack, stepOf(heldBack, "p2")), null, "a later hold on the step takes the go back");
});

test("merge gate: a go counts only for its own step; a standing go, a go on the goal or one on another PR does not carry over", () => {
  const board = run(merges(), [{ op: "todo_add", text: "p3: merge PR 124 and future PRs once checks pass?", choices: ["Go", "Not yet"], step: "p3" }]);
  const standing = run(board, [{ op: "todo_update", id: "t1", reply: "Go", done: true }], "owner");
  assert.equal(stepGo(standing, stepOf(standing, "p3"))?.id, "t1");
  refused(standing, [{ op: "plan_update", id: "p2", status: "doing" }], /p2 .* cannot move to doing: it needs the owner's go/);

  const goal = run(emptyBoard(T0), [
    { op: "plan_add", text: "Ship the scheduler", go: "needed" },
    { op: "plan_add", parent: "p1", text: "Merge PR #9" },
    { op: "todo_add", text: "Ship the scheduler? It merges PR #9", choices: ["Go", "Not yet"], step: "p1" },
  ]);
  const goalGo = run(goal, [{ op: "todo_update", id: "t1", reply: "Go" }], "owner");
  assert.equal(stepOf(run(goalGo, [{ op: "plan_update", id: "p1", status: "doing" }]), "p1").status, "doing");
  refused(goalGo, [{ op: "plan_update", id: "p2", status: "doing" }], /p2 "Merge PR #9" cannot move to doing: it needs the owner's go/);

  const renamed = run(merges(), [{ op: "plan_update", id: "p2", text: "Finish PR #123" }]);
  refused(renamed, [{ op: "plan_update", id: "p2", status: "done" }], /needs the owner's go/);
  const swapped = run(run(merges(), [{ op: "todo_add", text: "Merge PR #123?", choices: ["Go", "Not yet"], step: "p2" }]), [{ op: "todo_update", id: "t1", reply: "Go", done: true }], "owner");
  assert.equal(stepGo(swapped, stepOf(swapped, "p2"))?.id, "t1");
  refused(run(swapped, [{ op: "plan_update", id: "p2", text: "Merge PR #130" }]), [{ op: "plan_update", id: "p2", status: "doing" }], /names #130/);
});

test("merge gate: the board and the global-rules merge guard agree on which todo text names a PR", async () => {
  // Loaded by URL so this package's stricter tsconfig does not type-check global-rules, which the root tsconfig owns.
  const guard = pathToFileURL(join(import.meta.dirname, "..", "..", "global-rules", "merge-guard.ts")).href;
  const { prSubject } = await import(guard) as { prSubject: (pr: string) => { pattern: RegExp } };
  const guardNamesPr = (text: string, pr: string): boolean => prSubject(pr).pattern.test(text);
  for (const text of ["Merge PR #123?", "merge pr123", "Merge pull request 123 now?", "https://github.com/o/r/pull/123", "Merge #1234?", "Merge PR 12?", "Merge it?",
    "Merge PRs #123 and #124?", "pull/123", "issue 123"]) {
    for (const pr of ["123", "12"]) assert.equal(namesPr(text, pr), guardNamesPr(text, pr), `${text} / ${pr}`);
  }
});

test("merge gate: a push to main, master or staging is a merge step whose go must say push or name the branch", () => {
  for (const text of ["Push the fix to main", "git push -f origin HEAD:main", "Push sieun-pi to master", "land it on main"]) assert.equal(mergeStep(text), true, text);
  for (const text of ["git push origin staging", "git push origin sieun/dev", "Push to sieun/dev, then promote to staging", "Push the branch", "push notifications to the main app"]) {
    assert.equal(mergeStep(text), false, text);
  }
  // A step that states the rule merges nothing (a CI thread 10-12: a step like this was read as a merge done without a go).
  assert.equal(mergeStep("Nothing merges without your go on that PR: the command guard refuses gh pr merge, auto-merge and API merges unless they name an approved todo for that PR (c49)"), false);
  assert.equal(pushBranch("git push -f origin HEAD:main"), "main");
  assert.equal(pushBranch("Merge PR #3"), null);
  const board = run(emptyBoard(T0), [{ op: "plan_add", text: "Release" }, { op: "plan_add", parent: "p1", text: "Push sieun-pi to main" }]);
  refused(board, [{ op: "plan_update", id: "p2", status: "doing" }], /p2 "Push sieun-pi to main" cannot move to doing: it needs the owner's go/);
  const vague = run(run(board, [{ op: "todo_add", text: "Ship sieun-pi?", choices: ["Go", "Not yet"], step: "p2" }]), [{ op: "todo_update", id: "t1", reply: "Go", done: true }], "owner");
  assert.equal(stepGo(vague, stepOf(vague, "p2")), null, "a go that neither says push nor names main is no go for the push");
  const named = run(run(board, [{ op: "todo_add", text: "Push sieun-pi to main now?", choices: ["Push it", "Not yet"], step: "p2" }]), [{ op: "todo_update", id: "t1", reply: "Push it", done: true }], "owner");
  assert.equal(stepOf(run(named, [{ op: "plan_update", id: "p2", status: "done" }]), "p2").status, "done");
});

test("staging needs no go: a step whose only target is staging moves without the owner, even when marked; a production target still needs his go", () => {
  // A launch chat's p33 (10-12), the step a chat asked the owner to approve before the owner said staging deploys never need his ok.
  const p33 = "Ship: land the deeper-depth and cursor-handoff stack to staging after green CI probe";
  for (const text of [p33, "Land 32b", "Deploy the crawler to staging", "Merge PR #12 into staging", "git push origin staging", "Push the fix to sieun/dev"]) {
    assert.equal(needsGo({ text, go: "needed" }), false, text);
  }
  for (const text of ["Promote 8 to production", "Ship: put the Watchlist fixes on staging, then prod", "land it on main", "Land PR #12", "Merge PR #12", "Push sieun-pi to main",
    "Build: move the merged Staging versions into the real app", "Ship the downloader page fix to the real search app after its CI probe and land slot",
    "Ship: install the pool fixes (ea7da4c), so sessions leaving a full account spread out instead of all landing on one"]) {
    assert.equal(needsGo({ text, go: "needed" }), true, text);
  }
  assert.equal(needsGo({ text: "Land PR #12" }), true, "a PR land with no staging target is a merge into the production branch");
  const board = run(emptyBoard(T0), [{ op: "plan_add", text: "Sync on staging and prod" }, { op: "plan_add", parent: "p1", text: p33, go: "needed" },
    { op: "plan_add", parent: "p1", text: "Promote the stack to prod", go: "needed" }]);
  const staged = run(board, [{ op: "plan_update", id: "p2", status: "doing" }, { op: "plan_update", id: "p2", status: "done" }]);
  assert.equal(stepOf(staged, "p2").status, "done");
  assert.doesNotMatch(renderOpenPlan(run(board, [{ op: "plan_update", id: "p2", status: "doing" }])), /p2 [^\n]*needs owner's go/);
  refused(board, [{ op: "plan_update", id: "p3", status: "doing" }], /p3 "Promote the stack to prod" cannot move to doing: it needs the owner's go/);
  assert.deepEqual(gateFindings(staged, []).map(gate => `${gate.kind} ${gate.item.id}`), ["go_waiting p3"], "a staging land done with no go is no breach");
});

test("merge gate: the owner's own board actions are never refused", () => {
  const board = run(merges(), [{ op: "todo_add", text: "Merge PR #123?", choices: ["Go", "Not yet"], step: "p2" }]);
  const owner = run(board, [{ op: "todo_add", text: "merge #124 too" }, { op: "todo_update", id: "t1", reply: "Not yet", done: true },
    { op: "todo_remove", id: "t2" }], "owner");
  assert.equal(owner.todos.length, 1);
});

test("merge gate: the check-in lists a merge step done without the owner's go as merges_without_go, a repo rule breach", async () => {
  const NOW = Date.parse("2026-10-12T12:00:00Z");
  const step = (id: string, text: string, status: PlanItem["status"]): PlanItem => ({ id, text, status, children: [] });
  const board: ChatBoard = { v: 2, rev: 1, updatedAt: new Date(NOW - 3_600_000).toISOString(), plan: [{ ...step("p1", "Ship the scheduler", "doing"), children: [
    step("p2", "Merge PR #123", "done"), step("p3", "Land PR #124", "done"), step("p4", "Fix merge conflicts on PR #125", "done"), step("p5", "Merge PR #126", "todo")] }],
    todos: [{ id: "t1", text: "Land PR #124?", done: true, from: "agent", at: "", choices: ["Go", "Not yet"], step: "p3", reply: "Go", answeredBy: "owner" },
      { id: "t2", text: "Merge once checks pass?", done: true, from: "agent", at: "", step: "p2", reply: "yes", answeredBy: "owner" }] };
  assert.deepEqual(gateFindings(board, []).map(gate => `${gate.kind} ${gate.item.id}`), ["merges_without_go p2", "go_waiting p5"]);
  const precheck = checkInPrecheck(undefined, [], board, NOW);
  const output = convergenceMisses("c1", precheck.steps, precheck, {}, 15 * 60_000, NOW);
  assert.equal(output.metrics.merges_without_go, 1);
  assert.equal(NO_MISSES.merges_without_go, 0);
  const text = checkInPrecheckText(precheck, [], output.flagged, NOW);
  assert.match(text, /### Merged without the owner's go \(a repo rule breach: report each to the owner in this run; never merge without his go on that PR\)\n- p2 "Merge PR #123" is done, and the board shows no owner go that names PR #123: a repo rule breach\. Tell the owner in this run/);
  const kept: ChatBoard = { ...board, todos: [...board.todos, { id: "t3", text: "PR #123 merged without your go. Keep it?", done: true, from: "agent", at: "", step: "p2",
    choices: ["Yes, keep it", "No, revert it"], reply: "Yes, keep it", answeredBy: "owner" }] };
  assert.deepEqual(gateFindings(kept, []).map(gate => gate.kind), ["go_waiting"], "the owner's answer on that PR clears it");
  assert.equal(NO_MISSES.merges_without_go, 0, "the check-in measure counts merges_without_go");
});

test("merge gate: while the c74 standing go is on, the brief, the job reply guideline and the duty job brief carry it, and git.md holds the rule word for word", async () => {
  assert.equal(releaseGo.preapproval, null, "this file turned the switch off after the briefs were built from it");
  assert.ok(MERGE_RULE.startsWith("Never ask the owner to confirm a staging land, merge or deploy: do it on your own (owner 10-12)."));
  assert.ok(MERGE_RULE.includes(preApprovalText(C74)), "the c74 words and date");
  assert.ok(MERGE_RULE.includes("An outside send (an email, a ticket or support reply, a customer message, a post) still needs the owner's ok on a For you todo first (c37)."));
  assert.ok(!/OWNER_OK=<chat id>|\(c49\)/.test(MERGE_RULE), "no merge go to ask for while c74 is on");
  assert.ok(CHAT_BRIEF.some(line => line === `Staging lands and deploys never need the owner's ok (c50). ${preApprovalText(C74)}`), "chat brief: c50 and c74 in one line");
  const git = await readFile(new URL("../../../skills/board/references/git.md", import.meta.url), "utf8");
  assert.ok(git.includes(MERGE_RULE), "the full rule sits in the git reference the brief points to");
  assert.ok(git.includes("Production needs his explicit approval of that specific PR or push in For you (c49)"), "git.md keeps the c49 rule that returns when the switch is off");
  assert.ok(CHAT_BRIEF.some(line => line.includes("references/git.md before a sieun-pi commit, release, merge or push")));
  assert.ok(jobReplyGuideline({ chat: "slack green guy", root: false }).includes(MERGE_RULE_SHORT), "job reply guideline");
  assert.equal(MERGE_RULE_SHORT, `Never ask the owner to confirm a staging land, a deploy, a merge, a push to main or master or a prod promote. ${preApprovalText(C74)}`);
  const duty = dutyJobBrief({ duty: { ...CHECK_IN_DUTY }, chat: { id: "c1", name: "slack green guy", board: "/b/c1.json" }, job: "check-in slack green guy 14:00", at: 0, measure: "m", findings: "f" });
  assert.ok(duty.includes("(a step whose only target is staging never needs one)"), "duty job brief: staging needs no go");
  assert.ok(duty.includes(MERGE_RULE), "duty job brief");
});
