// Guards the push of a met run with a part off target. On 10-20 cited code changed under 20 wiki pages in the 15 min after 48 were
// rewritten, so the Wiki dream counts a page only after the follow window and records newer ones as wiki_problems_following; a part the
// verdict leaves out would otherwise never start the push run that rewrites those pages.
import assert from "node:assert/strict";
import { test } from "node:test";
import { closedUntil, PART_READ_MS, pushMisses } from "../src/duty-push.ts";
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
  assert.equal(first, at("12:31:00"), "PART_READ_MS after 11:51Z had passed, so the first minute after the after-job measure gets it");
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

// From 10-27 to 10-29 the d4 run after a met run came at p50 60.3 min on the hourly check-in interval, past the 70 min follow window less a
// 52.7 min rewrite, so pages that fell behind between reads counted at the next one: the 16:50Z verify of 10-29 read 1 and the next read 57.
test("a met run with parts is read again after PART_READ_MS when the check-in interval is longer", () => {
  const hourly = 60 * MIN;
  const met = (age: number, following: number) => [run(NOW - age, "met", { wiki_problems: 0, open_mistakes: 0 }, { wiki_problems_following: following })];
  assert.equal(PART_READ_MS, 15 * MIN);
  assert.deepEqual(pushMisses(met(PART_READ_MS, 0), COUNTED, hourly, NOW), [], "every part on target, read again after 15 min");
  assert.deepEqual(pushMisses(met(PART_READ_MS, 3), COUNTED, hourly, NOW), ["wiki_problems_following"]);
  assert.equal(pushMisses(met(PART_READ_MS - MIN, 3), COUNTED, hourly, NOW), null, "not before 15 min");
  assert.deepEqual(pushMisses(met(10 * MIN, 0), COUNTED, 10 * MIN, NOW), [], "a shorter check-in interval still wins");
  assert.equal(pushMisses([run(NOW - 30 * MIN, "met", { wiki_problems: 0, open_mistakes: 0 })], COUNTED, hourly, NOW), null, "no parts: the interval holds");
});

// api portal vp's d4 runs of 11-02, newest first, with the 11-02 precheck's rollsAt added: slow_route_p90_s reads the last full UTC day, 8.97 s
// on 11-01, so no run before 00:00Z on 11-03 can read another number. The old rule pushed at 21:42:41Z and 21:58:24Z, each push with a job, and
// the 22:08:56Z verify run of p111 started a fourth job on the same day.
test("a miss on a closed window gets no push until the window rolls over, then one push", () => {
  const at = (time: string) => Date.parse(`2026-11-0${time}Z`);
  const rollsAt = at("3T00:00:00");
  const day = (value: number, rolls = rollsAt): Record<string, MetricResult> => ({
    customer_5xx_share_pct: { value: 0.32, target: 1, op: "<=", met: true, rollsAt: rolls },
    slow_route_p90_s: { value, target: 5, op: "<=", met: value <= 5, rollsAt: rolls }, source_errors: result(0) });
  const counted = new Set(["customer_5xx_share_pct", "slow_route_p90_s", "source_errors"]);
  const red = (time: string, trigger: DutyRunRecord["trigger"], ended: string): DutyRunRecord => ({ duty: "d4", at: at(time), trigger, ms: 6000,
    verdict: "missed", summary: "", metrics: day(8.97), job: { id: time, name: time }, after: { at: at(ended), verdict: "missed", metrics: day(8.97), summary: "" } });
  const scheduled = red("2T21:33:09", "schedule", "2T21:42:10");
  const pushed = red("2T21:42:41", "push", "2T21:58:12");
  const verify: DutyRunRecord = { duty: "d4", at: at("2T18:35:47"), trigger: "verify", ms: 3800, verdict: "met", summary: "", metrics: { source_errors: result(0) } };
  assert.equal(pushMisses([scheduled, verify], counted, EVERY, at("2T21:42:41")), null, "no push when the schedule job ends");
  assert.equal(pushMisses([pushed, scheduled, verify], counted, EVERY, at("2T21:58:24")), null, "no push at the check-in interval");
  assert.equal(closedUntil([pushed, scheduled], ["slow_route_p90_s"], at("2T22:08:56")), rollsAt, "no verify run of p111 before the roll");
  assert.deepEqual(pushMisses([pushed, scheduled], counted, EVERY, rollsAt + 30_000), ["slow_route_p90_s"], "one push right after the roll");
  const next: DutyRunRecord = { duty: "d4", at: rollsAt + 40_000, trigger: "push", ms: 6000, verdict: "missed", summary: "", metrics: day(6.1, at("4T00:00:00")) };
  assert.equal(pushMisses([next, pushed, scheduled], counted, EVERY, rollsAt + 60 * MIN), null, "a run read the new day, so it waits for 11-04");
  const { after: _ended, ...unended } = scheduled;
  const live: DutyRunRecord = { ...unended, metrics: { ...scheduled.metrics, slow_route_p90_s: result(9) } };
  assert.deepEqual(pushMisses([live], counted, EVERY, at("2T21:58:24")), ["slow_route_p90_s"], "a miss with no closed window keeps its push");
});
