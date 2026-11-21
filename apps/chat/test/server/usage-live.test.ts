/**
 * api/usage/live: Prime's per-second card from pi-host's usage rows (server/usage.ts `usageLive`), the tokens of the minute before the last
 * 10 s tick over 60 and that rate every 10 s over 10 min, read from the 10 s sums `KeptUsage` keeps.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/usage-live.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ThreadIndex, type UsageRow } from "../../../../packages/pi-host/src/durable/index-db.ts";
import type { UsageRange } from "../../server/host/types.ts";
import { KeptUsage, LIVE_TICK_MS, SqliteUsage, usageLive } from "../../server/usage.ts";

test("api/usage/live sums the minute before each 10 s tick over 60, the same from the kept sums as from pi-host, with no call to any box", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-live-"));
  const index = new ThreadIndex(join(dir, "index.sqlite"));
  const now = Date.UTC(2026, 10, 22, 5, 30, 17, 250);
  index.insertThread({ id: "t", name: "t", provider: "anthropic", modelId: "m", thinkingLevel: "high", cwd: "/", createdAt: 1, updatedAt: 1 });
  let entry = 0;
  const usage = (thread: string, at: number, output: number): UsageRow => ({ thread, conversation: 1, entryId: ++entry, model: "m", at, input: 3, output,
    cacheRead: 7, cacheWrite: 11, cost: 1, costInput: 0.25, costOutput: 0.25, costCacheRead: 0.25, costCacheWrite: 0.25 });
  const rows = Array.from({ length: 300 }, (_, i) => usage(i % 3 ? "t" : "u", now - ((i * 7_919) % 900_000), 1 + (i % 17)));
  index.addEntries("t", [], rows.filter(row => row.thread === "t"));
  index.addEntries("u", [], rows.filter(row => row.thread === "u"));
  const asked: UsageRange[] = [];
  const direct = { usage: async (range: UsageRange) => (asked.push(range), index.usage(range)) };
  const own = new SqliteUsage("box", join(dir, "index.sqlite"));
  const kept = new KeptUsage(() => [own], direct, () => {}, () => now);

  const at = Math.floor(now / LIVE_TICK_MS) * LIVE_TICK_MS;
  const rate = (end: number, thread?: string) => {
    const inMinute = rows.filter(row => row.at >= end - 60_000 && row.at < end && (!thread || row.thread === thread));
    return { output: inMinute.reduce((sum, row) => sum + row.output, 0) / 60, total: inMinute.reduce((sum, row) => sum + row.input + row.output + row.cacheRead + row.cacheWrite, 0) / 60 };
  };
  const want = await usageLive(direct, "box", {}, now);
  assert.equal(want.at, at);
  assert.equal(want.spark.total.length, 61);
  assert.deepEqual(want.perSecond, rate(at));
  for (const i of [0, 17, 59]) {
    const end = at - (60 - i) * LIVE_TICK_MS;
    assert.deepEqual({ output: want.spark.output[i], total: want.spark.total[i] }, rate(end), `the spark point ending ${end}`);
  }
  assert.deepEqual((await usageLive(direct, "box", { thread: "u" }, now)).perSecond, rate(at, "u"));
  assert.deepEqual((await usageLive(direct, "box", { host: "mac" }, now)).perSecond, { output: 0, total: 0 }, "the host filter keeps only that box's rows");

  await kept.pull();
  asked.length = 0;
  assert.deepEqual(await usageLive(kept, "box", {}, now), want);
  assert.deepEqual(await usageLive(kept, "box", { thread: "u" }, now), await usageLive(direct, "box", { thread: "u" }, now));
  asked.length = 0;
  await usageLive(kept, "box", {}, now);
  assert.equal(asked.length, 0, "the kept 10 s sums answer the live rate");
  await kept.usage({ since: at - 65_000, until: at, bucketMs: 5_000 });
  assert.equal(asked.length, 1, "a range off every kept grain reads the boxes, since a kept sum would land whole in one bucket");
  own.close();
  index.close();
  rmSync(dir, { recursive: true, force: true });
});
