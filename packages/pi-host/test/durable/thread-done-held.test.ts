/**
 * set_thread_done holds once when the turn's newest tell_owner did not go out (`heldAnswer`, c98). On 11-21 a blind run's comm thread called
 * tell_owner and set_thread_done in one round, tell_owner held the answer as long, and the room showed the thread done with no answer in it.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, Type, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTool, Harness, type EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ChatApp } from "../../src/durable/chat-app.ts";
import { roomTools } from "../../src/durable/room-tools.ts";
import { HELD_DONE_MARK, SET_THREAD_DONE_TOOL } from "../../src/durable/thread-done.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "pi-host-thread-done-held-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let server: Server;
let app: ChatApp;
const marked: string[] = [];
before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) as { message: string } : { message: "" };
      marked.push(body.message);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: `The thread of ${body.message} is done.` }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  app = new ChatApp(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
});
after(() => new Promise<void>(resolve => server.close(() => resolve())));

type Call = { name: string; args: Record<string, string | boolean> };
/** One turn whose model makes each round's calls in turn; a tell_owner text with "long" in it is refused as tell_owner refuses a long one. */
async function run(thread: string, rounds: Call[][]): Promise<{ name: string; text: string; isError: boolean }[]> {
  const models = createModels();
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  let made = 0;
  faux.setResponses(Array.from({ length: rounds.length + 1 }, () => () => {
    const round = rounds[made++];
    return round ? fauxAssistantMessage(round.map(call => fauxToolCall(call.name, call.args)), { stopReason: "toolUse" }) : fauxAssistantMessage("");
  }));
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(roomTools(app, thread));
  registry.install(defineExtension({ name: "fake-tell-owner", tools: [defineTool({
    name: "tell_owner", description: "Post to the room.", parameters: Type.Object({ text: Type.String() }),
    execute: async args => args.text.includes("long")
      ? { output: [{ type: "text", text: "Not sent, it runs long, with 90 words in all." }], isError: true }
      : { output: [{ type: "text", text: "told the owner" }] },
  })] }));
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, `${thread}.sqlite`)), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
  await (await root.submit({ type: "input", content: "where do posts live?" }, context)).wait(context);
  const entries: EntryRecord[] = [...(await root.entries({ order: "ascending" }, 1000, undefined, context)).items];
  await harness.close(context);
  return entries.flatMap(entry => {
    const message = entry.model?.[0] as Message | undefined;
    return message?.role === "toolResult" ? [{ name: message.toolName, text: textOf(message.content), isError: message.isError }] : [];
  });
}

const done = { name: SET_THREAD_DONE_TOOL, args: { message_id: "dm_vent/p2", done: true } };
const long = { name: "tell_owner", args: { text: "a long answer" } };
const short = { name: "tell_owner", args: { text: "in one file per room" } };

test("a done mark in the round whose answer tell_owner held is held once, and the same call again goes through", async () => {
  marked.length = 0;
  const results = await run("th_held", [[long, done], [done]]);
  const marks = results.filter(r => r.name === SET_THREAD_DONE_TOOL);
  assert.ok(marks[0]!.isError && marks[0]!.text.startsWith(HELD_DONE_MARK), marks[0]!.text);
  assert.equal(marks[1]!.isError, false, "the same call again marks it");
  assert.deepEqual(marked, ["dm_vent/p2"], "the server got one mark, the second call's");
});

test("a done mark after the answer went out, or after a held answer was sent again, or with no post in the turn goes through", async () => {
  marked.length = 0;
  for (const [thread, rounds] of [["th_sent", [[short, done]]], ["th_resent", [[long], [short, done]]], ["th_quiet", [[done]]]] as const) {
    const marks = (await run(thread, rounds.map(round => [...round]))).filter(r => r.name === SET_THREAD_DONE_TOOL);
    assert.equal(marks[0]!.isError, false, `${thread}: ${marks[0]!.text}`);
  }
  assert.equal(marked.length, 3);
});
