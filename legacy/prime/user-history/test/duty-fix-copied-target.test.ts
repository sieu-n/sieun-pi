// Guards d9's fix_not_moving on 11-03: AI harness p1385 kept the clean_min_30 target the chat copied from the 09:13Z d7 run (26), while d7 read
// 29, 28, 28 and 29 under p1385, and d9's 10:58Z run asked to replace p1385 as "read 26 against 30, no closer than its 26".
import assert from "node:assert/strict";
import { test } from "node:test";
import { judge, type DutyMetric, type DutyRunRecord, type FixLink } from "../src/shared/chat-duties.ts";
import { fixStepStreak } from "../src/shared/duty-streak.ts";

const metrics: DutyMetric[] = [{ key: "clean_min_30", label: "Clean minutes of the last 30", op: ">=", target: 30, headline: true }];
const copiedAt = "2026-11-03T09:13:32.875Z";
const run = (at: string, clean: number, target?: FixLink["target"]): DutyRunRecord => ({ duty: "d7", at: Date.parse(at), trigger: "schedule", ms: 1,
  ...judge(metrics, { metrics: { clean_min_30: clean } }),
  fixes: { clean_min_30: { step: "p1385", job: "d7 chat cpu vs ci root cause", live: true, ...target ? { target } : {} } } });
const copy = { current: 26, target: 30, direction: "up" as const, measuredAt: copiedAt };
/** d7's runs under p1385 on 11-03, newest first, each carrying the board target the chat copied from the first of them. */
const d7 = (values: readonly number[] = [29, 28, 28, 29]): DutyRunRecord[] => [
  run("2026-11-03T11:00:49.812Z", values[0]!, copy), run("2026-11-03T10:30:43.029Z", values[1]!, copy),
  run("2026-11-03T10:14:05.148Z", values[2]!, copy), run("2026-11-03T09:43:35.046Z", values[3]!, copy), run(copiedAt, 26)];

test("a step target copied from one of the duty's runs is judged on each run's own reading", () => {
  assert.deepEqual(fixStepStreak(d7(), "clean_min_30", "p1385"),
    { misses: 5, moved: true, worked: { item: "p1385", from: 26, to: 29, target: 30 } });
});

test("a copied target whose metric stays put still reads as not moving", () => {
  assert.equal(fixStepStreak(d7([26, 26, 26, 26]), "clean_min_30", "p1385").moved, false);
});

test("a step target measured apart from the duty's runs still judges the fix", () => {
  const own = { current: 26, target: 30, direction: "up" as const, measuredAt: "2026-11-03T09:20:00.000Z" };
  const runs = d7().map(entry => ({ ...entry, fixes: { clean_min_30: { ...entry.fixes!.clean_min_30!, target: own } } }));
  assert.deepEqual(fixStepStreak(runs, "clean_min_30", "p1385"), { misses: 5, moved: false, worked: { item: "p1385", from: 26, to: 26, target: 30 } });
});
