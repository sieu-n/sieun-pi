// Owner 11-24 (msg mwtu3137): "the chart looks different in both places". Settings > Usage draws a range with sw factory's colors, y axis, bar shape and time labels.
import assert from "node:assert/strict";
import { test } from "node:test";
import { barWidth, usageAxis, usageColor, usageTick } from "../../../../apps/chat/web/src/lib/api/shared/usage-chart.ts";
import { barAt, layout } from "../src/client/usage.ts";
import type { UsageSeries } from "../src/shared/usage.ts";

const H = 3_600_000;
const since = Date.parse("2026-11-23T00:00:00Z");
const tokens = (output: number) => ({ input: 0, output, cacheRead: 0, cacheWrite: 0, total: output });
const series: UsageSeries = {
  window: "24h", bucket: "hour", group: "client", metric: "output", since, until: since + 24 * H, keys: ["pi-host", "prime"],
  points: Array.from({ length: 24 }, (_, i) => ({ t: since + i * H, tokens: tokens(i === 5 ? 45e9 : 0), costUsd: 0, calls: i === 5 ? 1 : 0, byKey: i === 5 ? { "pi-host": 30e9, prime: 15e9 } : {} })),
};

test("the y axis steps are sw factory's, so 45B reads 0, 20B, 40B, 60B on both pages", () => {
  const chart = layout(series, 960, 190);
  assert.deepEqual(usageAxis(45e9).ticks, [0, 20e9, 40e9, 60e9]);
  assert.deepEqual(chart.grid.map(line => line.label), ["0", "20B", "40B", "60B"]);
  assert.equal(chart.top, 60e9);
});

test("bars take sw factory's width in the middle of their hour, and the hover answers anywhere in the hour", () => {
  const chart = layout(series, 960, 190);
  assert.equal(chart.step, 40);
  const bar = chart.bars[5]!;
  assert.equal(bar.w, barWidth(40));
  assert.equal(bar.x, 5 * 40 + (40 - bar.w) / 2);
  assert.equal(barAt(chart.bars, 5 * 40 + 1, chart.step), bar);
  assert.equal(bar.stack.length, 2);
  assert.ok(bar.stack.every(part => part.d.startsWith("M")));
});

test("time labels sit on the buckets sw factory labels, with its words", () => {
  const chart = layout(series, 960, 190);
  assert.ok(chart.ticks.length >= 2);
  for (const tick of chart.ticks) {
    const index = Math.floor(tick.x / chart.step);
    assert.equal(tick.label, usageTick(since + index * H, "hour"));
  }
});

test("a key's color is fixed, the same in every range and on both pages", () => {
  assert.equal(usageColor("pi-host"), "#0d74ce");
  assert.equal(usageColor("prime"), "#ef5f00");
  assert.equal(usageColor("anthropic/claude-opus-5-5"), usageColor("claude-opus-5-5"));
  assert.equal(usageColor("Other"), usageColor("other"));
  assert.equal(usageColor("a-key-no-table-names"), usageColor("a-key-no-table-names"));
});
