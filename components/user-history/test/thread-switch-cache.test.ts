// Guards the 10-18 thread switch: a switch back to AI harness waited 2.5 to 16 s for a fresh snapshot and then drew all 122 feed items, and an
// older page put in front changed every bubble's index key, so the whole feed drew again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatFeed } from "../src/shared/chat-feed.ts";
import { buildTurns } from "../src/shared/turns.ts";
import { keepOlder, newestPage, prependOlder, trimToNewest } from "../src/client/thread-pages.ts";
import { earlierTop, windowStart } from "../src/client/feed-window.ts";
import type { ThreadMessage, ThreadState } from "../src/shared/types.ts";

const user = (at: number, text: string): ThreadMessage => ({ role: "user", content: text, timestamp: at }) as ThreadMessage;
const reply = (at: number, text: string): ThreadMessage =>
  ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: at, api: "x", provider: "x", model: "x", usage: {} }) as unknown as ThreadMessage;
const thread = (messages: ThreadMessage[], older?: string): ThreadState =>
  ({ messages, streaming: null, queue: { steering: [], followUp: [] }, children: [], tools: [], retry: null, runStartedAt: null, connection: "connected", info: {} as ThreadState["info"],
    ...(older === undefined ? {} : { older }) }) as unknown as ThreadState;
const talk = (from: number, count: number): ThreadMessage[] =>
  Array.from({ length: count }, (_, index) => index % 2 ? reply(from + index, "answer " + index) : user(from + index, "ask " + index));

test("an older page put in front keeps every feed id and turn key of the messages already shown", () => {
  const newest = talk(1000, 20);
  const before = chatFeed(thread(newest)).map(item => item.id);
  const turnsBefore = buildTurns(newest).map(turn => turn.key);
  const paged = prependOlder(thread(newest, "m1000.0"), { messages: talk(900, 20), older: "m900.0" });
  assert.equal(paged.older, "m900.0");
  assert.deepEqual(chatFeed(paged).map(item => item.id).slice(-before.length), before);
  assert.deepEqual(buildTurns(paged.messages).map(turn => turn.key).slice(-turnsBefore.length), turnsBefore);
  const all = chatFeed(paged).map(item => item.id);
  assert.equal(new Set(all).size, all.length);
});

test("messages that share a timestamp get distinct ids", () => {
  const ids = chatFeed(thread([user(5, "a"), reply(5, "b"), user(5, "c")])).map(item => item.id);
  assert.equal(new Set(ids).size, 3);
});

test("a new snapshot over a held thread keeps the older pages when its first message is held, and replaces them otherwise", () => {
  const held = prependOlder(thread(talk(1000, 20), "m1000.0"), { messages: talk(900, 20), older: "m900.0" });
  const next = thread(talk(1010, 12), "m1010.0");
  const kept = keepOlder(held, next);
  assert.equal(kept.messages.length, 40 + 2);
  assert.equal(kept.older, "m900.0");
  const reset = keepOlder(held, thread(talk(5000, 10), "m5000.0"));
  assert.equal(reset.messages.length, 10);
  assert.equal(reset.older, "m5000.0");
});

test("a thread left alone goes back to the newest page of its last snapshot and what came after it", () => {
  const snapshot = thread(talk(1000, 20), "m1000.0");
  const newest = newestPage(snapshot);
  const grown = { ...prependOlder(snapshot, { messages: talk(900, 20), older: "m900.0" }), messages: [...talk(900, 20), ...talk(1000, 22)] };
  const trimmed = trimToNewest(grown, newest);
  assert.equal(trimmed.messages.length, 22);
  assert.equal(trimmed.older, "m1000.0");
});

test("the feed draws the newest items first, and its top stays on the same item as items land at either end", () => {
  const item = (key: string, at: number) => ({ key, at });
  const keys = Array.from({ length: 100 }, (_, index) => item("k" + index, 1000 + index));
  const start = windowStart(keys, null, 30);
  assert.equal(start, 70);
  const top = earlierTop(keys, start, 30);
  assert.equal(top?.key, "k40");
  const grown = [item("o1", 1), item("o2", 2), ...keys, item("n1", 5000)];
  assert.equal(grown[windowStart(grown, top, 30)]?.key, "k40");
  assert.equal(earlierTop(keys, 0, 30), null);
});
