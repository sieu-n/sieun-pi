import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HISTORY_HOURS, hourOf, turnHistory } from "../src/turn-history.ts";

const dir = mkdtempSync(join(tmpdir(), "turn-history-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const line = (ts: string, event: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ ts, event, session: "s", ...extra }) + "\n";
const at = (ts: string): number => new Date(ts).getTime();

test("pi-pool.log becomes turns finished and the median queued wait per local hour, with empty hours as zero", async () => {
  const log = join(dir, "a.log");
  writeFileSync(log, [
    line("2026-10-15T09:59:59", "turn_released", { kind: "slot", held_s: 3 }),
    line("2026-10-15T10:00:01", "turn_admitted", { kind: "slot", waited_s: 10 }),
    line("2026-10-15T10:10:00", "turn_admitted", { kind: "borrow", waited_s: 30 }),
    line("2026-10-15T10:20:00", "turn_admitted", { kind: "owner", waited_s: 0 }),
    line("2026-10-15T10:30:00", "turn_admitted", { kind: "prod", waited_s: 0 }),
    line("2026-10-15T10:40:00", "turn_released", { kind: "slot", held_s: 9 }),
    line("2026-10-15T10:41:00", "turn_queued", { class: "low" }),
    line("2026-10-15T12:05:00", "turn_admitted", { kind: "ahead", waited_s: 7 }),
    "not json\n",
  ].join(""));
  const read = turnHistory(log);
  const hours = await read(at("2026-10-15T12:30:00"));
  assert.deepEqual(hours, [
    { at: at("2026-10-15T09:00:00"), finished: 1, medianWaitS: null },
    { at: at("2026-10-15T10:00:00"), finished: 1, medianWaitS: 20 },
    { at: at("2026-10-15T11:00:00"), finished: 0, medianWaitS: null },
    { at: at("2026-10-15T12:00:00"), finished: 0, medianWaitS: 7 },
  ]);
  appendFileSync(log, line("2026-10-15T12:06:00", "turn_released", { kind: "ahead" }) + line("2026-10-15T12:07:00", "turn_admitted", { kind: "slot", waited_s: 9 }));
  const later = await read(at("2026-10-15T12:30:00"));
  assert.deepEqual(later.at(-1), { at: at("2026-10-15T12:00:00"), finished: 1, medianWaitS: 8 }, "a later read adds only the new lines");
});

test("the chart keeps the last 7 days, and a missing log reads as no history", async () => {
  const log = join(dir, "b.log");
  writeFileSync(log, line("2026-10-01T10:00:00", "turn_released") + line("2026-10-13T08:59:59", "turn_released") + line("2026-10-13T09:30:00", "turn_released") + line("2026-10-15T08:00:00", "turn_released"));
  const hours = await turnHistory(log)(at("2026-10-20T08:30:00"));
  assert.equal(hours.length, HISTORY_HOURS);
  assert.equal(hours[0]!.at, at("2026-10-13T09:00:00"));
  assert.equal(hours.reduce((sum, hour) => sum + hour.finished, 0), 2, "10-01 and 10-13 08:59 are older than the chart");
  assert.deepEqual(await turnHistory(join(dir, "missing.log"))(), []);
  assert.equal(hourOf("2026-10-15T10:59:59"), at("2026-10-15T10:00:00"));
  assert.equal(hourOf("10-15 10:59"), null);
});
