import assert from "node:assert/strict";
import { test } from "node:test";
import { barAt, bucketsFor, cost, defaultBucket, ingestLine, layout, modelLabel, niceMax, sparkPath, tokens, tps } from "../src/client/usage.ts";
import type { UsageIngest, UsageSeries } from "../src/shared/usage.ts";

const NOW = 1_791_300_000_000;
const t = (input: number, output = 0, cacheRead = 0) => ({ input, output, cacheRead, cacheWrite: 0, reasoning: 0, total: input + output + cacheRead });

test("usage formats: tokens, cost and tok/s read like a coworker would say them", () => {
  assert.deepEqual([0, 842, 1204, 84_312, 1_234_567, 12_400_000, 123_000_000].map(tokens), ["0", "842", "1.2k", "84k", "1.23M", "12.4M", "123M"]);
  assert.deepEqual([1000, 9_000_000, 84_000_000, 1_500_000, 1_080_000_000].map(tokens), ["1k", "9M", "84M", "1.5M", "1.08B"]);
  assert.deepEqual([null, 0, 0.004, 0.42, 12.3].map(cost), ["–", "$0.00", "$0.004", "$0.42", "$12.30"]);
  assert.deepEqual([null, 42.34, 128.4].map(tps), ["–", "42.3", "128"]);
  assert.equal(modelLabel("anthropic/claude-opus-5-5-20260301"), "claude-opus-5-5");
  assert.equal(modelLabel("gpt-6-astra"), "gpt-6-astra");
});

test("usage windows: each window has a default bucket that keeps the bar count sane", () => {
  assert.deepEqual(bucketsFor("1h"), ["minute"]);
  assert.equal(defaultBucket("24h"), "hour");
  assert.equal(defaultBucket("7d"), "hour");
  assert.equal(defaultBucket("30d"), "day");
  assert.equal(defaultBucket("all"), "day");
  assert.deepEqual([0, 7, 10, 13, 2600, 48_000].map(niceMax), [1, 10, 10, 20, 5000, 50_000]);
});

test("usage sparkline: a path from oldest to newest, flat when nothing was used", () => {
  assert.equal(sparkPath([], 120, 28), "");
  assert.equal(sparkPath([0, 0, 0], 120, 28), "M0.0 27.0L60.0 27.0L120.0 27.0");
  const path = sparkPath([0, 10, 5], 100, 28);
  assert.equal(path, "M0.0 27.0L50.0 1.0L100.0 14.0");
});

test("usage layout: bars sit by time inside a fixed window, stacks follow the keys and fold the rest into other", () => {
  const hour = 3_600_000;
  const series: UsageSeries = {
    window: "24h", bucket: "hour", group: "model", keys: ["opus", "astra"],
    points: [
      { t: NOW - 3 * hour, tokens: t(600, 400), costUsd: 0.5, calls: 3, byKey: { opus: 700, astra: 200 } },
      { t: NOW - hour, tokens: t(100, 100), costUsd: null, calls: 1, byKey: { astra: 200 } },
    ],
  };
  const chart = layout(series, 240, 100, NOW);
  assert.equal(chart.from, NOW - 24 * hour);
  assert.equal(chart.to, NOW);
  assert.equal(chart.top, 1000);
  assert.deepEqual(chart.keys, ["opus", "astra", "other"]);
  assert.equal(chart.bars.length, 2);
  const [first, second] = chart.bars;
  assert.equal(Math.round(first!.x), 210);
  assert.equal(Math.round(second!.x), 230);
  assert.deepEqual(first!.stack.map(part => [part.key, part.value, Math.round(part.y), Math.round(part.h)]), [["opus", 700, 30, 70], ["astra", 200, 10, 20], ["other", 100, 0, 10]]);
  assert.deepEqual(second!.stack.map(part => part.key), ["astra"]);
  assert.equal(barAt(chart.bars, 215), first);
  assert.equal(barAt(chart.bars, 100), null);
  assert.equal(chart.grid.at(-1)?.label, "1k");
  assert.equal(chart.ticks.length, 2);
});

test("usage layout: the all window spans the first bucket to the last, and group none makes one part per bar", () => {
  const day = 86_400_000;
  const series: UsageSeries = { window: "all", bucket: "day", group: "none", keys: [], points: [
    { t: NOW - 10 * day, tokens: t(50), costUsd: null, calls: 1 }, { t: NOW - day, tokens: t(0), costUsd: null, calls: 0 },
  ] };
  const chart = layout(series, 100, 50, NOW);
  assert.equal(chart.from, NOW - 10 * day);
  assert.equal(chart.to, NOW);
  assert.deepEqual(chart.keys, []);
  assert.deepEqual(chart.bars.map(bar => bar.stack.length), [1, 0]);
  assert.equal(chart.grid[0]!.label, "13");
  assert.deepEqual(layout({ ...series, points: [] }, 100, 50, NOW).grid.map(line => line.label), ["", "", "", ""]);
  assert.equal(chart.bars[0]!.stack[0]!.key, "");
});

test("usage ingest line: building shows progress, idle shows the sync age, an error is visible", () => {
  const base: UsageIngest = { state: "idle", filesDone: 4812, filesTotal: 4812, lastSyncAt: NOW - 3000, error: null, sources: [] };
  assert.deepEqual(ingestLine({ ...base, state: "building", filesDone: 1204 }, NOW), { text: "Building: 1,204 of 4,812 files", tone: "busy" });
  assert.deepEqual(ingestLine(base, NOW), { text: "Synced 3 s ago", tone: "quiet" });
  assert.deepEqual(ingestLine({ ...base, lastSyncAt: NOW - 5 * 60_000 }, NOW), { text: "Synced 5 min ago", tone: "quiet" });
  assert.deepEqual(ingestLine({ ...base, state: "syncing" }, NOW), { text: "Synced 3 s ago", tone: "busy" });
  assert.deepEqual(ingestLine({ ...base, state: "error", error: "usage.duckdb is locked" }, NOW), { text: "Usage sync failed: usage.duckdb is locked", tone: "error" });
});
