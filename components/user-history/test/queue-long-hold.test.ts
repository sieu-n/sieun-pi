import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { queueLong, QUEUE_LONG_PER_SLOT } from "../src/chat-turn-queue.ts";
import { Wakes } from "../src/wakes.ts";
import type { AgentQueueReading } from "../src/shared/types.ts";

// At 15:17Z on 10-15 the pool queued 90 turns for a working limit of 12 while 75 workers held 31 GB and swap held 11 of 12 GB. Over the 2,529
// turns pi-pool admitted that day a turn waited 637 s or more at the median once 4 or more turns waited per slot, past Prime's 10 min idle
// eviction, and Prime never evicts a session whose run waits in the queue. A board.wake due then is held in its file, which costs nothing.

const reading = (queued: number, limit: number | null, max = 12): AgentQueueReading => ({
  enabled: true, macWorkingMax: max, macWorkingMaxSet: null, treeWorkingMax: 8, working: [],
  queued: Array.from({ length: queued }, (_, i) => ({ session: `s${i}`, tree: `s${i}`, parent: null, class: "high", baseClass: "low", position: i + 1, total: queued, since: 0, waitS: 0 })),
  governor: limit === null ? null : { on: true, level: "critical", limit, held: 0, since: 0, reading: null, changed: null },
}) as unknown as AgentQueueReading;

test("the queue is long from 4 queued turns per working slot, the point where the median wait of 10-15 passed 600 s", () => {
  assert.equal(QUEUE_LONG_PER_SLOT, 4);
  assert.equal(queueLong(reading(90, 12)), "the turn queue holds 90 turns for 12 slots", "15:17Z on 10-15");
  assert.equal(queueLong(reading(48, 12)), "the turn queue holds 48 turns for 12 slots");
  assert.equal(queueLong(reading(47, 12)), null);
  assert.equal(queueLong(reading(60, null, 30)), null, "no governor record: the owner's 30 slots");
  assert.equal(queueLong(null), null, "an unread queue holds nothing");
  assert.equal(queueLong({ ...reading(200, 12), enabled: false }), null);
});

test("a due wake stays in its file while the queue is long and goes out the first tick it is short", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wakes-hold-"));
  const session = "01a14000-3b80-7e6a-9a1f-0c7d4f8b2e11";
  await writeFile(join(dir, `${session}-time.json`), JSON.stringify({ session, on: { kind: "time", at: Date.parse("2026-10-15T15:10:00Z") }, note: "", since: 0 }));
  let queue = reading(90, 12);
  const sent: string[] = [];
  const lines: string[] = [];
  const wakes = new Wakes({ dir, now: () => Date.parse("2026-10-15T15:17:00Z"), log: line => lines.push(line), runState: async () => ({ done: false }),
    deliver: async id => { sent.push(id); return "sent"; }, hold: async () => queueLong(queue) });
  assert.equal(await wakes.tick(), 0);
  assert.equal(await wakes.tick(), 0);
  assert.deepEqual(sent, [], "the woken turn would wait with its worker loaded");
  assert.equal((await readdir(dir)).length, 1);
  assert.deepEqual(lines, ["wakes: 1 sessions due, held while the turn queue holds 90 turns for 12 slots"], "one line per hold, not one per tick");
  queue = reading(20, 12);
  assert.equal(await wakes.tick(), 1);
  assert.deepEqual(sent, [session]);
  assert.equal((await readdir(dir)).length, 0);
});
