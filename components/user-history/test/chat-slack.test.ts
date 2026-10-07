import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { channelName, chunks, fallbackText, loadSlackTokens, outboundLines, runsSlack, SlackApiError, SlackBridge, slackToMarkdown, tsAfter, WORKING_REACTION,
  type SlackChats, type SlackTokens, type SocketListener, type SocketMode } from "../src/chat-slack.ts";
import type { AssistantMessage, ThreadEvent, ThreadMessage, UserMessage } from "../src/shared/types.ts";

const user = (text: string, timestamp: number): UserMessage => ({ role: "user", content: text, timestamp });
const assistant = (parts: AssistantMessage["content"], timestamp: number, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage =>
  ({ role: "assistant", content: parts, provider: "p", model: "m", stopReason, timestamp });
const text = (value: string): AssistantMessage["content"][number] => ({ type: "text", text: value });
const tell = (id: string, value: string): AssistantMessage["content"][number] => ({ type: "toolCall", id, name: "tell_owner", arguments: { text: value } });
const result = (toolCallId: string, timestamp: number, isError = false): ThreadMessage =>
  ({ role: "toolResult", toolCallId, toolName: "tell_owner", content: [{ type: "text", text: isError ? "shorter" : "told the owner" }], isError, timestamp });
const report = (timestamp: number): ThreadMessage => ({ role: "custom", customType: "agent_message", content: "[agent-message from child:job]\ndone", timestamp });

const OWNER = "U0OWNER01";
const TEAM = "T0TEAM001";
const CHAT = "11111111-2222-3333-4444-555555555555";
const TOKENS: SlackTokens = { bot: "xoxb-test", app: "xapp-test", source: "keychain" };

test("channel names are vp-<slug> in Slack's alphabet; a name with no ASCII uses the id", () => {
  assert.equal(channelName("Reach chats from Slack!", CHAT), "vp-reach-chats-from-slack");
  assert.equal(channelName("Café   déjà_vu", CHAT), "vp-cafe-deja_vu");
  assert.equal(channelName("슬랙 연결", CHAT), "vp-11111111");
  assert.equal(channelName("x".repeat(200), CHAT).length, 80);
});

test("Slack text comes back as markdown; the fallback escapes Slack's control characters", () => {
  assert.equal(slackToMarkdown("see <https://a.b/c|the doc> and <https://x.y> &lt;tag&gt; &amp; <@U0ABCDEF> in <#C0ABC|general> <!here>"),
    "see [the doc](https://a.b/c) and https://x.y <tag> & @U0ABCDEF in #general @here");
  assert.equal(fallbackText("a < b & c\n\nd"), "a &lt; b &amp; c d");
  assert.equal(fallbackText("y".repeat(400)).length, 300);
});

test("long replies split at line breaks under the block limit", () => {
  assert.deepEqual(chunks("short"), ["short"]);
  assert.deepEqual(chunks("aaaa\nbbbb\ncc", 9), ["aaaa\nbbbb", "cc"]);
  assert.deepEqual(chunks("abcdefghij", 4), ["abcd", "efgh", "ij"]);
});

test("ts order compares seconds, then the fraction", () => {
  assert.ok(tsAfter("1712345678.000200", "1712345678.000100"));
  assert.ok(tsAfter("1712345679.000000", "1712345678.999999"));
  assert.ok(!tsAfter("1712345678.000100", "1712345678.000100"));
});

test("outbound lines: owner-turn replies and accepted tell_owner calls, keyed by timestamp plus toolCallId, stable across compaction", () => {
  const messages: ThreadMessage[] = [
    user("go", 1000),
    assistant([text("Started two jobs.")], 1100),
    report(1500),
    assistant([text("quiet note"), tell("t1", "Job A finished.")], 1600, "toolUse"),
    result("t1", 1610),
    assistant([tell("t2", "x".repeat(10))], 1700, "toolUse"),
    result("t2", 1710, true),
  ];
  const lines = outboundLines(messages);
  assert.deepEqual(lines, [{ key: "1100:text", text: "Started two jobs.", at: 1100 }, { key: "1600:t1", text: "Job A finished.", at: 1600 }]);
  // A compaction drops the head; the keys of the lines that remain do not change.
  assert.deepEqual(outboundLines(messages.slice(2)).map(line => line.key), ["1600:t1"]);
});

test("tokens come from the Keychain, else the environment, and need the right prefixes", async () => {
  const keychain = async (_file: string, args: string[]) => ({ code: 0, stdout: args.includes("bot-token") ? "xoxb-1\n" : "xapp-1\n", stderr: "", timedOut: false });
  const none = async () => ({ code: 44, stdout: "", stderr: "not found", timedOut: false });
  if (process.platform === "darwin") assert.deepEqual(await loadSlackTokens(keychain, {}), { bot: "xoxb-1", app: "xapp-1", source: "keychain" });
  assert.deepEqual(await loadSlackTokens(none, { SIEUN_PI_SLACK_BOT_TOKEN: "xoxb-2", SIEUN_PI_SLACK_APP_TOKEN: "xapp-2" }), { bot: "xoxb-2", app: "xapp-2", source: "environment" });
  assert.equal(await loadSlackTokens(none, { SIEUN_PI_SLACK_BOT_TOKEN: "xapp-2", SIEUN_PI_SLACK_APP_TOKEN: "xoxb-2" }), null);
  assert.equal(await loadSlackTokens(none, {}), null);
});

test("only the main instance runs the bridge unless SIEUN_PI_SLACK says otherwise", () => {
  assert.equal(runsSlack(true, {}), true);
  assert.equal(runsSlack(false, {}), false);
  assert.equal(runsSlack(false, { SIEUN_PI_SLACK: "1" }), true);
  assert.equal(runsSlack(true, { SIEUN_PI_SLACK: "0" }), false);
});

class FakeSocket implements SocketMode {
  listener: SocketListener | null = null;
  closed = false;
  start(listener: SocketListener): void { this.listener = listener; }
  close(): void { this.closed = true; }
}

type Call = { method: string; args: Record<string, unknown> };
function harness(options: { tokens?: SlackTokens | null; history?: Record<string, unknown>[]; taken?: string } = {}) {
  const calls: Call[] = [];
  const prompts: { id: string; message: string }[] = [];
  const listeners = new Map<string, (event: ThreadEvent) => void>();
  let watcher: (() => void) | null = null;
  const socket = new FakeSocket();
  let connects = 0;
  let clock = 10_000;
  let history = options.history ?? [];
  const state = { ids: new Set([CHAT]), messages: [] as ThreadMessage[] };
  const chats: SlackChats = {
    ids: async () => state.ids,
    name: async () => "Slack bridge",
    messages: () => state.messages,
    subscribe: async (id, listener) => { listeners.set(id, listener); return () => { listeners.delete(id); }; },
    prompt: async (id, message) => { prompts.push({ id, message }); },
    watch: listener => { watcher = listener; return () => { watcher = null; }; },
  };
  const api = async (method: string, args: Record<string, unknown> = {}) => {
    calls.push({ method, args });
    if (method === "auth.test") return { ok: true, team_id: TEAM, team: "Company", user_id: "U0BOT0001" };
    if (method === "conversations.create") {
      if (args.name === options.taken) throw new SlackApiError("name_taken");
      return { ok: true, channel: { id: "G0CHANNEL" } };
    }
    if (method === "conversations.history") { const out = { ok: true, messages: history }; history = []; return out; }
    return { ok: true };
  };
  return {
    calls, prompts, listeners, socket, state,
    get connects() { return connects; },
    get watcher() { return watcher; },
    tick(ms: number) { clock += ms; },
    setHistory(next: Record<string, unknown>[]) { history = next; },
    async make(dir: string) {
      return new SlackBridge({ path: join(dir, "slack.json"), chats, tokens: async () => options.tokens === undefined ? TOKENS : options.tokens,
        connect: () => { connects++; return { api, socket }; }, now: () => clock, postGapMs: 0, syncMs: 0, sleep: async () => {} });
    },
  };
}
const envelope = (event: Record<string, unknown>, team = TEAM) => ({ type: "event_callback", team_id: team, event: { type: "message", channel: "G0CHANNEL", ...event } });
const posts = (calls: Call[]) => calls.filter(call => call.method === "chat.postMessage").map(call => (call.args.blocks as { text: string }[])[0]!.text);

async function linked(h: ReturnType<typeof harness>) {
  const dir = await mkdtemp(join(tmpdir(), "slack-"));
  const bridge = await h.make(dir);
  await bridge.start();
  await bridge.set({ enabled: true, ownerUserId: OWNER });
  h.socket.listener!.hello();
  await bridge.sync(false);
  await bridge.settled();
  return { bridge, dir };
}

test("the bridge is off until Settings turns it on, and with no tokens it stays off and connects nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slack-"));
  const h = harness({ tokens: null });
  const bridge = await h.make(dir);
  await bridge.start();
  assert.equal(bridge.view(true).state, "off");
  await bridge.set({ enabled: true, ownerUserId: OWNER });
  assert.equal(bridge.view(true).state, "no-tokens");
  assert.equal(h.connects, 0);
  assert.equal(h.calls.length, 0);
  await assert.rejects(bridge.set({ ownerUserId: "bob" }), /member id/);
});

test("on hello each chat gets a private channel with the owner invited, and a feed subscription", async () => {
  const h = harness();
  const { bridge, dir } = await linked(h);
  const create = h.calls.find(call => call.method === "conversations.create")!;
  assert.deepEqual(create.args, { name: "vp-slack-bridge", is_private: true });
  assert.deepEqual(h.calls.find(call => call.method === "conversations.invite")!.args, { channel: "G0CHANNEL", users: OWNER });
  assert.match(posts(h.calls)[0]!, /Linked to the chat \*Slack bridge\*/);
  assert.ok(h.listeners.has(CHAT));
  const view = bridge.view(true);
  assert.equal(view.state, "on");
  assert.equal(view.teamId, TEAM);
  assert.equal(view.channels, 1);
  const saved = JSON.parse(await readFile(join(dir, "slack.json"), "utf8"));
  assert.equal(saved.links[CHAT].channel, "G0CHANNEL");
  // A second sync creates nothing new.
  await bridge.sync(false);
  await bridge.settled();
  assert.equal(h.calls.filter(call => call.method === "conversations.create").length, 1);
  bridge.close();
  assert.ok(h.socket.closed);
});

test("allowlist: only the owner's plain messages from the bot's team become steers, with a working reaction until the turn ends", async () => {
  const h = harness();
  const { bridge } = await linked(h);
  const event = (fields: Record<string, unknown>, team?: string) => { h.socket.listener!.event(envelope(fields, team)); };
  event({ user: "U0SOMEONE", text: "not the owner", ts: "20.000001" });
  event({ user: OWNER, text: "other team", ts: "20.000002" }, "T0OTHER01");
  event({ user: OWNER, bot_id: "B1", text: "as a bot", ts: "20.000003" });
  event({ user: OWNER, subtype: "message_changed", text: "edit", ts: "20.000004" });
  event({ user: OWNER, text: "check <https://a.b|this> &amp; reply", ts: "20.000005" });
  await bridge.settled();
  assert.deepEqual(h.prompts, [{ id: CHAT, message: "check [this](https://a.b) & reply" }]);
  assert.deepEqual(h.calls.find(call => call.method === "reactions.add")!.args, { channel: "G0CHANNEL", timestamp: "20.000005", name: WORKING_REACTION });
  h.listeners.get(CHAT)!({ type: "event", event: { type: "agent_end" } });
  await bridge.settled();
  assert.deepEqual(h.calls.find(call => call.method === "reactions.remove")!.args, { channel: "G0CHANNEL", timestamp: "20.000005", name: WORKING_REACTION });
});

test("dedupe: a redelivered event is sent once, and each reply or ping is posted once across events and a compaction", async () => {
  const h = harness();
  const { bridge } = await linked(h);
  const message = { user: OWNER, text: "status?", ts: "30.000001", client_msg_id: "c1" };
  h.socket.listener!.event(envelope(message));
  h.socket.listener!.event(envelope(message));
  await bridge.settled();
  assert.equal(h.prompts.length, 1);

  const before = posts(h.calls).length;
  h.state.messages = [user("status?", 20_000), assistant([text("Two jobs run.")], 20_100), report(20_500),
    assistant([text("quiet"), tell("t9", "Job A is done.")], 20_600, "toolUse"), result("t9", 20_610)];
  const emit = h.listeners.get(CHAT)!;
  emit({ type: "event", event: { type: "message_end", message: h.state.messages[1]! } });
  emit({ type: "event", event: { type: "agent_end" } });
  emit({ type: "snapshot", snapshot: {} as never });
  await bridge.settled();
  assert.deepEqual(posts(h.calls).slice(before), ["Two jobs run.", "Job A is done."]);
  // Compaction: the head is replaced by a summary and every index moves; nothing is posted again.
  h.state.messages = [{ role: "compactionSummary", summary: "s", tokensBefore: 1, timestamp: 20_700 }, ...h.state.messages.slice(2)];
  emit({ type: "snapshot", snapshot: {} as never });
  await bridge.settled();
  assert.equal(posts(h.calls).length, before + 2);
});

test("lines from before the link are never posted", async () => {
  const h = harness();
  h.state.messages = [user("old", 1000), assistant([text("old reply")], 1100)];
  const { bridge } = await linked(h);
  await bridge.sync(false);
  await bridge.settled();
  assert.deepEqual(posts(h.calls).filter(post => post === "old reply"), []);
});

test("catch-up: after a reconnect the channel history since the last handled message is sent oldest first, once", async () => {
  const h = harness();
  const { bridge } = await linked(h);
  h.socket.listener!.event(envelope({ user: OWNER, text: "first", ts: "40.000001" }));
  await bridge.settled();
  // The Mac slept: two owner messages and a stranger's were written meanwhile. Slack answers newest first.
  h.setHistory([
    { type: "message", user: OWNER, text: "third", ts: "40.000003" },
    { type: "message", user: "U0SOMEONE", text: "stranger", ts: "40.000002" },
    { type: "message", user: OWNER, text: "second", ts: "40.000002" },
    { type: "message", user: OWNER, text: "first", ts: "40.000001" },
  ]);
  h.socket.listener!.hello();
  await new Promise(resolve => setImmediate(resolve));
  await bridge.settled();
  const history = h.calls.filter(call => call.method === "conversations.history");
  assert.equal(history.at(-1)!.args.oldest, "40.000001");
  assert.deepEqual(h.prompts.map(prompt => prompt.message), ["first", "second", "third"]);
  // The live event for a caught-up message arrives late: it is dropped.
  h.socket.listener!.event(envelope({ user: OWNER, text: "third", ts: "40.000003" }));
  await bridge.settled();
  assert.equal(h.prompts.length, 3);
});

test("a taken channel name gets the chat id's first four characters", async () => {
  const h = harness({ taken: "vp-slack-bridge" });
  const { bridge } = await linked(h);
  assert.deepEqual(h.calls.filter(call => call.method === "conversations.create").map(call => call.args.name), ["vp-slack-bridge", "vp-slack-bridge-1111"]);
  assert.equal(bridge.view(true).channels, 1);
});

test("a chat that leaves the list gets its channel archived and its link dropped", async () => {
  const h = harness();
  const { bridge } = await linked(h);
  h.state.ids = new Set();
  await bridge.sync(false);
  await bridge.settled();
  assert.deepEqual(h.calls.find(call => call.method === "conversations.archive")!.args, { channel: "G0CHANNEL" });
  assert.equal(bridge.view(true).channels, 0);
  assert.ok(!h.listeners.has(CHAT));
});

test("a failed send is answered in the channel and the reaction is cleared", async () => {
  const h = harness();
  const { bridge } = await linked(h);
  const chats = (bridge as unknown as { options: { chats: SlackChats } }).options.chats;
  chats.prompt = async () => { throw new Error("Prime Agent did not resume this thread."); };
  h.socket.listener!.event(envelope({ user: OWNER, text: "hello", ts: "50.000001" }));
  await bridge.settled();
  assert.ok(h.calls.some(call => call.method === "reactions.remove"));
  assert.match(posts(h.calls).at(-1)!, /Not sent to the chat: Prime Agent did not resume this thread/);
});
