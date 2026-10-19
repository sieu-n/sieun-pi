// Guards the 10-19 steady block: a scratch serve on a copy of the live data read the duty runs files about 30 times in each 30 s tick, and
// those parses held the main thread for 0.9 to 1.2 s every tick.
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DutyStore } from "../src/chat-duty-store.ts";
import type { DutyRunRecord } from "../src/shared/chat-duties.ts";

const CHAT = "01a115e2-9544-7204-b8db-8ce4d5319048";
const run = (at: number): DutyRunRecord => ({ duty: "d1", at, slot: at, trigger: "schedule", ms: 10, verdict: "met", metrics: {}, summary: `run ${at}` });

test("an unchanged runs file is parsed once, and an append or a rewrite is read again", async t => {
  const dir = await mkdtemp(join(tmpdir(), "duty-runs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DutyStore(dir);
  await store.appendRun(CHAT, run(1));
  await store.appendRun(CHAT, run(2));
  const first = await store.runs(CHAT);
  const again = await store.runs(CHAT);
  assert.deepEqual(first.map(record => record.at), [2, 1]);
  assert.equal(again[0], first[0], "the second read of an unchanged file gives the records of the first parse");
  assert.notEqual(again, first, "each caller gets its own array");

  await store.appendRun(CHAT, run(3));
  assert.deepEqual((await store.runs(CHAT)).map(record => record.at), [3, 2, 1]);

  assert.equal(await store.updateRun(CHAT, "d1", 2, record => { record.summary = "changed"; }), true);
  assert.equal((await store.runs(CHAT)).find(record => record.at === 2)?.summary, "changed");

  await appendFile(join(dir, "duties", `${CHAT}.runs.jsonl`), JSON.stringify(run(4)) + "\n");
  assert.deepEqual((await store.runs(CHAT)).map(record => record.at), [4, 3, 2, 1]);

  assert.equal(await store.remove(CHAT, "d1"), true);
  assert.deepEqual(await store.runs(CHAT), []);
});
