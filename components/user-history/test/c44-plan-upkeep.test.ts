import assert from "node:assert/strict";
import { test } from "node:test";
import { checkInPrecheck, checkInPrecheckText, convergenceMisses } from "../src/chat-checkin.ts";
import { STALE_STEP_MS } from "../src/checkin-findings.ts";
import type { JobFact } from "../src/checkin-steps.ts";
import { applyBoardOp, areaWords, BoardError, nextIds, sameAreaGoal } from "../src/shared/chat-board.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/** Shapes from a crawler thread's board: goal and step texts, jobs and waits as neutral sample text, statuses set per case. */
const NOW = Date.parse("2026-10-12T03:00:00Z");
const MIN = 60_000;
const EVERY = 15 * MIN;
const iso = (at: number) => new Date(at).toISOString();
const item = (id: string, text: string, extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status: "todo", children: [], ...extra });
const boardOf = (updatedAt: number, ...plan: PlanItem[]): ChatBoard => ({ v: 2, rev: 1, updatedAt: iso(updatedAt), todos: [], plan });
const check = (board: ChatBoard, facts: JobFact[] = []) => {
  const precheck = checkInPrecheck(undefined, facts, board, NOW, { self: ["01a00000-0000-7000-8000-000000000004", "Index VP"], rows: [], everyMs: EVERY });
  const output = convergenceMisses("c1", precheck.steps, precheck, {}, EVERY, NOW);
  return { precheck, output, text: checkInPrecheckText(precheck, facts, output.flagged, NOW) };
};
const sectionOf = (text: string, head: string) => text.split("\n\n").find(part => part.startsWith(`### ${head}`));

/** p86 and p63 as they stood after the fleet outage: waitUntil 10-10, 38 h and 45 h before NOW. */
const P86 = item("p86", "Fix: prod survey hop jobs end blocked since 02:05Z (page reads succeed, the hop parser drops them)", { status: "doing",
  job: "01a00000-0000-7000-8000-000000000003", waitUntil: "2026-10-10T13:00:00.000Z", waitFor: "exit labels abc1234 and hop fix def5678 in land 31" });
const P63 = item("p63", "Back up every store on the store box (databases, configs) to cloud storage", { status: "doing", job: "box backups",
  waitUntil: "2026-10-10T06:00:00.000Z", waitFor: "promote 7 (after 04:45Z), then the release owner's backup slot", children: [
    item("p64", "List every secret needed to rebuild the box that exists only on the box", { status: "done", job: "box backups" }),
    item("p66", "Search index snapshots to the local disk (daily, 14 kept)", { status: "doing", job: "box backups",
      waitUntil: iso(NOW + 4 * 60 * MIN), waitFor: "the staging drill 07:30-08:35Z, then the first snapshot" })] });
const goal = (...children: PlanItem[]) => item("p28", "Whole pipeline (crawl, DB, sync and other workers) scaled and stress tested at 1,000 items/s", { status: "doing", children });

test("stale_steps: a waitUntil over 24 h past is stale on a leaf step and on a step with open steps under it; a planned wait ahead is not", () => {
  const { precheck, output, text } = check(boardOf(NOW - 50 * 60 * MIN, goal(P86, P63)));
  assert.deepEqual(precheck.stale.map(entry => entry.item.id), ["p86", "p63"]);
  assert.equal(output.metrics.stale_steps, 2);
  assert.equal(output.metrics.due_late, 0, "p86 is due too, and counted once, as stale");
  assert.match(output.flagged.find(slice => slice.kind === "stale_steps" && slice.item === "p86")!.excerpt,
    /^p86 "Fix: prod survey hop jobs end blocked since 02:05Z .*" doing: its waitUntil \S+ \S+ passed 38 h ago; update it or close it in this run$/);
  const section = sectionOf(text, "Stale steps")!;
  assert.match(section, /update or close each in this run/);
  assert.deepEqual(section.split("\n").slice(1).map(line => line.slice(2, 5)), ["p86", "p63"]);
  assert.doesNotMatch(sectionOf(text, "Steps whose class needs action") ?? "", /p86/, "the due line for p86 is not listed again");
  assert.equal(STALE_STEP_MS, 24 * 60 * MIN);
});

test("stale_steps: a due step under 24 h is due_late only; one over 24 h is stale_steps only", () => {
  const due = (hours: number) => check(boardOf(NOW - 50 * 60 * MIN, goal({ ...P86, waitUntil: iso(NOW - hours * 60 * MIN) }))).output.metrics;
  assert.deepEqual([due(2).due_late, due(2).stale_steps], [1, 0]);
  assert.deepEqual([due(25).due_late, due(25).stale_steps], [0, 1]);
});

test("stale_steps: an item that looks finished is counted once, in finished_open, and listed under Look done only", () => {
  const shipped = { ...P86, note: "exit labels abc1234 and hop fix def5678 deployed and live on prod; jobs end done again" };
  const { output, text } = check(boardOf(NOW - 50 * 60 * MIN, goal(shipped)));
  assert.deepEqual([output.metrics.stale_steps, output.metrics.finished_open], [0, 1]);
  assert.equal(sectionOf(text, "Stale steps"), undefined);
  assert.match(sectionOf(text, "Look done")!, /p86 /);
  const P87 = item("p87", "Plan: find why prod hop jobs end blocked since 02:05Z", { status: "done", job: "hop parser fix" });
  const met = check(boardOf(NOW - 50 * 60 * MIN, goal(P87, { ...P86, waitFor: "p87 report" }))).output.metrics;
  assert.deepEqual([met.stale_steps, met.wait_met], [0, 1], "a wait that is over (c45) is counted there, not again as stale");
});

test("stale_steps: a job that ended a check-in ago with the step unchanged is stale when its waitFor kept it out of job_end_unrecorded; job_end_unrecorded keeps its own", () => {
  const ended = (minutes: number, extra: Partial<JobFact> = {}): JobFact => ({ key: "k-meter", name: "byte meter fix", state: "ended", activityAt: NOW - minutes * MIN, ...extra });
  const P51 = item("p51", "Fix: usage metering silent in prod since 10-08 08:49Z; meter every lane", { status: "doing", job: "byte meter fix",
    waitFor: "promote 7 rerun at 04:50Z, read-back about 05:35Z" });
  const held = check(boardOf(NOW - 3 * 60 * MIN, goal(P51)), [ended(40)]);
  assert.equal(held.output.metrics.job_end_unrecorded, 0, "a waitFor holds it out of job_end_unrecorded (holdsOnWait)");
  assert.equal(held.output.metrics.stale_steps, 1);
  assert.match(held.output.flagged.find(slice => slice.kind === "stale_steps")!.excerpt, /: job byte meter fix ended 40 min ago and the step has not changed since; update it or close it in this run$/);
  assert.equal(check(boardOf(NOW - 3 * 60 * MIN, goal(P51)), [ended(10)]).output.metrics.stale_steps, 0, "under one check-in interval");
  assert.equal(check(boardOf(NOW - 3 * 60 * MIN, goal(P51)), [ended(40, { state: "working" })]).output.metrics.stale_steps, 0, "a job at work");
  assert.equal(check(boardOf(NOW - 3 * 60 * MIN, goal({ ...P51, waitUntil: iso(NOW + 60 * MIN) })), [ended(40)]).output.metrics.stale_steps, 0, "a planned wait ahead");
  assert.equal(check(boardOf(NOW - 20 * MIN, goal(P51)), [ended(40)]).output.metrics.stale_steps, 0, "the step changed after the job ended");
  const cancelled = check(boardOf(NOW - 3 * 60 * MIN, goal(P51)), [ended(40, { cancelled: true })]).output;
  assert.match(cancelled.flagged.find(slice => slice.kind === "stale_steps")!.excerpt, /job byte meter fix was cancelled 40 min ago/);
  const thread: JobFact = { key: "thread:01a00000-0000-7000-8000-000000000003", name: "release thread", state: "ended", activityAt: NOW - 40 * MIN };
  assert.equal(check(boardOf(NOW - 3 * 60 * MIN, goal({ ...P51, job: "01a00000-0000-7000-8000-000000000003" })), [thread]).output.metrics.stale_steps, 0,
    "a thread owner is chased by its class, not called ended");
  const { waitFor: _wait, ...noWait } = P51;
  const bare = check(boardOf(NOW - 3 * 60 * MIN, goal(noWait)), [ended(40)]).output;
  assert.deepEqual([bare.metrics.job_end_unrecorded, bare.metrics.stale_steps], [1, 0], "with no wait the end is job_end_unrecorded, counted once");
});

/** A crawler thread's top-level goals, open unless done; p4 left out so a new goal stays under the 6-goal cap. */
const CRAWLER_GOALS: PlanItem[] = [
  item("p3", "Status roll-up of all active dev threads", { status: "done" }),
  item("p10", "Crawlers ready for full speed the moment ProxyCo returns (offline proof)", { status: "doing" }),
  item("p19", "Catalog survey filling the 200 Mbps ProxyCo plan (about 500 reads/s) and the whole box, today", { status: "doing" }),
  item("p24", "The crawler starts with no flags or options unless essential", { status: "done" }),
  item("p28", "Whole pipeline (crawl, DB, sync and other workers) scaled and stress tested at 1,000 items/s, watched in the metrics dashboard", { status: "doing" }),
  item("p44", "Analytics store: one snapshot table per entity per source, Vendor Mall shape, no junk columns, no _latest tables", { status: "doing" }),
  item("p71", "Complete index of Catalog, Promo Ads and Vendor Mall (owner 10-09)", { status: "doing" }),
];
const crawlerBoard = boardOf(NOW, ...CRAWLER_GOALS);
const add = (op: Parameters<typeof applyBoardOp>[1], actor: "agent" | "owner" = "agent") => applyBoardOp(crawlerBoard, op, actor, iso(NOW), nextIds(crawlerBoard));

test("plan_add: a new top-level goal in an open goal's area applies with a warning naming that goal; the owner is never warned", () => {
  const { board, summary } = add({ op: "plan_add", text: "Catalog index" });
  assert.equal(board.plan.at(-1)!.text, "Catalog index", "the op still applies");
  assert.equal(summary, 'Added p72 "Catalog index". p71 "Complete index of Catalog, Promo Ads and Vendor Mall (owner 10-09)" covers the same area: ' +
    "put new work under it unless it is a separate area");
  assert.equal(add({ op: "plan_add", text: "ProxyCo bandwidth report for the owner" }).summary, 'Added p72 "ProxyCo bandwidth report for the owner"',
    "one shared word (ProxyCo, in two separate goals here) is no warning");
  assert.equal(add({ op: "plan_add", text: "Vendor Mall sellers, products and live rooms on staging and prod" }).summary,
    'Added p72 "Vendor Mall sellers, products and live rooms on staging and prod"', "2 shared words out of 8 is a separate area");
  assert.equal(add({ op: "plan_add", text: "Catalog index", parent: "p71" }).summary, 'Added p72 "Catalog index" under p71', "a step is never warned");
  assert.equal(add({ op: "plan_add", text: "Roll-up of all dev threads" }).summary, 'Added p72 "Roll-up of all dev threads"', "a done goal is no area to join");
  assert.throws(() => add({ op: "plan_add", text: "Catalog index" }, "owner"), error => error instanceof BoardError && error.kind === "forbidden",
    "the owner's board ops never add plan goals, so the owner is never warned");
});

test("area words: lowercase words of 4 letters or more, plural cut, stop words out; the best goal shares the most words", () => {
  assert.deepEqual([...areaWords("Plan: the Catalog index, crawlers and the whole box")].sort(), ["catalog", "crawler", "index"]);
  assert.equal(sameAreaGoal(CRAWLER_GOALS, "Catalog survey reads per second on prod")?.id, "p19", "3 shared words with p19, 1 with p71");
  assert.equal(sameAreaGoal(CRAWLER_GOALS, "Crawlers for the Catalog survey at full speed")?.id, "p10", "a tie of 2 words goes to the first goal in board order");
  assert.equal(sameAreaGoal(CRAWLER_GOALS, "Plan the build"), undefined);
});
