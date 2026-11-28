/**
 * What a duty run gives the duty's job item by item, when a job has held its duty too long, and which fix step owns which flagged item
 * (server/duty-items.ts, `fixesOn` in server/duty-run.ts). The case is devops guy's d17 "Vendor bills stay inside plan": from 11-25 21:10Z
 * one job held it for 62 h, 7 runs started none and gave it nothing, and every run read lines_over_pace as fixed by p46 "vercel spend cut"
 * (~/work/bill-check-miss/survey.md).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/duty-items.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { beside, countedItems, givenTo, heldSince, itemKey, itemOwners, metricKey, runKeys, stepNames, unseen } from "../../server/duty-items.ts";
import { fixesOn, measure, newItemsText } from "../../server/duty-run.ts";
import { emptyBoard } from "../../web/src/lib/api/shared/chat-board.ts";
import type { Duty, DutyRunRecord, FlaggedSlice } from "../../web/src/lib/api/shared/chat-duties.ts";
import type { ChatBoard, PlanItem } from "../../web/src/lib/api/types.ts";

delete process.env.INVOCATION_ID;

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 25, 21, 10);
const DAILY = { kind: "daily", at: "08:41" } as const;
const line = (item: string, kind = "line_over_pace"): FlaggedSlice => ({ kind, item, excerpt: `${item}: 366 GB a cycle, 146% of 250 GB included` });
const SYNCED = line("posthog//Synced rows");
const GEONODE = line("geonode/residential-premium/Bandwidth");
const EVENTS = line("posthog//Events");
const CREDITS = line("openai/sieunpark77@gmail.com/credits");
const run = (at: number, over: number, extra: Partial<DutyRunRecord> = {}): DutyRunRecord => ({
  duty: "d17", at, slot: at, trigger: "schedule", ms: 900, verdict: over ? "missed" : "met", summary: `lines_over_pace ${over}`,
  metrics: { lines_over_pace: { value: over, target: 0, op: "<=", met: over === 0 } }, job: { id: "job-1", name: "Vendor bills duty" }, ...extra,
});

test("a flagged item's key is its sig, else its kind and item, else its kind and its text with the numbers read as one", () => {
  assert.equal(itemKey({ kind: "area_review", sig: "ag_x:2026-11-25", excerpt: "review" }), "ag_x:2026-11-25");
  assert.equal(itemKey(SYNCED), "line_over_pace|posthog//Synced rows");
  assert.notEqual(itemKey(SYNCED), itemKey({ ...SYNCED, kind: "line_left_out" }), "the same line under another kind is another finding");
  const waits = (hours: number) => ({ kind: "unanswered_chat", excerpt: `chat qx7qa3 nghdevv@gmail.com waits ${hours} h since 2026-07-30` });
  assert.equal(itemKey(waits(2850)), itemKey(waits(2874)), "a count that grew is the same finding");
  assert.notEqual(itemKey(waits(2850)), itemKey({ ...waits(2850), excerpt: "chat zz9 other@x.io waits 2850 h since 2026-07-30" }));
  const db = (n: number) => ({ kind: "unlisted", excerpt: `local postgres database crawler_local_pytest_${n}: 8 MB, 0 connections` });
  assert.notEqual(itemKey(db(30266)), itemKey(db(30267)), "a number inside a name tells two items apart");
  const fired = (at: string) => ({ kind: "alert_firing", excerpt: `ci-warn-spec-new-red firing since ${at}: sent to devops guy` });
  assert.equal(itemKey(fired("2026-11-25T16:39Z")), itemKey(fired("2026-11-26T02:10Z")));
  assert.equal(metricKey("lines_over_pace"), "metric|lines_over_pace");
});

test("a job is given each flagged item and missed metric once", () => {
  const given = new Set(runKeys({ flagged: [SYNCED, GEONODE], missed: ["lines_over_pace"] }));
  assert.deepEqual(unseen({ flagged: [SYNCED, GEONODE], missed: ["lines_over_pace"] }, given), { flagged: [], missed: [], keys: [] });
  const fresh = unseen({ flagged: [SYNCED, EVENTS, EVENTS], missed: ["lines_over_pace", "reads_failing"] }, given);
  assert.deepEqual(fresh.flagged, [EVENTS], "only the item no run gave it, once");
  assert.deepEqual(fresh.missed, ["reads_failing"]);
  assert.deepEqual(fresh.keys, ["line_over_pace|posthog//Events", "metric|reads_failing"]);
});

test("the runs that name a job say what it was given; a record with no given list gave its brief only when it started the job", async () => {
  const flaggedOf = async (detail: string) => detail === "first.json" ? [SYNCED, GEONODE] : [SYNCED, GEONODE, EVENTS];
  const old = [run(T0, 2, { detail: "first.json" }), run(T0 + 26 * HOUR, 3, { detail: "later.json" })];
  assert.deepEqual([...await givenTo(old, flaggedOf)].sort(), ["line_over_pace|geonode/residential-premium/Bandwidth", "line_over_pace|posthog//Synced rows", "metric|lines_over_pace"]);
  const steered = [...old.slice(0, 1), run(T0 + 26 * HOUR, 3, { given: [itemKey(EVENTS)] })];
  assert.ok((await givenTo(steered, flaggedOf)).has("line_over_pace|posthog//Events"), "a run that steered the job gave it that item");
  assert.deepEqual([...await givenTo([run(T0, 2, { detail: "gone.json" })], async () => { throw new Error("no such file"); })], ["metric|lines_over_pace"]);
});

test("a job has held its duty since the last run that read a missed number closer to its target", () => {
  assert.equal(heldSince([run(T0, 2), run(T0 + 3 * HOUR, 2), run(T0 + 26 * HOUR, 3)]), T0, "2, 2, 3 never moved");
  assert.equal(heldSince([run(T0, 4), run(T0 + 3 * HOUR, 3), run(T0 + 26 * HOUR, 3)]), T0 + 3 * HOUR, "4 to 3 moved at the second run");
  assert.equal(heldSince([run(T0, 4), run(T0 + 3 * HOUR, 0)]), T0 + 3 * HOUR, "a met reading moved it");
  const up = (at: number, value: number): DutyRunRecord => ({ ...run(at, 1), metrics: { up: { value, target: 99, op: ">=", met: value >= 99 } } });
  assert.equal(heldSince([up(T0, 90), up(T0 + HOUR, 95), up(T0 + 2 * HOUR, 93)]), T0 + HOUR, "a number that should rise moved when it rose");
  assert.equal(heldSince([{ ...run(T0, 0), verdict: "met" }, run(T0 + 30 * HOUR, 2)]), T0, "a job that started for no missed metric has no number to move");
});

test("a due run replaces a job past its stuck limit whose number did not move, and never one that waits for a model account", () => {
  const first = run(T0, 2);
  const at = (hours: number, over: number, more: Partial<Parameters<typeof beside>[0]> = {}) =>
    beside({ now: T0 + hours * HOUR, schedule: DAILY, jobRuns: [first], record: run(T0 + hours * HOUR, over), due: true, waitsForAccount: false, fresh: 0, ...more });
  assert.deepEqual(at(2.5, 2), { do: "leave" }, "a daily duty's job has 12 h");
  assert.deepEqual(at(2.5, 2, { fresh: 1 }), { do: "steer" });
  assert.deepEqual(at(26.5, 3, { fresh: 1 }), { do: "replace", heldMs: 26.5 * HOUR, limitMs: 12 * HOUR });
  assert.deepEqual(at(26.5, 3, { waitsForAccount: true }), { do: "leave" }, "a new job would wait in the same line");
  assert.deepEqual(at(26.5, 3, { waitsForAccount: true, fresh: 2 }), { do: "steer" }, "a waiting job still gets the run's new items");
  assert.deepEqual(at(26.5, 1), { do: "leave" }, "the number moved in this run");
  assert.deepEqual(at(26.5, 3, { due: false }), { do: "leave" }, "a run with nothing due has nothing for a new job");
  const often = (minutes: number) => beside({ now: T0 + minutes * 60_000, schedule: { kind: "every", minutes: 10 }, jobRuns: [first], record: run(T0 + minutes * 60_000, 2), due: true, waitsForAccount: false, fresh: 0 });
  assert.equal(often(80).do, "leave", "a 10-minute duty's job has 90 min, as in Prime");
  assert.equal(often(100).do, "replace");
});

test("a missed metric counts the flagged items of its own kind, and a step names an item by its words", () => {
  const flagged = [SYNCED, GEONODE, line("vercel//spend", "line_left_out"), { kind: "line_over_pace", excerpt: "a line with no name" }, { kind: "billing_problem", item: "billing_mail/aws", excerpt: "x" }];
  assert.deepEqual(countedItems("lines_over_pace", flagged), ["posthog//Synced rows", "geonode/residential-premium/Bandwidth"]);
  assert.deepEqual(countedItems("billing_problems", flagged), ["billing_mail/aws"]);
  assert.deepEqual(countedItems("search_p90_ms", flagged), []);
  assert.equal(stepNames({ text: "vercel spend cut" }, "posthog//Synced rows"), false);
  assert.equal(stepNames({ text: "posthog synced rows" }, "posthog//Synced rows"), true);
  assert.equal(stepNames({ text: "cut the sync", note: "owns posthog//Synced rows" }, "posthog//Synced rows"), true);
  assert.equal(stepNames({ text: "geonode bandwidth" }, "geonode/residential-premium/Bandwidth"), false, "every word of the item, not some");
  assert.deepEqual(itemOwners([{ id: "p46", text: "vercel spend cut" }, { id: "p56", text: "posthog synced rows" }], ["posthog//Synced rows", "posthog//Events"]),
    [{ item: "posthog//Synced rows", step: "p56" }, { item: "posthog//Events" }]);
});

const step = (id: string, text: string, more: Partial<PlanItem> = {}): PlanItem => ({ id, text, status: "doing", duty: "d17/lines_over_pace", children: [], ...more });
const boardOf = (...plan: PlanItem[]): ChatBoard => ({ ...emptyBoard(new Date(T0).toISOString()), plan });

test("a metric that counts flagged items has a fix only when an open step names every item", () => {
  const items = { lines_over_pace: ["posthog//Synced rows", "geonode/residential-premium/Bandwidth"] };
  const live = (job: string) => job === "vercel spend cut" || job === "posthog synced rows";
  // d17 on 11-26: p46 was the first open step linked to the metric, so it read as the owner of both over lines.
  const p46 = fixesOn(boardOf(step("p46", "vercel spend cut", { job: "vercel spend cut" })), "d17", ["lines_over_pace"], live, items);
  assert.deepEqual(p46.fixes, {}, "a step that names none of the lines owns none");
  assert.deepEqual(p46.owners, { lines_over_pace: [{ item: "posthog//Synced rows" }, { item: "geonode/residential-premium/Bandwidth" }] });
  const half = fixesOn(boardOf(step("p46", "vercel spend cut"), step("p56", "posthog synced rows", { job: "posthog synced rows" })), "d17", ["lines_over_pace"], live, items);
  assert.deepEqual(half.fixes, {}, "one line still has no owner");
  assert.deepEqual(half.owners.lines_over_pace, [{ item: "posthog//Synced rows", step: "p56" }, { item: "geonode/residential-premium/Bandwidth" }]);
  const all = fixesOn(boardOf(step("p46", "vercel spend cut"), step("p56", "posthog synced rows", { job: "posthog synced rows" }),
    step("p60", "geonode pace", { note: "geonode/residential-premium/Bandwidth" })), "d17", ["lines_over_pace"], live, items);
  assert.deepEqual(all.fixes, { lines_over_pace: { step: "p56", job: "posthog synced rows", live: true } });
  // A metric with no flagged items of its kind keeps the first open step linked to it.
  assert.deepEqual(fixesOn(boardOf(step("p46", "vercel spend cut", { job: "vercel spend cut" })), "d17", ["lines_over_pace"], live).fixes,
    { lines_over_pace: { step: "p46", job: "vercel spend cut", live: true } });
  assert.deepEqual(fixesOn(boardOf(step("p9", "done", { status: "done" })), "d17", ["lines_over_pace"], live, items).fixes, {});
});

test("a run records each counted item's owner, and its brief names the items no step owns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "duty-items-"));
  try {
    const duty = {
      id: "d17", name: "Vendor bills stay inside plan", ownerWords: "w", goal: "g", onMiss: "m", schedule: DAILY,
      metrics: [{ key: "lines_over_pace", label: "Lines over pace", op: "<=", target: 0, headline: true }],
      precheck: { command: ["node", "-e", `require("fs").writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({ n: 9, metrics: { lines_over_pace: 2 }, flagged: ${JSON.stringify([SYNCED, GEONODE])} }))`], cwd: dir, timeoutMs: 30_000 },
    } as unknown as Duty;
    const measured = (board: ChatBoard) => measure({ duty, chat: { id: "ag_devops-guy", name: "devops guy" }, dir, trigger: "schedule", previous: [], board, liveJob: () => true, boardApi: "http://x", now: T0 });
    const first = await measured(boardOf(step("p46", "vercel spend cut", { job: "vercel spend cut" })));
    assert.equal(first.record.fixes, undefined, "p46 is no fix of the two lines");
    assert.deepEqual(first.record.owners?.lines_over_pace?.map(owner => owner.step), [undefined, undefined]);
    assert.match(first.brief!, /lines_over_pace: missed 1 run in a row, and no open fix step names 2 of the 2 flagged items it counts: posthog\/\/Synced rows; geonode\/residential-premium\/Bandwidth\./);
    assert.match(first.brief!, /a step owns only the items its text or note names/);
    assert.deepEqual(first.items, { flagged: [SYNCED, GEONODE], missed: ["lines_over_pace"] });
    assert.ok(first.findingsFile?.endsWith(".findings.md"));
    const owned = await measured(boardOf(step("p56", "posthog synced rows and geonode residential premium bandwidth", { job: "pace fix" })));
    assert.deepEqual(owned.record.fixes, { lines_over_pace: { step: "p56", job: "pace fix", live: true } });
    assert.match(owned.brief!, /lines_over_pace: missed 1 run in a row, fix step p56 \(job pace fix, working\)\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the steer for new items names at most 3 of them, the newly missed metrics and the findings file", () => {
  const record = { ...run(T0 + 26.5 * HOUR, 3), metrics: { lines_over_pace: { value: 3, target: 0, op: "<=" as const, met: false }, reads_failing: { value: 2, target: 0, op: "<=" as const, met: false } } };
  const text = newItemsText({ duty: { name: "Vendor bills stay inside plan" }, record, findingsFile: "/x/d17.findings.md",
    fresh: { flagged: [EVENTS, CREDITS, SYNCED, GEONODE], missed: ["reads_failing"], keys: [] } });
  assert.match(text, /^The Vendor bills stay inside plan run of 08:40 KST measured while you work: lines_over_pace 3\. It found 4 flagged items and 1 missed metric that your brief and the runs since did not give you\./);
  assert.match(text, /Newly missed: reads_failing 2 \(target at most 0\)\./);
  assert.match(text, /- posthog\/\/Events: 366 GB/);
  assert.match(text, /- and 1 more, all listed in \/x\/d17\.findings\.md/);
});

/**
 * d17's 8 stored runs of 11-25 21:10Z to 11-28 06:17Z, as the old code ran them: one job, 7 runs that started none. The times, the missed
 * number, each run's over lines and whether the job waited for a model account are from ~/.pi/agent/chat/agents/ag_devops-guy/duties.json
 * and its d17-*.json files (~/work/duty-beside-job/d17-replay.md runs the same over the files themselves).
 */
test("d17's stored runs: the fourth run replaces the job, and the lines the old runs kept reach a job", async () => {
  const stored: { h: number; over: FlaggedSlice[]; waits: boolean }[] = [
    { h: 0, over: [SYNCED, GEONODE], waits: false },
    { h: 2.5, over: [SYNCED, GEONODE], waits: false },
    { h: 5.7, over: [SYNCED, GEONODE], waits: false },
    { h: 26.5, over: [SYNCED, GEONODE, EVENTS], waits: false },
    { h: 42.2, over: [SYNCED, GEONODE, EVENTS, CREDITS], waits: true },
    { h: 42.8, over: [SYNCED, GEONODE, EVENTS, CREDITS], waits: true },
    { h: 50.5, over: [SYNCED, GEONODE, EVENTS, { ...CREDITS, kind: "credits" }], waits: true },
    { h: 57.1, over: [SYNCED, GEONODE], waits: true },
  ];
  const runs: DutyRunRecord[] = [];
  const acts: string[] = [];
  let job = 0;
  for (const entry of stored) {
    const items = { flagged: entry.over, missed: ["lines_over_pace"] };
    const record = run(T0 + entry.h * HOUR, entry.over.filter(slice => slice.kind === "line_over_pace").length);
    const jobRuns = runs.filter(earlier => earlier.job?.id === `job-${job}`);
    const fresh = unseen(items, await givenTo(jobRuns, async () => []));
    const act = jobRuns.length ? beside({ now: record.at, schedule: DAILY, jobRuns, record, due: true, waitsForAccount: entry.waits, fresh: fresh.keys.length }) : { do: "start" as const };
    if (act.do === "start" || act.do === "replace") job += 1;
    runs.push({ ...record, job: { id: `job-${job}`, name: "Vendor bills duty" }, given: act.do === "start" || act.do === "replace" ? runKeys(items) : act.do === "steer" ? fresh.keys : [] });
    acts.push(act.do === "steer" ? `steer ${fresh.flagged.map(slice => slice.item).join(", ")}` : act.do);
  }
  assert.deepEqual(acts, ["start", "leave", "leave", "replace", "steer openai/sieunpark77@gmail.com/credits", "leave", "steer openai/sieunpark77@gmail.com/credits", "leave"]);
  assert.ok(runs[3]!.given!.includes(itemKey(EVENTS)), "the job that replaced the first one got PostHog Events in its brief");
});
