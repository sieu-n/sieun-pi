// vent 10-18: p1 (cadence daily) read 6% at 16:15Z, up from 3%, and the 16:25Z check-in read it on pace. The 16:40Z check-in read the same
// 16:15Z reading and flagged "no move toward target in the last check-in", though nobody had measured it again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { goalTrend, offPace } from "../src/checkin-goals.ts";

const h = 3_600_000;
const t0 = Date.parse("2026-10-18T07:24:00Z");
const number = (value: number, at: number) => ({ metric: "share", target: 100, unit: "%", op: ">=" as const, value, measuredAt: at, source: "vent_share.py", staleMs: 24 * h });

test("the same reading as last run keeps its moving trend and stays on pace", () => {
  const first = goalTrend(number(6, t0 + 9 * h), { readings: [{ value: 0, at: t0 }, { value: 3, at: t0 + 5 * h }], still: 0 });
  assert.equal(first.trend.kind, "moving");
  const again = goalTrend(number(6, t0 + 9 * h), first.memo);
  assert.equal(again.trend.kind, "moving");
  assert.equal(again.memo?.still, 0);
  assert.equal(again.memo?.readings.length, 3);
  assert.equal(offPace(again.trend, false), false);
});

test("a new reading with no move still counts as still, and so does a repeat of it", () => {
  const memo = { readings: [{ value: 3, at: t0 }], still: 0 };
  const flat = goalTrend(number(3, t0 + h), memo);
  assert.deepEqual(flat.trend, { kind: "still", runs: 1 });
  const repeat = goalTrend(number(3, t0 + h), flat.memo);
  assert.deepEqual(repeat.trend, { kind: "still", runs: 1 });
  assert.equal(offPace(repeat.trend, false), true);
});
