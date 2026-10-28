/**
 * Prime's chat extension in a durable thread (`prime-chat.ts` through `pi-extensions.ts`): the root conversation offers `tell_owner`,
 * `chat_board`, `correction_add`, `search_history` and `poteto_mode` with the definitions the user-history extension itself registers,
 * an owner input reaches the model with Prime's `[message id: ...]` and another sender's with Prime's `[not from the owner: ...]` while the
 * stored entries keep the raw text, tell_owner's guard holds a message on a turn the owner did not start, chat_board reads and writes the
 * new chat's board through its HTTP API, correction_add writes the shared ledger, and a subagent's child conversation gets none of them.
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
import { Harness, ROOT_CONVERSATION_ID, type EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { TELL_OWNER_DESCRIPTION, TELL_OWNER_PARAMETERS, WAKE_NOTE } from "../../../../legacy/prime/user-history/src/chat-guard.ts";
import { messageIdNote, TELL_OWNER_HELD } from "../../../../legacy/prime/user-history/src/shared/chat-feed.ts";
import { ChatApp } from "../../src/durable/chat-app.ts";
import { loadPrimeChat, PRIME_CHAT_TOOLS, type ChatThread, type PrimeChat } from "../../src/durable/prime-chat.ts";
import { guidelines } from "../../src/durable/prime-prompt.ts";
import { threadRegistry } from "../../src/durable/registry.ts";
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
  const thread: ChatThread = { id: name, name: () => name, file, cwd: dir, harness: () => harness };
  const models = createModels();
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  faux.setResponses(Array.from({ length: 32 }, () => respond));
  models.setProvider(faux.provider);
  harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry: threadRegistry(undefined, { chat, thread }) }, context);
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
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
  assert.deepEqual(tools.map(tool => tool.name), ["read", "write", "edit", "bash", "subagent", SEND_MESSAGE_TOOL, ...PRIME_CHAT_TOOLS]);
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
