/**
 * An agent speaks to people only through send_message: a turn's bubbles are its send_message texts, its other text and steps go into the
 * fold, a turn that sent nothing is only a fold row, and a channel thread gets one post per call. A conversation that never called it
 * keeps its turn text as the bubble and a channel answer as its text. Prime's tell_owner, which durable chat threads run, renders the same way.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/send-message.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Item, SearchResult, TimelinePage } from "../../web/src/lib/api/types.ts";
import { FixtureHost, QUIET_NOTE } from "../../server/host/fixture.ts";
import type { ContentBlock, EntryRecord } from "../../server/host/types.ts";
import { describe as describeHit } from "../../server/search-snippet.ts";
import { shows } from "../../server/threads.ts";
import { buildItems, firstSendIn, sentMessages, SPEAKING_TOOLS, speaksThroughSendMessage, type TimelineContext } from "../../server/timeline.ts";
import { TELL_OWNER_HELD, TELL_OWNER_TOOL } from "../../web/src/lib/api/shared/chat-feed.ts";
import { start, until, type Running } from "./helpers.ts";

type Turn = Extract<Item, { kind: "turn" }>;
const turns = (items: readonly Item[]): Turn[] => items.filter((i): i is Turn => i.kind === "turn");

// Entries as pi-durable shapes them, for the projection on its own.
let nextId = 1;
const user = (text: string): EntryRecord => ({ id: nextId++, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text }], timestamp: nextId }] });
const assistant = (...content: ContentBlock[]): EntryRecord => ({ id: nextId++, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", content, provider: "anthropic", model: "claude-opus-5-5", stopReason: "stop", timestamp: nextId }] });
const result = (callId: string, name: string, text: string, isError = false): EntryRecord => ({ id: nextId++, conversationId: 1, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError, timestamp: nextId }] });
const send = (id: string, text: string, to?: string): ContentBlock => ({ type: "toolCall", id, name: "send_message", arguments: { text, ...(to ? { to } : {}) } });
const ctx = (extra: Partial<TimelineContext> = {}): TimelineContext => ({
  thread: "t", conversation: 1, agent: { id: "t", kind: "chat", name: "Agent", avatar: { initials: "AG", hue: 1 } }, principal: id => ({ id, kind: "owner", name: id, avatar: { initials: "?", hue: 0 } }),
  tree: [], jobStatus: () => "idle", running: false, ...extra,
});

describe("timeline projection", () => {
  test("sent texts are the bubbles, one per call, and the turn's own text is a private note in the fold", () => {
    const entries = [
      user("Is the relay up?"),
      assistant({ type: "thinking", thinking: "Check the log." }, { type: "text", text: "Reading the relay log first." }, { type: "toolCall", id: "b1", name: "bash", arguments: { command: "tail relay.log" } }),
      result("b1", "bash", "relay: ok"),
      assistant(send("s1", "The relay is up since 02:11."), send("s2", "The canary needs your ok.")),
      result("s1", "send_message", "Sent."),
      result("s2", "send_message", "Sent."),
      assistant({ type: "text", text: "Told him both." }),
    ];
    const [turn] = turns(buildItems(entries, ctx()));
    assert.deepEqual(turn!.sent, ["The relay is up since 02:11.", "The canary needs your ok."]);
    assert.equal(turn!.text, "The relay is up since 02:11.\n\nThe canary needs your ok.");
    assert.deepEqual(turn!.steps.map(s => (s.kind === "tool" ? `tool ${s.name}` : `${s.kind} ${s.text}`)), [
      "thinking Check the log.", "note Reading the relay log first.", "tool bash", "note Told him both.",
    ]);
  });

  test("a turn that sends nothing has no bubble, only its fold; a refused call is not a message", () => {
    const entries = [
      user("first"), assistant(send("a", "Done.")), result("a", "send_message", "Sent."),
      user("[check-in]"), assistant({ type: "text", text: "Nothing changed." }),
      user("third"), assistant(send("bad", "half sent")), result("bad", "send_message", "Validation failed", true),
    ];
    const [, quiet, refused] = turns(buildItems(entries, ctx()));
    assert.deepEqual(quiet!.sent, []);
    assert.equal(quiet!.text, "");
    assert.deepEqual(quiet!.steps, [{ kind: "note", text: "Nothing changed." }]);
    assert.deepEqual(refused!.sent, []);
  });

  test("a conversation with no send_message call keeps today's turn text as the bubble", () => {
    const entries = [user("Is the relay up?"), assistant({ type: "text", text: "It is." }, { type: "toolCall", id: "b", name: "bash", arguments: { command: "ls" } }), result("b", "bash", "x"), assistant({ type: "text", text: "Yes." })];
    const [turn] = turns(buildItems(entries, ctx()));
    assert.equal(turn!.sent, undefined);
    assert.equal(turn!.text, "It is.\n\nYes.");
    assert.deepEqual(turn!.steps.map(s => s.kind), ["tool"]);
  });

  test("turns before the first send_message call stay as they were; a page with no call follows a call seen earlier", () => {
    const old = [user("old question"), assistant({ type: "text", text: "Old answer." })];
    const sending = [user("new question"), assistant(send("n", "New answer.")), result("n", "send_message", "Sent.")];
    const quiet = [user("[wake]"), assistant({ type: "text", text: "Private." })];
    const items = turns(buildItems([...old, ...sending, ...quiet], ctx()));
    assert.deepEqual(items.map(t => [t.text, t.sent]), [["Old answer.", undefined], ["New answer.", ["New answer."]], ["", []]]);
    assert.equal(speaksThroughSendMessage(old.slice(1), sending[1]!.id), false);
    assert.equal(speaksThroughSendMessage(quiet.slice(1), sending[1]!.id), true);
    // The quiet turn on a page of its own, with the earlier call known to the server.
    assert.deepEqual(turns(buildItems(quiet, ctx({ firstSend: sending[1]!.id })))[0]!.sent, []);
    assert.equal(turns(buildItems(quiet, ctx()))[0]!.text, "Private.");
    // The live turn of such a conversation, before its first entry, is ready for bubbles.
    assert.deepEqual(turns(buildItems([user("next")], ctx({ running: true, firstSend: sending[1]!.id })))[0]!.sent, []);
  });

  test("a tell_owner call renders like a send_message call, and a call its guard held is a note in the fold", () => {
    const tell = (id: string, text: string): ContentBlock => ({ type: "toolCall", id, name: TELL_OWNER_TOOL, arguments: { text } });
    const entries = [
      user("Is the relay up?"),
      assistant({ type: "text", text: "Reading the log." }, tell("t1", "The relay is up since 02:11.")),
      result("t1", TELL_OWNER_TOOL, "told the owner"),
      user("[check-in]"),
      assistant(tell("t2", "Still up.")),
      result("t2", TELL_OWNER_TOOL, `${TELL_OWNER_HELD}. The owner did not start this turn.`),
      assistant(tell("t3", "half")),
      result("t3", TELL_OWNER_TOOL, "why is required on a turn the owner did not start.", true),
    ];
    const [answer, quiet] = turns(buildItems(entries, ctx()));
    const sendEntries = [user("Is the relay up?"), assistant({ type: "text", text: "Reading the log." }, send("t1", "The relay is up since 02:11.")), result("t1", "send_message", "Sent.")];
    const [sendAnswer] = turns(buildItems(sendEntries, ctx()));
    assert.deepEqual([answer!.sent, answer!.text, answer!.steps], [sendAnswer!.sent, sendAnswer!.text, sendAnswer!.steps]);
    assert.deepEqual(quiet!.sent, []);
    assert.deepEqual(quiet!.steps, [{ kind: "note", text: "Still up." }]);
    assert.deepEqual(sentMessages(entries), [{ id: "t1", text: "The relay is up since 02:11." }]);
    assert.equal(firstSendIn(entries), entries[1]!.id);
    assert.ok(SPEAKING_TOOLS.has(TELL_OWNER_TOOL) && SPEAKING_TOOLS.has("send_message"));
    assert.equal(shows(assistant(tell("x", "hi"))), true);
    const said = describeHit("pi.assistant", "anthropic/claude-opus-5-5", `Private note.\ntell_owner ${JSON.stringify({ text: "The zebra relay is up." })}`, ["zebra"]);
    assert.equal(said.role, "agent");
    assert.match(said.text, /^The zebra relay is up\./);
  });

  test("an entry with a send_message call shows at once, like an answer with text", () => {
    assert.equal(shows(assistant(send("x", "hi"))), true);
    assert.equal(shows(assistant({ type: "toolCall", id: "y", name: "bash", arguments: {} })), false);
  });

  test("search reads a send_message call as the agent's message, not as tool input", () => {
    const said = describeHit("pi.assistant", "anthropic/claude-opus-5-5", `Private note.\nsend_message ${JSON.stringify({ text: "The zebra relay is up." })}\nbash {"command":"ls"}`, ["zebra"]);
    assert.equal(said.role, "agent");
    assert.equal(said.tool, undefined);
    assert.match(said.text, /^The zebra relay is up\./);
  });
});

describe("on the fixture", () => {
  let s: Running;
  let host: FixtureHost;
  before(async () => {
    s = await start({ wordMs: 2 });
    host = s.host as FixtureHost;
  });
  after(async () => {
    await s.close();
  });

  const newThread = async (name: string): Promise<string> => {
    const id = host.addThread({ name, createdAt: Date.now() }).row.id;
    await s.app.threads.refresh();
    return id;
  };

  test("a live answer shows its first message before the second is sent, then a quiet turn is only a fold", async () => {
    host.wordMs = 20;
    const id = await newThread("send desk");
    const live = await s.live();
    live.watch(id);
    await live.waitFor(e => e.type === "status" && e.conversation === id);
    await s.send("POST", `/api/c/${id}/send`, { text: "how is the zebra relay", requestId: "sm-1" });
    const first = await live.waitFor(e => e.type === "items" && e.conversation === id && turns(e.items).some(t => t.live && t.sent?.length === 1));
    assert.ok(first.type === "items");
    assert.match(turns(first.items).find(t => t.live)!.sent![0]!, /^Got it\. You said: "how is the zebra relay"\.$/);
    await live.waitFor(e => e.type === "items" && turns(e.items).some(t => !t.live && t.sent?.length === 2));
    await live.waitFor(e => e.type === "status" && e.conversation === id && e.status === "idle");
    // The sidebar previews what the agent sent, not its "Sent." result.
    assert.equal(host.threadsById.get(id)!.row.preview, "I checked the canary and the relay, and both answer.");
    await s.send("POST", `/api/c/${id}/send`, { text: "quiet check-in", requestId: "sm-2" });
    await live.waitFor(e => e.type === "items" && turns(e.items).some(t => !t.live && t.sent?.length === 0 && t.steps.length > 0));
    live.close();
    host.wordMs = 2;

    const page = await s.get<TimelinePage>(`/api/c/${id}/items`);
    const [answer, quiet] = turns(page.items);
    assert.deepEqual(answer!.sent, ['Got it. You said: "how is the zebra relay".', "I checked the canary and the relay, and both answer."]);
    assert.ok(answer!.steps.every(step => step.kind !== "tool" || step.name !== "send_message"), "a send is a bubble, not a step");
    assert.deepEqual(quiet!.sent, []);
    assert.deepEqual(quiet!.steps, [{ kind: "note", text: QUIET_NOTE }]);
    const hits = await s.get<SearchResult>(`/api/search?q=${encodeURIComponent("zebra relay")}&in=${id}`);
    const hit = hits.hits.find(h => h.kind === "turn");
    assert.equal(hit?.role, "agent");
    assert.equal(hit?.author.id, s.app.threads.principal(id).id);
  });

  test("a channel mention posts one reply per send_message call; a quiet turn posts nothing and reads no_reply", async () => {
    const id = await newThread("channel desk");
    const channel = (await s.send("POST", "/api/channels", { name: "send-desk", members: [id] })).body;
    const post = (await s.send("POST", `/api/c/${channel.id}/send`, { text: "@channel desk is the relay fine?", mentions: [id], requestId: "smc-1" })).body;
    const thread = await until(() => s.get(`/api/c/${channel.id}/replies/${post.item.id}`), t => t.root.deliveries[0].state === "answered");
    assert.deepEqual(thread.items.map((i: Extract<Item, { kind: "message" }>) => [i.author.id, i.text]), [
      [s.app.threads.principal(id).id, 'Got it. You said: "@channel desk is the relay fine?".'], [s.app.threads.principal(id).id, "I checked the canary and the relay, and both answer."],
    ]);
    assert.equal(thread.root.deliveries[0].answer, thread.items[0].id);
    const quiet = (await s.send("POST", `/api/c/${channel.id}/send`, { text: "@channel desk quiet please", mentions: [id], requestId: "smc-2" })).body;
    const after = await until(() => s.get(`/api/c/${channel.id}/replies/${quiet.item.id}`), t => t.root.deliveries[0].state !== "queued" && t.root.deliveries[0].state !== "delivered");
    assert.equal(after.root.deliveries[0].state, "no_reply");
    assert.deepEqual(after.items, []);
  });

  test("a send_message call to another channel is not posted here", async () => {
    const id = await newThread("aimed desk");
    const channel = (await s.send("POST", "/api/channels", { name: "aimed-desk", members: [id] })).body;
    const thread = host.threadsById.get(id)!;
    // This agent answers with one message aimed here and one aimed at #general, then ends its turn quietly.
    const original = host.answer.bind(host);
    host.answer = async (t, conversation, submission, text, reply) => {
      if (t !== thread) return original(t, conversation, submission, text, reply);
      host.answer = original;
      const now = Date.now();
      host.append(t, conversation, { kind: "pi.assistant", model: [{ role: "assistant", content: [send("h1", "Posted here.", "#aimed-desk"), send("g1", "Meant for general.", "#general")], provider: "anthropic", model: "claude-opus-5-5", stopReason: "toolUse", timestamp: now }] });
      host.append(t, conversation, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "h1", toolName: "send_message", content: [{ type: "text", text: "Sent." }], isError: false, timestamp: now }] });
      host.append(t, conversation, { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "g1", toolName: "send_message", content: [{ type: "text", text: "Sent." }], isError: false, timestamp: now }] });
      return original(t, conversation, submission, "quiet", undefined);
    };
    const post = (await s.send("POST", `/api/c/${channel.id}/send`, { text: "@aimed desk where does this go?", mentions: [id], requestId: "sma-1" })).body;
    const replies = await until(() => s.get(`/api/c/${channel.id}/replies/${post.item.id}`), t => t.root.deliveries[0].state === "answered");
    assert.deepEqual(replies.items.map((i: Item) => i.text), ["Posted here."]);
  });

  test("a target that never called send_message still answers a channel with its turn text", async () => {
    host.sendMessage = false;
    try {
      const id = await newThread("legacy desk");
      const channel = (await s.send("POST", "/api/channels", { name: "legacy-desk", members: [id] })).body;
      const post = (await s.send("POST", `/api/c/${channel.id}/send`, { text: "@legacy desk is the relay fine?", mentions: [id], requestId: "sml-1" })).body;
      const thread = await until(() => s.get(`/api/c/${channel.id}/replies/${post.item.id}`), t => t.root.deliveries[0].state === "answered");
      assert.deepEqual(thread.items.map((i: Item) => i.text), ['Got it. You said: "@legacy desk is the relay fine?". I checked the canary and the relay, and both answer.']);
      const page = await s.get<TimelinePage>(`/api/c/${id}/items`);
      assert.equal(turns(page.items)[0]!.sent, undefined);
    } finally {
      host.sendMessage = true;
    }
  });

  test("the seeded turns from before the first speaking call keep their text bubbles", async () => {
    const page = await s.get<TimelinePage>(`/api/c/${host.threadsById.values().next().value!.row.id}/items`);
    const all = turns(page.items);
    assert.ok(all.slice(0, -1).every(t => t.sent === undefined));
    assert.ok(all.some(t => t.text.includes("The canary relay lost the Mac")));
    assert.deepEqual(all.at(-1)!.sent, ["No. The Mac sleeps every night, so a page would wake you for nothing; I log it and flag a gap over an hour on the board."]);
  });
});
