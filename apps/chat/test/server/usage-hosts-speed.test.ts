/**
 * api/hosts answers from each box's last machine reading and reads it again behind the answer (server/usage.ts `MachineReads`), and
 * api/usage reads a range in one bucketed call (`usageReport`). On 11-03 on us-metal02 the two took 1.1 s and 2.4 s. Since 11-22 api/usage
 * sums every box's usage rows kept in memory (`KeptUsage`), since each call still waited 205 to 220 ms for the Mac's pi-host.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/usage-hosts-speed.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineView } from "../../web/src/lib/api/types.ts";
import type { Host, UsageTotal } from "../../server/host/types.ts";
import type { Threads } from "../../server/threads.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadIndex, type UsageRow } from "../../../../packages/pi-host/src/durable/index-db.ts";
import type { UsageRange } from "../../server/host/types.ts";
import { KeptUsage, MACHINE_TICK_MS, MachineReads, SqliteUsage, usageReport } from "../../server/usage.ts";

const settle = () => new Promise(resolve => setImmediate(resolve));
const machine = (percent: number) => ({ platform: "linux", cpu: { percent, cores: 8, load: [1, 1, 1] }, memory: { usedBytes: 1, totalBytes: 2 } }) as unknown as MachineView;

test("a machine reading answers at once within the tick, and past it answers the last reading while one read runs behind it", async () => {
  let at = 1_000_000;
  const calls: { resolve: (percent: number) => void; reject: (error: Error) => void }[] = [];
  const reads = new MachineReads(() => new Promise((resolve, reject) => {
    calls.push({ resolve: percent => resolve({ pingMs: 5, machine: machine(percent) }), reject });
  }), () => at);
  const box = { name: "mac", address: "127.0.0.1", relayPort: 1 };

  const first = reads.get(box);
  await settle();
  assert.equal(calls.length, 1, "a box never read waits for its first read");
  calls[0]!.resolve(10);
  const one = await first;
  assert.ok("read" in one && one.read.machine?.cpu.percent === 10);

  at += MACHINE_TICK_MS - 1;
  assert.equal(await reads.get(box), one, "a reading younger than the tick answers with no read");
  assert.equal(calls.length, 1);

  at += 1;
  const stale = await Promise.all([reads.get(box), reads.get(box), reads.get(box)]);
  assert.ok(stale.every(answer => answer === one), "past the tick the last reading answers at once");
  assert.equal(calls.length, 2, "and one read starts behind it however many polls ask");
  calls[1]!.resolve(20);
  await settle(); await settle();
  const two = await reads.get(box);
  assert.ok("read" in two && two.read.machine?.cpu.percent === 20);

  at += MACHINE_TICK_MS;
  assert.equal(await reads.get(box), two);
  calls[2]!.reject(new Error("connect ECONNREFUSED"));
  await settle(); await settle();
  const down = await reads.get(box);
  assert.ok("error" in down && down.error === "connect ECONNREFUSED", "a relay that stops answering reads as unreachable at the next poll");
});

test("api/usage reads the range in one bucketed call, each bucket summed apart and the totals equal to their sum", async () => {
  const HOUR = 3_600_000;
  const now = Date.UTC(2026, 10, 22, 5, 30);
  const calls: { since?: number; until?: number; bucketMs?: number }[] = [];
  const row = (bucket: number, thread: string, cost: number): UsageTotal => ({ bucket, thread, model: "m", turns: 1, input: 1, output: 1, cacheRead: 2, cacheWrite: 0, cost,
    costInput: 0, costOutput: 0, costCacheRead: cost, costCacheWrite: 0 });
  const host = {
    async usage(range: { since?: number; until?: number; bucketMs?: number }): Promise<UsageTotal[]> {
      calls.push(range);
      const since = range.since!;
      return [row(since, "t", 5), row(since + 23 * HOUR, "t", 1), row(since + 23 * HOUR, "u", 2)];
    },
  } as unknown as Host;
  const threads = { thread: () => undefined, threadsList: () => [] } as unknown as Threads;
  const report = await usageReport(host, threads, "box", { range: "24h", bucket: "hour" }, now);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.bucketMs, HOUR);
  assert.equal(calls[0]!.until, Date.UTC(2026, 10, 22, 6), "the range ends with the hour that holds now");
  assert.equal(calls[0]!.until! - calls[0]!.since!, 24 * HOUR);
  assert.equal(report.buckets.length, 24);
  assert.deepEqual(report.buckets.map(b => b.cost.total).filter(Boolean), [5, 3]);
  assert.equal(report.buckets[23]!.turns, 2);
  assert.equal(report.buckets[23]!.tokens.cacheRead, 4);
  assert.equal(report.buckets[23]!.cost.cacheRead, 3, "cache reads keep their own cost in each bucket (c157)");
  assert.deepEqual(report.rows.map(r => [r.thread, r.turns, r.cost.total]), [["t", 2, 6], ["u", 1, 2]]);
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  assert.equal(sum(report.buckets.map(b => b.cost.total)), sum(report.rows.map(r => r.cost.total)));
});

test("api/usage offers each range only its own buckets, a day starting at the owner's midnight", async () => {
  const calls: { since?: number; until?: number; bucketMs?: number }[] = [];
  const host = { async usage(range: { since?: number; until?: number; bucketMs?: number }) { calls.push(range); return []; } } as unknown as Host;
  const threads = { thread: () => undefined, threadsList: () => [] } as unknown as Threads;
  const now = Date.UTC(2026, 10, 22, 5, 30, 12);
  const minute = await usageReport(host, threads, "box", { range: "1h", bucket: "day" }, now);
  assert.equal(minute.bucket, "minute", "1h has minutes only");
  assert.equal(minute.buckets.length, 60);
  assert.equal(minute.until, Date.UTC(2026, 10, 22, 5, 31));
  const week = await usageReport(host, threads, "box", { range: "7d", bucket: "day" }, now);
  assert.equal(week.buckets.length, 7);
  assert.equal(week.until, Date.UTC(2026, 10, 22, 15), "the day after now starts at KST midnight");
  const fallback = await usageReport(host, threads, "box", { range: "nope" }, now);
  assert.deepEqual([fallback.range, fallback.bucket, fallback.buckets.length], ["24h", "hour", 24]);
});

test("api/usage from a pi-host without buckets asks each bucket in one round", async () => {
  let open = 0, most = 0;
  const host = {
    async usage(range: { since?: number; until?: number; bucketMs?: number }): Promise<UsageTotal[]> {
      open++;
      most = Math.max(most, open);
      await new Promise(resolve => setTimeout(resolve, 20));
      open--;
      return [{ thread: "t", model: "m", turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 1, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0 }];
    },
  } as unknown as Host;
  const threads = { thread: () => undefined, threadsList: () => [] } as unknown as Threads;
  const report = await usageReport(host, threads, "box", { range: "7d", bucket: "day" });
  assert.equal(most, 7, "the bucketed call answered without buckets, then all 7 days go out before any answers");
  assert.ok(report.buckets.every(b => b.byModel.m === 1));
  assert.ok(report.buckets.every(b => JSON.stringify(b.tokensByModel.m) === JSON.stringify(b.tokens)), "one model's tokens per bucket equal the bucket's tokens");
  assert.equal(report.rows[0]!.cost.total, 7);
});

test("api/usage labels each row with the box that answered it, and the host filter keeps that box's rows", async () => {
  const DAY = 86_400_000;
  const row = (bucket: number, host: string, cost: number): UsageTotal => ({ bucket, host, thread: "t", model: "m", turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
    cost, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0 });
  const host = {
    async usage(range: { since?: number }): Promise<UsageTotal[]> {
      return [row(range.since!, "us-metal02", 1), row(range.since!, "mac", 2), row(range.since! + 6 * DAY, "mac", 4)];
    },
  } as unknown as Host;
  const threads = { thread: () => undefined, threadsList: () => [] } as unknown as Threads;
  const all = await usageReport(host, threads, "us-metal02", { range: "7d", bucket: "day" });
  assert.deepEqual(all.rows.map(r => [r.host, r.cost.total]), [["us-metal02", 1], ["mac", 6]]);
  const mac = await usageReport(host, threads, "us-metal02", { range: "7d", bucket: "day", host: "mac" });
  assert.deepEqual(mac.rows.map(r => [r.host, r.cost.total]), [["mac", 6]]);
  assert.equal(mac.buckets[0]!.byModel.m, 2);
  assert.equal(mac.buckets[6]!.byModel.m, 4);
  assert.deepEqual(mac.buckets[6]!.tokensByModel.m, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });
});

test("api/usage answers from the kept rows with no call to any box, with the same sums as pi-host's own query, and follows new and dropped rows", async () => {
  const HOUR = 3_600_000;
  const dir = mkdtempSync(join(tmpdir(), "kept-usage-"));
  const index = new ThreadIndex(join(dir, "index.sqlite"));
  const now = Date.UTC(2026, 10, 22, 5, 30, 12);
  index.insertThread({ id: "t", name: "t", provider: "anthropic", modelId: "m", thinkingLevel: "high", cwd: "/", createdAt: 1, updatedAt: 1 });
  let entry = 0;
  const usage = (thread: string, at: number, cost: number) => ({ thread, conversation: 1, entryId: ++entry, model: cost > 1 ? "big" : "small", at, input: 3, output: 5,
    cacheRead: 7, cacheWrite: 11, cost, costInput: cost / 4, costOutput: cost / 4, costCacheRead: cost / 4, costCacheWrite: cost / 4 });
  const rows = Array.from({ length: 400 }, (_, i) => usage(i % 3 ? "t" : "u", now - (i * 7919 * 1000) % (95 * 24 * HOUR), (i % 5) * 0.5 + 0.25));
  index.addEntries("t", [], rows.filter(row => row.thread === "t"));
  index.addEntries("u", [], rows.filter(row => row.thread === "u"));
  const asked: unknown[] = [];
  const live = { async usage(range: UsageRange) { asked.push(range); return index.usage(range); } };
  const direct = { usage: async (range: UsageRange) => index.usage(range) };
  const own = new SqliteUsage("box", join(dir, "index.sqlite"));
  const mac: UsageRow[] = [usage("m", now - 5 * 60_000, 2)];
  let macUp = true;
  const kept = new KeptUsage(() => [own, { box: "mac", up: () => macUp, read: (cursor, since) => ({ rows: cursor ? [] : mac.filter(row => row.at >= since), cursor: "0:1", more: false, restart: !cursor }) }],
    live, () => {}, () => now);
  const threads = { thread: () => undefined, threadsList: () => [] } as unknown as Threads;
  const cases = [["1h", "minute"], ["24h", "hour"], ["24h", "minute"], ["7d", "hour"], ["7d", "day"], ["30d", "day"], ["90d", "day"]] as const;

  await kept.usage({ since: now - HOUR - (now % HOUR), until: now - (now % HOUR) + HOUR, bucketMs: HOUR });
  assert.equal(asked.length, 1, "before the first read the range reads the boxes as before");
  await kept.pull();
  asked.length = 0;
  for (const [range, bucket] of cases) {
    const got = await usageReport(kept, threads, "box", { range, bucket, host: "box" }, now);
    const want = await usageReport(direct, threads, "box", { range, bucket }, now);
    const round = (report: typeof got) => JSON.stringify(report, (_key, value) => (typeof value === "number" ? Math.round(value * 1e9) / 1e9 : value));
    assert.equal(round(got), round(want), `${range} by ${bucket}`);
    const one = await usageReport(kept, threads, "box", { range, bucket, thread: "u", host: "box" }, now);
    assert.equal(round(one), round(await usageReport(direct, threads, "box", { range, bucket, thread: "u" }, now)));
  }
  assert.equal(asked.length, 0, "no range asked a box");
  const both = await usageReport(kept, threads, "box", { range: "1h", bucket: "minute" }, now);
  assert.deepEqual(both.rows.filter(row => row.host === "mac").map(row => [row.thread, row.cost.total]), [["m", 2]]);

  index.addEntries("t", [], [usage("t", now - 1000, 3)]);
  index.resetEntries("u");
  await kept.pull();
  const after = await usageReport(kept, threads, "box", { range: "1h", bucket: "minute", host: "box" }, now);
  assert.equal(JSON.stringify(after.buckets), JSON.stringify((await usageReport(direct, threads, "box", { range: "1h", bucket: "minute" }, now)).buckets),
    "a new row counts and a dropped thread's rows leave at the next pull");
  macUp = false;
  await kept.pull();
  assert.ok((await usageReport(kept, threads, "box", { range: "1h", bucket: "minute" }, now)).rows.some(row => row.host === "mac"), "a box whose link went down keeps its read rows");
  assert.equal(asked.length, 0);
  own.close();
  index.close();
  rmSync(dir, { recursive: true, force: true });
});
