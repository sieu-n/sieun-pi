// mac load 10-26: each check-in, duty, catalog projection and poolWaiting call on us-metal02 read the Mac's relay /v1/host again, and each
// read started `pi-pool queue --json` and `pi-pool config` there: 26 Python processes every 10 s, 61,582 Gatekeeper exec checks from 04:36Z
// to 04:49Z against none in the 13 minutes before, and load 317 at 04:46Z.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hostsQueueRead } from "../src/chat-turn-queue.ts";
import type { AgentQueueReading } from "../src/shared/types.ts";

const own: AgentQueueReading = { enabled: true, workingMax: 24, workingMaxSet: null, treeWorkingMax: 60, working: [], queued: [] };
const macPool = { machine: {}, pool: { queue: { enabled: true, working_max: 30, tree_working_max: 16, working: [], queued: [] } } };

test("callers within the max age share one relay read, and a later caller reads again", async () => {
  let clock = 0, reads = 0;
  const read = hostsQueueRead(async () => own, () => [async () => { reads += 1; return macPool; }], 10_000, () => clock);
  await Promise.all(Array.from({ length: 20 }, () => read()));
  await read();
  assert.equal(reads, 1, "20 concurrent callers and one more within 10 s made one /v1/host read");
  clock = 10_000;
  await read();
  assert.equal(reads, 2);
});

test("a relay that throws reads as no box, and that reading is shared for the max age too", async () => {
  let reads = 0;
  const read = hostsQueueRead(async () => own, () => [async () => { reads += 1; throw new Error("relay away"); }], 10_000, () => 0);
  assert.deepEqual((await read()).queued, []);
  await read();
  assert.equal(reads, 1, "a relay that throws reads as no box, and that empty reading is shared like any other");
});
