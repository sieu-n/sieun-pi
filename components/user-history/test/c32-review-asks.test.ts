import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, checkInPrecheckText } from "../src/chat-checkin.ts";
import { readyReviews } from "../src/checkin-steps.ts";
import { applyBoardOp, BoardError, emptyBoard, nextIds, parseBoardOps, renderOpenPlan } from "../src/shared/chat-board.ts";
import type { BoardActor, BoardOp, ChatBoard, PlanItem } from "../src/shared/types.ts";

// c32, repeated by the owner 10-14 01:42Z: "is any other tabs ready for review? keep listing them in FOR YOU with the links i need to check."
// frontend bro's Connections walk passed (p114) and its look step p115 sat in the plan with no For you todo, while t11 to t14 had said only
// "Links and screenshots are in the chat". The steps and todos below are the ones on that board.
const T0 = "2026-10-14T01:00:00.000Z";
const NOW = Date.parse("2026-10-14T01:50:00.000Z");
function run(board: ChatBoard, ops: unknown[], actor: BoardActor = "agent"): ChatBoard {
  for (const op of parseBoardOps(ops)) board = applyBoardOp(board, op as BoardOp, actor, T0, nextIds(board)).board;
  return board;
}
const refused = (board: ChatBoard, ops: unknown[], pattern: RegExp): void =>
  assert.throws(() => run(board, ops), error => error instanceof BoardError && error.kind === "invalid" && pattern.test(error.message), JSON.stringify(ops));
const STAGING = "http://localhost:5180/app/connections?line=staging";

test("c32: a todo that asks the owner to review, look at or pick something needs a link", () => {
  const board = emptyBoard(T0);
  for (const text of [
    "Look at the new Connections on Staging and say if it's good or what to change.",
    "Connections has 4 new versions on 5180, each checked in a browser. Pick one with Put in line, or tell me what to change. Links and screenshots are in the chat.",
    "Review Email on Staging and say good or what to change.",
    "Take a look at the list app and say what to change.",
    "Choose the inbox you like best.",
  ]) refused(board, [{ op: "todo_add", text, choices: ["Good", "Needs changes"] }], /review, look at or pick.*links \[\{label, target\}\].*\(c32\)/s);

  const linked = run(board, [{ op: "todo_add", text: "Look at the new Connections on Staging and say if it's good or what to change.",
    links: [{ label: "Connections on Staging", target: STAGING }], choices: ["Good", "Needs changes"] }]);
  assert.deepEqual(linked.todos[0]!.links, [{ label: "Connections on Staging", target: STAGING }]);
  assert.match(renderOpenPlan(linked), new RegExp(`links: ${STAGING.replace(/[?.]/g, "\\$&")}`), "the agent's checklist shows the link");
  const inText = run(board, [{ op: "todo_add", text: `Review the Staging Inbox, now Desk with its contact panel: http://localhost:5180/app/inbox?line=staging.` }]);
  assert.equal(inText.todos.length, 1, "a URL in the text is a link too (t21)");
  const wiki = run(board, [{ op: "todo_add", text: "Review the joint inbox design page and say what to change.", links: [{ label: "design", target: "wiki:sessions/2026/10/14/0756-joint-inbox/design.html" }] }]);
  assert.equal(wiki.todos[0]!.links![0]!.target, "wiki:sessions/2026/10/14/0756-joint-inbox/design.html");

  for (const text of ["Minimal Home stays live. Ship the 5 held fixes for it?", "PostHog is signed out in Aside. Can you log in once with Google?"]) {
    assert.equal(run(board, [{ op: "todo_add", text, choices: ["Yes", "Not yet"] }]).todos.length, 1, `${text} asks for no review`);
  }
  assert.equal(run(board, [{ op: "todo_add", text: "Pick one of the Home versions." }], "owner").todos.length, 1, "the owner's own todo is his");
});

test("c32: a todo_update keeps the link rule, and links can be set or cleared on a todo", () => {
  const board = run(emptyBoard(T0), [{ op: "todo_add", text: "Are the Staging pages ready for you this week?", choices: ["Yes", "Not yet"] }]);
  refused(board, [{ op: "todo_update", id: "t1", text: "Look at the Staging Connections page and say good or what to change." }], /\(c32\)/);
  const set = run(board, [{ op: "todo_update", id: "t1", text: "Look at the Staging Connections page and say good or what to change.", links: [{ label: "Connections", target: STAGING }] }]);
  assert.equal(set.todos[0]!.links!.length, 1);
  refused(set, [{ op: "todo_update", id: "t1", links: [] }], /review, look at or pick/);
  const dismissed = run(run(emptyBoard(T0), [{ op: "todo_add", text: "Pick one.", links: [{ label: "x", target: STAGING }] }]), [{ op: "todo_update", id: "t1", done: true }]);
  assert.equal(dismissed.todos[0]!.done, true, "dismissing an ask is never refused");
});

test("c32: For you text in plain words; our internal names are refused with the fix", () => {
  const board = emptyBoard(T0);
  refused(board, [{ op: "todo_add", text: "Your temporary metal CI slots need the key lock first: buy GitHub Pro, then say go.", choices: ["Go", "Not yet"] }],
    /uses "key lock".*plain words \(c32\)/s);
  refused(board, [{ op: "todo_add", text: "The fix waits for the probe slots and the land flow. Is that ok with you?", choices: ["Yes", "No"] }], /"probe slots", "land flow"/);
  refused(board, [{ op: "todo_add", text: "Should the check-in job fan out the duty fixes?", choices: ["Yes", "No"] }], /"check-in job".*"fan out"|"fan out".*"check-in job"/);
  for (const text of [
    "Look at the new Connections on Staging and say if it's good or what to change.",
    "Save a card on the Virev Internal org at api.virev.ai/settings/billing so the daily check can run.",
    "Our Google search check now shows on /specs, and both runs passed. Keep it daily?",
  ]) assert.equal(run(board, [{ op: "todo_add", text, links: [{ label: "page", target: STAGING }], choices: ["Yes", "No"] }]).todos.length, 1, text);
  const owner = run(board, [{ op: "todo_add", text: "ask the duty about key lock" }], "owner");
  assert.equal(owner.todos.length, 1, "the owner writes what he likes");
});

const step = (id: string, text: string, status: PlanItem["status"], note?: string, children: PlanItem[] = []): PlanItem =>
  ({ id, text, status, children, ...(note ? { note } : {}) });
const connections = (look = step("p115", "You look at the new Connections on Staging and say good or what to change", "blocked")): PlanItem =>
  step("p106", "Connections: multiple accounts per channel, clearer sections, API keys made in place", "doing", "Owner round 3 (10-14).", [
    step("p113", "The six Connections parts in the Staging version on 5180", "done"),
    step("p114", "Walk the Staging Connections page in Aside at 1440x900 with 0 outside requests", "done",
      "The walk passed with 0 outside requests and 0 console errors, and Staging was re-set."),
    look,
  ]);
const listApp = (): PlanItem => step("p120", "Creators: each list as a full app with CRM, Deck, Configure and Dashboard views", "doing", undefined, [
  step("p121", "Build the list app on 5180", "doing"),
  step("p122", "Check the list app in Aside at 1440x900 with a screenshot per view", "todo"),
  step("p123", "You look at the list app on 5180 and say good or what to change", "blocked"),
]);
const boardOf = (plan: PlanItem[], todos: ChatBoard["todos"] = []): ChatBoard => ({ ...emptyBoard(T0), plan, todos });
const T21 = { id: "t21", text: "Review the Staging Inbox, now Desk with its contact panel: http://localhost:5180/app/inbox?line=staging.", done: false, step: "p112",
  from: "agent" as const, at: T0 };

test("c32: the check-in flags a look step whose browser check passed and that has no todo in For you", () => {
  const board = boardOf([connections(), listApp()], [T21]);
  assert.deepEqual(readyReviews(board).map(review => [review.look.id, review.passed.id]), [["p115", "p114"]],
    "t21 names Staging too, but it is about the Inbox; the list app is not checked yet");
  const precheck = checkInPrecheck(undefined, [], board, NOW);
  const fact = precheck.facts.find(line => line.startsWith("p115 "));
  assert.ok(fact, precheck.facts.join("\n"));
  assert.match(fact!, /ready for the owner: p114 passed its browser check.*step "p115" and links to each page he checks/);
  assert.match(checkInPrecheckText(precheck, [], [], NOW), /p115 "You look at the new Connections/);

  const asked = boardOf([connections(), listApp()], [T21, { id: "t22", text: "Look at the new Connections on Staging and say good or what to change.", done: false,
    step: "p115", links: [{ label: "Connections", target: STAGING }], from: "agent", at: T0 }]);
  assert.deepEqual(readyReviews(asked), [], "an open todo on the step covers it");
  const answered = boardOf([connections()], [{ id: "t16", text: "Look at the new Connections on Staging.", done: true, reply: "Good", answeredBy: "owner", step: "p115", from: "agent", at: T0 }]);
  assert.equal(readyReviews(answered).length, 1, "a closed todo from an earlier round does not cover the new one");
});

test("c32: a done Check step under the goal counts as a passed check, and an open one holds the review", () => {
  const checked = boardOf([step("p120", "Creators list app", "doing", undefined, [
    step("p121", "Build the list app on 5180", "done", undefined, [step("p130", "Check the list app in the browser at 1440x900", "done")]),
    step("p123", "You pick one of the list views and say what to change", "todo"),
  ])]);
  assert.deepEqual(readyReviews(checked).map(review => [review.look.id, review.passed.id]), [["p123", "p130"]]);
  const notYet = boardOf([step("p120", "Creators list app", "doing", undefined, [
    step("p121", "Build round 1", "done", "Browser-checked in Aside at 1440x900."),
    step("p122", "Re-walk the list app in Aside after round 2", "doing"),
    step("p123", "You look at the list app on 5180", "blocked"),
  ])]);
  assert.deepEqual(readyReviews(notYet), [], "the next round's check is still open");
  const parked = boardOf([connections(step("p115", "You look at the new Connections on Staging", "blocked", "Parked by your rule until you say 5180 is good enough (c40)."))]);
  assert.deepEqual(readyReviews(parked, new Set(["c40"])), [], "a look step parked by an active rule waits");
  assert.deepEqual(readyReviews(boardOf([connections(step("p115", "You look at the new Connections on Staging", "done"))])), [], "a done look step is no ask");
});
