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
  const lines = fixNotMoving([red], () => "CI and RepoOps", new Map(), NOW);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.serial, serialKey("d4", "p725"));
  assert.match(lines[0]!.line, /missed alerts_firing 36 runs in a row over 93 h with no move across all its fix steps/);
  assert.match(lines[0]!.line, /one root-cause job \(rlm\.spawn, not a new thread\)/);
});

test("the ask goes out once per streak: the push records it, and the next run that reads that record asks no more", () => {
  const red = duty(runs, "p725");
  const lines = fixNotMoving([red], () => "CI and RepoOps", new Map(), NOW);
  const records = pushRecords(pushList({ idleGoals: [], stuckDuties: [], upkeep: [], notMoving: lines }), "[d9 push]", NOW);
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
  assert.deepEqual(fixNotMoving([red], () => "ops guy", new Map(), ops[0]!.at), []);
  const slow = Array.from({ length: 13 }, (_, i) => run(12 - i, 1, i < 2 ? "p802" : "p799", 2.5 * HOUR, "risks_firing", "d2"));
  assert.equal(fixNotMoving([duty(slow, "p802")], () => "ops guy", new Map(), slow[0]!.at).length, 1);
});

test("a streak under a day, or one whose number moved, gets no serial ask", () => {
  const young = runs.filter(record => NOW - record.at < SERIAL_MS);
  assert.deepEqual(fixNotMoving([duty(young, "p725")], () => "CI", new Map(), NOW), []);
  const moved = runs.map((record, i) => i === 0 ? { ...record, metrics: { alerts_firing: { ...record.metrics.alerts_firing!, value: 2 } } } : record);
  assert.deepEqual(fixNotMoving([duty(moved, "p725")], () => "CI", new Map(), NOW), []);
});

test("metal d3's root-cause step p269, made after d9's 21:18Z ask, gets no new serial ask; it is judged on its own runs", () => {
  // 11-09: d3 profiles_p95_s read 0.9 against <= 0.4 for 14 runs over 216 h across p251, p258, p259 and p267. d9 asked at 21:18Z, metal-management
  // made p269 to fold them in, and the 21:23Z run asked again to replace p269 because it "began 0 runs ago".
  const metal = "01a14d31-6ec0-7005-bbe8-c38b7ae73cfb";
  const asked = Date.parse("2026-11-09T21:18:00Z");
  const first = asked - 216 * HOUR;
  const read = (at: number, step: string): DutyRunRecord => ({ duty: "d3", at, trigger: "schedule", ms: 1, verdict: "missed", summary: "",
    fixes: { profiles_p95_s: { step, job: `job ${step}`, live: true } satisfies FixLink }, metrics: { profiles_p95_s: { value: 0.9, target: 0.4, op: "<=", met: false } } });
  const older = ["p251", "p258", "p259", "p267"];
  const before = Array.from({ length: 13 }, (_, i) => read(first + i * 216 * HOUR / 12, older[Math.min(3, Math.floor(i / 4))]!)).reverse();
  const d3 = (history: readonly DutyRunRecord[], step: string): RedDuty => {
    const metric = { ...metricStreaks(history)[0]!, fix: { step, job: `job ${step}`, live: true } };
    return { chat: metal, duty: "d3", name: "Prod box speed", green: false, misses: metric.misses, stuck: false, metric, fix: step,
      underFix: fixStepStreak(history, "profiles_p95_s", step) };
  };
  const ask = fixNotMoving([d3(before, "p267")], () => "metal-management", new Map(), asked);
  assert.equal(ask.length, 1, "the 21:18Z run asks once");
  const log = pushRecords(pushList({ idleGoals: [], stuckDuties: [], upkeep: [], notMoving: ask }), "[d9 push 2026-11-09T21:18Z]", asked)
    .map(line => JSON.stringify(line)).join("\n");
  const at2123 = Date.parse("2026-11-09T21:23:00Z");
  const after = [read(at2123, "p269"), ...before];
  assert.deepEqual(fixNotMoving([d3(after, "p269")], () => "metal-management", serialAsked(log), at2123), [], "p269 answers the ask, so 21:23Z asks nothing");
  assert.equal(fixNotMoving([{ ...d3(after, "p269"), chat: "another chat" }], () => "x", serialAsked(log), at2123).length, 1, "another chat's d3 is its own duty");
  const p269 = [read(at2123 + 3 * HOUR, "p269"), read(at2123 + 2 * HOUR, "p269"), read(at2123 + HOUR, "p269"), ...after];
  const judged = fixNotMoving([d3(p269, "p269")], () => "metal-management", serialAsked(log), at2123 + 3 * HOUR);
  assert.equal(judged.length, 1, "after its own fair streak p269 is judged by the per-step rule");
  assert.equal(judged[0]!.serial, undefined);
  assert.match(judged[0]!.line, /under its fix step p269/);
});
