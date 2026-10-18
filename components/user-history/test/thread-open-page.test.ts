// Guards the 10-18 thread open incident: a thread snapshot carried about 1,000 messages (up to 1.28 MB), Show earlier read the AI harness chat's whole 171 MB session file, and the owner waited 6 to 52 s for a thread to show.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { FIRST_PAGE_MESSAGES, PAGE_MESSAGES } from "../src/session-tail.ts";
import { messageKey } from "../src/shared/message-key.ts";
import type { ThreadEvent, ThreadMessage } from "../src/shared/types.ts";

const ID = "01a1164b-0000-7000-8000-000000000000";
const MESSAGES = 3000;
const BODY = 12_000;

/** A version 3 session file of MESSAGES alternating user and assistant messages of BODY characters each (about 37 MB); every 50th pair shares a timestamp. */
async function sessionFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "thread-open-"));
  const file = join(dir, ID + ".jsonl");
  const lines = [JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-10-18T00:00:00.000Z", cwd: dir })];
  let parent: string | null = null;
  let stamp = Date.parse("2026-10-18T00:00:00.000Z");
  for (let index = 0; index < MESSAGES; index++) {
    if (index % 50 !== 1) stamp += 1000;
    const id = index.toString(16).padStart(8, "0");
    const text = `message ${index} ` + "x".repeat(BODY);
    const message = index % 2 === 0 ? { role: "user", content: text, timestamp: stamp }
      : { role: "assistant", content: [{ type: "text", text }], provider: "anthropic", model: "claude", api: "anthropic-messages", stopReason: "stop", timestamp: stamp,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    lines.push(JSON.stringify({ type: "message", id, parentId: parent, timestamp: new Date(stamp).toISOString(), message }));
    parent = id;
  }
  await writeFile(file, lines.join("\n") + "\n");
  return file;
}

/** Bytes this process read through any read call so far (Linux `rchar`), so a whole-file read by any path shows. */
function bytesRead(): number {
  return Number(/rchar: (\d+)/.exec(readFileSync("/proc/self/io", "utf8"))![1]);
}

test("thread open: the first frame holds the newest page and older pages read only their own bytes, never the whole session file", { skip: !existsSync("/proc/self/io") }, async t => {
  const file = await sessionFile();
  t.after(() => rm(dirname(file), { recursive: true, force: true }));
  const size = readFileSync(file).length;
  const catalog = { summary: async (id: string) => ({ sessionId: id, sessionFile: file, cwd: "/", lifecycle: "saved", messageCount: MESSAGES }), hostOf: () => null } as unknown as Catalog;
  const hub = new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  const events: ThreadEvent[] = [];
  const before = bytesRead();
  await hub.subscribe(ID, event => events.push(event));
  const openRead = bytesRead() - before;
  const [preview, first] = events;
  assert.ok(preview?.type === "snapshot" && preview.snapshot.messages.length < FIRST_PAGE_MESSAGES, "a preview of the newest messages comes first (thread-first-page.test.ts)");
  assert.equal(first?.type, "snapshot");
  if (first?.type !== "snapshot") return;
  const page = first.snapshot.messages;
  assert.ok(page.length >= FIRST_PAGE_MESSAGES && page.length <= FIRST_PAGE_MESSAGES + 2, `the first frame holds the newest page, not ${page.length} messages`);
  assert.match(page.at(-1)!.role === "assistant" ? JSON.stringify(page.at(-1)) : "", new RegExp(`message ${MESSAGES - 1} `));
  assert.equal(first.snapshot.board, undefined, "the board is not in the snapshot frame");
  assert.equal(first.snapshot.children, undefined, "the children are not in the snapshot frame");
  assert.ok(openRead < size / 2, `the open read ${openRead} bytes of a ${size}-byte session file`);

  // Scroll back to the first message: every page reads its own bytes, and the pages join with no gap and no repeat.
  const all: ThreadMessage[] = [...page];
  let cursor = first.snapshot.older;
  let pages = 0;
  while (cursor) {
    const start = bytesRead();
    const older = await hub.olderPage(ID, cursor);
    const read = bytesRead() - start;
    assert.ok(read < size / 4, `an older page read ${read} bytes of a ${size}-byte session file`);
    assert.ok(older.messages.length <= PAGE_MESSAGES + 2, `an older page holds ${older.messages.length} messages`);
    all.unshift(...older.messages);
    cursor = older.older;
    pages++;
  }
  assert.ok(pages > 3, "the history came in several pages");
  const indices = all.map(message => Number(/message (\d+) /.exec(message.role === "user" ? String(message.content) : message.role === "assistant" && message.content[0]?.type === "text" ? message.content[0].text : "")?.[1]));
  assert.deepEqual(indices, Array.from({ length: MESSAGES }, (_, index) => index), "every message once, in order");

  // A part by message key works on a message from an older page, and reads back only as far as that message.
  const index = MESSAGES - FIRST_PAGE_MESSAGES - 50;
  const start = bytesRead();
  const part = await hub.part(ID, messageKey(all, index), 0);
  assert.ok(bytesRead() - start < size / 4, "a part read back only to its message");
  assert.ok(part.text.startsWith(`message ${index} `));
  await hub.close();
});
