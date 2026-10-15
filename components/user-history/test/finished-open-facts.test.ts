import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { boardPrs, type DoneFacts, finishedOpen, looksDone, metricFacts, NO_FACTS, type PrState } from "../src/checkin-done.ts";
import { noProgress, PROGRESS_MS } from "../src/checkin-findings.ts";
import { prStates } from "../src/pr-states.ts";
import type { DutyRunRecord } from "../src/shared/chat-duties.ts";
import type { ChatBoard, PlanItem } from "../src/shared/types.ts";

/*
 * On 10-16 at 05:3xZ the check-in prechecks of 11 chats flagged 7 items as looking done, and all 7 were open work: notes said "is live" or
 * "merged" about a part, or every step under a goal was closed while its metric missed or its work moved to another chat. The fixture holds the
 * 7 items as the boards had them. An item now looks done only on a fact: its duty metric met, its target met, or every PR its text names merged.
 */
const fixture = JSON.parse(readFileSync(new URL("./fixtures/finished-open-1016.json", import.meta.url), "utf8")) as { items: Record<string, PlanItem[]> };
const NOW = Date.parse("2026-10-16T05:35:00Z");
const facts = (extra: Partial<DoneFacts> = {}): DoneFacts => ({ ...NO_FACTS, ...extra });
const step = (id: string, text: string, extra: Partial<PlanItem> = {}): PlanItem => ({ id, text, status: "doing", children: [], ...extra });
const board = (plan: PlanItem[]): ChatBoard => ({ v: 2, rev: 1, plan, todos: [], updatedAt: "2026-10-16T00:00:00Z" });
const run = (duty: string, at: number, metrics: Record<string, boolean>, verdict: DutyRunRecord["verdict"] = "missed"): DutyRunRecord => ({
  duty, at, trigger: "schedule", ms: 1, verdict, summary: "",
  metrics: Object.fromEntries(Object.entries(metrics).map(([key, met]) => [key, { value: met ? 0 : 1, target: 0, op: "<=", met }])) });

test("none of the 7 items the 10-16 prechecks flagged looks done, with their real metric verdicts and PR states", () => {
  const all = Object.values(fixture.items).flat();
  assert.equal(all.length, 7);
  // launch main bro's d1 missed deep_walk_ok_pct (90% for a 99% target) and the AI harness d1 missed repeat_corrections.
  const metrics = metricFacts([run("d1", NOW - 60_000, { deep_walk_ok_pct: false, repeat_corrections: false })]);
  // p71 names #254 to #257; #255 was still open.
  const prs = new Map<string, PrState>([["254", { state: "merged" }], ["252", { state: "merged" }], ["253", { state: "merged" }], ["225", { state: "merged" }],
    ["250", { state: "merged" }], ["255", { state: "open" }], ["256", { state: "merged" }], ["257", { state: "merged" }]]);
  assert.deepEqual(finishedOpen(board(all), facts({ metrics, prs })).map(found => found.item.id), []);
});

test("a fix step looks done when its duty metric is met on the duty's newest measured run, and the after-job measure counts", () => {
  const p488 = step("p488", "Goals or steps that look done but are still open in the Check-in duty reaches at most 0, from 2 on the last run", { duty: "checkin/finished_open" });
  const met = metricFacts([run("checkin", NOW - 60_000, { finished_open: true }, "met"), run("checkin", NOW - 3_600_000, { finished_open: false })]);
  assert.deepEqual(looksDone(p488, facts({ metrics: met })), { reason: "its metric checkin/finished_open is met on the duty's last run", at: NOW - 60_000 });
  const missed = metricFacts([run("checkin", NOW - 60_000, { finished_open: false }), run("checkin", NOW - 3_600_000, { finished_open: true }, "met")]);
  assert.equal(looksDone(p488, facts({ metrics: missed })), null, "the newest run missed");
  const skipped = metricFacts([run("checkin", NOW - 60_000, {}, "skipped"), run("checkin", NOW - 3_600_000, { finished_open: true }, "met")]);
  assert.notEqual(looksDone(p488, facts({ metrics: skipped })), null, "a skipped run neither makes nor breaks it");
  const after = { ...run("checkin", NOW - 3_600_000, { finished_open: false }), after: { at: NOW - 3_000_000, verdict: "met" as const, summary: "",
    metrics: { finished_open: { value: 0, target: 0, op: "<=" as const, met: true } } } };
  assert.equal(looksDone(p488, facts({ metrics: metricFacts([after]) }))?.at, NOW - 3_000_000);
  assert.equal(looksDone({ ...p488, status: "done" }, facts({ metrics: met })), null, "a closed item");
});

test("a goal's own target never makes it look done: it has no direction (launch main bro p127, error reads at 32.4% for a 5% target)", () => {
  const p127 = step("p127", "Finished prod watch reads in 24 h that ended in an error after retries", { target: { metric: "error reads", target: 5, unit: "%", current: 32.4,
    measuredAt: "2026-10-16T05:00:00Z", source: "d2 precheck" } });
  assert.equal(looksDone(p127, NO_FACTS), null);
});

test("a step looks done when GitHub shows every PR its text names merged, and a note's words never count", () => {
  const p71 = fixture.items["slack green guy"]!.find(item => item.id === "p71")!;
  const merged = (numbers: string[]) => new Map(numbers.map(pr => [pr, { state: "merged", mergedAt: NOW - Number(pr) * 1000 } as PrState]));
  const all = ["254", "252", "253", "225", "250", "255", "256", "257"];
  assert.deepEqual(looksDone(p71, facts({ prs: merged(all) })), { reason: "#254, #252, #253, #225, #250, #255, #256, #257 are merged", at: NOW - 225_000 });
  assert.equal(looksDone(p71, facts({ prs: merged(all.filter(pr => pr !== "255")) })), null, "#255 unknown");
  assert.equal(looksDone(step("p4", "Ship the theme", { note: "PR #187 merged. Now live on production." }), facts({ prs: merged(["187"]) })), null,
    "a PR in the note is not the step's own");
  assert.deepEqual(boardPrs(board([p71, step("p5", "Done one #9", { status: "done" })])), [...all, "259"], "open items' text and note");
});

test("no_progress: a PR an open step names that merged in the last hour is progress (slack green guy 10-15 11:18Z, p144 and #258)", () => {
  const p144 = step("p144", "Build: most people who sign up with email finish signing in, instead of 13 of 20 stopping at the confirm email", {
    job: "email confirm loss", note: "#258 merged as ecfaebb at 10:57Z on Oct 15, Vercel production READY and the backend check green on ecfaebb." });
  const at = Date.parse("2026-10-15T11:18:37Z");
  const view = { item: p144, cls: "orphan", mine: true, changedAt: at - 2 * PROGRESS_MS } as unknown as Parameters<typeof noProgress>[1][number];
  const args = [board([p144]), [view], {}, at - 3 * PROGRESS_MS, [], new Set(["chat"]), at, undefined, new Map()] as const;
  assert.notEqual(noProgress(...args), null, "the old reading: no plan item turned done in the hour");
  const prs = new Map<string, PrState>([["258", { state: "merged", mergedAt: Date.parse("2026-10-15T10:57:43Z") }]]);
  assert.equal(noProgress(...args, { done: [], prs }), null, "#258 merged 21 min before");
  assert.notEqual(noProgress(...args, { done: [], prs: new Map([["258", { state: "merged", mergedAt: at - 2 * PROGRESS_MS }]]) }), null, "a merge 2 h ago");
  assert.equal(noProgress(...args, { done: [{ reason: "its metric d1/x is met", at: at - 60_000 }], prs: new Map() }), null, "a metric met in the hour");
});

test("prStates reads a folder's repo once, every asked PR in one GraphQL call, keeps merged PRs and reads open ones again after 10 min", async () => {
  const calls: string[][] = [];
  let now = NOW;
  const gh = async (args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === "repo") return "sieu-n/slack-green\n";
    const asked = [...(args[3] ?? "").matchAll(/p(\d+): pullRequest/g)].map(match => match[1]!);
    const data = Object.fromEntries(asked.map(pr => [`p${pr}`, pr === "1" ? null : pr === "258" ? { state: "MERGED", mergedAt: "2026-10-15T10:57:43Z" } : { state: "OPEN", mergedAt: null }]));
    // gh exits 1 when one number is unknown, with the data on stdout.
    if (asked.includes("1")) throw Object.assign(new Error("exit 1"), { stdout: JSON.stringify({ data: { repository: data } }) });
    return JSON.stringify({ data: { repository: data } });
  };
  const read = prStates(gh, () => now);
  const first = await read("/repo", ["258", "259", "1"]);
  assert.deepEqual(Object.fromEntries(first), { 258: { state: "merged", mergedAt: Date.parse("2026-10-15T10:57:43Z") }, 259: { state: "open" } });
  assert.equal(calls.length, 2);
  await read("/repo", ["258", "259"]);
  assert.equal(calls.length, 2, "both kept");
  now += 11 * 60_000;
  await read("/repo", ["258", "259"]);
  assert.deepEqual(calls.at(-1)?.[3]?.match(/p\d+:/g), ["p259:"], "only the open PR is read again");
  const none = prStates(async () => { throw new Error("not a git repository"); }, () => now);
  assert.deepEqual(Object.fromEntries(await none("/tmp", ["5"])), {});
});

test("AI harness p490, p494 and p505 at 06:3xZ on 10-16: notes that say shipped or is live count for nothing, and only p505's met metric does", () => {
  const live = JSON.parse(readFileSync(new URL("./fixtures/finished-open-ah-1016.json", import.meta.url), "utf8")) as { items: PlanItem[]; runs: DutyRunRecord[] };
  assert.deepEqual(live.items.map(item => item.duty), ["d1/repeat_corrections", "d6/usable_pct_1h", "checkin/stalled_steps"]);
  const metrics = metricFacts(live.runs);
  // d1 repeat_corrections read 1 and d6 usable_pct_1h 77.8%; the check-in's after-job measure read stalled_steps 0.
  assert.deepEqual(finishedOpen(board(live.items), facts({ metrics })).map(found => [found.item.id, found.reason]),
    [["p505", "its metric checkin/stalled_steps is met on the duty's last run"]]);
  const met = new Map([...metrics].map(([link, fact]) => [link, { ...fact, met: true }]));
  assert.deepEqual(finishedOpen(board(live.items), facts({ metrics: met })).map(found => found.item.id), ["p490", "p494", "p505"], "each closes once its metric is met");
});
