// pi-pool.log's `ts` is UTC since 10-27 (packages/pi-pool/pool/base.py `log`); until then it was the writer's local time, and the
// Agent queue chart read it as local time, which on the owner's Mac (KST) would put each UTC line 9 hours early.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addTurnLines, firstLineFrom, hourOf, turnHistory } from "../src/turn-history.ts";

const inZone = async (zone: string, run: () => Promise<void> | void): Promise<void> => {
  const was = process.env.TZ;
  process.env.TZ = zone;
  try { await run(); } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
};

test("hourOf reads ts as UTC on a KST clock", () => inZone("Asia/Seoul", () => {
  assert.equal(hourOf("2026-10-27T01:20:00"), Date.parse("2026-10-27T01:00:00Z"));
  assert.equal(hourOf("2026-10-27T01:20:00Z"), null, "pi-pool writes no offset");
}));

test("the chart's hours on a KST clock hold the UTC lines of their hour", () => inZone("Asia/Seoul", async () => {
  const dir = mkdtempSync(join(tmpdir(), "turn-history-"));
  try {
    const log = join(dir, "pi-pool.log");
    writeFileSync(log, [
      { ts: "2026-10-27T00:10:00", event: "turn_admitted", kind: "slot", waited_s: 30 },
      { ts: "2026-10-27T00:50:00", event: "turn_released" },
      { ts: "2026-10-27T01:05:00", event: "turn_admitted", kind: "slot", waited_s: 10 },
      { ts: "2026-10-27T01:06:00", event: "turn_released" },
      { ts: "2026-10-27T01:07:00", event: "turn_released" },
    ].map(line => JSON.stringify(line)).join("\n") + "\n");
    const hours = await turnHistory(log)(Date.parse("2026-10-27T01:30:00Z"));
    assert.deepEqual(hours, [
      { at: Date.parse("2026-10-27T00:00:00Z"), finished: 1, medianWaitS: 30 },
      { at: Date.parse("2026-10-27T01:00:00Z"), finished: 2, medianWaitS: 10 },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));

// At 16:29:58Z on 11-19 the successor of release-e5c7eae took the port and 2 s later read all 787 MB of pi-pool.log for the Agent queue
// chart: 16.2 s of its main thread over 78 s, splitting every line to a string, and the garbage behind most of 4.7 s of GC in the next 20 s,
// where api/accounts took 2.6 s and d7 counted 16:30Z dirty. A first read now starts at the chart's first hour and decodes only turn lines.
const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-19T16:30:00Z");
const stamp = (at: number): string => new Date(at).toISOString().slice(0, 19);
/** Ten days of pi-pool.log, a released turn and an account line each minute, with the offset of each line. */
function tenDays(dir: string): { log: string; lines: { at: number; offset: number }[] } {
  const lines: { at: number; offset: number }[] = [];
  let text = "", offset = 0;
  for (let at = NOW - 240 * HOUR; at < NOW; at += 60_000) {
    for (const entry of [{ ts: stamp(at), event: "turn_released", session: "s", kind: "slot", held_s: 3 }, { ts: stamp(at), event: "account_read", account: "a" }]) {
      const line = JSON.stringify(entry) + "\n";
      lines.push({ at, offset });
      text += line;
      offset += Buffer.byteLength(line);
    }
  }
  const log = join(dir, "pi-pool.log");
  writeFileSync(log, text);
  return { log, lines };
}

test("a first read starts near the chart's first hour and skips no line the chart keeps", async t => {
  const dir = mkdtempSync(join(tmpdir(), "turn-history-floor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { log, lines } = tenDays(dir);
  const floor = hourOf(stamp(NOW))! - 168 * HOUR;
  const file = await open(log, "r");
  try {
    const size = (await file.stat()).size;
    const from = await firstLineFrom(file, size, floor);
    const first = lines.find(line => line.at >= floor)!;
    assert.ok(from <= first.offset, "no line of the chart's hours lies before the start");
    assert.ok(first.offset - from <= 1 << 16, `the start is within one probe of the chart's first line, not ${first.offset - from} bytes before it`);
    assert.ok(lines.some(line => line.offset === from), "the start is a line start");
  } finally { await file.close(); }
  const hours = await turnHistory(log)(NOW);
  assert.equal(hours.length, 168);
  assert.deepEqual(hours.map(hour => hour.finished), [...Array(167).fill(60), 30], "each hour holds its turns, the one now is in half of them");
});

test("a probe on a line with no stamp moves the start earlier, so no kept line is skipped", async t => {
  const dir = mkdtempSync(join(tmpdir(), "turn-history-junk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "pi-pool.log");
  writeFileSync(log, "not json\n".repeat(20_000) + JSON.stringify({ ts: stamp(NOW - HOUR), event: "turn_released" }) + "\n");
  const file = await open(log, "r");
  try { assert.equal(await firstLineFrom(file, (await file.stat()).size, NOW - 168 * HOUR), 0); } finally { await file.close(); }
  assert.equal((await turnHistory(log)(NOW)).find(hour => hour.at === NOW - HOUR - 30 * 60_000)?.finished, 1);
});

test("addTurnLines decodes only turn lines, the last one with no newline too", () => {
  const buckets = new Map<number, { finished: number; waits: number[] }>();
  const text = [
    { ts: "2026-11-19T16:01:00", event: "account_read", note: "turn_released in a note is not a turn" },
    { ts: "2026-11-19T16:02:00", event: "turn_admitted", kind: "slot", waited_s: 4 },
    { ts: "2026-11-19T16:03:00", event: "turn_released" },
    { ts: "2026-11-19T16:04:00", event: "turn_admitted", kind: "owner", waited_s: 0 },
    { ts: "2026-11-19T16:05:00", event: "turn_released", note: "é" },
  ].map(entry => JSON.stringify(entry)).join("\n");
  addTurnLines(buckets, Buffer.from(text));
  assert.deepEqual([...buckets], [[Date.parse("2026-11-19T16:00:00Z"), { finished: 2, waits: [4] }]]);
});
