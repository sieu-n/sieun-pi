/**
 * The read_post tool (`read-post.ts`) in the room-tools extension of a durable thread's root conversation, against a fake chat server on
 * loopback: it reads `GET /api/threads/<thread>/post?message=<id>` as the thread, returns the server's text, and returns a 404's sentence as an error.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ChatApp } from "../../src/durable/chat-app.ts";
import { READ_POST_TOOL } from "../../src/durable/read-post.ts";
import { roomTools } from "../../src/durable/room-tools.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "pi-host-read-post-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const paths: string[] = [];
let server: Server;
let app: ChatApp;
before(async () => {
  server = createServer((req, res) => {
    paths.push(req.url!);
    const message = new URL(req.url!, "http://x").searchParams.get("message");
    const answer = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (message === "p404") return answer(404, { error: "No post p404 in ch_test." });
    return answer(200, { room: "ch_test", post: "p12", text: `ch_test/p12 in #test · from Sieun (owner) · 2026-11-25 11:40Z\nread ${message}` });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  app = new ChatApp(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
});
after(() => new Promise<void>(resolve => server.close(() => resolve())));

async function run(thread: string, ids: string[]) {
  const models = createModels();
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  let made = 0;
  faux.setResponses(Array.from({ length: ids.length + 1 }, () => () => {
    const id = ids[made++];
    return id ? fauxAssistantMessage([fauxToolCall(READ_POST_TOOL, { message_id: id })], { stopReason: "toolUse" }) : fauxAssistantMessage("done");
  }));
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(roomTools(app, thread));
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, `${thread}.sqlite`)), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
  await (await root.submit({ type: "input", content: "Read it." }, context)).wait(context);
  const entries: EntryRecord[] = [...(await root.entries({ order: "ascending" }, 1000, undefined, context)).items];
  await harness.close(context);
  return entries.flatMap(entry => {
    const message = entry.model?.[0] as Message | undefined;
    return message?.role === "toolResult" ? [{ text: textOf(message.content), isError: message.isError }] : [];
  });
}

test("read_post reads the post the id names as the thread, and an unknown post comes back as an error with the server's sentence", async () => {
  const results = await run("th-read", ["ch_test/p12", "p404"]);
  assert.deepEqual(paths, ["/api/threads/th-read/post?message=ch_test%2Fp12", "/api/threads/th-read/post?message=p404"]);
  assert.equal(results[0]!.isError, false);
  assert.match(results[0]!.text, /^ch_test\/p12 in #test · from Sieun \(owner\)/);
  assert.match(results[0]!.text, /read ch_test\/p12$/);
  assert.equal(results[1]!.isError, true);
  assert.match(results[1]!.text, /No post p404 in ch_test\./);
});
