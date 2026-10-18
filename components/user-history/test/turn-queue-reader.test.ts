// 10-18 on us-metal02: api/threads/<id>/agents answered in 1 to 7 s, because it waits for a catalog projection and every projection asked the
// turn queue, whose read waits out the pool's tick and a `pi-pool snapshot` once its reading is 10 s old (up to 3.6 s through api/agent-queue).
import assert from "node:assert/strict";
import { test } from "node:test";
import { queueReader } from "../src/chat-turn-queue.ts";
import type { AgentQueueReading } from "../src/shared/types.ts";

const reading = (session: string): AgentQueueReading => ({ enabled: true, workingMax: 16, workingMaxSet: null, treeWorkingMax: 8, working: [],
  queued: [{ session, tree: "t", parent: null, priority: "normal", basePriority: "normal", since: 1, position: 1, total: 1, waitMs: 0 }] });

test("the queue reader answers at once with the last places and reads again behind them", async () => {
  const answers: ((value: AgentQueueReading) => void)[] = [];
  const queued = queueReader(() => new Promise(resolve => { answers.push(resolve); }));
  const first = queued();
  answers[0]!(reading("s1"));
  assert.deepEqual([...(await first).keys()], ["s1"]);
  const second = await Promise.race([queued(), new Promise(resolve => setTimeout(() => resolve("waited"), 50))]);
  assert.notEqual(second, "waited", "a projection does not wait for the pool's next read");
  assert.deepEqual([...(second as Map<string, unknown>).keys()], ["s1"]);
  assert.equal(answers.length, 2, "the next read started behind the answer");
  queued();
  assert.equal(answers.length, 2, "asks while a read runs share it");
  answers[1]!(reading("s2"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...(await queued()).keys()], ["s2"]);
});

test("a queue read that fails gives no places", async () => {
  const queued = queueReader(() => Promise.reject(new Error("pi-pool failed")));
  assert.equal((await queued()).size, 0);
});
