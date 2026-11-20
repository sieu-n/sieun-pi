/**
 * The thread done tool (`thread-done.ts`) in the room-tools extension of a durable thread's root conversation, against a fake chat server on
 * loopback: `set_thread_done` posts `{message, done}` as the thread to `POST /api/threads/<thread>/done` and returns the server's line, and a
 * refusal becomes the call's error. The For list shows the flag of an item's thread next to its reactions (`for-me.ts` itemText).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ForMeItem, Principal } from "../../../../apps/chat/web/src/lib/api/types.ts";
import { ChatApp } from "../../src/durable/chat-app.ts";
import { itemText } from "../../src/durable/for-me.ts";
import { roomTools } from "../../src/durable/room-tools.ts";
import { SET_THREAD_DONE_DESCRIPTION, SET_THREAD_DONE_TOOL } from "../../src/durable/thread-done.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "pi-host-thread-done-"));
after(() => rmSync(dir, { recursive: true, force: true }));

interface Call { method: string; path: string; body: unknown }
const calls: Call[] = [];
let server: Server;
let app: ChatApp;
const readBody = async (req: IncomingMessage): Promise<unknown> => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
};
before(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    calls.push({ method: req.method!, path: req.url!, body });
    const answer = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (!req.url!.endsWith("/done")) return answer(404, { error: "No such route." });
    const change = body as { message: string; done: boolean };
    if (change.message === "p404") return answer(404, { error: "No post p404 in ch_test." });
    return answer(200, { room: "ch_test", post: "p12", done: change.done, text: `The thread of p12 in ch_test is ${change.done ? "done" : "open again"}.` });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  app = new ChatApp(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
});
after(() => new Promise<void>(resolve => server.close(() => resolve())));

async function run(thread: string, plan: { message_id: string; done: boolean }[]) {
  const models = createModels();
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  let made = 0;
  faux.setResponses(Array.from({ length: plan.length + 1 }, () => () => {
    const args = plan[made++];
    return args ? fauxAssistantMessage([fauxToolCall(SET_THREAD_DONE_TOOL, args)], { stopReason: "toolUse" }) : fauxAssistantMessage("done");
  }));
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(roomTools(app, thread));
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, `${thread}.sqlite`)), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
  await (await root.submit({ type: "input", content: "That's handled." }, context)).wait(context);
  const entries: EntryRecord[] = [...(await root.entries({ order: "ascending" }, 1000, undefined, context)).items];
  await harness.close(context);
  return entries.flatMap(entry => {
    const message = entry.model?.[0] as Message | undefined;
    return message?.role === "toolResult" ? [{ name: message.toolName, text: textOf(message.content), isError: message.isError }] : [];
  });
}

test("set_thread_done posts the flag as the thread, returns the server's line, and a refusal becomes the call's error", async () => {
  const out = await run("done", [{ message_id: "ch_test/p14", done: true }, { message_id: "p12", done: false }, { message_id: "p404", done: true }]);
  const posts = calls.filter(call => call.method === "POST" && call.path === "/api/threads/done/done").map(call => call.body);
  assert.deepEqual(posts, [{ message: "ch_test/p14", done: true }, { message: "p12", done: false }, { message: "p404", done: true }]);
  assert.deepEqual(out.map(result => [result.name, result.text, result.isError]), [
    [SET_THREAD_DONE_TOOL, "The thread of p12 in ch_test is done.", false],
    [SET_THREAD_DONE_TOOL, "The thread of p12 in ch_test is open again.", false],
    [SET_THREAD_DONE_TOOL, "No post p404 in ch_test.", true],
  ]);
});

test("set_thread_done's own text says the flag goes on the root, shows as a check and an owner reply reopens it", () => {
  assert.match(SET_THREAD_DONE_DESCRIPTION, /goes on the thread's root post/);
  assert.match(SET_THREAD_DONE_DESCRIPTION, /with a check and dimmed/);
  assert.match(SET_THREAD_DONE_DESCRIPTION, /A new reply from the owner in a done thread reopens it/);
});

test("a For list item shows its thread's done flag next to its reactions", () => {
  const owner: Principal = { id: "owner", kind: "owner", name: "Sieun", avatar: { initials: "SP", hue: 0 } };
  const vent: Principal = { id: "ag_vent", kind: "chat", name: "vent", avatar: { initials: "VE", hue: 1 } };
  const at = Date.UTC(2026, 10, 20, 5, 0);
  const item: ForMeItem = {
    id: "ch_test/p14", room: "ch_test", roomKind: "channel", roomName: "#test", post: "p14", threadRoot: "p12", author: owner, text: "ship it",
    at, activityAt: at, reasons: ["thread"], status: "pending", reactions: [{ emoji: "👀", by: [vent] }], done: { by: owner, at: at + 60_000 },
  };
  assert.equal(itemText(item).split("\n")[1], "[reactions: 👀 vent] [thread done by Sieun (owner)]");
  assert.equal(itemText({ ...item, reactions: [], done: undefined }).split("\n").length, 2);
});
