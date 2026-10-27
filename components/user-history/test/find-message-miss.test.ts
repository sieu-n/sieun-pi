// Guards 07:36Z and 07:37Z on 10-27: a part read for a message not in Crawler VP's session file read undefined from findMessage, and the
// whole-file read that undefined calls for held the chat's event loop 1.8 and 1.9 s.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findMessage } from "../src/session-tail.ts";

const ID = "01a115e2-0000-7000-8000-000000000000";
const START = Date.parse("2026-10-27T05:00:00.000Z");

test("findMessage reads null for a message the branch does not hold, and finds one saved long after its stamp", async t => {
  const dir = await mkdtemp(join(tmpdir(), "find-message-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, ID + ".jsonl");
  const lines = [JSON.stringify({ type: "session", version: 3, id: ID, timestamp: new Date(START).toISOString(), cwd: dir })];
  const stamps = [START, START + 1000, START + 2000, START + 20];
  const written = [START, START + 1000, START + 2 * 3_600_000, START + 3 * 3_600_000];
  stamps.forEach((stamp, index) => lines.push(JSON.stringify({ type: "message", id: `m${index}`, parentId: index ? `m${index - 1}` : null,
    timestamp: new Date(written[index]!).toISOString(), message: { role: "user", content: `message ${index}`, timestamp: stamp } })));
  await writeFile(file, lines.join("\n") + "\n");

  assert.equal(await findMessage(file, START + 500, 0), null, "a stamp no message has");
  assert.equal(await findMessage(file, START + 2, 0), null, "a stamp that only prefixes another");
  assert.equal(await findMessage(file, START, 1), null, "a second message at a stamp only one has");
  assert.equal((await findMessage(file, START + 2000, 0))?.entry.id, "m2", "saved 2 h after its stamp");
  assert.equal((await findMessage(file, START, 0))?.entry.id, "m0");
  await writeFile(file, JSON.stringify({ type: "session", version: 1, id: ID }) + "\n");
  assert.equal(await findMessage(file, START, 0), undefined, "a file a full open must migrate");
});
