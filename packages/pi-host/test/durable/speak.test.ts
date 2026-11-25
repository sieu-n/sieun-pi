/**
 * The read-before-send check and the post id (`speak.ts`) through the send_message alias of a durable thread's root, against a fake chat
 * server on loopback: a call apps/chat holds fails with the new posts, the next call answers with the post it made, and a chat server with
 * no speak route leaves the call's old answer, so the feed posts it as before. tell_owner's answer that names its post still counts as sent.
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
import { MOVED_LINE, ROOM_TELL_OWNER_DESCRIPTION } from "../../src/durable/room-post.ts";
import { SEND_MESSAGE_TOOL, sendMessageAlias } from "../../src/durable/send-message.ts";
import { TOLD, toldText } from "../../src/durable/turn-end.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "pi-host-speak-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const HELD = "Not sent: the thread moved since you last read it. This post is new to you:\n\n[post 47 (p47) from Search product, misc., at 11:02:24Z]\nwe agree on all but two details";
const calls: { thread: string; call: string }[] = [];
let servers: Server[] = [];
async function chat(answer: (n: number) => { status: number; body: unknown }): Promise<ChatApp> {
  let n = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      const thread = decodeURIComponent(req.url!.split("/")[3]!);
      if (req.url!.endsWith("/speak")) calls.push({ thread, call: JSON.parse(raw).call });
      const { status, body } = answer(n++);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return new ChatApp(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
}
before(() => { servers = []; });
after(async () => { await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

async function run(app: ChatApp, thread: string, texts: string[]) {
  const models = createModels();
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  let made = 0;
  faux.setResponses(Array.from({ length: texts.length + 1 }, () => () => {
    const text = texts[made++];
    return text ? fauxAssistantMessage([fauxToolCall(SEND_MESSAGE_TOOL, { text })], { stopReason: "toolUse" }) : fauxAssistantMessage("");
  }));
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(sendMessageAlias(app, thread));
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, `${thread}.sqlite`)), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
  await (await root.submit({ type: "input", content: "Answer it." }, context)).wait(context);
  const entries: EntryRecord[] = [...(await root.entries({ order: "ascending" }, 1000, undefined, context)).items];
  await harness.close(context);
  return entries.flatMap(entry => {
    const message = entry.model?.[0] as Message | undefined;
    return message?.role === "toolResult" ? [{ text: textOf(message.content), isError: message.isError }] : [];
  });
}

test("a call the chat holds fails with the new posts, and the call after it answers with the post it made", async () => {
  const app = await chat(n => ({ status: 200, body: n === 0 ? { kind: "held", text: HELD } : { kind: "posted", room: "ch_test", id: "p48" } }));
  const results = await run(app, "thread-held", ["We agree on everything.", "We agree on all but the two details p47 names."]);
  assert.deepEqual(results, [{ text: HELD, isError: true }, { text: "Sent as ch_test/p48.", isError: false }]);
  assert.deepEqual(calls.filter(c => c.thread === "thread-held").length, 2);
  assert.ok(calls.every(c => c.call.length > 0), "each speak names its tool call");
});

test("a chat server with no speak route, or no such call in its feed, leaves the old answer for the feed to post", async () => {
  const missing = await chat(() => ({ status: 404, body: { error: "Not found." } }));
  assert.deepEqual(await run(missing, "thread-old", ["hi"]), [{ text: "Sent.", isError: false }]);
  const unknown = await chat(() => ({ status: 200, body: { kind: "unknown" } }));
  assert.deepEqual(await run(unknown, "thread-unknown", ["hi"]), [{ text: "Sent.", isError: false }]);
});

test("tell_owner's answer that names its post counts as sent, and its room description says what a moved thread does", () => {
  assert.equal(toldText(TOLD), true);
  assert.equal(toldText(`${TOLD}, posted as ch_14ad7a70/p223.`), true);
  assert.equal(toldText("Kept as a note, not sent."), false);
  assert.ok(ROOM_TELL_OWNER_DESCRIPTION.endsWith(MOVED_LINE));
});
