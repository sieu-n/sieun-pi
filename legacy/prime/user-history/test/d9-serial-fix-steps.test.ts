// Guards d9's ask about a duty whose fix steps were replaced one after another while its number never moved. CI and RepoOps' d4 alerts_firing
// missed 36 runs over 93 h from 11-05 23:30Z to 11-09 20:39Z under about 10 fix steps (p645 to p725). Each new step started its own count, so
// fix_not_moving read 0 the whole time and no run asked for the cause the steps shared. The ask judges elapsed time, since ops d2 runs every
// 15.5 min and a first rule of 12 runs asked about its 13 runs, 3.4 h on one disk fault whose fix p802 was moving (11-09 20:56Z).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixNotMoving, pushList, pushRecords, SERIAL_MS, serialAsked, serialKey, type RedDuty } from "../scripts/duties/chat-system.ts";
import type { DutyRunRecord, FixLink } from "../src/shared/chat-duties.ts";
import { fixStepStreak, metricStreaks } from "../src/shared/duty-streak.ts";

const HOUR = 3_600_000;
const START = Date.parse("2026-11-05T23:30:00Z");
/** CI d4's runs came about every 2.65 h: 36 over 93 h. */
const EVERY = 93 * HOUR / 35;
/** One CI d4 run: alerts_firing as read, under the fix step of its time. */
const run = (index: number, value: number, step: string, every = EVERY, key = "alerts_firing", id = "d4"): DutyRunRecord => ({ duty: id, at: START + index * every,
  trigger: "schedule", ms: 1, verdict: "missed", summary: "", fixes: { [key]: { step, job: `job ${step}`, live: true } satisfies FixLink },
  metrics: { [key]: { value, target: 0, op: "<=", met: false } } });

/** 36 runs newest first: 4 alerts, with a new fix step every 4 runs, the newest p725 named by the last run alone. */
const runs: DutyRunRecord[] = Array.from({ length: 36 }, (_, i) => {
  const index = 35 - i;
  const step = index === 35 ? "p725" : `p${645 + Math.floor(index / 4) * 8}`;
  return run(index, 4, step);
});

const duty = (history: readonly DutyRunRecord[], step: string): RedDuty => {
  const metric = { ...metricStreaks(history)[0]!, fix: { step, job: `job ${step}`, live: true } };
  return { chat: "ci", duty: history[0]!.duty, name: "CI monitoring", green: false, misses: metric.misses, stuck: false, metric, fix: step,
    underFix: fixStepStreak(history, metric.key, step) };
};
/** The time of the newest run, when d9 reads the streak. */
const NOW = runs[0]!.at;

test("CI d4's 36 runs with no move across its fix steps get one ask for a shared root cause, though p725 began one run ago", () => {
  const red = duty(runs, "p725");
  assert.equal(red.underFix!.misses, 1, "the newest step has one run, so the per-step rule alone says nothing");
  assert.ok(NOW - red.metric!.since >= SERIAL_MS);
  const lines = fixNotMoving([red], () => "CI and RepoOps", new Set(), NOW);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.serial, serialKey("d4", "p725"));
  assert.match(lines[0]!.line, /missed alerts_firing 36 runs in a row over 93 h with no move across all its fix steps/);
  assert.match(lines[0]!.line, /one root-cause job \(rlm\.spawn, not a new thread\)/);
});

test("the ask goes out once per fix step: the push records it, and the next run that reads that record asks no more", () => {
  const red = duty(runs, "p725");
  const lines = fixNotMoving([red], () => "CI and RepoOps", new Set(), NOW);
  const records = pushRecords(pushList({ idleGoals: [], stuckDuties: [], upkeep: [], notMoving: lines }), "[d9 push]", START);
  assert.ok(records[0]!.items.includes(serialKey("d4", "p725")));
  const log = records.map(line => JSON.stringify(line)).join("\n");
  assert.deepEqual(fixNotMoving([red], () => "CI and RepoOps", serialAsked(log), NOW), []);
});

test("ops d2's 13 runs at 15.5 min, 3.4 h on one fault, get no serial ask, and the same 13 runs over a day and more do", () => {
  const every = 15.5 * 60_000;
  const ops = Array.from({ length: 13 }, (_, i) => run(12 - i, 1, i < 2 ? "p802" : "p799", every, "risks_firing", "d2"));
  const red = duty(ops, "p802");
  assert.equal(red.metric!.misses, 13);
  assert.equal(red.underFix!.misses, 2);
  assert.deepEqual(fixNotMoving([red], () => "ops guy", new Set(), ops[0]!.at), []);
  const slow = Array.from({ length: 13 }, (_, i) => run(12 - i, 1, i < 2 ? "p802" : "p799", 2.5 * HOUR, "risks_firing", "d2"));
  assert.equal(fixNotMoving([duty(slow, "p802")], () => "ops guy", new Set(), slow[0]!.at).length, 1);
});

test("a streak under a day, or one whose number moved, gets no serial ask", () => {
  const young = runs.filter(record => NOW - record.at < SERIAL_MS);
  assert.deepEqual(fixNotMoving([duty(young, "p725")], () => "CI", new Set(), NOW), []);
  const moved = runs.map((record, i) => i === 0 ? { ...record, metrics: { alerts_firing: { ...record.metrics.alerts_firing!, value: 2 } } } : record);
  assert.deepEqual(fixNotMoving([duty(moved, "p725")], () => "CI", new Set(), NOW), []);
});
