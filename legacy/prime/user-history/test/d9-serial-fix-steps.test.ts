// Guards d9's ask about a duty whose fix steps were replaced one after another while its number never moved. CI and RepoOps' d4 alerts_firing
// missed 36 runs from 11-05 23:30Z to 11-09 20:39Z under about 10 fix steps (p645 to p725). Each new step started its own count, so
// fix_not_moving read 0 the whole time and no run asked for the cause the steps shared.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixNotMoving, pushList, pushRecords, SERIAL_MISSES, serialAsked, serialKey, type RedDuty } from "../scripts/duties/chat-system.ts";
import type { DutyRunRecord, FixLink } from "../src/shared/chat-duties.ts";
import { fixStepStreak, metricStreaks } from "../src/shared/duty-streak.ts";

const HOUR = 3_600_000;
const START = Date.parse("2026-11-05T23:30:00Z");
/** One CI d4 run: alerts_firing as read, under the fix step of its time. */
const run = (index: number, value: number, step: string): DutyRunRecord => ({ duty: "d4", at: START + index * 2 * HOUR, trigger: "schedule", ms: 1,
  verdict: "missed", summary: "", fixes: { alerts_firing: { step, job: `job ${step}`, live: true } satisfies FixLink },
  metrics: { alerts_firing: { value, target: 0, op: "<=", met: false } } });

/** 36 runs newest first: 4 alerts, with a new fix step every 4 runs, the newest p725 named by the last run alone. */
const runs: DutyRunRecord[] = Array.from({ length: 36 }, (_, i) => {
  const index = 35 - i;
  const step = index === 35 ? "p725" : `p${645 + Math.floor(index / 4) * 8}`;
  return run(index, 4, step);
});

const duty = (history: readonly DutyRunRecord[], step: string): RedDuty => {
  const metric = { ...metricStreaks(history)[0]!, fix: { step, job: `job ${step}`, live: true } };
  return { chat: "ci", duty: "d4", name: "CI monitoring", green: false, misses: metric.misses, stuck: false, metric, fix: step,
    underFix: fixStepStreak(history, "alerts_firing", step) };
};

test("CI d4's 36 runs with no move across its fix steps get one ask for a shared root cause, though p725 began one run ago", () => {
  const red = duty(runs, "p725");
  assert.equal(red.underFix!.misses, 1, "the newest step has one run, so the per-step rule alone says nothing");
  assert.ok(red.metric!.misses >= SERIAL_MISSES);
  const lines = fixNotMoving([red], () => "CI and RepoOps");
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.serial, serialKey("d4", "p725"));
  assert.match(lines[0]!.line, /missed alerts_firing 36 runs in a row with no move across all its fix steps/);
  assert.match(lines[0]!.line, /one root-cause job \(rlm\.spawn, not a new thread\)/);
});

test("the ask goes out once per fix step: the push records it, and the next run that reads that record asks no more", () => {
  const red = duty(runs, "p725");
  const lines = fixNotMoving([red], () => "CI and RepoOps");
  const records = pushRecords(pushList({ idleGoals: [], stuckDuties: [], upkeep: [], notMoving: lines }), "[d9 push]", START);
  assert.ok(records[0]!.items.includes(serialKey("d4", "p725")));
  const log = records.map(line => JSON.stringify(line)).join("\n");
  assert.deepEqual(fixNotMoving([red], () => "CI and RepoOps", serialAsked(log)), []);
});

test("a streak under 12 runs, or one whose number moved, gets no serial ask", () => {
  assert.deepEqual(fixNotMoving([duty(runs.slice(0, SERIAL_MISSES - 1), "p725")], () => "CI"), []);
  const moved = runs.map((record, i) => i === 0 ? { ...record, metrics: { alerts_firing: { ...record.metrics.alerts_firing!, value: 2 } } } : record);
  assert.deepEqual(fixNotMoving([duty(moved, "p725")], () => "CI"), []);
});
