/**
 * `send_message` in every thread: a call lands as an assistant entry with the call and a tool result that says "Sent.", the tool reaches a
 * thread whose history predates it from its next request on, a subagent's child conversation is never offered it, and the thread list
 * previews the sent message, not its result.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type EntryRecord, type Registry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Preamble } from "../../src/durable/open.ts";
import { threadRegistry } from "../../src/durable/registry.ts";
import { SEND_MESSAGE_RESULT, SEND_MESSAGE_TOOL } from "../../src/durable/send-message.ts";
import { ForegroundSubagent as Subagent, SUBAGENT_STARTED } from "../../src/durable/subagent.ts";
import { previewText } from "../../src/durable/threads.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "pi-host-send-message-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Whether a request offered the tool: pi-ai carries tool declarations in the transcript's system messages. */
const offers = (messages: readonly Message[], tool: string): boolean => JSON.stringify(messages.filter(m => m.role === "system")).includes(`"${tool}"`);
const lastUser = (messages: readonly Message[]): string => textOf([...messages].reverse().find(m => m.role === "user")?.content ?? "");

async function open(file: string, registry: Registry, respond: FauxResponseFactory) {
  const models = createModels();
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  faux.setResponses(Array.from({ length: 32 }, () => respond));
  models.setProvider(faux.provider);
  const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
  return { harness, root };
}

async function ask(root: Awaited<ReturnType<typeof open>>["root"], text: string): Promise<EntryRecord[]> {
  const settled = await (await root.submit({ type: "input", content: text }, context)).wait(context);
  assert.equal(settled.status, "done");
  return [...(await root.entries({ order: "ascending" }, 1000, undefined, context)).items];
}

const calls = (entries: readonly EntryRecord[]) => entries.flatMap(entry => {
  const message = entry.model?.[0] as Message | undefined;
  return message?.role === "assistant" ? message.content.flatMap(c => (c.type === "toolCall" ? [{ entry: entry.id, name: c.name, args: c.arguments }] : [])) : [];
});
const results = (entries: readonly EntryRecord[]) => entries.flatMap(entry => {
  const message = entry.model?.[0] as Message | undefined;
  return message?.role === "toolResult" ? [{ name: message.toolName, text: textOf(message.content), isError: message.isError }] : [];
});

test("a thread from before the tool gets send_message on its next request, and each call is an entry whose result is Sent.", async () => {
  const file = join(dir, "old-thread.sqlite");
  const seen: boolean[] = [];
  // The thread's first turn runs on a registry without the tool, as every thread did before this change.
  const before = createRegistry();
  before.install(Preamble);
  before.install(Subagent);
  const first = await open(file, before, ({ messages }) => {
    seen.push(offers(messages, SEND_MESSAGE_TOOL));
    return fauxAssistantMessage("The old answer, as plain text.");
  });
  await ask(first.root, "How is the relay?");
  await first.harness.close(context);
  assert.deepEqual(seen, [false]);

  // The same file reopened on threadRegistry(): the model now answers through two send_message calls and a private note.
  const second = await open(file, threadRegistry(), ({ messages }) => {
    seen.push(offers(messages, SEND_MESSAGE_TOOL));
    if (messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("Private note: told him both points.");
    return fauxAssistantMessage([
      fauxText("Checking the relay log first."),
      fauxToolCall(SEND_MESSAGE_TOOL, { text: "The relay is up again since 02:11." }),
      fauxToolCall(SEND_MESSAGE_TOOL, { text: "The canary needs your ok to ship.", to: "#pi-cutover" }),
    ], { stopReason: "toolUse" });
  });
  const entries = await ask(second.root, "And now?");
  await second.harness.close(context);
  assert.deepEqual(seen, [false, true, true]);
  const sent = calls(entries).filter(call => call.name === SEND_MESSAGE_TOOL);
  assert.deepEqual(sent.map(call => call.args), [{ text: "The relay is up again since 02:11." }, { text: "The canary needs your ok to ship.", to: "#pi-cutover" }]);
  assert.equal(new Set(sent.map(call => call.entry)).size, 1, "both calls sit in one assistant entry");
  assert.deepEqual(results(entries), [
    { name: SEND_MESSAGE_TOOL, text: SEND_MESSAGE_RESULT, isError: false },
    { name: SEND_MESSAGE_TOOL, text: SEND_MESSAGE_RESULT, isError: false },
  ]);
  // The tool arrives as a new pi.system entry after the second input; the first one, from before the tool, stays as it was.
  const systems = entries.filter(e => e.kind === "pi.system").map(e => JSON.stringify(e.model ?? null).includes(`"${SEND_MESSAGE_TOOL}"`));
  assert.deepEqual(systems, [false, true]);
  // The old turn is untouched: its answer is still plain text.
  assert.ok(entries.some(entry => entry.kind === "pi.assistant" && textOf((entry.model?.[0] as Message).content) === "The old answer, as plain text."));
});

test("a subagent's child conversation is not offered send_message, so its answer stays its final text and reaches the parent as an input", async () => {
  const file = join(dir, "child.sqlite");
  const offered = new Map<string, boolean>();
  const task = "List three primes.";
  const { harness, root } = await open(file, threadRegistry(), ({ messages }) => {
    const user = textOf(messages.find(m => m.role === "user")?.content ?? "");
    if (user === task) {
      offered.set("child", offers(messages, SEND_MESSAGE_TOOL));
      offered.set("child read", offers(messages, "read"));
      return fauxAssistantMessage("2, 3, 5");
    }
    offered.set("root", offers(messages, SEND_MESSAGE_TOOL));
    const last = messages.at(-1)!;
    if (last.role === "toolResult") return fauxAssistantMessage("");
    const text = textOf(last.content as Message["content"]);
    if (text.startsWith("[subagent-answer")) return fauxAssistantMessage([fauxToolCall(SEND_MESSAGE_TOOL, { text: `It said ${text.split("\n\n")[1]}.` })], { stopReason: "toolUse" });
    return fauxAssistantMessage([fauxToolCall("subagent", { task })], { stopReason: "toolUse" });
  });
  const first = await ask(root, "Ask a subagent.");
  assert.equal(results(first).find(r => r.name === "subagent")?.text, SUBAGENT_STARTED);
  let entries: EntryRecord[] = [];
  for (let i = 0; i < 200 && !calls(entries).some(call => call.name === SEND_MESSAGE_TOOL); i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    entries = [...(await root.entries({ order: "ascending" }, 1000, undefined, context)).items];
  }
  await harness.close(context);
  assert.deepEqual(Object.fromEntries(offered), { root: true, child: false, "child read": true });
  assert.deepEqual(calls(entries).filter(call => call.name === SEND_MESSAGE_TOOL).map(call => call.args), [{ text: "It said 2, 3, 5." }]);
});

test("the thread list previews the newest sent message, never its Sent. result", () => {
  const entry = (kind: string, message: Message) => ({ id: 1, conversationId: 1, kind, model: [message] }) as unknown as EntryRecord;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const sent = entry("pi.assistant", { role: "assistant", content: [fauxText("Note to self."), fauxToolCall(SEND_MESSAGE_TOOL, { text: "First." }), fauxToolCall(SEND_MESSAGE_TOOL, { text: "Second." })], api: "faux", provider: "anthropic", model: "m", usage, stopReason: "toolUse", timestamp: 1 } as Message);
  assert.equal(previewText(sent, 0), "Second.");
  assert.equal(previewText(entry("pi.tool-result", { role: "toolResult", toolCallId: "c", toolName: SEND_MESSAGE_TOOL, content: [{ type: "text", text: SEND_MESSAGE_RESULT }], isError: false, timestamp: 1 } as Message), 0), undefined);
  assert.equal(previewText(entry("pi.assistant", { role: "assistant", content: [fauxText("Plain answer.")], api: "faux", provider: "anthropic", model: "m", usage, stopReason: "stop", timestamp: 1 } as Message), 0), "Plain answer.");
});
