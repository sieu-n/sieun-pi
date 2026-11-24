/**
 * api/hosts answers from each box's last machine reading and reads it again behind the answer (server/usage.ts `MachineReads`), and
 * api/usage folds one bucketed read of the kept sums into rows and buckets (`usageReport`). On 11-03 on us-metal02 the two took 1.1 s and
 * 2.4 s. test/server/usage-store.test.ts checks the kept sums against a real ClickHouse.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/usage-hosts-speed.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineView } from "../../web/src/lib/api/types.ts";
import type { Threads } from "../../server/threads.ts";
import type { UsageRange, UsageTotal } from "../../server/usage-store.ts";
import { MACHINE_TICK_MS, MachineReads, usageReport } from "../../server/usage.ts";

const settle = () => new Promise(resolve => setImmediate(resolve));
const machine = (percent: number) => ({ platform: "linux", cpu: { percent, cores: 8, load: [1, 1, 1] }, memory: { usedBytes: 1, totalBytes: 2 } }) as unknown as MachineView;

test("a machine reading answers at once: null before the first read lands, the last reading after, with one read behind it past the tick", async () => {
  let at = 1_000_000;
  const calls: { resolve: (percent: number) => void; reject: (error: Error) => void }[] = [];
  const reads = new MachineReads(() => new Promise((resolve, reject) => {
    calls.push({ resolve: percent => resolve({ pingMs: 5, machine: machine(percent) }), reject });
  }), () => at);
  const box = { name: "mac", address: "127.0.0.1", relayPort: 1 };

  assert.equal(reads.get(box), null, "a box never read answers at once with no reading, and never waits on its relay");
  assert.equal(reads.get(box), null);
  assert.equal(calls.length, 1, "one first read runs behind however many calls ask");
  calls[0]!.resolve(10);
  await reads.settled();
  const one = reads.get(box)!;
  assert.ok("read" in one && one.read.machine?.cpu.percent === 10);

  at += MACHINE_TICK_MS - 1;
  assert.equal(reads.get(box), one, "a reading younger than the tick answers with no read");
  assert.equal(calls.length, 1);

  at += 1;
  assert.ok([reads.get(box), reads.get(box), reads.get(box)].every(answer => answer === one), "past the tick the last reading answers at once");
  assert.equal(calls.length, 2, "and one read starts behind it however many polls ask");
  calls[1]!.resolve(20);
  await reads.settled();
  const two = reads.get(box)!;
  assert.ok("read" in two && two.read.machine?.cpu.percent === 20);

  at += MACHINE_TICK_MS;
  assert.equal(reads.get(box), two);
  calls[2]!.reject(new Error("connect ECONNREFUSED"));
  await reads.settled();
  const down = reads.get(box)!;
  assert.ok("error" in down && down.error === "connect ECONNREFUSED", "a relay that stops answering reads as unreachable at the next poll");
});

test("the last machine readings stay on disk, so a restarted server answers its first call with them", async () => {
  const saved = new Map<string, unknown>();
  const store = { cache: <T>(name: string, fallback: T): T => (saved.has(name) ? structuredClone(saved.get(name)) as T : fallback), saveCache: (name: string, value: unknown) => void saved.set(name, structuredClone(value)) };
  const box = { name: "mac", address: "127.0.0.1", relayPort: 1 };
  const before = new MachineReads(async () => ({ pingMs: 5, machine: machine(42) }), Date.now, store);
  assert.equal(before.get(box), null);
  await before.settled();
  let reads = 0;
  const after = new MachineReads(() => (reads++, new Promise(() => {})), Date.now, store);
  const first = after.get(box);
  assert.ok(first && "read" in first && first.read.machine?.cpu.percent === 42, "the reading from before the restart answers at once");
  assert.equal(reads, 0, "a reading younger than the tick reads no relay");
});


const threads = { thread: () => undefined, threadsList: () => [] } as unknown as Threads;
const total = (bucket: number, over: Partial<UsageTotal>): UsageTotal => {
  const row = { bucket, host: "us-metal02", client: "pi-host", agent: "", thread: "t", threadName: "", model: "m", series: "", turns: 1, input: 1, output: 1, cacheRead: 0,
    cacheWrite: 0, cost: 0, costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, unpriced: 0, ...over };
  const chat = [row.host, row.client, row.agent, row.thread].join("\u0000");
  return { ...row, chat, series: `${chat}\u0000${row.model}` };
};

test("api/usage reads the range in one bucketed call, each bucket summed apart and the totals equal to their sum", async () => {
  const HOUR = 3_600_000;
  const now = Date.UTC(2026, 10, 22, 5, 30);
  const calls: UsageRange[] = [];
  const row = (bucket: number, thread: string, cost: number) => total(bucket, { thread, cacheRead: 2, cost, costCacheRead: cost });
  const sums = {
    async usage(range: UsageRange): Promise<UsageTotal[]> {
      calls.push(range);
      return [row(range.since, "t", 5), row(range.since + 23 * HOUR, "t", 1), row(range.since + 23 * HOUR, "u", 2)];
    },
  };
  const report = await usageReport(sums, threads, { range: "24h", bucket: "hour" }, now);
  assert.deepEqual(calls.map(call => call.bucketMs), [HOUR, 24 * HOUR], "one call by the hour for the buckets, one over the range for the chat table");
  assert.equal(calls[0]!.until, Date.UTC(2026, 10, 22, 6), "the range ends with the hour that holds now");
  assert.equal(calls[0]!.until - calls[0]!.since, 24 * HOUR);
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
  const sums = { async usage(): Promise<UsageTotal[]> { return []; } };
  const now = Date.UTC(2026, 10, 22, 5, 30, 12);
  const minute = await usageReport(sums, threads, { range: "1h", bucket: "day" }, now);
  assert.equal(minute.bucket, "minute", "1h has minutes only");
  assert.equal(minute.buckets.length, 60);
  assert.equal(minute.until, Date.UTC(2026, 10, 22, 5, 31));
  const week = await usageReport(sums, threads, { range: "7d", bucket: "day" }, now);
  assert.equal(week.buckets.length, 7);
  assert.equal(week.until, Date.UTC(2026, 10, 22, 15), "the day after now starts at KST midnight");
  const fallback = await usageReport(sums, threads, { range: "nope" }, now);
  assert.deepEqual([fallback.range, fallback.bucket, fallback.buckets.length], ["24h", "hour", 24]);
});

test("api/usage keeps each host and client apart, and the host filter keeps that host's rows", async () => {
  const DAY = 86_400_000;
  const sums = {
    async usage(range: UsageRange): Promise<UsageTotal[]> {
      return [total(range.since, { cost: 1 }), total(range.since, { host: "mbp", cost: 2 }), total(range.since + 6 * DAY, { host: "mbp", cost: 4 }),
        total(range.since, { host: "mbp", client: "codex", thread: "s1", cost: 8 })];
    },
  };
  const all = await usageReport(sums, threads, { range: "7d", bucket: "day" });
  assert.deepEqual(all.rows.map(r => [r.host, r.client, r.cost.total]), [["us-metal02", "pi-host", 1], ["mbp", "pi-host", 6], ["mbp", "codex", 8]]);
  const mac = await usageReport(sums, threads, { range: "7d", bucket: "day", host: "mbp" });
  assert.deepEqual(mac.rows.map(r => [r.host, r.cost.total]), [["mbp", 6], ["mbp", 8]]);
  assert.deepEqual(mac.series.map(line => [line.key, line.cost[0], line.cost[6], line.tokens[6], line.output[6]]), [["m", 10, 4, 2, 1]]);
  const clients = await usageReport(sums, threads, { range: "7d", bucket: "day", split: "client" });
  assert.deepEqual(clients.series.map(line => [line.key, line.cost[0]]), [["codex", 8], ["pi-host", 3]], "a client split sends one series per client, costliest first");
  const hosts = await usageReport(sums, threads, { range: "7d", bucket: "day", split: "host" });
  assert.equal(hosts.split, "host");
  assert.deepEqual(hosts.series.map(line => [line.key, line.cost[0], line.cost[6]]), [["mbp", 10, 4], ["us-metal02", 1, 0]], "a host split sends one series per host, as Prime chat's By host");
});
