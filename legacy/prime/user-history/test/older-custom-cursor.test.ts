// Guards 03:47Z on 11-05: right after a chat restart the owner's page asked for the page before the first page of the sep launch thread, a Mac
// chat whose first page starts at an agent message. The file walk matched a message only by a "timestamp":<ms> in its line, which a custom
// message (agent messages and notices), a compaction or a branch summary lacks, so the walk missed it, read the file again through the
// Mac relay (975 ms), and answered 409, which reopens the thread; the minute's slowest read took 1.4 s (d7 clean_min_30).
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { findMessage } from "../src/session-tail.ts";

const ID = "01a15427-0000-7000-8000-00000000c0de";
const MESSAGES = 300;
const START = Date.parse("2026-11-04T08:00:00.000Z");
const stampOf = (index: number) => START + index * 1000;

/** User messages, with an agent message (a custom message) at every tenth place and a compaction at 150. */
function sessionLines(): string {
  const lines = [JSON.stringify({ type: "session", version: 3, id: ID, timestamp: new Date(START).toISOString(), cwd: "/Users/owner" })];
  let parent: string | null = null;
  for (let index = 0; index < MESSAGES; index++) {
    const id = index.toString(16).padStart(8, "0");
    const timestamp = new Date(stampOf(index)).toISOString();
    const text = `message ${index}`;
    lines.push(JSON.stringify(index === 150 ? { type: "compaction", id, parentId: parent, timestamp, summary: text, firstKeptEntryId: id, tokensBefore: 1 }
      : index % 10 === 0 ? { type: "custom_message", customType: "agent_message", content: text, display: true, details: {}, id, parentId: parent, timestamp }
      : { type: "message", id, parentId: parent, timestamp, message: { role: "user", content: text, timestamp: stampOf(index) } }));
    parent = id;
  }
  return lines.join("\n") + "\n";
}

test("a message cursor at an agent message or a compaction is found in the held copy, with no relay read and no 409", async t => {
  const dir = await mkdtemp(join(tmpdir(), "older-custom-cursor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const copy = join(dir, ID + ".jsonl");
  await writeFile(copy, sessionLines());
  const size = (await stat(copy)).size;
  const relayed: string[] = [];
  const catalog = {
    summary: async (id: string) => ({ sessionId: id, sessionFile: `/Users/owner/.prime/agent/sessions/${id}.jsonl`, cwd: "/", lifecycle: "saved", messageCount: MESSAGES }),
    hostOf: () => "mac",
    heldCopy: () => ({ file: copy, size }),
    localFile: async (summary: { sessionId: string }) => { relayed.push(summary.sessionId); return copy; },
  } as unknown as Catalog;
  const hub = new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(() => hub.close());

  for (const index of [290, 150]) {
    const page = await hub.olderPage(ID, `m${stampOf(index)}.0`);
    assert.equal(JSON.stringify(page.messages.at(-1)).includes(`message ${index - 1}"`), true, `the page before ${index} ends right before it`);
  }
  assert.deepEqual(relayed, [], "the copy held both messages, so the relay was not asked");

  const read = { bytes: 0 };
  assert.equal((await findMessage(copy, stampOf(290), 0, null, read))?.entry.id, (290).toString(16).padStart(8, "0"));
  assert.ok(read.bytes <= size, `the walk read ${read.bytes} bytes`);
});
