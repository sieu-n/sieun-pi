import assert from "node:assert/strict";
import { test } from "node:test";
import { round } from "../feed.ts";
import { payload, promName, type Context } from "../otlp.ts";

const ctx: Context = { home: "/nonexistent", host: "t", platform: "linux", now: 0, chatHost: false, state: new Map() };

test("promName adds the unit suffix and _total as Alloy does", () => {
  assert.equal(promName({ name: "harness.feed.rss", kind: "gauge", unit: "By" }), "harness_feed_rss_bytes");
  assert.equal(promName({ name: "harness.pool.admitted", kind: "counter" }), "harness_pool_admitted_total");
  assert.equal(promName({ name: "harness.duties.green", kind: "gauge", unit: "1" }), "harness_duties_green_ratio");
});

test("payload groups points by name, drops non-finite values and gives counters a start time", () => {
  const body = payload([
    { name: "a", kind: "gauge", help: "A.", value: 1, labels: { chat: "x" } },
    { name: "a", kind: "gauge", help: "A.", value: 2, labels: { chat: "y" } },
    { name: "a", kind: "gauge", help: "A.", value: NaN },
    { name: "b", kind: "counter", help: "B.", value: 3 },
  ], { "service.name": "harness" }, 5n, 9n) as any;
  const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics;
  assert.equal(metrics[0].gauge.dataPoints.length, 2);
  assert.equal(metrics[1].sum.dataPoints[0].startTimeUnixNano, "5");
  assert.equal(metrics[1].sum.isMonotonic, true);
});

test("a failing reader reports ok 0 and leaves the others' samples", async () => {
  const { samples, errors } = await round(ctx, {
    good: async () => [{ name: "g", kind: "gauge", help: "G.", value: 1 }],
    bad: async () => { throw new Error("boom"); },
  });
  assert.ok(samples.some(s => s.name === "g"));
  assert.equal(samples.find(s => s.name === "harness.feed.reader_ok" && s.labels?.group === "bad")?.value, 0);
  assert.match(errors.bad, /boom/);
});
