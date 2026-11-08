// Owner 10-22 about 05:40Z, after the AI harness chat said it would close p200 only once duty d4's next run read 0: "it's reasonable already
// right? and bc actual code is changing, but then that's already being handled by the duty system. so then close it!!" (c110, the 4th time).
// p850 under p200 read wiki problems 0 of at most 0 at 03:57Z on d4's own precheck script, and p200, which d4/wiki_problems keeps, stayed open
// until the owner said close.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrompt, convergenceMisses } from "../src/chat-checkin.ts";
import { applyBoardOp, GOAL_PUSH_LINK, metOpenItems, metOpenLine } from "../src/shared/chat-board.ts";
import type { GoalPush } from "../src/checkin-goals.ts";
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

// Crawler VP's p1206 read met_open in 32 check-ins in a row up to 11-08 04:30Z from the words "reads met" in its note, while d9, which its link
// names, read the census Postgres writer missed at 23:26Z 11-07 (worst 4,805,833 records against at most 5,000).
const p1206 = item("p146", { text: "Every documented crawler API route passes its own example on prod", children: [item("p1206", {
  text: "Fix: the census Postgres writer fell 18.6M records behind at 02:05Z 11-05 against at most 5,000; find why the lane falls behind under new-first census and fix it in code",
  duty: "d9/throughput_goals_missed", note: "Done when d9's census Postgres writer row (p895) holds its worst 5-min slot under 5,000 for 24 h at 10k+ profiles a minute on prod. " +
    "The d9 row reads met 24 h after lag stays under 5,000." })] });
const d9Missed = new Map([["d9/throughput_goals_missed", { met: false, at: Date.parse("2026-11-07T23:26:00Z") }]]);

test("a note's words never make a step met: p1206 with d9 missed is not flagged, nor is a note that says the target is met", () => {
  assert.deepEqual(metOpenItems(boardOf([p1206]).plan, d9Missed).map(found => found.item.id), []);
  const board = boardOf([item("p1", { note: "Done when the import e2e passes.", children: [item("p2", { note: "Done when the target is met." })] })]);
  assert.doesNotMatch(applyBoardOp(board, { op: "plan_update", id: "p2", note: "Target met: 0 of 0 at 03:57Z." }, "agent", at, () => "p9").summary, /reads met|says its target is met/);
});

test("a duty miss newer than the target reading keeps the item open, and an older one does not", () => {
  const goal = (measuredAt: string) => boardOf([item("p200", { duty: "d4/wiki_problems", target: { ...zero, measuredAt } })]);
  const missed = new Map([["d4/wiki_problems", { met: false, at: Date.parse("2026-10-22T03:00:00Z") }]]);
  assert.deepEqual(metOpenItems(goal("2026-10-22T02:00:00Z").plan, missed).map(found => found.item.id), []);
  assert.deepEqual(metOpenItems(goal("2026-10-22T03:57:00Z").plan, missed).map(found => found.item.id), ["p200"]);
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

// Check-in "CI and RepoOps 19:40" on 10-23: goal p346 on d2/rule_breaks_24h read met with nothing open under it, and the prompt said no duty keeps it.
test("a met goal with its own duty link names that duty as its keeper in the check-in prompt", () => {
  const goal = item("p346", { text: "Rule breaks stay at 0", duty: "d2/rule_breaks_24h" });
  const push = { goal, stale: false, act: "on_pace", words: [], trend: { kind: "met" } } as unknown as GoalPush;
  const prompt = checkInPrompt({ goals: [push], end: [], risks: [], metOpen: [] }, null);
  assert.match(prompt, /p346 "Rule breaks stay at 0" meets its target\. Close it now.*Duty d2 keeps it\./);
  assert.doesNotMatch(prompt, /No duty keeps it yet/);
  const loose = { ...push, goal: item("p347") } as GoalPush;
  assert.match(checkInPrompt({ goals: [loose], end: [], risks: [], metOpen: [] }, null), /No duty keeps it yet/);
});
