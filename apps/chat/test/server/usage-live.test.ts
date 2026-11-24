/**
 * api/usage/live: Prime's per-second card (server/usage.ts `usageLive`), the tokens of the minute before the last 10 s tick over 60 and that
 * rate every 10 s over 10 min, read from the 10 s sums. test/server/usage-store.test.ts checks the same rate against a real ClickHouse.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/usage-live.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { LIVE_TICK_MS, type UsageRange, type UsageTotal } from "../../server/usage-store.ts";
import { usageLive } from "../../server/usage.ts";

test("api/usage/live sums the minute before each 10 s tick over 60, and its thread and host filters keep only their rows", async () => {
  const now = Date.UTC(2026, 10, 22, 5, 30, 17, 250);
  const calls = Array.from({ length: 300 }, (_, i) => ({ thread: i % 3 ? "t" : "u", host: i % 4 ? "us-metal02" : "mbp", at: now - ((i * 7_919) % 900_000), output: 1 + (i % 17) }));
  const asked: UsageRange[] = [];
  const sums = {
    async usage(range: UsageRange): Promise<UsageTotal[]> {
      asked.push(range);
      return calls.filter(c => c.at >= range.since && c.at < range.until && (!range.threads || range.threads.includes(c.thread))).map(c => ({
        bucket: range.since + Math.floor((c.at - range.since) / range.bucketMs) * range.bucketMs, host: c.host, client: "pi-host", agent: "", thread: c.thread,
        threadName: "", model: "m", series: `${c.host}\u0000pi-host\u0000\u0000${c.thread}\u0000m`, chat: `${c.host}\u0000pi-host\u0000\u0000${c.thread}`, turns: 1, input: 3, output: c.output, cacheRead: 7, cacheWrite: 11, cost: 1, costInput: 0.25, costOutput: 0.25, costCacheRead: 0.25,
        costCacheWrite: 0.25, unpriced: 0,
      }));
    },
  };
  const at = Math.floor(now / LIVE_TICK_MS) * LIVE_TICK_MS;
  const rate = (end: number, keep: (c: (typeof calls)[number]) => boolean = () => true) => {
    const inMinute = calls.filter(c => c.at >= end - 60_000 && c.at < end && keep(c));
    return { output: inMinute.reduce((sum, c) => sum + c.output, 0) / 60, total: inMinute.reduce((sum, c) => sum + 3 + c.output + 7 + 11, 0) / 60 };
  };
  const live = await usageLive(sums, {}, now);
  assert.equal(live.at, at);
  assert.equal(live.spark.total.length, 61);
  assert.deepEqual(live.perSecond, rate(at));
  for (const i of [0, 17, 59]) {
    const end = at - (60 - i) * LIVE_TICK_MS;
    assert.deepEqual({ output: live.spark.output[i], total: live.spark.total[i] }, rate(end), `the spark point ending ${end}`);
  }
  assert.deepEqual(asked.map(r => [r.until, r.bucketMs]), [[at, LIVE_TICK_MS]], "one read of 10 s buckets that ends on the tick");
  assert.deepEqual((await usageLive(sums, { thread: "u" }, now)).perSecond, rate(at, c => c.thread === "u"));
  assert.deepEqual((await usageLive(sums, { host: "mbp" }, now)).perSecond, rate(at, c => c.host === "mbp"));
});
