// Guards the push of a met run with a part off target. On 10-20 cited code changed under 20 wiki pages in the 15 min after 48 were
// rewritten, so the Wiki dream counts a page only after the follow window and records newer ones as wiki_problems_following; a part the
// verdict leaves out would otherwise never start the push run that rewrites those pages.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pushMisses } from "../src/duty-push.ts";
import type { DutyRunRecord, MetricResult } from "../src/shared/chat-duties.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-20T05:00:00Z");
const EVERY = 15 * MIN;
const COUNTED = new Set(["wiki_problems", "open_mistakes"]);
const result = (value: number): MetricResult => ({ value, target: 0, op: "<=", met: value <= 0 });
const run = (at: number, verdict: "met" | "missed", metrics: Record<string, number>, parts?: Record<string, number>): DutyRunRecord => ({
  duty: "d4", at, trigger: "push", ms: 1000, verdict, summary: "",
  metrics: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, result(value)])),
  ...parts ? { parts: Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, result(value)])) } : {},
});

test("a met run with a part of a counted metric off target gets a push for that part", () => {
  const runs = [run(NOW - 20 * MIN, "met", { wiki_problems: 0, open_mistakes: 0 }, { wiki_problems_following: 4 })];
  assert.deepEqual(pushMisses(runs, COUNTED, EVERY, NOW), ["wiki_problems_following"]);
});

test("a met run with every part on target gets a push with no keys to read the parts again, and one with no part of a counted metric gets none", () => {
  assert.deepEqual(pushMisses([run(NOW - 20 * MIN, "met", { wiki_problems: 0, open_mistakes: 0 }, { wiki_problems_following: 0 })], COUNTED, EVERY, NOW), []);
  assert.equal(pushMisses([run(NOW - 5 * MIN, "met", { wiki_problems: 0, open_mistakes: 0 }, { wiki_problems_following: 0 })], COUNTED, EVERY, NOW), null);
  assert.equal(pushMisses([run(NOW - 20 * MIN, "met", { wiki_problems: 0, open_mistakes: 0 }, { lint_over_glide_x: 3 })], COUNTED, EVERY, NOW), null);
  assert.equal(pushMisses([run(NOW - 24 * 60 * MIN, "met", { wiki_problems: 0, open_mistakes: 0 })], COUNTED, EVERY, NOW), null, "a met duty with no parts");
});

// The AI harness chat's d4 runs of 10-25 from 11:05Z on, as the runs file holds them, with the metrics that were on target left out. The
// 11:41Z verify run's job ended with an after-job measure at 12:30:29Z that read every metric and part on target, and the duty was not read
// again until its 16:30Z schedule run read wiki_problems 45 and wiki_problems_following 13.
test("the Wiki dream's runs of 10-25 get a push within one check-in interval of 11:51Z instead of waiting for the 16:30Z schedule run", () => {
  const counted = new Set(["wiki_problems", "open_mistakes", "mistakes_back", "dup_unjudged"]);
  const green = { wiki_problems: 0, open_mistakes: 0, mistakes_back: 0, dup_unjudged: 0 };
  const at = (time: string) => Date.parse(`2026-10-25T${time}Z`);
  const reading = (time: string, verdict: "met" | "missed", metrics: Record<string, number>, following: number) => {
    const { metrics: results, parts } = run(at(time), verdict, metrics, { wiki_problems_following: following });
    return { at: at(time), verdict, summary: "", metrics: results, parts: parts! };
  };
  const job = (id: string) => ({ id, name: `wiki dream AI harness developer environment ${id}` });
  const runs: DutyRunRecord[] = [
    { ...run(at("11:51:29.687"), "met", green, { wiki_problems_following: 17 }), trigger: "verify" },
    { ...run(at("11:41:00.554"), "met", green, { wiki_problems_following: 17 }), trigger: "verify", job: job("20:41"), after: reading("12:30:29.990", "met", green, 0) },
    { ...run(at("11:05:53.337"), "missed", { ...green, wiki_problems: 1 }, { wiki_problems_following: 13 }), job: job("10-25 20:05"), after: reading("11:28:15.163", "met", green, 2) },
  ];
  const everyMs = 60 * MIN;
  const first = [...Array(240).keys()].map(minute => at("12:31:00") + minute * MIN).find(now => pushMisses(runs, counted, everyMs, now) !== null);
  assert.equal(first, at("12:52:00"));
  assert.deepEqual(pushMisses(runs, counted, everyMs, first!), []);
  assert.ok(first! <= at("13:30:00"));
});

test("a missed run still pushes on its counted misses, and no run gets a push before the check-in interval", () => {
  assert.deepEqual(pushMisses([run(NOW - 20 * MIN, "missed", { wiki_problems: 2, open_mistakes: 0 }, { wiki_problems_following: 1 })], COUNTED, EVERY, NOW), ["wiki_problems"]);
  assert.equal(pushMisses([run(NOW - 5 * MIN, "met", { wiki_problems: 0, open_mistakes: 0 }, { wiki_problems_following: 4 })], COUNTED, EVERY, NOW), null);
});

test("the after-job measure judges the push: its parts replace the run's own", () => {
  const ran = run(NOW - 40 * MIN, "met", { wiki_problems: 0, open_mistakes: 0 }, { wiki_problems_following: 4 });
  const after = { at: NOW - 20 * MIN, verdict: "met" as const, summary: "", metrics: ran.metrics, parts: { wiki_problems_following: result(0) } };
  assert.deepEqual(pushMisses([{ ...ran, after }], COUNTED, EVERY, NOW), []);
});

test("an older run's after-job measure that is newer than a later run's reading judges the push", () => {
  const job = run(NOW - 300 * MIN, "missed", { wiki_problems: 4, open_mistakes: 0 });
  const after = { at: NOW - 140 * MIN, verdict: "missed" as const, summary: "", metrics: { wiki_problems: result(43), open_mistakes: result(0) } };
  const skipped = run(NOW - 230 * MIN, "met", { wiki_problems: 0, open_mistakes: 0 });
  assert.deepEqual(pushMisses([skipped, { ...job, after }], COUNTED, EVERY, NOW), ["wiki_problems"]);
  const green = { ...after, at: NOW - 250 * MIN, verdict: "met" as const, metrics: { wiki_problems: result(0), open_mistakes: result(0) } };
  const later = run(NOW - 230 * MIN, "missed", { wiki_problems: 5, open_mistakes: 0 });
  assert.deepEqual(pushMisses([later, { ...job, after: green }], COUNTED, EVERY, NOW), ["wiki_problems"]);
});

test("a duty whose non-push job ended red gets its push at once, once, and a quiet windowed count or a push job's end waits the interval (ops guy d1, 10-22)", () => {
  const job = { id: "01a160b8-dd9a-739a-9bf3-46c3a06aeb8b", name: "local dev servers ops guy (+observability) 10-22 08:08" };
  const after = { at: NOW - 3 * MIN, verdict: "missed" as const, summary: "", metrics: { wiki_problems: result(2), open_mistakes: result(0) } };
  const scheduled: DutyRunRecord = { ...run(NOW - 8 * 60 * MIN, "met", { wiki_problems: 0, open_mistakes: 0 }), trigger: "schedule", job, after };
  const raced: DutyRunRecord = { ...run(NOW - 2 * MIN, "missed", { wiki_problems: 2, open_mistakes: 0 }), summary: "skipped: previous run still working" };
  assert.deepEqual(pushMisses([raced, scheduled], COUNTED, 120 * MIN, NOW), ["wiki_problems"]);
  const pushed: DutyRunRecord = { ...raced, job: { id: "push-job", name: "push" } };
  assert.equal(pushMisses([pushed, scheduled], COUNTED, 120 * MIN, NOW), null, "a push job started since its end");
  assert.equal(pushMisses([{ ...scheduled, at: NOW - 30 * MIN, trigger: "push" }], COUNTED, 120 * MIN, NOW), null, "a push job that ended red waits the interval");
  const quietAfter = { ...after, metrics: { wiki_problems: { ...result(2), lastEventAt: NOW - 600 * MIN }, open_mistakes: result(0) } };
  const before: DutyRunRecord = { ...run(NOW - 9 * 60 * MIN, "missed", { wiki_problems: 2, open_mistakes: 0 }), trigger: "schedule" };
  assert.equal(pushMisses([{ ...raced, metrics: quietAfter.metrics }, { ...scheduled, after: quietAfter }, before], COUNTED, 120 * MIN, NOW), null, "a quiet windowed count owes no fix job");
});
