/**
 * The Threads tab's pure parts: what a pending wake waits on, and which 7 day split rows show.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/agents/threads-tab.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { capped, ROWS_SHOWN, usageRows, wakeWhen } from "../../web/src/pages/agents/threads-tab.ts";

const stamp = (at: number) => `T${at}`;

test("a wake reads as what it waits on", () => {
  assert.equal(wakeWhen({ kind: "time", at: 5 }, stamp), "at T5");
  assert.equal(wakeWhen({ kind: "run", run: 42 }, stamp), "when CI run 42 ends");
  assert.equal(wakeWhen({ kind: "run", run: 42, repo: "sieu-n/sieun-pi" }, stamp), "when CI run 42 in sieu-n/sieun-pi ends");
  assert.equal(wakeWhen({ kind: "check", command: "true", every: 60_000, at: 9 }, stamp), "when its check passes or at T9, checked every minute");
  assert.equal(wakeWhen({ kind: "check", command: "true", every: 1_800_000, at: 9 }, stamp), "when its check passes or at T9, checked every 30 min");
  assert.equal(wakeWhen({ kind: "check", command: "true", every: 3_600_000, at: 9 }, stamp), "when its check passes or at T9, checked every hour");
  assert.equal(wakeWhen({ kind: "check", command: "true", every: 7_200_000, at: 9 }, stamp), "when its check passes or at T9, checked every 2 hours");
});

test("the split shows the main thread always and another kind only once it ran or cost something", () => {
  const usage = {
    days: 7, turns: 5, cost: 3, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, scope: "",
    split: { main: { cost: 1, turns: 2, threads: 1 }, comm: { cost: 0, turns: 0, threads: 0 }, jobs: { cost: 2, turns: 3, threads: 2 } },
  };
  assert.deepEqual(usageRows(usage).map(row => [row.kind, row.label, row.cost, row.threads]), [["main", "Main thread", 1, 1], ["jobs", "Root jobs", 2, 2]]);
});

test("a long list shows its first rows until Show all", () => {
  const list = Array.from({ length: ROWS_SHOWN + 3 }, (_, i) => i);
  assert.equal(capped(list, false).length, ROWS_SHOWN);
  assert.equal(capped(list, true).length, ROWS_SHOWN + 3);
});
