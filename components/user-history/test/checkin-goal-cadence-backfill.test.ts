// spec and monitoring system 10-20: p12 "Test and CI numbers show in the daily report every day" (days of the last 7, target 7, cadence daily) read
// 1 at 15:15Z and 3 at 16:19Z on 10-19 after a one-time backfill of 10-16. The check-ins at 12:26, 16:52 and 18:52 KST on 10-20 read "about 2 h
// to target at this rate", while the number gains at most one a day and reaches 7 on 10-25 KST, when the backfilled 10-16 leaves the window.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type GoalMemo, type GoalNumber, goalTrend, offPace, trendText } from "../src/checkin-goals.ts";

const DAY = 24 * 3_600_000;
const days = (dates: readonly string[]): string => dates.map(date => date === "10-16" ? "10-16 (backfilled)" : date).join(", ");
const number = (value: number, at: string, source: string): GoalNumber => ({ metric: "Days of the last 7 with test and CI numbers in the daily report", target: 7,
  unit: "days", op: ">=", value, measuredAt: Date.parse(at), source, staleMs: DAY, cadence: "daily", ...(/backfill/i.test(source) ? { backfill: true as const } : {}) });
const legacy: GoalMemo = { readings: [{ value: 1, at: Date.parse("2026-10-19T15:15:00Z") }, { value: 3, at: Date.parse("2026-10-19T16:19:01Z") }], still: 0 };

test("the memo the check-ins kept on 10-20 reads a backfill step with no rate, not 2 h to target", () => {
  const read = number(3, "2026-10-19T16:19:01Z", `KST 10-14 to 10-20; ${days(["10-16", "10-19", "10-20"])}`);
  const { trend, memo } = goalTrend(read, structuredClone(legacy));
  assert.deepEqual(trend, { kind: "stepped", delta: 2, since: legacy.readings[0]!.at });
  assert.equal(trendText(read, trend, false), "+2 days since 10-19 15:15Z in a backfill, no rate yet");
  assert.equal(offPace(trend, false), true);
  assert.equal(memo?.readings.at(-1)?.backfill, true);
  assert.equal(goalTrend(read, memo).trend.kind, "stepped");
});

test("each daily run after the backfill gains one a day, and the pace reads about 10-25 once the backfilled day leaves the window", () => {
  let memo: GoalMemo | undefined = structuredClone(legacy);
  const filled = ["10-16", "10-19", "10-20"];
  const lines: string[] = [];
  for (const [index, kst] of ["10-20", "10-21", "10-22", "10-23", "10-24", "10-25"].entries()) {
    if (index) filled.push(kst);
    const window = new Set(Array.from({ length: 7 }, (_, back) => new Date(Date.parse(`2026-${kst}T00:00:00Z`) - back * DAY).toISOString().slice(5, 10)));
    const counted = filled.filter(date => window.has(date));
    const read = number(counted.length, new Date(Date.parse("2026-10-19T16:19:01Z") + index * DAY).toISOString(), days(counted));
    const step = goalTrend(read, memo);
    memo = step.memo;
    lines.push(`${kst} ${counted.length}: ${step.trend.kind === "met" ? "at target" : trendText(read, step.trend, false)}`);
  }
  assert.deepEqual(lines, [
    "10-20 3: +2 days since 10-19 15:15Z in a backfill, no rate yet",
    "10-21 4: +3 days since 10-19 15:15Z, about 3 days to target at this rate, about 10-23",
    "10-22 5: +4 days since 10-19 15:15Z, about 2 days to target at this rate, about 10-23",
    "10-23 5: no move toward target in the last check-in",
    "10-24 6: +5 days since 10-19 15:15Z, about 2 days to target at this rate, about 10-25",
    "10-25 7: at target",
  ]);
});

test("a daily number that moves within a day keeps its rate, in whole days", () => {
  const at = (hour: number) => Date.parse("2026-10-20T03:00:00Z") + hour * 3_600_000;
  const memo: GoalMemo = { readings: [{ value: 1_826_417, at: at(0) }], still: 0 };
  const read: GoalNumber = { metric: "Meta advertisers indexed", target: 3_000_000, unit: "", op: ">=", value: 1_960_477, measuredAt: at(7), source: "ClickHouse", staleMs: DAY, cadence: "daily" };
  const { trend } = goalTrend(read, memo);
  assert.equal(trend.kind, "moving");
  assert.ok(trend.kind === "moving" && trend.etaMs === 3 * DAY, JSON.stringify(trend));
});
