// Guards d7's dirty minutes of 10-22 15:01, 15:16 and 15:27Z: in the seconds after each chat release the owner's page asked for an older page of
// a Mac chat, and the read waited 1.6 to 2.4 s on the Mac relay to bring this box's copy of the file up to date, though the page sat in the copy.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import type { OlderPage } from "../src/shared/types.ts";

const ID = "01a15427-0000-7000-8000-000000000000";
const MESSAGES = 400;
const START = Date.parse("2026-10-22T15:00:00.000Z");
const stampOf = (index: number) => START + index * 1000;

function sessionLines(): string {
  const lines = [JSON.stringify({ type: "session", version: 3, id: ID, timestamp: new Date(START).toISOString(), cwd: "/Users/owner" })];
  let parent: string | null = null;
  for (let index = 0; index < MESSAGES; index++) {
    const id = index.toString(16).padStart(8, "0");
    const timestamp = stampOf(index);
    const text = `message ${index}`;
    const message = index % 2 === 0 ? { role: "user", content: text, timestamp }
      : { role: "assistant", content: [{ type: "text", text }], provider: "anthropic", model: "claude", api: "anthropic-messages", stopReason: "stop", timestamp,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    lines.push(JSON.stringify({ type: "message", id, parentId: parent, timestamp: new Date(timestamp).toISOString(), message }));
    parent = id;
  }
  return lines.join("\n") + "\n";
}

const shown = (page: OlderPage): number[] => page.messages.map(message => Number(/message (\d+)/.exec(JSON.stringify(message))?.[1]));

test("an older page of another box's chat reads the copy this box holds, and asks that box only for a place past the copy", async t => {
  const dir = await mkdtemp(join(tmpdir(), "older-held-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const copy = join(dir, ID + ".jsonl");
  await writeFile(copy, sessionLines());
  const size = (await stat(copy)).size;
  const synced: string[] = [];
  const catalog = {
    summary: async (id: string) => ({ sessionId: id, sessionFile: `/Users/owner/.prime/agent/sessions/${id}.jsonl`, cwd: "/", lifecycle: "saved", messageCount: MESSAGES }),
    hostOf: () => "mac",
    heldCopy: () => ({ file: copy, size }),
    localFile: async (summary: { sessionId: string }) => { synced.push(summary.sessionId); return copy; },
  } as unknown as Catalog;
  const hub = new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(() => hub.close());

  // A fresh service after a release: the thread is not open yet, so the page's message cursor is looked up in the file.
  const first = await hub.olderPage(ID, `m${stampOf(300)}.0`);
  assert.deepEqual(synced, [], "the copy held the message, so the relay was not asked");
  const numbers = shown(first);
  assert.equal(numbers.at(-1), 299, "the page ends right before the cursor's message");
  assert.ok(first.older?.startsWith("f"), "the next page has a file cursor");

  const second = await hub.olderPage(ID, first.older!);
  assert.deepEqual(synced, [], "a file cursor inside the copy reads the copy");
  assert.equal(shown(second).at(-1), numbers[0]! - 1, "the pages join with no gap");

  // A place past what the copy holds still brings the copy up to date first.
  await hub.olderPage(ID, `f${size + 100}.000000c7`).catch(() => undefined);
  assert.deepEqual(synced, [ID], "a file cursor past the copy asks the relay");
  await hub.olderPage(ID, `m${stampOf(MESSAGES + 5)}.0`).catch(() => undefined);
  assert.deepEqual(synced, [ID, ID], "a message the copy lacks asks the relay");
});
