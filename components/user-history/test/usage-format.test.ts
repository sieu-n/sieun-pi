import assert from "node:assert/strict";
import { test } from "node:test";
import { barAt, barValue, bucketsFor, cost, defaultBucket, ingestLine, kindLabel, layout, metricOf, modelLabel, niceMax, readSummary, share, sparkPath, tokens, tps } from "../src/client/usage.ts";
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
    window: "24h", bucket: "hour", group: "model", metric: "total", keys: ["opus", "astra"],
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
  const series: UsageSeries = { window: "all", bucket: "day", group: "none", metric: "total", keys: [], points: [
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

test("usage metric: one kind of a count, output with its reasoning; a bar is the metric or every kind when stacked by kind", () => {
  const counted = { input: 4, output: 677, cacheRead: 514, cacheWrite: 29_000, reasoning: 41, total: 30_236 };
  assert.deepEqual(["output", "input", "cacheRead", "cacheWrite", "total"].map(metric => metricOf(counted, metric as "output")), [718, 4, 514, 29_000, 30_236]);
  assert.equal(barValue({ group: "none", metric: "output" }, counted), 718);
  assert.equal(barValue({ group: "source", metric: "cacheRead" }, counted), 514);
  assert.equal(barValue({ group: "kind", metric: "output" }, counted), 30_236);
  assert.deepEqual(["output", "cacheWrite", "other"].map(kindLabel), ["Output", "Cache write", "other"]);
  assert.deepEqual([[718, 30_236], [29_000, 30_236], [5, 30_236], [0, 30_236], [3, 0]].map(([v, t]) => share(v!, t!)), ["2.4%", "96%", "<0.1%", "0%", "0%"]);
});

test("usage layout: a non-total metric sizes the bars by that kind, and By kind stacks the kinds in order with a share scale", () => {
  const hour = 3_600_000;
  const point = (t: number, byKey: Record<string, number>) => ({ t, tokens: { input: 100, output: 20, cacheRead: 1000, cacheWrite: 80, reasoning: 0, total: 1200 }, costUsd: null, calls: 1, byKey });
  const bySource: UsageSeries = { window: "24h", bucket: "hour", group: "source", metric: "output", keys: ["prime-agent", "codex"],
    points: [point(NOW - 2 * hour, { "prime-agent": 15, codex: 5 })] };
  const outputs = layout(bySource, 240, 100, NOW);
  assert.equal(outputs.top, 20);
  assert.deepEqual(outputs.keys, ["prime-agent", "codex"]);
  assert.deepEqual(outputs.bars[0]!.stack.map(part => [part.key, part.value, Math.round(part.h)]), [["prime-agent", 15, 75], ["codex", 5, 25]]);
  assert.equal(outputs.bars[0]!.total, 20);
  assert.equal(outputs.bars[0]!.tokens.total, 1200);
  assert.equal(outputs.grid.at(-1)?.label, "20");

  const byKind: UsageSeries = { window: "24h", bucket: "hour", group: "kind", metric: "output", keys: ["output", "input", "cacheWrite", "cacheRead"],
    points: [point(NOW - 2 * hour, { output: 20, input: 100, cacheWrite: 80, cacheRead: 1000 }), { ...point(NOW - hour, { output: 1, input: 1, cacheWrite: 0, cacheRead: 2 }), tokens: { input: 1, output: 1, cacheRead: 2, cacheWrite: 0, reasoning: 0, total: 4 } }] };
  const absolute = layout(byKind, 240, 100, NOW);
  assert.equal(absolute.top, 2000);
  assert.deepEqual(absolute.bars[0]!.stack.map(part => [part.key, Math.round(part.y * 10) / 10, Math.round(part.h * 10) / 10]), [["output", 99, 1], ["input", 94, 5], ["cacheWrite", 90, 4], ["cacheRead", 40, 50]]);
  assert.equal(absolute.grid.at(-1)?.label, "2k");

  const shares = layout(byKind, 240, 100, NOW, true);
  assert.equal(shares.top, 1);
  assert.deepEqual(shares.grid.map(line => line.label), ["25%", "50%", "75%", "100%"]);
  // Both bars fill the plot; the quiet one shows its own mix.
  for (const bar of shares.bars) assert.equal(Math.round(bar.stack.reduce((sum, part) => sum + part.h, 0)), 100);
  assert.deepEqual(shares.bars[1]!.stack.map(part => [part.key, part.h]), [["output", 25], ["input", 25], ["cacheRead", 50]]);
  // Share never applies to a single series.
  assert.equal(layout({ ...bySource, group: "none", keys: [] }, 240, 100, NOW, true).top, 20);
});

test("usage summary: the page reads only a summary in its own shape; one from another server build is null, never a render error", () => {
  const rate = { output: 1, input: 2, cacheRead: 3, cacheWrite: 4, total: 10 };
  const spark = { output: [0, 1], input: [0, 2], cacheRead: [0, 3], cacheWrite: [0, 4], total: [0, 10] };
  const ingest: UsageIngest = { state: "idle", filesDone: 1, filesTotal: 1, lastSyncAt: NOW, error: null, sources: [] };
  const summary = { at: NOW, perSecond: rate, perMinute: rate, perDay: rate, sparkSeconds: spark, sparkMinutes: spark, costToday: null, ingest };
  assert.equal(readSummary(summary), summary);
  // The shape before per-kind metrics: rates with total and output only, one spark array of totals.
  const before = { ...summary, perSecond: { total: 10, output: 1 }, perMinute: { total: 10, output: 1 }, perDay: { total: 10, output: 1 }, sparkSeconds: [0, 10], sparkMinutes: [0, 10] };
  assert.equal(readSummary(before), null);
  assert.equal(readSummary({ ...summary, sparkMinutes: { ...spark, cacheRead: undefined } }), null);
  for (const value of [null, "usage", [], { ...summary, ingest: null }]) assert.equal(readSummary(value), null);
});

test("usage ingest line: building shows progress, idle shows the sync age, an error is visible", () => {
  const base: UsageIngest = { state: "idle", filesDone: 4812, filesTotal: 4812, lastSyncAt: NOW - 3000, error: null, sources: [] };
  assert.deepEqual(ingestLine({ ...base, state: "building", filesDone: 1204 }, NOW), { text: "Building: 1,204 of 4,812 files", tone: "busy" });
  assert.deepEqual(ingestLine(base, NOW), { text: "Synced 3 s ago", tone: "quiet" });
  assert.deepEqual(ingestLine({ ...base, lastSyncAt: NOW - 5 * 60_000 }, NOW), { text: "Synced 5 min ago", tone: "quiet" });
  assert.deepEqual(ingestLine({ ...base, state: "syncing" }, NOW), { text: "Synced 3 s ago", tone: "busy" });
  assert.deepEqual(ingestLine({ ...base, state: "error", error: "usage.duckdb is locked" }, NOW), { text: "Usage sync failed: usage.duckdb is locked", tone: "error" });
});
