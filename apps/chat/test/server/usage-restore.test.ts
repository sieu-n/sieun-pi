/**
 * A new server reads the usage snapshot its predecessor wrote (usage-store.ts `restore`) a line per turn of the event loop. It decoded the
 * whole file and split it in one turn before, which held the loop 95 to 108 ms for the 31 MB snapshot of 11-24, in the first seconds after
 * each release when the owner's first calls land (~/work/p279-search/p279-meili.md).
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/usage-restore.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { StoreUsage } from "../../server/usage-store.ts";

const NOW = Date.UTC(2026, 10, 24, 10, 0);
const MIN = 60_000;

/** A snapshot as `snapshotLines` writes it: a header and `lines` chunks of 2,000 minute sums, with Korean thread names as the live one has. */
function snapshot(file: string, lines: number): void {
  const head = JSON.stringify({ at: NOW, fullAt: NOW, covered: { hour: NOW - 30 * 86_400_000, minute: NOW - 86_400_000, tick: NOW - 11 * MIN } });
  const chunk = (n: number) => JSON.stringify(["minute", Array.from({ length: 2_000 }, (_, i) => ({
    bucket: NOW - ((n * 2_000 + i) % 1_400) * MIN, host: "us-metal02", client: "prime", agent: `agent ${i % 40}`, thread: `thread-${n}-${i}`,
    threadName: `검색 속도 점검 ${n} ${i}`, model: "anthropic/claude-opus-5-5", turns: 1, input: 10, output: 20, cacheRead: 0, cacheWrite: 0,
    cost: 3, costInput: 1, costOutput: 2, costCacheRead: 0, costCacheWrite: 0, unpriced: 0,
  }))]);
  writeFileSync(file, [head, ...Array.from({ length: lines }, (_, n) => chunk(n))].join("\n"));
}

/** The longest gap between turns of the event loop while `run` goes. */
async function longestTurn(run: () => Promise<void>): Promise<number> {
  let longest = 0;
  let last = performance.now();
  let running = true;
  const tick = (): void => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  await run();
  running = false;
  return longest;
}

test("a new server reads the usage snapshot a line per turn, never decoding and splitting the whole file in one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-restore-"));
  try {
    const file = join(dir, "usage-sums.json");
    snapshot(file, 100);
    // What the old read did in one turn, timed here on the same box and file: decode the whole file and split it into lines.
    const started = performance.now();
    const lines = readFileSync(file).toString("utf8").split("\n");
    const whole = performance.now() - started;
    assert.equal(lines.length, 101);
    const logs: string[] = [];
    const store = new StoreUsage({ query: () => new Promise(() => undefined) }, "t", line => logs.push(line), () => NOW + 1_000, 600_000, file);
    const longest = await longestTurn(() => store.prepare());
    assert.match(logs.at(-1) ?? "", /200000 sums/);
    assert.equal((await store.usage({ since: NOW - 1_400 * MIN, until: NOW + MIN, bucketMs: MIN })).reduce((sum, row) => sum + row.cost, 0), 600_000);
    assert.ok(longest < whole / 2, `the longest turn took ${longest.toFixed(1)} ms against ${whole.toFixed(1)} ms to decode and split the whole file`);
    store.stop(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
