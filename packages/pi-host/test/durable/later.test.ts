/**
 * The Later tools (`later.ts`) in the room-tools extension of a durable thread's root conversation, against a fake chat server on loopback:
 * `save_message` and `remind_me` post the change as the thread to `POST /api/threads/<thread>/later` and return the server's line,
 * `list_saved_messages` reads `GET /api/threads/<thread>/later`, and a bad reminder time is refused before any call.
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
import type { ForMeItem } from "../../../../apps/chat/web/src/lib/api/types.ts";
import { ChatApp } from "../../src/durable/chat-app.ts";
import { itemText, laterText } from "../../src/durable/for-me.ts";
import { LIST_SAVED_TOOL, REMIND_ME_DESCRIPTION, REMIND_ME_TOOL, reminderTime, SAVE_MESSAGE_TOOL } from "../../src/durable/later.ts";
import { roomTools } from "../../src/durable/room-tools.ts";
import { MODEL, textOf } from "./crash-scenario.ts";

const context = BACKGROUND_CONTEXT;
const dir = mkdtempSync(join(tmpdir(), "pi-host-later-"));
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
    const url = new URL(req.url!, "http://x");
    if (!url.pathname.endsWith("/later")) return answer(404, { error: "No such route." });
    if (req.method === "GET") return answer(200, { text: `1 open, 0 done. state=${url.searchParams.get("state")}` });
    const change = body as { message: string; state?: string; remindAt?: number | null };
    if (change.message === "p404") return answer(404, { error: "No post p404 in ch_test." });
    return answer(200, { text: `ok ${change.message} ${change.state ?? "-"} ${change.remindAt === undefined ? "-" : String(change.remindAt)}` });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  app = new ChatApp(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
});
after(() => new Promise<void>(resolve => server.close(() => resolve())));

async function run(thread: string, plan: { name: string; args: Record<string, unknown> }[]) {
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
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, `${thread}.sqlite`)), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
  await (await root.submit({ type: "input", content: "Save it." }, context)).wait(context);
  const entries: EntryRecord[] = [...(await root.entries({ order: "ascending" }, 1000, undefined, context)).items];
  await harness.close(context);
  return entries.flatMap(entry => {
    const message = entry.model?.[0] as Message | undefined;
    return message?.role === "toolResult" ? [{ name: message.toolName, text: textOf(message.content), isError: message.isError }] : [];
  });
}

test("a reminder time comes from in_minutes or a zoned ISO time, one of them, and clear gives null", () => {
  const now = Date.UTC(2026, 10, 20, 5, 0);
  assert.equal(reminderTime({ in_minutes: 2 }, now), now + 120_000);
  assert.equal(reminderTime({ at: "2026-11-20T14:30:00+09:00" }, now), Date.UTC(2026, 10, 20, 5, 30));
  assert.equal(reminderTime({ clear: true, in_minutes: 5 }, now), null);
  for (const bad of [{}, { in_minutes: 2, at: "2026-11-21T00:00:00Z" }, { in_minutes: 0 }, { at: "2026-11-21 09:00" }, { at: "2026-11-19T00:00:00Z" }]) {
    const result = reminderTime(bad, now);
    assert.ok(result !== null && typeof result === "object" && "error" in result, JSON.stringify(bad));
  }
});

test("remind_me's own text says a due reminder wakes the agent with the post, so it can come back to a thread itself", () => {
  assert.match(REMIND_ME_DESCRIPTION, /you get a \[wake\] in this agent's thread for the message's room, with a link to the message and its thread/);
  assert.match(REMIND_ME_DESCRIPTION, /what you post in that turn goes in the message's thread/);
  assert.match(REMIND_ME_DESCRIPTION, /come back to something yourself, such as to check a thread again/);
});

test("the tools post each change as the thread, list with the state asked, and a refusal becomes the call's error", async () => {
  const before = Date.now();
  const out = await run("th_later", [
    { name: SAVE_MESSAGE_TOOL, args: { message_id: "ch_test/p12" } },
    { name: SAVE_MESSAGE_TOOL, args: { message_id: "p12", state: "done" } },
    { name: SAVE_MESSAGE_TOOL, args: { message_id: "p12", state: "removed" } },
    { name: REMIND_ME_TOOL, args: { message_id: "p12", in_minutes: 2 } },
    { name: REMIND_ME_TOOL, args: { message_id: "p12", clear: true } },
    { name: REMIND_ME_TOOL, args: { message_id: "p12" } },
    { name: SAVE_MESSAGE_TOOL, args: { message_id: "p404" } },
    { name: LIST_SAVED_TOOL, args: {} },
    { name: LIST_SAVED_TOOL, args: { state: "done" } },
  ]);
  const posts = calls.filter(call => call.path === "/api/threads/th_later/later").map(call => call.body as Record<string, unknown>);
  assert.deepEqual(posts.map(b => [b.message, b.state, typeof b.remindAt === "number" ? "time" : b.remindAt]), [
    ["ch_test/p12", "open", undefined], ["p12", "done", undefined], ["p12", "removed", undefined], ["p12", undefined, "time"], ["p12", undefined, null],
    ["p404", "open", undefined],
  ]);
  const remindAt = posts[3]!.remindAt as number;
  assert.ok(remindAt >= before + 120_000 && remindAt <= Date.now() + 120_000);
  assert.deepEqual(calls.filter(call => call.method === "GET" && call.path.startsWith("/api/threads/th_later/")).map(call => call.path), [
    "/api/threads/th_later/later?state=open", "/api/threads/th_later/later?state=done",
  ]);
  assert.deepEqual(out.map(r => [r.name, r.isError]), [
    [SAVE_MESSAGE_TOOL, false], [SAVE_MESSAGE_TOOL, false], [SAVE_MESSAGE_TOOL, false], [REMIND_ME_TOOL, false], [REMIND_ME_TOOL, false],
    [REMIND_ME_TOOL, true], [SAVE_MESSAGE_TOOL, true], [LIST_SAVED_TOOL, false], [LIST_SAVED_TOOL, false],
  ]);
  assert.equal(out[0]!.text, "ok ch_test/p12 open -");
  assert.equal(out[4]!.text, "ok p12 - null");
  assert.match(out[5]!.text, /Give in_minutes or at/);
  assert.equal(out[6]!.text, "No post p404 in ch_test.");
  assert.equal(out[8]!.text, "1 open, 0 done. state=done");
});

test("a For list item the agent saved shows it beside its reactions", () => {
  const item = {
    id: "dm_vent/p41", room: "dm_vent", roomKind: "dm", roomName: "DM", post: "p41", author: { id: "owner", kind: "owner", name: "Sieun", avatar: { initials: "SP", hue: 1 } },
    text: "Ship it.", at: Date.UTC(2026, 10, 3, 4, 12), activityAt: Date.UTC(2026, 10, 3, 4, 12), reasons: ["dm"], status: "pending",
    later: { saved: true, remindAt: Date.UTC(2026, 10, 3, 6, 0) },
  } as unknown as ForMeItem;
  assert.equal(laterText(item), "[saved for later · reminder 2026-11-03 06:00Z]");
  assert.equal(itemText(item), "dm_vent/p41 in DM · from Sieun (owner) · 2026-11-03 04:12Z · dm · pending\n[saved for later · reminder 2026-11-03 06:00Z]\nShip it.");
  assert.equal(laterText({}), "");
});
