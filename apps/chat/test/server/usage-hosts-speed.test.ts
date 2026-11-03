/**
 * api/hosts answers from each box's last machine reading and reads it again behind the answer (server/usage.ts `MachineReads`), and
 * api/usage asks every range in one round (`usageReport`). On 11-03 on us-metal02 the two took 1.1 s and 2.4 s.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/usage-hosts-speed.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineView } from "../../web/src/lib/api/types.ts";
import type { Host, UsageTotal } from "../../server/host/types.ts";
import type { Threads } from "../../server/threads.ts";
import { MACHINE_TICK_MS, MachineReads, usageReport } from "../../server/usage.ts";

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

test("api/usage asks for the period, each day and the period before in one round", async () => {
  let open = 0, most = 0;
  const host = {
    async usage(range: { since?: number; until?: number }): Promise<UsageTotal[]> {
      open++;
      most = Math.max(most, open);
      await new Promise(resolve => setTimeout(resolve, 20));
      open--;
      return [{ thread: "t", model: "m", turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: range.until! - range.since! === 86_400_000 ? 1 : 7,
        costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0 }];
    },
  } as unknown as Host;
  const threads = { thread: () => undefined, threadsList: () => [] } as unknown as Threads;
  const report = await usageReport(host, threads, "box", { days: 7 });
  assert.equal(most, 9, "the period, 7 days and the period before all go out before any answers");
  assert.equal(report.days.length, 7);
  assert.ok(report.days.every(day => day.byModel.m === 1));
  assert.equal(report.rows[0]!.cost.total, 7);
  assert.equal(report.previous.cost, 7);
});
