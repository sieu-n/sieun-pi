// Guards the 10-18 06:40Z incident: from Korea (186 ms round trip) a new chat painted 1.25 to 1.63 s after a click, because its first frame was 100 messages, 68 to 84 KB of JSON, more than a fresh connection sends in one round trip.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { FIRST_PAGE_BYTES, PREVIEW_CHARS } from "../src/first-page.ts";
import { FIRST_PAGE_MESSAGES } from "../src/session-tail.ts";
import type { ThreadEvent, ThreadMessage } from "../src/shared/types.ts";

const ID = "01a1164b-0000-7000-8000-000000000001";
const ROUNDS = 100;
const OWNER_TEXT = "Done. " + "The thread opens in one round trip now. ".repeat(40);

/** A chat's session: per round a job message, an ipython call with a long cell, its long output, and a tell_owner call with a long text. */
async function sessionFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "first-page-"));
  const file = join(dir, ID + ".jsonl");
  const lines = [JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-10-18T00:00:00.000Z", cwd: dir })];
  let parent: string | null = null;
  let stamp = Date.parse("2026-10-18T00:00:00.000Z");
  let count = 0;
  const add = (entry: Record<string, unknown>) => {
    stamp += 1000;
    const id = (count++).toString(16).padStart(8, "0");
    lines.push(JSON.stringify({ ...entry, id, parentId: parent, timestamp: new Date(stamp).toISOString() }));
    parent = id;
  };
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (content: unknown[]) => ({ role: "assistant", content, provider: "anthropic", model: "claude", api: "anthropic-messages", stopReason: "toolUse", timestamp: stamp + 1000, usage });
  for (let round = 0; round < ROUNDS; round++) {
    add({ type: "custom_message", customType: "agent_message", content: `from worker-${round}\n` + "report line\n".repeat(150), display: true });
    add({ type: "message", message: assistant([{ type: "thinking", thinking: "t".repeat(2000) }, { type: "toolCall", id: `call-${round}`, name: "ipython", arguments: { code: "print(1)\n".repeat(400) } }]) });
    add({ type: "message", message: { role: "toolResult", toolCallId: `call-${round}`, toolName: "ipython", content: [{ type: "text", text: "output\n".repeat(700) }], isError: false, timestamp: stamp + 1000 } });
    add({ type: "message", message: assistant([{ type: "toolCall", id: `tell-${round}`, name: "tell_owner", arguments: { text: OWNER_TEXT } }]) });
  }
  await writeFile(file, lines.join("\n") + "\n");
  return file;
}

const snapshotOf = (event: ThreadEvent | undefined) => event?.type === "snapshot" ? event.snapshot : assert.fail(`expected a snapshot, got ${event?.type}`);

test("first page: a new feed gets the newest messages within FIRST_PAGE_BYTES with work-row content cut to previews, then the full page", async () => {
  const file = await sessionFile();
  const catalog = { summary: async (id: string) => ({ sessionId: id, sessionFile: file, cwd: "/", lifecycle: "saved", messageCount: ROUNDS * 4 }), hostOf: () => null, heldCopy: () => undefined } as unknown as Catalog;
  const hub = new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  const events: ThreadEvent[] = [];
  await hub.subscribe(ID, event => events.push(event));
  const preview = snapshotOf(events[0]);
  const full = snapshotOf(events[1]);

  const messageBytes = JSON.stringify(preview.messages).length;
  assert.ok(messageBytes <= FIRST_PAGE_BYTES, `the first frame's messages are ${messageBytes} bytes of JSON`);
  assert.ok(preview.messages.length >= 20, `the first frame holds ${preview.messages.length} messages`);
  assert.ok(full.messages.length >= FIRST_PAGE_MESSAGES, "the full page follows");
  assert.deepEqual(preview.messages.map(message => message.timestamp), full.messages.slice(-preview.messages.length).map(message => message.timestamp), "the preview is the newest messages of the full page");

  const toolResult = preview.messages.find((message): message is Extract<ThreadMessage, { role: "toolResult" }> => message.role === "toolResult")!;
  assert.deepEqual(toolResult.content, [{ type: "text", text: "", truncated: true }], "tool output loads on expand");
  const calls = preview.messages.flatMap(message => message.role === "assistant" ? message.content : []);
  const ipython = calls.find(part => part.type === "toolCall" && part.name === "ipython");
  assert.ok(ipython?.type === "toolCall" && ipython.truncated && String(ipython.arguments.code).length === PREVIEW_CHARS, "the cell keeps what the collapsed row shows");
  const told = calls.find(part => part.type === "toolCall" && part.name === "tell_owner");
  assert.ok(told?.type === "toolCall" && told.arguments.text === OWNER_TEXT && !told.truncated, "the owner's message is whole");
  const fullResult = full.messages.find(message => message.role === "toolResult");
  assert.ok(fullResult?.role === "toolResult" && fullResult.content[0]?.type === "text" && fullResult.content[0].text.length > 0, "the full page carries the usual previews");

  // Scrolling up from the first frame's cursor joins it with no gap and no repeat.
  const older = await hub.olderPage(ID, preview.older!);
  const joined = [...older.messages, ...preview.messages].map(message => message.timestamp);
  const held = full.messages.map(message => message.timestamp);
  assert.deepEqual(joined.slice(-held.length), held.slice(-joined.length), "the older page ends where the first frame starts");

  // The page shell inlines the same first frame.
  const thread = await hub.open(ID);
  assert.deepEqual(snapshotOf(thread.firstFrame()).messages, preview.messages);
  await hub.close();
});
