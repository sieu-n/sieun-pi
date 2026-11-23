/**
 * pi-host removes a job with `DELETE /api/threads/:id/wakes?conversation=<n>`: the job's pending wakes go, and other conversations keep theirs.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/drop-wakes.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FIXTURE_IDS } from "../../server/fixture/seed.ts";
import { start } from "./helpers.ts";

const MIN = 60_000;

test("deleting a job's wakes drops only that conversation's, and a root conversation is refused", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "apps-chat-drop-wakes-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const chat = await start({ dataDir });
  t.after(() => chat.close());
  const thread = FIXTURE_IDS.vent;
  const arm = (conversation: number, note: string) =>
    chat.send("POST", `/api/threads/${thread}/wakes`, { conversation, on: { kind: "check", command: "exit 1", every: 5 * MIN, at: Date.now() + 60 * MIN }, note, id: `${thread}-${conversation}-${note}` });
  for (const [conversation, note] of [[4, "a"], [4, "b"], [5, "c"]] as const) assert.equal((await arm(conversation, note)).status, 200);
  const dropped = await chat.send("DELETE", `/api/threads/${thread}/wakes?conversation=4`);
  assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
  assert.deepEqual(dropped.body, { dropped: 2 });
  assert.deepEqual((await chat.send("GET", `/api/threads/${thread}/wakes?conversation=4`)).body, { wakes: [] });
  assert.equal(((await chat.send("GET", `/api/threads/${thread}/wakes?conversation=5`)).body as { wakes: unknown[] }).wakes.length, 1);
  assert.deepEqual(readdirSync(join(dataDir, "wakes")).filter(name => name.endsWith(".json")), [`${thread}-5-c.json`]);
  assert.equal((await chat.send("DELETE", `/api/threads/${thread}/wakes?conversation=1`)).status, 400);
});
