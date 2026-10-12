import assert from "node:assert/strict";
import { test } from "node:test";
import { BLOCKED_MS, checkInPrecheck, checkInPrecheckText, convergenceMisses, type JobFact } from "../src/chat-checkin.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const MIN = 60_000;
const EVERY = 15 * MIN;
const iso = (at: number) => new Date(at).toISOString();
const step = (id: string, text: string, extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status: "todo", children: [], ...extra });
/** A board last changed `minutes` ago, so a step the check-in has not seen before waits since then. */
const boardOf = (minutes: number, ...steps: PlanItem[]): ChatBoard =>
  ({ v: 2, rev: 1, updatedAt: iso(NOW - minutes * MIN), scratch: [], todos: [], plan: [step("p1", "Ship the concierge DM", { status: "doing", children: steps })] });
const ROWS = [{ id: "s-release", name: "release owner", archived: false }, { id: "s-crawler", name: "Crawler VP", archived: false }];
const blocked = (board: ChatBoard, facts: JobFact[] = []) => {
  const precheck = checkInPrecheck(undefined, facts, board, NOW, { self: ["c1", "Concierge"], rows: ROWS, everyMs: EVERY });
  return { precheck, output: convergenceMisses("c1", precheck.steps, precheck, {}, EVERY, NOW) };
};

test("blocked on others: a 70-min CI wait with no job is flagged, counted and listed as needing a fix job this run", () => {
  const { precheck, output } = blocked(boardOf(70, step("p2", "Land the DM worker", { waitFor: "CI on ci/concierge-dm" })));
  assert.deepEqual(precheck.blocked.map(block => `${block.view.item.id} ${block.on}`), ["p2 CI"]);
  assert.equal(output.metrics.blocked_on_others, 1);
  const [flag] = output.flagged.filter(slice => slice.kind === "blocked_on_others");
  assert.equal(flag!.item, "p2");
  assert.equal(flag!.excerpt, 'p2 "Land the DM worker" is blocked on CI for 70 min and no job works on it: find out why and start a job that fixes the blocker, ' +
    "or send the blocker's owner a concrete patch");
  const text = checkInPrecheckText(precheck, [], output.flagged, NOW);
  const section = text.split("\n\n").find(part => part.startsWith("### Blocked on CI, a release or another thread"))!;
  assert.match(section, /start a job that fixes each blocker in this run, or send its owner a concrete patch; marking the step waiting is not an answer/);
  assert.match(section.split("\n")[1]!, /^- p2 "Land the DM worker" is blocked on CI for 70 min/);
});

test("blocked on others: a live job on the step, a 30-min wait, or a wait on nothing outside the chat is not flagged", () => {
  const ci = step("p2", "Land the DM worker", { waitFor: "CI on ci/concierge-dm", job: "ci-fix" });
  const fixing: JobFact = { key: "k1", name: "ci-fix", state: "working", activityAt: NOW - MIN };
  assert.deepEqual(blocked(boardOf(70, ci), [fixing]).precheck.blocked, [], "a live job works on it");
  assert.equal(blocked(boardOf(70, ci), [fixing]).output.metrics.blocked_on_others, 0);
  assert.deepEqual(blocked(boardOf(30, step("p2", "Land the DM worker", { waitFor: "CI on ci/concierge-dm" }))).precheck.blocked, [], "30 min is under BLOCKED_MS");
  assert.equal(BLOCKED_MS, 60 * MIN);
  assert.deepEqual(blocked(boardOf(70, step("p2", "Write the copy", { waitFor: "the landing page draft" }))).precheck.blocked, [], "landing is not land");
  assert.deepEqual(blocked(boardOf(70, step("p2", "Note the CI run", { note: "CI passed on ci/x" }))).precheck.blocked, [], "a todo step that does not wait is not blocked");
});

test("blocked on others: a release, a pin, another thread, or a job that ended counts; the line names the blocker and the job", () => {
  const { precheck, output } = blocked(boardOf(90,
    step("p2", "Promote to production", { waitFor: "promote.yml after the train" }),
    step("p3", "Bump the SDK", { status: "blocked", note: "pinned to 0.9.8 until the pool moves" }),
    step("p4", "Share the crawler schema", { waitFor: "Crawler VP to send the schema" }),
    step("p5", "Fix the release gate", { waitFor: "the release queue", job: "gate-fix" })), [{ key: "k2", name: "gate-fix", state: "ended", activityAt: NOW - 80 * MIN }]);
  assert.deepEqual(precheck.blocked.map(block => `${block.view.item.id} ${block.on}`), ["p2 promote.yml", "p3 pinned", "p4 the Crawler VP thread", "p5 release queue"]);
  assert.equal(output.metrics.blocked_on_others, 4);
  assert.match(output.flagged.find(slice => slice.item === "p5" && slice.kind === "blocked_on_others")!.excerpt, /is blocked on release queue for 90 min and job gate-fix is idle: /);
});

/** p168 of the developer environment VP board, verbatim (10-10): a planned 2-day audit window, its note naming the audit's session folder. */
const P168 = {
  text: "Verify: in 2 days, rerun the audit's measure script: more jobs fan out, fewer silent job ends, fewer repeat job names",
  status: "doing" as const, waitUntil: "2026-10-11T11:00:00.000Z", job: "c1",
  waitFor: "final fixed-window audit at 2026-10-11 20:00 KST; copy the script into a new wiki session and review child-to-output links",
  note: "Interim rerun at 12:12 KST (measure_interim_1215.py, data/measure-interim-20261010-1215.json in sessions/2026/10/09/1952-thread-job-split-audit): " +
    "262 jobs since 2026-10-09 11:13Z. Fan-out 39.3% (baseline 17%), no report 1.5% (baseline 13%), repeated names 6 (baseline 21). The final fixed-window run stays at 2026-10-11 20:00 KST.",
};

test("blocked on others: a path or dated folder name in the note is not a blocker; the same word as a real word still is (W59, p168)", () => {
  const p168 = blocked(boardOf(240, step("p168", P168.text, P168)));
  assert.deepEqual(p168.precheck.blocked, [], "\"thread\" inside sessions/2026/10/09/1952-thread-job-split-audit is no blocker");
  assert.equal(p168.output.metrics.blocked_on_others, 0);
  const slug = { ...P168, note: "The script is in 1952-thread-job-split-audit, data folder." };
  assert.deepEqual(blocked(boardOf(240, step("p168", P168.text, slug))).precheck.blocked, [], "a dated folder name alone, with its punctuation, is no blocker either");
  const real = { ...P168, note: P168.note + " The other thread owns the script now." };
  assert.deepEqual(blocked(boardOf(240, step("p168", P168.text, real))).precheck.blocked.map(block => block.on), ["thread"], "a real word in the same note still counts");
  assert.deepEqual(blocked(boardOf(70, step("p2", "Land the DM worker", { waitFor: "CI on ci/concierge-dm" }))).precheck.blocked.map(block => block.on), ["CI"],
    "the path token drops out, the word CI next to it stays");
});

test("stalled waits: a future, never-moved waitUntil with a waitFor is a planned wait unless the waitFor names CI, a land, a release, a pin or a thread (W59, p168)", () => {
  const stalled = (extra: Partial<PlanItem>) => blocked(boardOf(240, step("p168", P168.text, { ...P168, ...extra }))).precheck.stalled.map(stall => stall.view.item.id);
  assert.deepEqual(stalled({}), [], "p168 waits for its own audit date: planned, not stalled");
  assert.deepEqual(stalled({ waitFor: "the final audit after the CI fix lands" }), ["p168"], "a waitFor naming CI still stalls after 2 h");
  assert.deepEqual(stalled({ waitFor: "Crawler VP to send the schema" }), ["p168"], "a waitFor naming another thread (waitTarget) still stalls");
  assert.deepEqual(stalled({ waitFor: "promote.yml after the train" }), ["p168"], "a release word still stalls");
  assert.deepEqual(stalled({ waitUntil: iso(NOW - 60 * MIN) }), ["p168"], "a passed date still stalls");
  const { waitUntil: _date, ...noDate } = P168;
  assert.deepEqual(blocked(boardOf(240, step("p168", P168.text, noDate))).precheck.stalled.map(stall => stall.view.item.id), ["p168"], "a wait with no date still stalls");
  assert.deepEqual(blocked(boardOf(60, step("p168", P168.text, noDate))).precheck.stalled, [], "1 h is under STALL_MS");
});

test("blocked on others: a step an open For you todo covers waits on the owner, not on others (AI harness 10-12: p288 on t41, p277 on t42)", () => {
  const board = boardOf(70,
    step("p288", "Verify the title bar theme after the release", { status: "blocked", waitFor: "the next release, then the owner's answer on t41" }),
    step("p277", "Turn SEO guy's check-ins back on", { status: "blocked", waitFor: "Crawler VP pool headroom and the owner's answer on t42" }),
    step("p290", "Land the duty fix", { status: "blocked", waitFor: "the release owner's next land" }));
  board.todos = [{ id: "t41", text: "Does the title bar follow your theme now?", from: "agent", done: false, at: "" },
    { id: "t42", text: "Press Resume on SEO guy after 15:30?", from: "agent", done: false, at: "" }];
  const { precheck, output } = blocked(board);
  assert.deepEqual(precheck.steps.map(view => `${view.item.id} ${view.cls}`).slice(0, 2), ["p288 foryou", "p277 foryou"]);
  assert.deepEqual(precheck.blocked.map(block => block.view.item.id), ["p290"], "only the step that waits on others alone");
  assert.equal(output.metrics.blocked_on_others, 1);
});
