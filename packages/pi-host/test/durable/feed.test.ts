/**
 * The host's outbox and `durable_feed`: a real durable thread whose faux model answers through `send_message` gets one outbox row per call
 * that went out, a result read again (a replay after a crash, or a thread indexed again) adds no second row, and a feed writes its response,
 * then the backlog after its cursor in seq order, then each new row live, until `durable_feed_stop` or disconnect.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { TELL_OWNER_HELD, TELL_OWNER_TOOL } from "../../../../legacy/prime/user-history/src/shared/chat-feed.ts";
import type { Outbound } from "../../src/protocol.ts";
import { DurableCommands } from "../../src/durable/commands.ts";
import { speechOf, type FeedRow } from "../../src/durable/feed.ts";
import { ThreadIndex } from "../../src/durable/index-db.ts";
import { SEND_MESSAGE_TOOL } from "../../src/durable/send-message.ts";
import { DurableThreads } from "../../src/durable/threads.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-feed-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Each input "say A | B" answers with one send_message call per part; "say A | B" with "to:" parts sets `to` and `why`. */
const respond = ({ messages }: { messages: Message[] }) => {
  if (messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("Private note: sent.");
  const said = textOf([...messages].reverse().find(m => m.role === "user")?.content ?? "").replace(/^say /, "");
  return fauxAssistantMessage([
    fauxText("Working note."),
    ...said.split(" | ").map(part => {
      const [text, to] = part.split(" to:");
      return fauxToolCall(SEND_MESSAGE_TOOL, to ? { text, to, why: "update" } : { text });
    }),
  ], { stopReason: "toolUse" });
};

function models() {
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  faux.setResponses(Array.from({ length: 40 }, () => respond));
  const out = createModels();
  out.setProvider(faux.provider);
  return out;
}

const threadsAt = (durable: string) => new DurableThreads({ dir: durable, models, defaultModel: MODEL, defaultThinkingLevel: "off", defaultCwd: dir });

async function say(threads: DurableThreads, thread: string, text: string): Promise<void> {
  const { submission } = await threads.submit(thread, { text });
  assert.equal((await threads.wait(thread, submission)).status, "done");
}

/** A connection's sink that keeps every line, as pi-host's socket would write them. */
function sinkFor(clientId: string) {
  const lines: Outbound[] = [];
  return { lines, sink: { clientId, write: (line: Outbound) => void lines.push(line) } };
}
const feedRows = (lines: readonly Outbound[]): FeedRow[] => lines.flatMap(line => (line.type === "durable_feed_event" ? [line.row] : []));

test("each send_message call that went out is one outbox row, and indexing the thread again adds none", async () => {
  const durable = join(dir, "rows");
  let threads = threadsAt(durable);
  try {
    await threads.start();
    const { id } = await threads.create({ name: "rows" });
    await say(threads, id, "say The relay is up. | The canary needs your ok. to:#pi-cutover");
    const { rows, more } = threads.index.readOutbox(0, 10);
    assert.equal(more, false);
    const page = await threads.entries(id, { after: 0, limit: 50 });
    const assistant = page.entries.find(e => (e.model?.[0] as Message | undefined)?.role === "assistant" && JSON.stringify(e.model).includes(SEND_MESSAGE_TOOL))!;
    const callIds = ((assistant.model![0] as Message & { role: "assistant" }).content).flatMap(c => (c.type === "toolCall" ? [c.id] : []));
    assert.deepEqual(rows.map(({ at, ...row }) => (assert.ok(at > 0), row)), [
      { seq: 1, thread: id, conversation: 1, entry: assistant.id, toolCallId: callIds[0]!, toolName: SEND_MESSAGE_TOOL, requestId: `m:${id}:${callIds[0]}`, text: "The relay is up." },
      { seq: 2, thread: id, conversation: 1, entry: assistant.id, toolCallId: callIds[1]!, toolName: SEND_MESSAGE_TOOL, requestId: `m:${id}:${callIds[1]}`, text: "The canary needs your ok.", to: "#pi-cutover", why: "update" },
    ]);

    // The thread's index rows start over and its whole file is read again on the next open, as after a crash or a rebuild.
    await threads.closeThread(id, "test");
    threads.index.resetEntries(id);
    await threads.shutdown();
    threads = threadsAt(durable);
    await threads.start();
    await threads.entries(id, { after: 0, limit: 1 });
    assert.deepEqual(threads.index.readOutbox(0, 10).rows.map(r => r.seq), [1, 2]);
  } finally {
    await threads.shutdown();
  }
});

test("a result read twice, an unsent result and a result from before the outbox add no row", () => {
  const index = new ThreadIndex(join(dir, "index-only.sqlite"));
  try {
    const entry = (entryId: number, extra: object, at = Date.now()) => ({ thread: "t", conversation: 1, entryId, kind: "pi.x", author: "a", at, text: "", ...extra });
    index.insertThread({ id: "t", name: "t", provider: "p", modelId: "m", thinkingLevel: "off", cwd: dir, createdAt: 0, updatedAt: 0 });
    index.addEntries("t", [entry(1, { calls: [
      { toolCallId: "a", toolName: SEND_MESSAGE_TOOL, text: "one" },
      { toolCallId: "b", toolName: TELL_OWNER_TOOL, text: "held" },
      { toolCallId: "c", toolName: SEND_MESSAGE_TOOL, text: "old" },
    ] })], []);
    index.addEntries("t", [entry(2, { result: { toolCallId: "a", sent: true } }), entry(3, { result: { toolCallId: "b", sent: false } })], []);
    // pi-durable replays call "a" after a crash: its result commits again under a new entry id.
    index.addEntries("t", [entry(4, { result: { toolCallId: "a", sent: true } })], []);
    index.addEntries("t", [entry(5, { result: { toolCallId: "c", sent: true } }, index.outboxSince - 1)], []);
    assert.deepEqual(index.readOutbox(0).rows.map(r => [r.seq, r.toolCallId, r.text]), [[1, "a", "one"]]);
  } finally {
    index.close();
  }
});

test("speechOf reads what went out the way the chat's feed does: no error, no held tell_owner, root conversation only", () => {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const entry = (message: object, conversationId = 1) => ({ id: 1, conversationId, kind: "pi.x", model: [message] }) as unknown as EntryRecord;
  const assistant = { role: "assistant", content: [fauxToolCall(TELL_OWNER_TOOL, { text: " Hi. ", why: "done" }), fauxToolCall(SEND_MESSAGE_TOOL, { text: "  " }), fauxToolCall("read", { text: "x" })], api: "faux", provider: "p", model: "m", usage, stopReason: "toolUse", timestamp: 1 };
  assert.deepEqual(speechOf(entry(assistant)).calls?.map(({ toolCallId, ...call }) => call), [{ toolName: TELL_OWNER_TOOL, text: "Hi.", why: "done" }]);
  assert.deepEqual(speechOf(entry(assistant, 2)), {});
  const result = (toolName: string, text: string, isError = false) => entry({ role: "toolResult", toolCallId: "c", toolName, content: [{ type: "text", text }], isError, timestamp: 1 });
  assert.deepEqual(speechOf(result(TELL_OWNER_TOOL, "Sent.")).result, { toolCallId: "c", sent: true });
  assert.deepEqual(speechOf(result(TELL_OWNER_TOOL, `${TELL_OWNER_HELD}. The owner did not start this turn.`)).result, { toolCallId: "c", sent: false });
  assert.deepEqual(speechOf(result(SEND_MESSAGE_TOOL, "bad", true)).result, { toolCallId: "c", sent: false });
  assert.deepEqual(speechOf(result("read", "Sent.")), {});
});

test("durable_feed answers first, then the backlog after its cursor in seq order, then new rows live, until durable_feed_stop", async () => {
  const durable = join(dir, "feed");
  const threads = threadsAt(durable);
  const commands = new DurableCommands(threads);
  try {
    await threads.start();
    const { id } = await threads.create({ name: "feed" });
    await say(threads, id, "say one | two | three");

    const a = sinkFor("a");
    assert.equal(await commands.handle({ id: "1", type: "durable_feed", after: 1 }, a.sink), undefined);
    const response = a.lines[0] as Extract<Outbound, { type: "response" }>;
    assert.equal(response.type, "response");
    assert.equal(response.success, true);
    const feed = (response.data as { feed: string }).feed;
    assert.deepEqual(a.lines.slice(1).map(line => line.type === "durable_feed_event" && [line.feed, line.row.seq, line.row.text]), [[feed, 2, "two"], [feed, 3, "three"]]);

    // A second connection reads from the start; both hear the next turn's rows live, in order.
    const b = sinkFor("b");
    await commands.handle({ id: "2", type: "durable_feed", after: 0 }, b.sink);
    await say(threads, id, "say four | five");
    assert.deepEqual(feedRows(a.lines).map(r => [r.seq, r.text]), [[2, "two"], [3, "three"], [4, "four"], [5, "five"]]);
    assert.deepEqual(feedRows(b.lines).map(r => r.seq), [1, 2, 3, 4, 5]);

    const stopped = await commands.handle({ id: "3", type: "durable_feed_stop", feed }, a.sink);
    assert.deepEqual(stopped?.success && stopped.data, { stopped: true });
    await commands.disconnect("b");
    await say(threads, id, "say six");
    assert.deepEqual(feedRows(a.lines).map(r => r.seq), [2, 3, 4, 5]);
    assert.deepEqual(feedRows(b.lines).map(r => r.seq), [1, 2, 3, 4, 5]);

    const read = await commands.handle({ id: "4", type: "durable_feed_read", after: 4, limit: 1 }, a.sink);
    assert.deepEqual(read?.success && (read.data as { rows: FeedRow[]; more: boolean }).rows.map(r => r.text), ["five"]);
    assert.equal(read?.success && (read.data as { more: boolean }).more, true);
  } finally {
    await commands.disconnect("a");
    await threads.shutdown();
  }
});
