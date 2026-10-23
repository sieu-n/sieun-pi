// 10-21: the prod run started each minute's 100 calls in one second, and prod /api/profiles reads in those seconds took 1.0 to 3.2 s (board goal p8).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ORGS, pacedSlot, perMinute } from "../scripts/duties/portal-parity.ts";

function clock() {
  let t = 1_000_000;
  const starts: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, starts, mark: () => starts.push(t) };
}

test("a paced run starts one call every 60 s / perMinute, not the whole quota at once", async () => {
  const c = clock();
  const slot = pacedSlot(100, c.now, c.sleep);
  for (let i = 0; i < 5; i++) { await slot(); c.mark(); }
  assert.deepEqual(c.starts.map(s => s - c.starts[0]!), [0, 600, 1200, 1800, 2400]);
});

test("no 60 s window holds more than perMinute starts, and a late call does not wait", async () => {
  const c = clock();
  const slot = pacedSlot(100, c.now, c.sleep);
  for (let i = 0; i < 250; i++) { await slot(); c.mark(); }
  for (const s of c.starts) assert.ok(c.starts.filter(x => x >= s && x < s + 60_000).length <= 100);
  const before = c.now();
  await c.sleep(120_000);
  await slot();
  assert.equal(c.now(), before + 120_000);
});

// 10-23 08:40:03Z: the unpaced staging run started 173 calls in one second, and the crawler's /api/live reads took 11.8 s at p50.
test("staging's test orgs are paced too: 173 calls start one every 0.2 s, never 173 in one second", async () => {
  const c = clock();
  const slot = pacedSlot(perMinute(Array.from({ length: ORGS })), c.now, c.sleep);
  for (let i = 0; i < 173; i++) { await slot(); c.mark(); }
  for (const s of c.starts) assert.ok(c.starts.filter(x => x >= s && x < s + 1_000).length <= 5);
  assert.equal(c.starts.at(-1)! - c.starts[0]!, 172 * 200);
  assert.equal(perMinute([{}]), 100);
});
