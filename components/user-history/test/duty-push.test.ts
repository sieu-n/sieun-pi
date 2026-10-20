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

test("a met run with every part on target, or a part of no counted metric, gets no push", () => {
  assert.equal(pushMisses([run(NOW - 20 * MIN, "met", { wiki_problems: 0, open_mistakes: 0 }, { wiki_problems_following: 0 })], COUNTED, EVERY, NOW), null);
  assert.equal(pushMisses([run(NOW - 20 * MIN, "met", { wiki_problems: 0, open_mistakes: 0 }, { lint_over_glide_x: 3 })], COUNTED, EVERY, NOW), null);
});

test("a missed run still pushes on its counted misses, and no run gets a push before the check-in interval", () => {
  assert.deepEqual(pushMisses([run(NOW - 20 * MIN, "missed", { wiki_problems: 2, open_mistakes: 0 }, { wiki_problems_following: 1 })], COUNTED, EVERY, NOW), ["wiki_problems"]);
  assert.equal(pushMisses([run(NOW - 5 * MIN, "met", { wiki_problems: 0, open_mistakes: 0 }, { wiki_problems_following: 4 })], COUNTED, EVERY, NOW), null);
});

test("the after-job measure judges the push: its parts replace the run's own", () => {
  const ran = run(NOW - 40 * MIN, "met", { wiki_problems: 0, open_mistakes: 0 }, { wiki_problems_following: 4 });
  const after = { at: NOW - 20 * MIN, verdict: "met" as const, summary: "", metrics: ran.metrics, parts: { wiki_problems_following: result(0) } };
  assert.equal(pushMisses([{ ...ran, after }], COUNTED, EVERY, NOW), null);
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
