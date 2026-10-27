// Guards the 10-18 08:16Z owner send that bounced with 'Timed out after 30000ms waiting for the Prime Agent daemon response to "attach"': a red
// toast, the bubble gone and the text back in the box. A send now stays in the page outbox and goes again with its own id until the server holds it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryStorage, PageOutbox, pendingOf, type OutboxView, type PageSend } from "../src/client/outbox.ts";
import { chatFeed, settledPending } from "../src/shared/chat-feed.ts";
import type { OutboxAccepted, OutboxEntry, OutboxState } from "../src/shared/outbox.ts";
import type { ThreadMessage } from "../src/shared/types.ts";

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

const entry = (send: PageSend, state: OutboxState, error?: string): OutboxEntry =>
  ({ id: send.id, threadId: send.threadId, text: send.text, imageCount: send.images.length, state, at: send.at, attempts: 0, ...(error ? { error } : {}) });

/** A page outbox whose POST answers come from `answer`, in order; it records every POSTed id. */
function page(storage = memoryStorage(), answer: (send: PageSend, call: number) => OutboxState | Error | "hang" = () => "queued") {
  const posted: string[] = [];
  let view: OutboxView = { sends: [], sent: [] };
  const outbox = new PageOutbox({
    storage,
    post: async send => {
      posted.push(send.id);
      const result = answer(send, posted.length);
      if (result === "hang") return new Promise<OutboxAccepted>(() => {});
      if (result instanceof Error) throw result;
      return { accepted: true, outbox: entry(send, result) };
    },
    status: error => error instanceof HttpError ? error.status : null,
    onChange: next => { view = next; },
    sleep: async () => {},
  });
  return { outbox, storage, posted, view: () => view };
}

const send = (id: string, text = "hello", at = 1000) => ({ id, threadId: "t1", text, images: [{ type: "image" as const, mimeType: "image/png", data: "aGk=" }], at });
const userMessage = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp }) as unknown as ThreadMessage;

test("a reload in the middle of a send keeps the entry, shows it as sending, and posts it again with the same id", async () => {
  const storage = memoryStorage();
  const first = page(storage, () => "hang");
  void first.outbox.submit(send("a1"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(first.posted, ["a1"]);
  assert.equal(storage.sends.get("a1")?.state, "posting");
  // The reload: a new page on the same storage.
  const second = page(storage);
  await second.outbox.resend();
  assert.equal(pendingOf(second.view())["t1"]?.[0]?.id, "a1");
  await second.outbox.idle();
  assert.deepEqual(second.posted, ["a1"]);
  assert.equal(storage.sends.get("a1")?.state, "held");
  const items = chatFeed({ messages: [], streaming: null, wait: null }, pendingOf(second.view())["t1"]);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind === "user" && items[0].pending, true);
});

test("a send the server cannot take yet goes again with the same id until it is held, and shows no failure", async () => {
  const errors = [new TypeError("fetch failed"), new HttpError(503, "Service Unavailable"), new HttpError(504, 'Timed out after 30000ms waiting for the Prime Agent daemon response to "attach"')];
  const tab = page(memoryStorage(), (_send, call) => errors[call - 1] ?? "queued");
  await tab.outbox.submit(send("b1"));
  assert.equal(tab.view().sends[0]?.state, "posting");
  await tab.outbox.idle();
  assert.deepEqual(tab.posted, ["b1", "b1", "b1", "b1"]);
  assert.equal(tab.view().sends[0]?.state, "held");
  assert.equal(pendingOf(tab.view())["t1"]?.[0]?.failed, undefined);
});

test("a double submit of one message makes one entry, one id and one POST", async () => {
  const tab = page();
  await Promise.all([tab.outbox.submit(send("c1")), tab.outbox.submit(send("c1"))]);
  await tab.outbox.idle();
  assert.equal(tab.view().sends.length, 1);
  assert.equal(tab.storage.sends.size, 1);
  assert.deepEqual(tab.posted, ["c1"]);
});

test("a failed send shows the note state with its reason, and Retry sends it again under a new id", async () => {
  const tab = page();
  await tab.outbox.submit(send("d1"));
  await tab.outbox.idle();
  // Accepted, then the server's outbox event says it cannot go.
  const held = tab.view().sends[0]!;
  await tab.outbox.server([entry(held, "failed", "The chat was archived before this message went.")]);
  const pending = pendingOf(tab.view())["t1"]!;
  assert.equal(pending[0]?.failed, "The chat was archived before this message went.");
  const item = chatFeed({ messages: [], streaming: null, wait: null }, pending)[0];
  assert.ok(item?.kind === "user");
  assert.equal(item.failed, "The chat was archived before this message went.");
  assert.equal(item.pending, undefined);
  // A user message with the same text does not settle a send that never went.
  assert.equal(settledPending([userMessage("hello", 2000)], pending).size, 0);
  // A resend leaves a failed send alone.
  await tab.outbox.resend();
  await tab.outbox.idle();
  assert.deepEqual(tab.posted, ["d1"]);
  await tab.outbox.retry("d1", "d2", 3000);
  await tab.outbox.idle();
  assert.deepEqual(tab.view().sends.map(item => [item.id, item.state]), [["d2", "held"]]);
  assert.deepEqual([...tab.storage.sends.keys()], ["d2"]);
  assert.deepEqual(tab.posted, ["d1", "d2"]);
});

test("a 4xx answer fails the send at once, a 409 for its id counts as held, and Edit drops it", async () => {
  const tab = page(memoryStorage(), item => item.id === "e1" ? new HttpError(400, "Add a message or image.") : new HttpError(409, "This request ID belongs to a different message."));
  await tab.outbox.submit(send("e1"));
  await tab.outbox.submit(send("e2", "second", 1001));
  await tab.outbox.idle();
  assert.deepEqual(tab.view().sends.map(item => [item.id, item.state, item.error]), [["e1", "failed", "Add a message or image."], ["e2", "held", undefined]]);
  assert.deepEqual(tab.posted, ["e1", "e2"]);
  await tab.outbox.drop("e1");
  assert.deepEqual([...tab.storage.sends.keys()], ["e2"]);
});

test("a delivered send leaves the outbox and draws as a normal bubble until the thread echoes it", async () => {
  const tab = page();
  await tab.outbox.submit(send("f1"));
  await tab.outbox.submit(send("f2", "other", 1001));
  await tab.outbox.idle();
  await tab.outbox.server([entry(tab.view().sends[0]!, "delivered")]);
  assert.deepEqual([...tab.storage.sends.keys()], ["f2"]);
  const pending = pendingOf(tab.view())["t1"]!;
  assert.deepEqual(pending.map(item => [item.id, item.sent ?? false]), [["f1", true], ["f2", false]]);
  const items = chatFeed({ messages: [], streaming: null, wait: null }, pending);
  assert.equal(items[0]?.kind === "user" && items[0].pending, undefined);
  // The echo of f1, and an echo of f2 before its delivered event came: both leave.
  const settled = settledPending([userMessage("hello", 1500), userMessage("other", 1600)], pending);
  await tab.outbox.echoed(settled);
  assert.deepEqual(tab.view(), { sends: [], sent: [] });
  assert.equal(tab.storage.sends.size, 0);
  assert.equal(pendingOf(tab.view())["t1"], undefined);
});

test("a held send the server delivered while the socket was down learns it from the resend's answer on reconnect", async () => {
  let delivered = false;
  const tab = page(memoryStorage(), () => delivered ? "delivered" : "queued");
  await tab.outbox.submit(send("g1"));
  await tab.outbox.idle();
  assert.equal(tab.view().sends[0]?.state, "held");
  delivered = true;
  await tab.outbox.resend("t1");
  await tab.outbox.idle();
  assert.deepEqual(tab.posted, ["g1", "g1"]);
  assert.equal(tab.view().sends.length, 0);
  assert.equal(tab.view().sent[0]?.id, "g1");
});

test("a second tab does not write back a send the first tab finished", async () => {
  const storage = memoryStorage();
  const one = page(storage);
  const two = page(storage);
  await one.outbox.submit(send("h1"));
  await one.outbox.idle();
  await two.outbox.resend();
  await two.outbox.idle();
  await one.outbox.server([entry(one.view().sends[0]!, "delivered")]);
  assert.equal(storage.sends.size, 0);
  // The second tab still holds h1 in memory; a server event for it must not put it back in storage.
  await two.outbox.server([entry(two.view().sends[0]!, "queued")]);
  await two.outbox.idle();
  assert.equal(storage.sends.size, 0);
});

test("a reload onto new client code waits only for a send that is in no storage yet, and not for one storage holds", async () => {
  const kept = page(memoryStorage(), () => "hang");
  await kept.outbox.submit(send("r1"));
  assert.equal(kept.view().sends[0]?.state, "posting");
  assert.equal(kept.outbox.onlyInPage(), false);
  const broken = { ...memoryStorage(), add: async () => { throw new Error("QuotaExceededError"); } };
  const unsaved = page(broken, () => "hang");
  await unsaved.outbox.submit(send("r2"));
  assert.equal(unsaved.outbox.onlyInPage(), true);
});
