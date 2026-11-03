/**
 * Prime's chat extension in a durable thread (`prime-chat.ts` through `pi-extensions.ts`): the root conversation offers `tell_owner`,
 * `chat_board`, `correction_add`, `search_history` and `poteto_mode` with the definitions the user-history extension itself registers,
 * an owner input reaches the model with Prime's `[message id: ...]` and another sender's with Prime's `[not from the owner: ...]` while the
 * stored entries keep the raw text, tell_owner's guard holds a message on a turn the owner did not start, chat_board reads and writes the
 * new chat's board through its HTTP API, correction_add writes the shared ledger, and a subagent's child conversation gets none of them. In a
 * comm thread, tell_owner refuses a post after the turn's hand-over and a relay line (`comm-guard.ts`) before Prime's guard reads it.
 * A DM comm thread's answer left as text on the owner's turn queues one note that asks it to post (`comm-reply.ts`), also when his next post waits.
 * `set_emoji` (`room-tools.ts`) posts the thread's reaction to the chat server and passes its answer or its error through.
 */
import { strict as assert } from "node:assert";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { getCurrentTools, toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import { Harness, ROOT_CONVERSATION_ID, type ContextView, type EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { TELL_OWNER_DESCRIPTION, TELL_OWNER_PARAMETERS, WAKE_NOTE } from "../../../../legacy/prime/user-history/src/chat-guard.ts";
import { messageIdNote, TELL_OWNER_HELD } from "../../../../legacy/prime/user-history/src/shared/chat-feed.ts";
import type { ThreadMessage } from "../../../../legacy/prime/user-history/src/shared/types.ts";
import { AGENT_REF_DOC } from "../../src/durable/agent-profile.ts";
import { ChatApp } from "../../src/durable/chat-app.ts";
import { CommHandedDoc } from "../../src/durable/comm.ts";
import { UNPOSTED_REPLY, unpostedReply, unpostedReplyNote, unpostedReplyRequest } from "../../src/durable/comm-reply.ts";
import { LIST_FOR_ME_TOOL, MARK_MESSAGE_TOOL } from "../../src/durable/for-me.ts";
import { loadPrimeChat, PRIME_CHAT_TOOLS, withTurnWrappers, type ChatThread, type PrimeChat } from "../../src/durable/prime-chat.ts";
import { guidelines } from "../../src/durable/prime-prompt.ts";
import { ChatDoc, threadRegistry } from "../../src/durable/registry.ts";
import { SET_EMOJI_TOOL } from "../../src/durable/room-tools.ts";
import { SEND_MESSAGE_TOOL } from "../../src/durable/send-message.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "pi-host-prime-chat-"));
after(() => rmSync(dir, { recursive: true, force: true }));
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);
// No hosts registry, so the extension finds no remote chat host and writes this box's ledger, as on the chat host itself.
process.env.SIEUN_PI_HOSTS = join(dir, "no-hosts.json");
delete process.env.AGENT_CHAT_SHARED_DIR;
const agentDir = join(dir, "agent");
cpSync(join(import.meta.dirname, "../fixtures/prime-agent"), agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
// The extension resolves pi-coding-agent to prime-agent (legacy/prime/user-history/node_modules), whose agent dir variable this is.
process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
const ledgerDir = join(dir, "shared-chat");
mkdirSync(ledgerDir);

/** apps/chat's board, check-in, agents and For you routes, as the tools call them. */
interface Call { method: string; path: string; body: unknown }
const calls: Call[] = [];
let board: Record<string, unknown> | null = null;
let server: Server;
let chat: PrimeChat;
const readBody = async (req: IncomingMessage): Promise<unknown> => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
};
before(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    calls.push({ method: req.method!, path: req.url!, body });
    const send = (value: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url!.endsWith("/board") && req.method === "POST") {
      const ops = (body as { ops: { op: string; text?: string }[] }).ops;
      board = { v: 2, rev: 1, plan: [{ id: "p1", text: ops[0]!.text, status: "todo", children: [] }], todos: [], updatedAt: new Date().toISOString() };
      return send({ board, awaitingGo: [], summaries: [`Added p1: ${ops[0]!.text}`] });
    }
    if (req.url!.endsWith("/board")) return send({ board, awaitingGo: [] });
    if (req.url!.endsWith("/check-in")) return send({ everyMs: 120 * 60_000, paused: false, pausedUntil: null, nextAt: null, lastAt: null });
    if (req.url!.endsWith("/agents")) return send({ agents: [] });
    if (req.url === "/api/for-you") return send({ items: [] });
    if (req.url!.endsWith("/reactions")) {
      const { message, emoji, on } = body as { message: string; emoji: string; on: boolean };
      if (message === "p404") { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "No post p404 in dm_vent. Pass a post id such as p12." })); }
      return send({ room: "dm_vent", post: message, reactions: on ? [{ emoji: "👀", by: ["vent"] }] : [], text: `${emoji === "eyes" ? "👀" : emoji} is ${on ? "on" : "off"} ${message} in dm_vent.` });
    }
    res.writeHead(404).end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  chat = await loadPrimeChat({ agentDir, dataDir: ledgerDir, app: new ChatApp(`http://127.0.0.1:${address.port}`) });
});
after(() => new Promise<void>(resolve => server.close(() => resolve())));

const offered = (messages: readonly Message[]) => getCurrentTools(messages as never).map(tool => toToolDeclaration(tool));
const lastUser = (messages: readonly Message[]) => [...messages].reverse().find(m => m.role === "user");

async function open(name: string, respond: FauxResponseFactory) {
  const file = join(dir, `${name}.sqlite`);
  let harness: Harness | undefined;
  let rootOf: Awaited<ReturnType<Harness["root"]>> | undefined;
  const thread: ChatThread = {
    id: name, name: () => name, file, cwd: dir, harness: () => harness,
    submit: (text, requestId) => rootOf!.submit({ type: "input", content: text, requestId, whenBusy: "followUp" }, context),
  };
  const models = createModels();
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  faux.setResponses(Array.from({ length: 32 }, () => respond));
  models.setProvider(faux.provider);
  harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry: threadRegistry(undefined, { chat, thread }) }, context);
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
  rootOf = root;
  return { harness, root };
}

async function entriesOf(root: Awaited<ReturnType<typeof open>>["root"]): Promise<EntryRecord[]> {
  return [...(await root.entries({ order: "ascending" }, 1000, undefined, context)).items];
}
const results = (entries: readonly EntryRecord[]) => entries.flatMap(entry => {
  const message = entry.model?.[0] as Message | undefined;
  return message?.role === "toolResult" ? [{ name: message.toolName, text: textOf(message.content), isError: message.isError }] : [];
});

test("the extension registers a Prime chat's tools, and their guidelines are the guidance prime-prompt builds", () => {
  assert.deepEqual(chat.tools.map(tool => tool.name), [...PRIME_CHAT_TOOLS]);
  const tell = chat.loaded.tools.get("tell_owner")!;
  assert.equal(tell.description, TELL_OWNER_DESCRIPTION);
  assert.deepEqual(tell.parameters, TELL_OWNER_PARAMETERS);
  // The brief rides on chat_board and the persona line on poteto_mode, as Prime's base prompt reads them; prime-prompt renders the same lines.
  const lines = chat.tools.flatMap(tool => tool.promptGuidelines ?? []);
  assert.deepEqual(lines, guidelines({ agentDir, depth: 0 }));
  assert.ok(chat.loaded.skipped.has("registerCommand"));
});

test("a durable chat thread offers the extension's tools with its exact definitions, after the coding tools, subagent and send_message", async () => {
  let tools: ReturnType<typeof offered> = [];
  const { harness, root } = await open("offers", ({ messages }) => {
    tools = offered(messages);
    return fauxAssistantMessage("ok");
  });
  await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);
  await harness.close(context);
  assert.deepEqual(tools.map(tool => tool.name), ["read", "write", "edit", "bash", "subagent", SEND_MESSAGE_TOOL, ...PRIME_CHAT_TOOLS, SET_EMOJI_TOOL, LIST_FOR_ME_TOOL, MARK_MESSAGE_TOOL]);
  for (const name of PRIME_CHAT_TOOLS) {
    const registered = chat.loaded.tools.get(name)!;
    assert.deepEqual(tools.find(tool => tool.name === name), toToolDeclaration({ name, description: registered.description, parameters: registered.parameters as never }), name);
  }
});

test("an owner input reaches the model with Prime's message id, another sender's with the wake note, and the entries keep the raw text", async () => {
  const seen: Message[] = [];
  const { harness, root } = await open("wrappers", ({ messages }) => {
    seen.push(lastUser(messages)!);
    return fauxAssistantMessage("ok");
  });
  await (await root.submit({ type: "input", content: "How is the relay?" }, context)).wait(context);
  await (await root.submit({ type: "input", content: "Check-in: read the board.", entry: { kind: "agent.message", data: { from: "board", via: "check-in" } } }, context)).wait(context);
  const entries = await entriesOf(root);
  await harness.close(context);
  const owner = entries.find(entry => entry.kind === "pi.user")!.model![0] as Message & { timestamp: number };
  assert.equal(textOf(owner.content), "How is the relay?");
  assert.deepEqual((seen[0]!.content as { text: string }[]).map(part => part.text), ["How is the relay?", messageIdNote(owner.timestamp)]);
  assert.deepEqual((seen[1]!.content as { text: string }[]).map(part => part.text), ["Check-in: read the board.", WAKE_NOTE]);
  assert.equal(seen[1]!.role, "user");
  const stored = entries.find(entry => entry.kind === "agent.message")!.model![0] as Message;
  assert.equal(textOf(stored.content), "Check-in: read the board.");
});

test("an imported Prime message keeps its custom type, so only Prime's wake types get the note, and a summary gets no message id", () => {
  const user = (text: string, at: number) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: at });
  const rows: [string, unknown, ReturnType<typeof user>][] = [
    ["prime.custom", { customType: "heartbeat_prompt", display: true }, user("Heartbeat: check the relay.", 1)],
    ["prime.custom", { customType: "rlm_task_brief", display: false }, user("Your task: count to three.", 2)],
    ["pi.compaction", { reason: "threshold" }, user("The conversation history before this point was compacted.", 3)],
    ["pi.user", undefined, user("And now?", 4)],
  ];
  const view = { head: undefined, entries: rows.map(([kind, data], index) => ({ id: index + 1, conversationId: 1, kind, data })), contributions: rows.map(([, , message]) => [message]),
    messages: rows.map(([, , message]) => message) } as unknown as ContextView;
  const out = withTurnWrappers(view.messages, view).map(message => (message.content as { text: string }[]).map(part => part.text));
  assert.deepEqual(out, [["Heartbeat: check the relay.", WAKE_NOTE], ["Your task: count to three."], ["The conversation history before this point was compacted."], ["And now?", messageIdNote(4)]]);
});

test("tell_owner sends on the owner's turn, refuses a call with no why on a check-in and holds an update there, as Prime's guard does", async () => {
  const plan: Record<string, string>[] = [{ text: "The relay is up again." }, { text: "The relay is up again." }, { text: "The relay is up again.", why: "update", about: "relay" }];
  let made = 0;
  const { harness, root } = await open("tell", ({ messages }) => {
    const last = messages.at(-1)!;
    // One call per owner turn; the check-in turn calls again after its first answer.
    if (last.role === "toolResult" && (made === 1 || made === 3)) return fauxAssistantMessage("");
    return fauxAssistantMessage([fauxToolCall("tell_owner", plan[made++]!)], { stopReason: "toolUse" });
  });
  await (await root.submit({ type: "input", content: "Is the relay up?" }, context)).wait(context);
  await (await root.submit({ type: "input", content: "Check-in: read the board.", entry: { kind: "agent.message", data: { from: "board", via: "check-in" } } }, context)).wait(context);
  const told = results(await entriesOf(root)).filter(result => result.name === "tell_owner");
  await harness.close(context);
  assert.equal(told[0]!.text, "told the owner");
  assert.equal(told[1]!.isError, true);
  assert.match(told[1]!.text, /^why is required on a turn the owner did not start/);
  assert.ok(told[2]!.text.startsWith(TELL_OWNER_HELD), told[2]!.text);
  assert.ok(calls.some(call => call.method === "GET" && call.path === "/api/threads/tell/board"), "the check read the thread's board");
});

test("in a comm thread, a post after the turn's hand-over and a relay line are refused, and a question and a result go out", async () => {
  const steps: (Record<string, string> | null)[] = [
    { text: "Makes sense, Accounts moves into a tab under Settings and leaves the top bar." },
    { tool: SEND_MESSAGE_TOOL, text: "Makes sense, Accounts moves into a tab under Settings and leaves the top bar." },
    { text: "Which repo should the panel list cover, auto-sns-agent only or every repo?" },
    null,
    { text: "The work thread is reading threads.ts now, the last of the 20 files." },
    { text: "I'll post the wiki link here once the list is done." },
    null,
    { text: "The work thread is reading threads.ts now, the last of the 20 files.", why: "update", about: "summaries" },
    { text: "summaries.md is done, with one line for each of the 20 files.", why: "done", about: "summaries" },
    null,
  ];
  let made = 0;
  const { harness, root } = await open("comm-guard", () => {
    const step = steps[made++];
    if (!step) return fauxAssistantMessage("");
    const { tool = "tell_owner", ...args } = step;
    return fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: "toolUse" });
  });
  const handAt = (at: number) => harness.commit(async tx => {
    (await tx.doc(ChatDoc, ROOT_CONVERSATION_ID, AGENT_REF_DOC, null)).value = { agent: "ag_vent", dir: agentDir, role: "comm", room: "ch_1a2b3c4d", work: "w-1" };
    (await tx.doc(CommHandedDoc, ROOT_CONVERSATION_ID)).at = at;
  }, context);
  // The hand-over is noted after the owner's post arrives, as threads.ts notes it while the turn runs.
  await handAt(Date.now() + 3_600_000);
  await (await root.submit({ type: "input", content: "@vent list every management panel" }, context)).wait(context);
  await handAt(1);
  await (await root.submit({ type: "input", content: "@vent how far is the list?" }, context)).wait(context);
  await (await root.submit({ type: "input", content: "[agent-message from sibling:vent]\n\nreading threads.ts", entry: { kind: "agent.message", data: { from: "w-1", via: "agent_message" } } }, context)).wait(context);
  const all = results(await entriesOf(root));
  const told = all.filter(result => result.name === "tell_owner");
  await harness.close(context);
  const sent = all.find(result => result.name === SEND_MESSAGE_TOOL)!;
  assert.equal(sent.isError, true);
  assert.match(sent.text, /Not sent: you handed this to your work thread in this turn/, "send_message gets the same check");
  assert.equal(told.length, 6);
  assert.equal(told[0]!.isError, true);
  assert.match(told[0]!.text, /Not sent: you handed this to your work thread in this turn/);
  assert.equal(told[1]!.text, "told the owner", "a question goes out after the hand-over");
  assert.equal(told[2]!.text, "told the owner", "progress answers the owner's own status question");
  assert.match(told[3]!.text, /Not sent: "I'll post the wiki link here once" announces a hand-over/);
  assert.match(told[4]!.text, /Not sent: "The work thread is reading" is progress on work still going/);
  assert.doesNotMatch(told[5]!.text, /Not sent/, "the result passes the comm check");
});

test("in a DM comm thread, an answer left as text on the owner's turn queues one note and then posts, also past his next post, and a handed, posted, notice or group turn gets none", async () => {
  const markdown = "The dashboards are on [Grafana dashboards](wiki:apps/infra/grafana-boards.html).";
  let steer: Promise<unknown> | undefined;
  const { harness, root } = await open("comm-reply", async ({ messages }) => {
    // The inputs since the last settled answer, as one turn: the model answers each of them once.
    const settled = messages.findLastIndex(m => m.role === "assistant" && m.stopReason !== "toolUse");
    const turn = messages.slice(settled + 1);
    if (turn.some(m => m.role === "toolResult")) return fauxAssistantMessage("");
    const texts = turn.filter(m => m.role === "user").map(m => textOf(m.content));
    const posts: string[] = [];
    for (const text of texts) {
      if (text.startsWith(UNPOSTED_REPLY)) {
        if (text.includes("ALPHA")) posts.push("ALPHA");
        else if (!text.includes("thanks")) posts.push(markdown);
      } else if (text.includes("17 times 23")) posts.push("391.");
      else if (text.includes("post first")) posts.push("Here it is.");
    }
    if (posts.length) return fauxAssistantMessage(posts.map(text => fauxToolCall("tell_owner", { text })), { stopReason: "toolUse" });
    const text = texts.at(-1) ?? "";
    if (text.includes("ALPHA")) {
      // His next post arrives while this turn runs, so it waits at the run's end.
      steer = root.submit({ type: "input", content: "What is 17 times 23?", whenBusy: "steer" }, context);
      await steer;
      return fauxAssistantMessage("ALPHA");
    }
    if (text.includes("thanks")) return fauxAssistantMessage("I put 🙏 on your thanks.");
    if (text.includes("hand this")) return fauxAssistantMessage("I handed it to the work thread.");
    if (text.startsWith(UNPOSTED_REPLY) || text.includes("post first")) return fauxAssistantMessage("");
    return fauxAssistantMessage(markdown);
  });
  const refIn = (room: string, handedAt: number) => harness.commit(async tx => {
    (await tx.doc(ChatDoc, ROOT_CONVERSATION_ID, AGENT_REF_DOC, null)).value = { agent: "ag_vent", dir: agentDir, role: "comm", room, work: "w-1" };
    (await tx.doc(CommHandedDoc, ROOT_CONVERSATION_ID)).at = handedAt;
  }, context);
  const idle = () => harness.waitForIdle(context);
  const ask = async (content: string, entry?: { kind: string; data: { from: string; via: string } }) => {
    await (await root.submit({ type: "input", content, ...(entry ? { entry } : {}) }, context)).wait(context);
    await idle();
  };
  await refIn("dm_vent", 0);
  await ask("Reply with exactly the markdown and nothing else, no tools.");
  await ask("nice, thanks!");
  await ask("Reply with exactly the word ALPHA and nothing else, no tools.");
  await steer;
  await idle();
  // The hand-over is noted after the owner's post arrives, as threads.ts notes it while the turn runs.
  await refIn("dm_vent", Date.now() + 3_600_000);
  await ask("hand this to the work thread");
  await refIn("dm_vent", 1);
  await ask("post first, then say so");
  await ask("[work-done: no-reply agent:vent]\n\nLast assistant text: page built", { kind: "agent.message", data: { from: "w-1", via: "work.done" } });
  await refIn("ch_1a2b3c4d", 0);
  await ask("[#vent-dev · post 3 from You (owner) · hops 0]\n\nReply with the markdown in the channel.");
  const entries = await entriesOf(root);
  await harness.close(context);
  const notes = entries.filter(entry => entry.kind === "pi.user").map(entry => textOf((entry.model![0] as Message).content)).filter(text => text.startsWith(UNPOSTED_REPLY));
  assert.deepEqual(notes, [
    unpostedReplyNote("Reply with exactly the markdown and nothing else, no tools."), unpostedReplyNote("nice, thanks!"),
    unpostedReplyNote("Reply with exactly the word ALPHA and nothing else, no tools."),
  ]);
  assert.match(notes[0]!, /The owner's message is still unanswered: "Reply with exactly the markdown/);
  const posts = entries.flatMap(entry => (entry.model?.[0] as Message | undefined)?.role === "assistant" ? ((entry.model![0] as Message).content as { type: string; name?: string; arguments?: { text?: string } }[]).filter(part => part.type === "toolCall" && part.name === "tell_owner").map(part => part.arguments!.text) : []);
  assert.deepEqual(posts.sort(), [markdown, "391.", "ALPHA", "Here it is."].sort());
  const told = results(entries).filter(result => result.name === "tell_owner");
  assert.deepEqual(told.map(result => result.text), ["told the owner", "told the owner", "told the owner", "told the owner"], "the note's turn is the owner's, so each post goes out");
});

test("the unposted reply check reads only the turn since the last settled answer, and a turn its note started gets no second note", () => {
  const speaking = new Set(["tell_owner", "send_message"]);
  const user = (text: string, timestamp = 10) => ({ role: "user", content: [{ type: "text", text }], timestamp }) as unknown as ThreadMessage;
  const said = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: 11 }) as unknown as ThreadMessage;
  const answer = { content: [{ type: "text", text: "the answer" }] };
  const note = (messages: ThreadMessage[], handedAt = 0, reply = answer) => unpostedReply(messages, reply, handedAt, speaking)?.note;
  assert.deepEqual(unpostedReply([user("what is up?")], answer, 0, speaking), { note: unpostedReplyNote("what is up?"), ownerAt: 10 });
  assert.equal(note([user("what is up?")], 0, { content: [{ type: "text", text: "  " }] }), undefined, "an empty answer needs no post");
  assert.equal(note([user("what is up?"), said("old answer"), user(unpostedReplyNote("what is up?"), 12)]), undefined);
  assert.equal(note([user("what is up?"), said("", "error")]), unpostedReplyNote("what is up?"), "a failed request the pool retries ends no turn");
  assert.equal(note([user("what is up?", 10)], 10), undefined, "a hand-over in the turn waits for the work-done notice");
  assert.equal(note([user("what is up?", 10)], 9), unpostedReplyNote("what is up?"), "a hand-over of an earlier turn does not count");
  const held = { role: "toolResult", toolName: "tell_owner", content: [{ type: "text", text: `${TELL_OWNER_HELD}. why` }], isError: false, timestamp: 11 } as unknown as ThreadMessage;
  assert.equal(note([user("what is up?"), held]), unpostedReplyNote("what is up?"), "a held post reached nobody");
  assert.equal(note([user("[check-in] Re-check the board.")]), undefined, "a server note is no owner post");
  assert.equal(unpostedReplyRequest("t1", 10), "unposted:t1:10");
  assert.ok(unpostedReplyNote("x".repeat(400)).length < 600);
});

test("chat_board writes through the chat server as the agent and reads the open plan back in Prime's words", async () => {
  let step = 0;
  const { harness, root } = await open("board", () => {
    step++;
    if (step === 1) return fauxAssistantMessage([fauxToolCall("chat_board", { ops: [{ op: "plan_add", text: "Ship the relay fix" }] })], { stopReason: "toolUse" });
    if (step === 2) return fauxAssistantMessage([fauxToolCall("chat_board", {})], { stopReason: "toolUse" });
    return fauxAssistantMessage("done");
  });
  await (await root.submit({ type: "input", content: "Plan the relay fix." }, context)).wait(context);
  const out = results(await entriesOf(root)).filter(result => result.name === "chat_board");
  await harness.close(context);
  const write = calls.find(call => call.method === "POST" && call.path === "/api/threads/board/board")!;
  assert.deepEqual(write.body, { ops: [{ op: "plan_add", text: "Ship the relay fix" }], actor: "agent" });
  assert.equal(out[0]!.isError, false);
  assert.match(out[0]!.text, /^Added p1: Ship the relay fix\nBoard rev 1: 1 open steps, 0 open todos\.$/);
  assert.match(out[1]!.text, /^This chat: thread:board\nCheck-in: every 120 min\nBoard rev 1\. Open plan/);
  assert.match(out[1]!.text, /p1/);
});

test("set_emoji posts the reaction to the chat server as the thread, returns its line, and an error answer becomes the call's error", async () => {
  const plan = [{ message_id: "dm_vent/p7", emoji: "eyes", on: true }, { message_id: "dm_vent/p7", emoji: "eyes", on: false }, { message_id: "p404", emoji: "eyes", on: true }];
  let made = 0;
  const { harness, root } = await open("react", () => {
    const args = plan[made++];
    return args ? fauxAssistantMessage([fauxToolCall(SET_EMOJI_TOOL, args)], { stopReason: "toolUse" }) : fauxAssistantMessage("done");
  });
  await (await root.submit({ type: "input", content: "Look at p7." }, context)).wait(context);
  const out = results(await entriesOf(root)).filter(result => result.name === SET_EMOJI_TOOL);
  await harness.close(context);
  const posts = calls.filter(call => call.method === "POST" && call.path === "/api/threads/react/reactions").map(call => call.body);
  assert.deepEqual(posts, [{ message: "dm_vent/p7", emoji: "eyes", on: true }, { message: "dm_vent/p7", emoji: "eyes", on: false }, { message: "p404", emoji: "eyes", on: true }]);
  assert.deepEqual(out.map(result => [result.text, result.isError]), [
    ["👀 is on dm_vent/p7 in dm_vent.", false], ["👀 is off dm_vent/p7 in dm_vent.", false], ["No post p404 in dm_vent. Pass a post id such as p12.", true],
  ]);
});

test("correction_add runs the extension's own execute and writes the shared ledger with the thread as the chat", async () => {
  const { harness, root } = await open("corrections", ({ messages }) => {
    if (messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("");
    return fauxAssistantMessage([fauxToolCall("correction_add", { words: "always say the time in KST", rule: "Give times in KST.", theme: "time zone kst", ref: "chat brief" })], { stopReason: "toolUse" });
  });
  await (await root.submit({ type: "input", content: "always say the time in KST" }, context)).wait(context);
  const out = results(await entriesOf(root)).find(result => result.name === "correction_add")!;
  await harness.close(context);
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /^Recorded c1: Give times in KST\./);
  assert.ok(existsSync(join(ledgerDir, "corrections.json")));
  const ledger = JSON.parse(readFileSync(join(ledgerDir, "corrections.json"), "utf8")) as { corrections: { chat: { id: string; name: string } }[] };
  assert.deepEqual(ledger.corrections[0]!.chat, { id: "corrections", name: "corrections" });
});

test("a subagent's child conversation is offered none of the chat's tools and gets no turn wrappers", async () => {
  const childTools: string[][] = [];
  const childUsers: Message[] = [];
  const { harness, root } = await open("child", ({ messages }) => {
    const system = JSON.stringify(messages.filter(m => m.role === "system"));
    const user = lastUser(messages)!;
    if (textOf(user.content).startsWith("Count")) {
      childTools.push(offered(messages).map(tool => tool.name));
      childUsers.push(user);
      return fauxAssistantMessage("1 2 3");
    }
    if (messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("done");
    void system;
    return fauxAssistantMessage([fauxToolCall("subagent", { task: "Count to three." })], { stopReason: "toolUse" });
  });
  await (await root.submit({ type: "input", content: "Ask a subagent to count." }, context)).wait(context);
  await harness.close(context);
  assert.deepEqual(childTools[0], ["read", "write", "edit", "bash"]);
  assert.equal(textOf(childUsers[0]!.content), "Count to three.");
  assert.equal(ROOT_CONVERSATION_ID, 1);
});
