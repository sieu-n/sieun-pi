import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck } from "../src/chat-checkin.ts";
import type { ChatBoard, OwnerTodo, PlanItem } from "../src/shared/types.ts";

const step = (id: string, text: string, status: PlanItem["status"], extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status, children: [], ...extra });
const board = (plan: PlanItem[], todos: ChatBoard["todos"] = []): ChatBoard => ({ v: 2, rev: 1, updatedAt: "", todos, plan });

/*
 * slack green guy 10-13: before the 05:13 KST check-in, p57, p85, p82, p83 and p86 each waited for "#226 and #234 merged (see p74), then a green
 * re-run of #<n> on the Air". p74 merged only #226, and #234's merge is open step p124, yet waitsMet read p74 as the whole wait and said "the
 * wait is over" two runs in a row. Steps and todos from the board snapshot at 05:16 KST, trimmed.
 */
const waits: [string, string, string][] = [
  ["p57", "Ship: merge validated onboarding replay into the shared app after owner go", "218"],
  ["p85", "Ship: merge the straight-to-setup fix (#231) after the owner's go", "231"],
  ["p82", "Ship: merge the signup page test (#229) and launch experiment 477145 after the owner's go", "229"],
  ["p83", "Ship: merge the QA visit filter for the dashboard script (#230) after the owner's go", "230"],
  ["p86", "Ship: merge the one-checkout-per-click fix (#232) after the owner's go", "232"],
];
const todos = [
  { id: "t17", text: "You okayed #226, #218, #229, #230, #231 and #232. GitHub checks can't run until the M1 Air runner works, likely Oct 13. When should they merge?",
    done: true, reply: "Go: merge after the Air checks pass", answeredBy: "owner", from: "agent", at: "" },
  { id: "t18", text: "Fifteen changes are ready, each merging only after its checks pass on the M1 Air: the switch moving checks onto the Air (#234, the rest wait on it). " +
    "Merge after the Air checks pass?", done: false, from: "agent", at: "" },
] as OwnerTodo[];
const slackGreen = (p124: PlanItem["status"], waitFor: (pr: string) => string, extra: { t18?: Partial<OwnerTodo> } = {}): ChatBoard => board([
  step("p113", "Ship the open slack-green PRs", "doing", { children: [
    step("p74", "Ship: merge the CI minutes cut (PR #226) after the owner's go", "done", { go: "needed" }),
    step("p124", "Ship: merge #234 (all slack-green checks on the M1 Air) after the owner's go on t18, then re-run #218, #229, #230, #231, #232 on the Air and merge " +
      "them one by one", p124, { go: "needed", waitFor: "the owner's answer on t18, which names #234; #234 head 1308072 is green on the Air (run 38289995168)" }),
    ...waits.map(([id, text, pr]) => step(id, text, "blocked", { go: "needed", waitFor: waitFor(pr) })),
  ] })], todos.map(todo => todo.id === "t18" ? { ...todo, ...extra.t18 } : todo));
const met = (plan: ChatBoard): string[] => checkInPrecheck(undefined, [], plan, Date.parse("2026-10-12T20:13:00Z"), { self: ["chat"] }).waitsMet.map(({ view }) => view.item.id);

test("c45: a step id in a \"see\" reference is a pointer, and a wait that names PRs is over only when a done merge step covers each (slack green guy 10-13: p57 and p74)", () => {
  const before = (pr: string) => `#226 and #234 merged (see p74), then a green re-run of #${pr} on the Air`;
  assert.deepEqual(met(slackGreen("todo", before)), [], "p74 merged only #226; #234 is open step p124");
  assert.deepEqual(met(slackGreen("todo", pr => `p74: #226 and #234 merged, then a green re-run of #${pr} on the Air`)), [],
    "p74 named as the wait is done, but #234 has no done merge step");
});

test("c45: a wait whose named ids are closed and whose named PRs each have a done merge step is still over (slack green guy 10-13: p124 done)", () => {
  const after = (pr: string) => `p124: #234 merged after the owner's go on t18, then a green re-run of #${pr} on the Air`;
  const answered = { t18: { done: true, reply: "Go: merge after the Air checks pass", answeredBy: "owner" as const } };
  assert.deepEqual(met(slackGreen("done", after, answered)), ["p57", "p85", "p82", "p83", "p86"]);
  assert.deepEqual(met(slackGreen("done", pr => `#226 and #234 merged (see p74), then a green re-run of #${pr} on the Air`)), ["p57", "p85", "p82", "p83", "p86"],
    "p74 merged #226 and p124 merged #234 and re-ran the rest");
  assert.deepEqual(met(slackGreen("doing", after, answered)), ["p124"], "p124's own #234 is its merge, not its wait, so t18's answer ends its wait; the rest wait on p124");
  assert.deepEqual(met(slackGreen("done", after)), [], "t18 not answered");
});
