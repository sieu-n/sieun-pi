/**
 * The room member tool (`room-members.ts`) in the room-tools extension of a durable thread's root conversation, against a fake chat server
 * on loopback: `set_room_member` posts `{room, agent, member}` as the thread to `POST /api/threads/<thread>/members` and returns the
 * server's line, and a refusal becomes the call's error.
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
import { ChatApp } from "../../src/durable/chat-app.ts";
import { SET_ROOM_MEMBER_DESCRIPTION, SET_ROOM_MEMBER_TOOL } from "../../src/durable/room-members.ts";
import { roomTools } from "../../src/durable/room-tools.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "pi-host-room-members-"));
after(() => rmSync(dir, { recursive: true, force: true }));

type Change = { room: string; agent: string; member: boolean };
const calls: { method: string; path: string; body: unknown }[] = [];
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
    const change = body as Change;
    if (change.agent === "nobody") return answer(404, { error: "No agent nobody." });
    return answer(200, { room: "ch_test", agent: "ag_crawler-vp", member: change.member, text: `${change.member ? "Added" : "Removed"} Crawler VP.` });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  app = new ChatApp(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
});
after(() => new Promise<void>(resolve => server.close(() => resolve())));

async function run(thread: string, plan: Change[]) {
  const models = createModels();
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  let made = 0;
  faux.setResponses(Array.from({ length: plan.length + 1 }, () => () => {
    const args = plan[made++];
    return args ? fauxAssistantMessage([fauxToolCall(SET_ROOM_MEMBER_TOOL, args)], { stopReason: "toolUse" }) : fauxAssistantMessage("done");
  }));
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(roomTools(app, thread));
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, `${thread}.sqlite`)), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
  await (await root.submit({ type: "input", content: "Add Crawler VP to #test." }, context)).wait(context);
  const entries: EntryRecord[] = [...(await root.entries({ order: "ascending" }, 1000, undefined, context)).items];
  await harness.close(context);
  return entries.flatMap(entry => {
    const message = entry.model?.[0] as Message | undefined;
    return message?.role === "toolResult" ? [{ name: message.toolName, text: textOf(message.content), isError: message.isError }] : [];
  });
}

test("set_room_member posts the change as the thread, returns the server's line, and a refusal becomes the call's error", async () => {
  const plan = [{ room: "#test", agent: "Crawler VP", member: true }, { room: "ch_test", agent: "ag_crawler-vp", member: false }, { room: "#test", agent: "nobody", member: true }];
  const out = await run("members", plan);
  assert.deepEqual(calls.filter(call => call.method === "POST" && call.path === "/api/threads/members/members").map(call => call.body), plan);
  assert.deepEqual(out.map(result => [result.name, result.text, result.isError]), [
    [SET_ROOM_MEMBER_TOOL, "Added Crawler VP.", false],
    [SET_ROOM_MEMBER_TOOL, "Removed Crawler VP.", false],
    [SET_ROOM_MEMBER_TOOL, "No agent nobody.", true],
  ]);
});

test("set_room_member's own text says when to use it and that repeats change nothing", () => {
  assert.match(SET_ROOM_MEMBER_DESCRIPTION, /when the owner asks you to/);
  assert.match(SET_ROOM_MEMBER_DESCRIPTION, /Adding a member twice or removing a non-member changes nothing/);
});
