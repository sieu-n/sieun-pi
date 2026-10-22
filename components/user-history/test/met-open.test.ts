// Owner 10-22 about 05:40Z, after the AI harness chat said it would close p200 only once duty d4's next run read 0: "it's reasonable already
// right? and bc actual code is changing, but then that's already being handled by the duty system. so then close it!!" (c110, the 4th time).
// p850 under p200 read wiki problems 0 of at most 0 at 03:57Z on d4's own precheck script, and p200, which d4/wiki_problems keeps, stayed open
// until the owner said close.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrompt, convergenceMisses } from "../src/chat-checkin.ts";
import { applyBoardOp, GOAL_PUSH_LINK, metOpenItems, metOpenLine } from "../src/shared/chat-board.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const item = (id: string, fields: Partial<PlanItem> = {}): PlanItem => ({ id, text: `Work on ${id}`, status: "doing", children: [], ...fields });
const p850 = (fields: Partial<PlanItem> = {}) => item("p850", { text: "Push wiki problems from 91 to 0 by counting only real code changes and rewriting what is left",
  duty: GOAL_PUSH_LINK, note: "Done when wiki problems read 0 on d4's own run.",
  target: { metric: "wiki problems", target: 0, unit: "pages", current: 14, measuredAt: "2026-10-22T01:10:00.000Z", direction: "down" }, ...fields });
const p200 = (children: PlanItem[], fields: Partial<PlanItem> = {}) => item("p200", { text: "The wiki matches the code and every page reads like a plain blog post",
  duty: "d4/wiki_problems", note: "Done when d4 reads 0 for a day, checked 10-21 06:45Z.",
  requirements: [{ text: "should be unslop, read like an actual blog article", status: "met", evidence: "p201" }],
  target: { metric: "wiki problems", target: 0, unit: "problems", current: 4, measuredAt: "2026-10-22T02:51:02.793Z", direction: "down" },
  children: [item("p844", { status: "done", duty: "d4/wiki_problems" }), ...children], ...fields });
const boardOf = (plan: PlanItem[]) => ({ v: 2, rev: 1, updatedAt: "2026-10-22T03:50:00Z", todos: [], plan }) as unknown as ChatBoard;
const at = "2026-10-22T03:58:00Z";
const zero = { metric: "wiki problems", target: 0, unit: "pages", current: 0, measuredAt: "2026-10-22T03:57:00.000Z", direction: "down" as const };

test("setting p850's target to met tells the chat to close p850 and p200 now, naming duty d4", () => {
  const { summary } = applyBoardOp(boardOf([p200([p850()])]), { op: "plan_update", id: "p850", target: zero }, "agent", at, () => "p9");
  assert.match(summary, /p850 "Push wiki problems[^"]*" reads met \(wiki problems 0 pages, target at most 0, read 10-22 03:57Z\)\. Close it now/);
  assert.match(summary, /p200 "The wiki matches[^"]*" reads met \(wiki problems 0 problems, target at most 0, read 10-22 03:57Z on p850\)\. Close it now/);
  assert.match(summary, /duty d4 keeps wiki_problems \(c110\), so no reading of its next run is needed/);
});

test("closing p850 at target flags p200, and a later op on the same board does not repeat it", () => {
  const { board: next, summary } = applyBoardOp(boardOf([p200([p850()])]), { op: "plan_update", id: "p850", status: "done", target: zero }, "agent", at, () => "p9");
  assert.match(summary, /p200 .* reads met .* Close it now/);
  assert.doesNotMatch(summary, /p850 .* reads met/);
  assert.doesNotMatch(applyBoardOp(next, { op: "plan_add", text: "Fix the wiki lint", note: "Done when lint passes." }, "agent", at, () => "p9").summary, /reads met/);
});

test("a note that says the target is met flags an open step, and a Done when line that names met does not", () => {
  const board = boardOf([item("p1", { note: "Done when the import e2e passes.", children: [item("p2", { note: "Done when the target is met." })] })]);
  assert.match(applyBoardOp(board, { op: "plan_update", id: "p2", note: "Target met: 0 of 0 at 03:57Z." }, "agent", at, () => "p9").summary, /p2 "Work on p2" has a note that says its target is met\. Close it now/);
  assert.doesNotMatch(applyBoardOp(board, { op: "plan_update", id: "p2", note: "Done when the target is met. Working on it." }, "agent", at, () => "p9").summary, /reads met|says its target is met/);
});

test("an open step that is not met, a hold in the owner's words and an unmet requirement keep a met goal open", () => {
  const blocking = boardOf([p200([p850({ status: "done", target: zero }), item("p851", { note: "Done when the last writer wave lands." })])]);
  assert.deepEqual(metOpenItems(blocking.plan).map(found => found.item.id), []);
  const held = boardOf([p200([p850({ status: "done", target: zero })], { text: "Instagram profiles crawl at 10k a minute, held 6 h" })]);
  assert.deepEqual(metOpenItems(held.plan).map(found => found.item.id), []);
  const asked = boardOf([p200([p850({ status: "done", target: zero })], { requirements: [{ text: "every page reads like a blog post", status: "open" }] })]);
  assert.deepEqual(metOpenItems(asked.plan).map(found => found.item.id), []);
});

test("the check-in precheck flags met_open for p850 and p200 and asks to close them now", () => {
  const board = boardOf([p200([p850({ target: zero })])]);
  const found = metOpenItems(board.plan);
  assert.deepEqual(found.map(entry => [entry.item.id, entry.keeper]), [["p850", "d4/wiki_problems"], ["p200", "d4/wiki_problems"]]);
  const empty = { scope: [], gates: [], stalled: [], goals: [], blocked: [], done: [], loose: [], extra: [], underClosed: [], held: [], waitsMet: [], noProgress: null, stale: [], fold: [] };
  const out = convergenceMisses("AI harness", [], { ...empty, metOpen: found }, {}, 30 * 60_000, Date.parse(at));
  assert.equal(out.metrics.met_open, 2);
  assert.deepEqual(out.flagged.filter(slice => slice.kind === "met_open").map(slice => slice.item), ["p850", "p200"]);
  const prompt = checkInPrompt({ goals: [], end: [], risks: [], metOpen: found }, null);
  assert.match(prompt, /2 open items, like p850 "Push wiki problems[^"]*", meet their target/);
  assert.match(prompt, /Close each now/);
  assert.doesNotMatch(prompt, /long enough|6 h/);
});

test("a met item no duty keeps is closed now and its metric goes into a duty first", () => {
  const [found] = metOpenItems(boardOf([item("p5", { target: { metric: "pages done", target: 5, unit: "pages", current: 5, measuredAt: "2026-10-22T03:00:00Z", direction: "up" } })]).plan);
  assert.equal(found!.keeper, undefined);
  assert.match(metOpenLine(found!), /No duty keeps this metric yet: when it must stay there, add it to a duty as a metric, then close it/);
});
