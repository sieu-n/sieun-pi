/**
 * The For list tools (`for-me.ts`) in the room-tools extension of a durable thread's root conversation, against a fake chat server on loopback: `list_for_me_messages`
 * reads `GET /api/agents/<thread>/for-me` as the thread and writes each item as the agent reads it, `mark_message` posts the mark and answers
 * one line, and an error answer becomes the call's error.
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
import type { ForMeItem, ForMeList, Principal } from "../../../../apps/chat/web/src/lib/api/types.ts";
import { commInstructions } from "../../src/durable/agent-profile.ts";
import { ChatApp } from "../../src/durable/chat-app.ts";
import { itemText, LIST_FOR_ME_TOOL, listText, MARK_MESSAGE_TOOL } from "../../src/durable/for-me.ts";
import { roomTools } from "../../src/durable/room-tools.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "pi-host-for-me-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const owner: Principal = { id: "owner", kind: "owner", name: "Sieun", avatar: { initials: "SP", hue: 1 } };
const factory: Principal = { id: "ag_factory" as Principal["id"], kind: "chat", name: "agent factory", avatar: { initials: "AF", hue: 2 } };
const vent: Principal = { id: "ag_vent" as Principal["id"], kind: "chat", name: "vent", avatar: { initials: "VE", hue: 3 } };
const T = Date.UTC(2026, 10, 3, 5, 12);

const items: ForMeItem[] = [
  {
    id: "ch_1a2b3c4d/p12", room: "ch_1a2b3c4d" as ForMeItem["room"], roomKind: "channel", roomName: "#sw-factory-build", post: "p12", threadRoot: "p9",
    author: factory, text: "@vent can you check the panel list?", at: T, activityAt: T + 60_000, reasons: ["mention", "thread"],
    reactions: [{ emoji: "👀", by: [vent, factory] }, { emoji: "👍", by: [owner] }], status: "pending",
  },
  {
    id: "dm_vent/p41", room: "dm_vent" as ForMeItem["room"], roomKind: "dm", roomName: "DM", post: "p41",
    author: owner, text: "Ship it.", at: T - 3_600_000, activityAt: T - 3_600_000, reasons: ["dm"], status: "completed", completedAt: T - 1_800_000,
  },
];

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
    const url = new URL(req.url!, "http://x");
    if (!url.pathname.endsWith("/for-me")) return answer(404, { error: "No such route." });
    if (req.method === "GET") {
      const status = url.searchParams.get("status");
      const list: ForMeList = { agent: "ag_vent" as ForMeList["agent"], items: items.filter(item => status === "all" || item.status === status), pending: 1, completed: 1 };
      return answer(200, list);
    }
    const { messageId, completed } = body as { messageId: string; completed: boolean };
    const item = items.find(i => i.id === messageId);
    if (!item) return answer(404, { error: `${messageId} is not on vent's For list. Pass an id from list_for_me_messages, such as dm_vent/p41.` });
    return answer(200, { item: { ...item, status: completed ? "completed" : "pending" }, pending: completed ? 0 : 1 });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  app = new ChatApp(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
});
after(() => new Promise<void>(resolve => server.close(() => resolve())));

async function run(thread: string, plan: { name: string; args: Record<string, string | boolean> }[]) {
  const file = join(dir, `${thread}.sqlite`);
  const models = createModels();
  const faux = fauxProvider({ provider: MODEL.provider, models: [{ id: MODEL.modelId }], tokensPerSecond: 0 });
  let made = 0;
  faux.setResponses(Array.from({ length: plan.length + 1 }, () => () => {
    const call = plan[made++];
    return call ? fauxAssistantMessage([fauxToolCall(call.name, call.args)], { stopReason: "toolUse" }) : fauxAssistantMessage("done");
  }));
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(roomTools(app, thread));
  const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
  await (await root.submit({ type: "input", content: "Work your list." }, context)).wait(context);
  const entries: EntryRecord[] = [...(await root.entries({ order: "ascending" }, 1000, undefined, context)).items];
  await harness.close(context);
  return entries.flatMap(entry => {
    const message = entry.model?.[0] as Message | undefined;
    return message?.role === "toolResult" ? [{ name: message.toolName, text: textOf(message.content), isError: message.isError }] : [];
  });
}

test("an item reads as one header line, its reactions in the shared form, then the post's text", () => {
  assert.equal(itemText(items[0]!), [
    "ch_1a2b3c4d/p12 in #sw-factory-build, thread p9 · from agent factory · 2026-11-03 05:12Z, active 2026-11-03 05:13Z · mention, thread · pending",
    "[reactions: 👀 vent, agent factory · 👍 Sieun (owner)]",
    "@vent can you check the panel list?",
  ].join("\n"));
  assert.equal(itemText(items[1]!), "dm_vent/p41 in DM · from Sieun (owner) · 2026-11-03 04:12Z · dm · completed 2026-11-03 04:42Z\nShip it.");
  assert.equal(listText({ agent: "ag_vent" as ForMeList["agent"], items: [], pending: 0, completed: 4 }, "pending"), "0 pending, 4 completed. No pending messages.");
});

test("list_for_me_messages reads the thread's list with its status, pending by default, and returns the count line and each item", async () => {
  const out = await run("th_comm", [{ name: LIST_FOR_ME_TOOL, args: {} }, { name: LIST_FOR_ME_TOOL, args: { status: "all" } }]);
  const reads = calls.filter(call => call.method === "GET" && call.path.startsWith("/api/agents/th_comm/")).map(call => call.path);
  assert.deepEqual(reads, ["/api/agents/th_comm/for-me?status=pending", "/api/agents/th_comm/for-me?status=all"]);
  assert.deepEqual(out.map(r => [r.name, r.isError]), [[LIST_FOR_ME_TOOL, false], [LIST_FOR_ME_TOOL, false]]);
  assert.equal(out[0]!.text, `1 pending, 1 completed. Showing the 1 pending.\n\n${itemText(items[0]!)}`);
  assert.equal(out[1]!.text, `1 pending, 1 completed. Showing all 2.\n\n${itemText(items[0]!)}\n\n${itemText(items[1]!)}`);
});

test("mark_message posts the mark as the thread and answers one line, and an error answer becomes the call's error", async () => {
  const out = await run("th_mark", [
    { name: MARK_MESSAGE_TOOL, args: { message_id: "ch_1a2b3c4d/p12", completed: true } },
    { name: MARK_MESSAGE_TOOL, args: { message_id: "ch_1a2b3c4d/p12", completed: false } },
    { name: MARK_MESSAGE_TOOL, args: { message_id: "dm_vent/p404", completed: true } },
  ]);
  const posts = calls.filter(call => call.method === "POST" && call.path === "/api/agents/th_mark/for-me").map(call => call.body);
  assert.deepEqual(posts, [
    { messageId: "ch_1a2b3c4d/p12", completed: true }, { messageId: "ch_1a2b3c4d/p12", completed: false }, { messageId: "dm_vent/p404", completed: true },
  ]);
  assert.deepEqual(out.map(r => [r.text, r.isError]), [
    ["Marked ch_1a2b3c4d/p12 completed. 0 pending.", false],
    ["Marked ch_1a2b3c4d/p12 pending. 1 pending.", false],
    ["dm_vent/p404 is not on vent's For list. Pass an id from list_for_me_messages, such as dm_vent/p41.", true],
  ]);
});

test("both comm texts ask the thread to read its pending list at a turn's start, handle its own room's items and mark each one handled", () => {
  for (const [room, n] of [["dm_vent", 5], ["ch_1a2b3c4d", 9], ["so_plan", 9]] as const) {
    const lines = commInstructions({ agent: "ag_vent", room, work: "vent" }).split("\n");
    const line = lines.find(l => l.includes("list_for_me_messages"))!;
    assert.ok(line.startsWith(`${n}. When a turn starts, read your pending For list with \`list_for_me_messages()\`. Handle the items of room ${room},`), line);
    assert.match(line, /Mark an item completed with `mark_message\(message_id, true\)` once you answered or handled it/);
    assert.match(line, /Leave an item pending while its work still runs/);
    // The numbers stay in order after the inserted line.
    const numbers = lines.flatMap(l => /^(\d+)\. /.exec(l)?.[1] ?? []).map(Number);
    assert.deepEqual(numbers, numbers.map((_, i) => i + 1), room);
  }
});
