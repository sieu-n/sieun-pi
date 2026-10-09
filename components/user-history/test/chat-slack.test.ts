import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chunks, fallbackText, loadSlackTokens, OPT_IN_MIGRATION, outboundLines, runsSlack, SlackApiError, SlackBridge, slackToMarkdown, tsAfter, WORKING_REACTION,
  type SlackChats, type SlackTokens, type SocketListener, type SocketMode } from "../src/chat-slack.ts";
import { channelName, channelNameError, defaultChannelName, parseChannelRef } from "../src/shared/slack-channel.ts";
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

test("channel name validation follows Slack: lowercase, digits, hyphens, underscores, no spaces, at most 80 characters", () => {
  assert.equal(channelNameError("vp-reach-chats_2"), null);
  assert.equal(channelNameError(""), "Enter a channel name.");
  assert.equal(channelNameError("vp chat"), "No spaces.");
  assert.equal(channelNameError("VP-chat"), "Lowercase only.");
  assert.equal(channelNameError("vp.chat"), "Only lowercase letters, numbers, hyphens and underscores.");
  assert.equal(channelNameError("vp-" + "a".repeat(78)), "At most 80 characters.");
  assert.equal(channelNameError("a".repeat(80)), null);
  assert.equal(defaultChannelName("Reach chats from Slack!"), "vp-reach-chats-from-slack");
  assert.equal(defaultChannelName("  ", new Date("2026-10-09T03:00:00Z")), "vp-chat-2026-10-09");
  assert.deepEqual(parseChannelRef(" #VP-Ops "), { name: "vp-ops" });
  assert.deepEqual(parseChannelRef("C0123ABCDE"), { id: "C0123ABCDE" });
  assert.equal(parseChannelRef("   "), null);
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
function harness(options: { tokens?: SlackTokens | null; history?: Record<string, unknown>[]; taken?: string; refuseUnarchive?: boolean;
  /** What conversations.list answers (both types), and what conversations.info answers for any id. */
  listed?: Record<string, unknown>[]; listError?: Error; info?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const prompts: { id: string; message: string }[] = [];
  const listeners = new Map<string, (event: ThreadEvent) => void>();
  let watcher: (() => void) | null = null;
  const socket = new FakeSocket();
  const logs: string[] = [];
  let connects = 0;
  let clock = 10_000;
  let history = options.history ?? [];
  const state = { ids: new Set([CHAT]), messages: [] as ThreadMessage[], subscribeError: null as Error | null, subscribes: 0 };
  let channels = 0;
  const chats: SlackChats = {
    ids: async () => state.ids,
    name: async () => "Slack bridge",
    messages: () => state.messages,
    subscribe: async (id, listener) => {
      state.subscribes++;
      if (state.subscribeError) throw state.subscribeError;
      listeners.set(id, listener);
      return () => { listeners.delete(id); };
    },
    prompt: async (id, message) => { prompts.push({ id, message }); },
    watch: listener => { watcher = listener; return () => { watcher = null; }; },
  };
  const api = async (method: string, args: Record<string, unknown> = {}) => {
    calls.push({ method, args });
    if (method === "auth.test") return { ok: true, team_id: TEAM, team: "Company", user_id: "U0BOT0001" };
    if (method === "conversations.create") {
      if (args.name === options.taken) throw new SlackApiError("name_taken");
      return { ok: true, channel: { id: channels++ ? `G0CHANNEL${channels}` : "G0CHANNEL", name: args.name } };
    }
    if (method === "conversations.unarchive" && options.refuseUnarchive) throw new SlackApiError("not_in_channel");
    if (method === "conversations.list") { if (options.listError) throw options.listError; return { ok: true, channels: args.types === "private_channel" ? options.listed ?? [] : [] }; }
    if (method === "conversations.info") return options.info ? { ok: true, channel: options.info } : { ok: true };
    if (method === "conversations.rename") return { ok: true, channel: { id: args.channel, name: args.name } };
    if (method === "conversations.history") { const out = { ok: true, messages: history }; history = []; return out; }
    return { ok: true };
  };
  return {
    calls, prompts, listeners, socket, state, logs,
    get connects() { return connects; },
    get watcher() { return watcher; },
    tick(ms: number) { clock += ms; },
    setHistory(next: Record<string, unknown>[]) { history = next; },
    async make(dir: string) {
      return new SlackBridge({ path: join(dir, "slack.json"), chats, tokens: async () => options.tokens === undefined ? TOKENS : options.tokens,
        connect: () => { connects++; return { api, socket }; }, now: () => clock, postGapMs: 0, syncMs: 0, sleep: async () => {}, log: line => { logs.push(line); } });
    },
  };
}
const envelope = (event: Record<string, unknown>, team = TEAM) => ({ type: "event_callback", team_id: team, event: { type: "message", channel: "G0CHANNEL", ...event } });
const posts = (calls: Call[]) => calls.filter(call => call.method === "chat.postMessage").map(call => (call.args.blocks as { text: string }[])[0]!.text);

async function connected(h: ReturnType<typeof harness>, dir?: string) {
  dir ??= await mkdtemp(join(tmpdir(), "slack-"));
  const bridge = await h.make(dir);
  await bridge.start();
  await bridge.set({ enabled: true, ownerUserId: OWNER });
  h.socket.listener!.hello();
  await new Promise(resolve => setImmediate(resolve));
  await bridge.sync(false);
  await bridge.settled();
  return { bridge, dir };
}

/** Connected, with CHAT connected to Slack the way the header dialog does, with the default name. */
async function linked(h: ReturnType<typeof harness>) {
  const { bridge, dir } = await connected(h);
  await bridge.chat(CHAT, { action: "connect" });
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

test("sync is off for every chat until it is turned on; on gives the chat a private channel with the owner invited and a feed subscription", async () => {
  const h = harness();
  const { bridge, dir } = await connected(h);
  assert.equal(bridge.view(true).state, "on");
  assert.ok(!h.calls.some(call => call.method === "conversations.create"), "no channel before the owner opts in");
  assert.ok(!h.listeners.has(CHAT));
  assert.deepEqual(bridge.view(true).chats, {});
  await bridge.chat(CHAT, { action: "connect" });
  await bridge.settled();
  const create = h.calls.find(call => call.method === "conversations.create")!;
  assert.deepEqual(create.args, { name: "vp-slack-bridge", is_private: true });
  assert.deepEqual(h.calls.find(call => call.method === "conversations.invite")!.args, { channel: "G0CHANNEL", users: OWNER });
  assert.match(posts(h.calls)[0]!, /Linked to the chat \*Slack bridge\*/);
  assert.ok(h.listeners.has(CHAT));
  const view = bridge.view(true);
  assert.equal(view.teamId, TEAM);
  assert.equal(view.channels, 1);
  assert.deepEqual(view.chats, { [CHAT]: { channel: "G0CHANNEL", name: "vp-slack-bridge", isPrivate: true } });
  const saved = JSON.parse(await readFile(join(dir, "slack.json"), "utf8"));
  assert.deepEqual([saved.links[CHAT].channel, saved.links[CHAT].channelName, saved.links[CHAT].archived], ["G0CHANNEL", "vp-slack-bridge", false]);
  // Turning it on again, or a later sync, creates nothing new.
  await bridge.chat(CHAT, { action: "connect" });
  await bridge.sync(false);
  await bridge.settled();
  assert.equal(h.calls.filter(call => call.method === "conversations.create").length, 1);
  bridge.close();
  assert.ok(h.socket.closed);
});

test("turning sync off archives the channel and drops the link; a chat nobody synced is never touched", async () => {
  const h = harness();
  const { bridge } = await linked(h);
  await bridge.chat(CHAT, { action: "stop" });
  assert.deepEqual(h.calls.find(call => call.method === "conversations.archive")!.args, { channel: "G0CHANNEL" });
  assert.deepEqual(bridge.view(true).chats, {});
  assert.ok(!h.listeners.has(CHAT));
  await bridge.sync(true);
  await bridge.settled();
  assert.equal(h.calls.filter(call => call.method === "conversations.create").length, 1);
  assert.ok(!h.calls.some(call => call.method === "conversations.history"));
});

test("the chat switch needs a live connection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slack-"));
  const h = harness();
  const bridge = await h.make(dir);
  await bridge.start();
  await assert.rejects(bridge.chat(CHAT, { action: "connect" }), /Slack is not connected/);
  await bridge.set({ enabled: true, ownerUserId: OWNER });
  await assert.rejects(bridge.chat(CHAT, { action: "connect" }), /Slack is not connected/, "connecting, no hello yet");
  assert.ok(!h.calls.some(call => call.method === "conversations.create"));
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

test("connect is idempotent: concurrent and repeated connects make one channel, and a connected chat keeps its channel whatever the body says", async () => {
  const h = harness();
  const { bridge } = await connected(h);
  const results = await Promise.all([bridge.chat(CHAT, { action: "connect", name: "vp-first" }), bridge.chat(CHAT, { action: "connect", name: "vp-second" }), bridge.chat(CHAT, { action: "connect" })]);
  assert.equal(h.calls.filter(call => call.method === "conversations.create").length, 1);
  assert.deepEqual(h.calls.find(call => call.method === "conversations.create")!.args, { name: "vp-first", is_private: true });
  assert.deepEqual(results, Array(3).fill({ channel: "G0CHANNEL", name: "vp-first", isPrivate: true }));
  const again = await bridge.chat(CHAT, { action: "connect", name: "vp-third", isPrivate: false });
  assert.deepEqual(again, { channel: "G0CHANNEL", name: "vp-first", isPrivate: true });
  assert.equal(h.calls.filter(call => call.method === "conversations.create").length, 1);
  assert.equal(posts(h.calls).filter(post => post.startsWith("Linked to the chat")).length, 1);
});

test("connect takes a name and visibility, refuses a name Slack would refuse, and reuses a taken name when the bot is in that channel", async () => {
  const h = harness({ taken: "vp-ops", listed: [{ id: "C0OPS", name: "vp-ops", is_member: true, is_private: false }] });
  const { bridge } = await connected(h);
  await assert.rejects(bridge.chat(CHAT, { action: "connect", name: "VP Ops" }), /No spaces/);
  assert.ok(!h.calls.some(call => call.method === "conversations.create"));
  const link = await bridge.chat(CHAT, { action: "connect", name: "vp-ops", isPrivate: false });
  assert.deepEqual(h.calls.find(call => call.method === "conversations.create")!.args, { name: "vp-ops", is_private: false });
  assert.deepEqual(link, { channel: "C0OPS", name: "vp-ops", isPrivate: false });
  assert.deepEqual(h.calls.find(call => call.method === "conversations.invite")!.args, { channel: "C0OPS", users: OWNER });
  assert.equal(h.calls.filter(call => call.method === "conversations.create").length, 1, "no suffixed name once the channel was reused");
});

test("connect to an existing channel by #name or id; a channel the bot is not in is refused", async () => {
  const h = harness({ listed: [{ id: "G0SHARED", name: "ops-room", is_member: true, is_private: true }], info: { id: "C0BYID", name: "by-id", is_member: true } });
  const { bridge } = await connected(h);
  assert.deepEqual(await bridge.chat(CHAT, { action: "connect", existing: "#Ops-Room" }), { channel: "G0SHARED", name: "ops-room", isPrivate: true });
  assert.ok(!h.calls.some(call => call.method === "conversations.create"));
  await bridge.chat(CHAT, { action: "stop" });
  await assert.rejects(bridge.chat(CHAT, { action: "connect", existing: "#nowhere" }), /No channel #nowhere that the bot is in/);
  assert.deepEqual(await bridge.chat(CHAT, { action: "connect", existing: "C0BYID" }), { channel: "C0BYID", name: "by-id", isPrivate: false });
  assert.deepEqual(h.calls.find(call => call.method === "conversations.info")!.args, { channel: "C0BYID" });
});

test("rename changes the channel name and keeps the link; the same name is a no-op; stop archives and drops the link; a chat not synced cannot be renamed", async () => {
  const h = harness();
  const { bridge, dir } = await linked(h);
  assert.deepEqual(await bridge.chat(CHAT, { action: "rename", name: "vp-renamed" }), { channel: "G0CHANNEL", name: "vp-renamed", isPrivate: true });
  assert.deepEqual(h.calls.find(call => call.method === "conversations.rename")!.args, { channel: "G0CHANNEL", name: "vp-renamed" });
  await bridge.chat(CHAT, { action: "rename", name: "vp-renamed" });
  assert.equal(h.calls.filter(call => call.method === "conversations.rename").length, 1);
  await assert.rejects(bridge.chat(CHAT, { action: "rename", name: "Bad Name" }), /No spaces/);
  const saved = JSON.parse(await readFile(join(dir, "slack.json"), "utf8"));
  assert.equal(saved.links[CHAT].channelName, "vp-renamed");
  assert.ok(h.listeners.has(CHAT));
  assert.equal(await bridge.chat(CHAT, { action: "stop" }), null);
  assert.deepEqual(h.calls.find(call => call.method === "conversations.archive")!.args, { channel: "G0CHANNEL" });
  assert.equal(await bridge.chat(CHAT, { action: "stop" }), null, "stop twice is quiet");
  assert.equal(h.calls.filter(call => call.method === "conversations.archive").length, 1);
  await assert.rejects(bridge.chat(CHAT, { action: "rename", name: "vp-x" }), /not synced/);
});

test("channels lists the unarchived channels the bot is in; null when the bot cannot list", async () => {
  const h = harness({ listed: [{ id: "G0B", name: "b-room", is_member: true, is_private: true }, { id: "C0A", name: "a-room", is_member: true, is_private: false }, { id: "C0X", name: "not-in", is_member: false }] });
  const { bridge } = await connected(h);
  assert.deepEqual(await bridge.channels(), [{ id: "C0A", name: "a-room", isPrivate: false }, { id: "G0B", name: "b-room", isPrivate: true }]);
  const closed = harness({ listError: new SlackApiError("missing_scope") });
  const other = await connected(closed);
  assert.equal(await other.bridge.channels(), null);
});

test("archiving a chat archives its channel and keeps the link; unarchiving opens the same channel again", async () => {
  const h = harness();
  const { bridge, dir } = await linked(h);
  h.state.ids = new Set();
  await bridge.sync(false);
  await bridge.settled();
  assert.deepEqual(h.calls.find(call => call.method === "conversations.archive")!.args, { channel: "G0CHANNEL" });
  assert.deepEqual(bridge.view(true).chats, {});
  assert.ok(!h.listeners.has(CHAT));
  assert.equal(JSON.parse(await readFile(join(dir, "slack.json"), "utf8")).links[CHAT].archived, true);
  // A second sync while archived calls Slack no more.
  const before = h.calls.length;
  await bridge.sync(false);
  await bridge.settled();
  assert.equal(h.calls.length, before);
  h.state.ids = new Set([CHAT]);
  await bridge.sync(false);
  await bridge.settled();
  assert.deepEqual(h.calls.find(call => call.method === "conversations.unarchive")!.args, { channel: "G0CHANNEL" });
  assert.deepEqual(bridge.view(true).chats, { [CHAT]: { channel: "G0CHANNEL", name: "vp-slack-bridge", isPrivate: true } });
  assert.match(posts(h.calls).at(-1)!, /back from the archive/);
  assert.ok(h.listeners.has(CHAT));
});

test("when Slack refuses to unarchive, an unarchived chat gets a new channel", async () => {
  const h = harness({ refuseUnarchive: true });
  const { bridge } = await linked(h);
  h.state.ids = new Set();
  await bridge.sync(false);
  await bridge.settled();
  h.state.ids = new Set([CHAT]);
  await bridge.sync(false);
  await bridge.settled();
  assert.equal(h.calls.filter(call => call.method === "conversations.create").length, 2);
  assert.deepEqual(bridge.view(true).chats[CHAT], { channel: "G0CHANNEL2", name: "vp-slack-bridge", isPrivate: true });
  assert.equal(h.calls.filter(call => call.method === "chat.postMessage").at(-1)!.args.channel, "G0CHANNEL2");
});

test("a chat whose feed does not open is parked: one log line, no retry on each sync, a quiet retry after the gap", async () => {
  const h = harness();
  h.state.subscribeError = new Error("Unknown active session: 01c62015bf3b");
  const { bridge } = await linked(h);
  assert.equal(h.state.subscribes, 1);
  for (let index = 0; index < 20; index++) await bridge.sync(false);
  await bridge.settled();
  assert.equal(h.state.subscribes, 1, "no attach per sync while parked");
  assert.equal(h.logs.filter(line => line.includes("did not open")).length, 1);
  assert.match(h.logs.find(line => line.includes("did not open"))!, /Unknown active session: 01c62015bf3b\); parked/);
  h.tick(60_000);
  await bridge.sync(false);
  await bridge.settled();
  assert.equal(h.state.subscribes, 2);
  // The gap doubles; the retry stays quiet.
  h.tick(60_000);
  await bridge.sync(false);
  await bridge.settled();
  assert.equal(h.state.subscribes, 2);
  assert.equal(h.logs.filter(line => line.includes("did not open")).length, 1);
  h.state.subscribeError = null;
  h.tick(60_000);
  await bridge.sync(false);
  await bridge.settled();
  assert.equal(h.state.subscribes, 3);
  assert.ok(h.listeners.has(CHAT));
  assert.ok(h.logs.some(line => line.includes("feed is open again")));
});

test("a closed feed is opened again on the next sync, and a session gone by then is parked", async () => {
  const h = harness();
  const { bridge } = await linked(h);
  h.state.subscribeError = new Error("Unknown active session: abc");
  h.listeners.get(CHAT)!({ type: "status", connection: "closed", error: "This thread was archived." });
  await bridge.sync(false);
  await bridge.sync(false);
  await bridge.settled();
  assert.equal(h.state.subscribes, 2);
  assert.equal(h.logs.filter(line => line.includes("did not open")).length, 1);
});

test("the opt-in migration runs once: every earlier link but the probe's is dropped and its channel archived", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slack-"));
  const PROBE = "22222222-2222-3333-4444-555555555555";
  const OTHER = "33333333-2222-3333-4444-555555555555";
  const old = (channel: string, name: string) => ({ channel, name, since: 1, seen: "1.000000", posted: [] });
  await writeFile(join(dir, "slack.json"), JSON.stringify({ enabled: true, ownerUserId: OWNER, teamId: TEAM, teamName: "Company",
    links: { [CHAT]: old("C0ONE", "VP of CI"), [PROBE]: old("C0PROBE", "slack bridge probe"), [OTHER]: old("C0TWO", "SEO guy") } }));
  const h = harness();
  h.state.ids = new Set([CHAT, PROBE, OTHER]);
  const bridge = await h.make(dir);
  await bridge.start();
  h.socket.listener!.hello();
  await new Promise(resolve => setImmediate(resolve));
  await bridge.settled();
  await bridge.sync(false);
  await bridge.settled();
  assert.deepEqual(h.calls.filter(call => call.method === "conversations.archive").map(call => call.args.channel).sort(), ["C0ONE", "C0TWO"]);
  assert.deepEqual(bridge.view(true).chats, { [PROBE]: { channel: "C0PROBE", name: "vp-slack-bridge-probe", isPrivate: true } });
  assert.ok(h.listeners.has(PROBE) && !h.listeners.has(CHAT) && !h.listeners.has(OTHER));
  const saved = JSON.parse(await readFile(join(dir, "slack.json"), "utf8"));
  assert.deepEqual(saved.migrations, [OPT_IN_MIGRATION]);
  assert.deepEqual(Object.keys(saved.links), [PROBE]);
  assert.equal(h.logs.filter(line => line.includes("sync is opt-in now")).length, 2);
  // A chat synced after the migration survives every later reconnect.
  await bridge.chat(OTHER, { action: "connect" });
  h.socket.listener!.hello();
  await new Promise(resolve => setImmediate(resolve));
  await bridge.settled();
  assert.equal(h.calls.filter(call => call.method === "conversations.archive").length, 2);
  assert.deepEqual(Object.keys(bridge.view(true).chats).sort(), [PROBE, OTHER].sort());
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
