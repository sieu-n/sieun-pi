import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { SessionSummary } from "prime-agent";
import type { Catalog } from "../src/chat-catalog.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import { messageText } from "../src/shared/turns.ts";

/**
 * Frontend bro's transcript is 64 MB with 10 compactions and the VP chat's 130 MB with 32. Every open of a thread (a pin coming back, a tab,
 * a stall check) parsed the whole file in the hub, so its cost grew with the session. These tests write a 40 MB transcript with 20 compactions
 * and count the bytes the hub reads from disk while it opens the thread.
 */
const SESSION = "01a1-tail-test";
const MESSAGES = 20_000;
const COMPACT_EVERY = 1_000;
const PAD = "x".repeat(2_000);
const at = "2026-10-12T16:57:20.082Z";
/** The open may read the tail it shows and a chunk around it; the whole file is 40 MB. */
const OPEN_BYTES = 16 * 1024 * 1024;

let dir: string;
let file: string;
let size: number;
let bytesRead = 0;
const original = { readFileSync: fs.readFileSync };
let restoreHandleRead: () => void = () => {};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "history-tail-"));
  file = join(dir, SESSION + ".jsonl");
  const lines = [JSON.stringify({ type: "session", version: 3, id: SESSION, timestamp: at, cwd: dir })];
  let parent: string | null = null;
  const ids: string[] = [];
  for (let index = 0; index < MESSAGES; index++) {
    const id = "m" + index;
    const message = index % 2 === 0 ? { role: "user", content: [{ type: "text", text: `message ${index} ${PAD}` }], timestamp: index }
      : { role: "assistant", content: [{ type: "text", text: `message ${index} ${PAD}` }], provider: "anthropic", model: "claude-opus-4-5", api: "anthropic-messages",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: index };
    lines.push(JSON.stringify({ type: "message", id, parentId: parent, timestamp: at, message }));
    ids.push(id);
    parent = id;
    // Each compaction keeps the last 20 messages before it; the last one leaves 40 live messages after its first kept entry, m19960.
    if ((index + 21) % COMPACT_EVERY === 0) {
      const compaction = "c" + index;
      lines.push(JSON.stringify({ type: "compaction", id: compaction, parentId: parent, timestamp: at, summary: `summary up to ${index}`, firstKeptEntryId: ids[index - 19], tokensBefore: 150_000 }));
      parent = compaction;
    }
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
  size = fs.statSync(file).size;

  // Both ways the hub reads a session file: SessionManager's readFileSync (whole file) and a FileHandle read (a slice).
  fs.readFileSync = function (this: unknown, ...args: Parameters<typeof fs.readFileSync>) {
    const out = original.readFileSync.apply(this, args);
    bytesRead += out.length;
    return out;
  } as typeof fs.readFileSync;
  syncBuiltinESMExports();
  const handle = await fs.promises.open(file, "r");
  const proto = Object.getPrototypeOf(handle) as { read: (...input: unknown[]) => Promise<{ bytesRead: number }> };
  await handle.close();
  const read = proto.read;
  proto.read = async function (this: unknown, ...input: unknown[]) {
    const result = await read.apply(this, input);
    bytesRead += result.bytesRead;
    return result;
  };
  restoreHandleRead = () => { proto.read = read; };
});

after(async () => {
  fs.readFileSync = original.readFileSync;
  syncBuiltinESMExports();
  restoreHandleRead();
  await rm(dir, { recursive: true, force: true });
});

function hubFor(summary: SessionSummary): ThreadHub {
  const catalog = { summary: async () => summary, refresh: async () => {}, connect: async () => {}, hostOf: () => null } as unknown as Catalog;
  return new ThreadHub("/nonexistent.sock", catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
}

const textOf = (message: { role: string } | undefined): string => message && (message.role === "user" || message.role === "assistant")
  ? messageText(message as unknown as Parameters<typeof messageText>[0]).split(" ").slice(0, 2).join(" ") : message?.role ?? "none";

test("opening a saved thread with a 40 MB transcript reads its tail, not the whole file, and Show earlier reads the rest", async t => {
  assert.ok(size > 40_000_000, `the transcript is ${size} bytes`);
  const hub = hubFor({ sessionId: SESSION, cwd: dir, sessionFile: file } as SessionSummary);
  bytesRead = 0;
  const started = performance.now();
  const thread = await hub.open(SESSION);
  const ms = performance.now() - started;
  const read = bytesRead;
  const state = thread.state as typeof thread.state & { older?: boolean };
  t.diagnostic(`the open read ${read} bytes of a ${size}-byte file in ${Math.round(ms)} ms`);
  assert.ok(read < OPEN_BYTES, `the open read ${read} bytes of a ${size}-byte file in ${Math.round(ms)} ms`);
  assert.equal(textOf(state.messages.at(-1)), `message ${MESSAGES - 1}`, "the feed ends at the last message");
  assert.ok(state.messages.length < MESSAGES / 4, `the feed holds the tail, ${state.messages.length} messages`);
  assert.equal(state.older, true, "the feed knows older messages are left in the file");

  await (hub as unknown as { older(id: string): Promise<void> }).older(SESSION);
  const whole = hub.state(SESSION) as typeof thread.state & { older?: boolean };
  assert.equal(whole.messages.length, MESSAGES + MESSAGES / COMPACT_EVERY, "Show earlier loads every message and compaction marker");
  assert.equal(textOf(whole.messages[0]), "message 0");
  assert.ok(!whole.older);
  await hub.close();
});

test("attaching a live compacted thread reads the turns before the compaction from the tail of the file, not the whole file", async t => {
  const hub = hubFor({ sessionId: SESSION, cwd: dir, sessionFile: file, activeSessionId: "active-1" } as SessionSummary);
  // The daemon's live context after the 20th compaction: its summary, then the 40 messages from its first kept entry on.
  const kept = Array.from({ length: 40 }, (_, offset) => MESSAGES - 40 + offset).map(index => ({ role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `message ${index} ${PAD}` }], timestamp: index }));
  const live = [{ role: "compactionSummary", summary: "summary up to 19979", tokensBefore: 150_000, timestamp: MESSAGES }, ...kept];
  const connection = {
    getInitialSnapshot: async () => ({ state: { sessionId: SESSION, cwd: dir, thinkingLevel: "off", availableThinkingLevels: [], isStreaming: false, isCompacting: false,
      isBashRunning: false, retryAttempt: 0, messageCount: live.length, sessionActions: { queuedCount: 0 } }, messages: live, children: [] }),
    getQueue: async () => ({ steering: [], followUp: [] }),
  };
  const internals = hub as unknown as { liveSnapshot(connection: unknown, summary: SessionSummary): Promise<{ messages: { role: string }[]; older?: boolean }> };
  bytesRead = 0;
  const snapshot = await internals.liveSnapshot(connection, { sessionId: SESSION, cwd: dir, sessionFile: file } as SessionSummary);
  const read = bytesRead;
  t.diagnostic(`the attach read ${read} bytes of a ${size}-byte file`);
  assert.ok(read < OPEN_BYTES, `the attach read ${read} bytes of a ${size}-byte file`);
  const first = snapshot.messages.findIndex(message => message.role === "compactionSummary" && snapshot.messages.indexOf(message) > 0 &&
    textOf(snapshot.messages[snapshot.messages.indexOf(message) + 1]) === `message ${MESSAGES - 40}`);
  assert.ok(first > 0, "the live context follows the turns read back from the file");
  assert.equal(textOf(snapshot.messages[first - 1]), `message ${MESSAGES - 41}`, "the last compacted turn sits right before the live context's summary");
  assert.equal(textOf(snapshot.messages.at(-1)), `message ${MESSAGES - 1}`);
  assert.equal(snapshot.older, true);
  await hub.close();
});
