import assert from "node:assert/strict";
import { test } from "node:test";
import { round, tagRunsOn } from "../feed.ts";
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

test("a round keeps the first sample of each series and counts the repeats a reader sent", async () => {
  const { samples } = await round(ctx, {
    twice: async () => [
      { name: "d", kind: "gauge", help: "D.", value: 1, labels: { chat: "x", source: "a" } },
      { name: "d", kind: "gauge", help: "D.", value: 2, labels: { source: "a", chat: "x" } },
      { name: "d", kind: "gauge", help: "D.", value: 3, labels: { chat: "y", source: "a" } },
    ],
  });
  assert.deepEqual(samples.filter(s => s.name === "d").map(s => s.value), [1, 3]);
  assert.equal(samples.find(s => s.name === "harness.feed.repeated_samples" && s.labels?.metric === "d")?.value, 1);
});

test("every chat sample gets the box its chat runs on, and every host sample the box it names, in the board's box names", () => {
  const samples = [
    { name: "harness.tokens.chat_cost_usd", kind: "gauge" as const, help: "C.", value: 1, labels: { chat: "frontend bro", part: "thread", runs_on: "mac" } },
    { name: "harness.tokens.chat_cost_usd", kind: "gauge" as const, help: "C.", value: 1, labels: { chat: "AI harness", part: "thread", runs_on: "us-metal02" } },
    { name: "harness.duties.count", kind: "gauge" as const, help: "D.", value: 2, labels: { chat: "frontend bro", state: "met" } },
    { name: "harness.plan.items", kind: "gauge" as const, help: "P.", value: 3, labels: { chat: "AI harness" } },
    { name: "harness.plan.items", kind: "gauge" as const, help: "P.", value: 4, labels: { chat: "gone chat" } },
    { name: "harness.pool.waiting", kind: "gauge" as const, help: "W.", value: 0 },
    { name: "harness.chat.agents", kind: "gauge" as const, help: "A.", value: 5, labels: { host: "mac", state: "idle" } },
    { name: "harness.chat.agents", kind: "gauge" as const, help: "A.", value: 6, labels: { host: "us-metal02", state: "idle" } },
  ];
  tagRunsOn(samples);
  assert.deepEqual(samples.map(s => (s.labels as Record<string, string> | undefined)?.runs_on), ["mbp", "us-metal02", "mbp", "us-metal02", undefined, undefined, "mbp", "us-metal02"]);
});
