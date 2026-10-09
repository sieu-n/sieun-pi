import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatBackend } from "../src/chat-backend.ts";
import { startChatServer } from "../src/chat-server.ts";
import { SlackBridge, type SlackChats, type SocketListener, type SocketMode } from "../src/chat-slack.ts";
import type { SlackView } from "../src/shared/types.ts";

const CHAT = "11111111-2222-3333-4444-555555555555";
const NEW = "99999999-2222-3333-4444-555555555555";

async function setup(connected = true) {
  const dir = await mkdtemp(join(tmpdir(), "slack-route-"));
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const ids = new Set([CHAT]);
  let notified = 0;
  let socket: SocketListener | null = null;
  const chats: SlackChats = {
    ids: async () => ids, name: async id => id === NEW ? "New one" : "Route chat", messages: () => [],
    subscribe: async () => () => {}, prompt: async () => {}, watch: () => () => {},
  };
  const fake: SocketMode = { start: listener => { socket = listener; }, close: () => {} };
  const api = async (method: string, args: Record<string, unknown> = {}) => {
    calls.push({ method, args });
    if (method === "auth.test") return { ok: true, team_id: "T0TEAM001", team: "Company" };
    if (method === "conversations.create") return { ok: true, channel: { id: "G0" + String(args.name).length, name: args.name } };
    if (method === "conversations.rename") return { ok: true, channel: { id: args.channel, name: args.name } };
    if (method === "conversations.list") return { ok: true, channels: [] };
    return { ok: true };
  };
  const bridge = new SlackBridge({ path: join(dir, "slack.json"), chats, tokens: async () => ({ bot: "xoxb-t", app: "xapp-t", source: "keychain" }),
    connect: () => ({ api, socket: fake }), postGapMs: 0, syncMs: 0, sleep: async () => {} });
  await bridge.start();
  await bridge.set({ enabled: true, ownerUserId: "U0OWNER01" });
  if (connected) { socket!.hello(); await bridge.settled(); }
  const backend = {
    chats: { ids: async () => ids, forget: async (id: string) => { ids.delete(id); }, create: async () => { ids.add(NEW); return { id: NEW, name: "New one" }; } },
    threads: { archive: async () => {}, prompt: async () => {} },
    catalog: { notify: async () => { notified++; } },
    created: { add: async () => {} },
    close: async () => {},
  } as unknown as ChatBackend;
  const asset = { body: Buffer.from(""), etag: '"x"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "t" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "i", socketPath: "/none" }, onStop: async () => {}, slack: bridge });
  const origin = new URL(server.url).origin;
  const post = async (route: string, body: unknown, token = "token") => {
    const res = await fetch(server.url + route, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", "X-Chat-Token": token, Origin: origin } });
    return { status: res.status, body: await res.json() as SlackView & { error?: string; id?: string; notice?: string } };
  };
  return { bridge, server, post, calls, ids, get notified() { return notified; } };
}

test("api/threads/:id/slack connects a chat (idempotent, with a name and visibility), renames and stops with the write token; non-chats 404, bad input 400", async () => {
  const s = await setup();
  try {
    assert.equal((await s.post(`api/threads/${CHAT}/slack`, { action: "connect" }, "wrong")).status, 403);
    assert.equal((await s.post(`api/threads/${CHAT}/slack`, { on: true })).status, 400);
    assert.equal((await s.post(`api/threads/${CHAT}/slack`, { action: "connect", name: "Bad Name" })).status, 400);
    assert.equal((await s.post(`api/threads/${CHAT}/slack`, { action: "connect", isPrivate: "no" })).status, 400);
    assert.equal((await s.post(`api/threads/${CHAT}/slack`, { action: "rename" })).status, 400);
    assert.equal((await s.post("api/threads/plain/slack", { action: "connect" })).status, 404);
    assert.ok(!s.calls.some(call => call.method === "conversations.create"));
    // A double click: two connects in flight at once make one channel, and both answer with it.
    const [first, second] = await Promise.all([s.post(`api/threads/${CHAT}/slack`, { action: "connect", name: "vp-ops", isPrivate: false }), s.post(`api/threads/${CHAT}/slack`, { action: "connect" })]);
    assert.deepEqual([first.status, second.status], [200, 200]);
    // Whichever request reached the bridge first named the channel; the other got that same channel back.
    const creates = s.calls.filter(call => call.method === "conversations.create");
    assert.equal(creates.length, 1);
    const made = creates[0]!.args.name === "vp-ops" ? { channel: "G06", name: "vp-ops", isPrivate: false } : { channel: "G013", name: "vp-route-chat", isPrivate: true };
    assert.deepEqual(first.body.chats, { [CHAT]: made });
    assert.deepEqual(second.body.chats, first.body.chats);
    const third = await s.post(`api/threads/${CHAT}/slack`, { action: "connect", name: "vp-other" });
    assert.deepEqual([third.status, third.body.chats], [200, first.body.chats], "already connected returns the existing channel");
    assert.equal(s.calls.filter(call => call.method === "conversations.create").length, 1);
    const renamed = await s.post(`api/threads/${CHAT}/slack`, { action: "rename", name: "vp-ops-2" });
    assert.deepEqual([renamed.status, renamed.body.chats[CHAT]!.name], [200, "vp-ops-2"]);
    const off = await s.post(`api/threads/${CHAT}/slack`, { action: "stop" });
    assert.deepEqual([off.status, off.body.chats], [200, {}]);
    assert.ok(s.calls.some(call => call.method === "conversations.archive"));
    const list = await fetch(s.server.url + "api/slack/channels");
    assert.deepEqual([list.status, await list.json()], [200, { channels: [] }]);
  } finally { await s.server.close(); s.bridge.close(); }
});

test("api/threads/:id/slack answers 409 while Slack is not connected", async () => {
  const s = await setup(false);
  try {
    const refused = await s.post(`api/threads/${CHAT}/slack`, { action: "connect" });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error!, /Slack is not connected/);
    assert.ok(!s.calls.some(call => call.method === "conversations.create"));
  } finally { await s.server.close(); s.bridge.close(); }
});

test("archiving a synced chat archives its channel; a new chat created with slack true is synced, one without is not", async () => {
  const s = await setup();
  try {
    await s.post(`api/threads/${CHAT}/slack`, { action: "connect" });
    assert.equal((await s.post(`api/threads/${CHAT}/archive`, {})).status, 200);
    assert.equal(s.notified, 1, "the archive tells the catalog watchers, the bridge among them");
    await s.bridge.sync(false);
    await s.bridge.settled();
    assert.ok(s.calls.some(call => call.method === "conversations.archive"));
    assert.deepEqual(s.bridge.view(true).chats, {});

    const plain = await s.post("api/threads", { requestId: "q".repeat(24), cwd: tmpdir(), message: "hi", images: [], kind: "chat" });
    assert.deepEqual([plain.status, plain.body.id, s.bridge.view(true).chats], [200, NEW, {}]);
    const created = await s.post("api/threads", { requestId: "r".repeat(24), cwd: tmpdir(), message: "hi", images: [], kind: "chat", slack: { name: "vp-new-one", isPrivate: true } });
    assert.deepEqual([created.status, created.body.id, created.body.notice], [200, NEW, undefined]);
    assert.deepEqual(s.bridge.view(true).chats, { [NEW]: { channel: "G010", name: "vp-new-one", isPrivate: true } });
    assert.equal((await s.post("api/threads", { requestId: "s".repeat(24), cwd: tmpdir(), message: "hi", images: [], kind: "chat", slack: "yes" })).status, 400);
    assert.equal((await s.post("api/threads", { requestId: "t".repeat(24), cwd: tmpdir(), message: "hi", images: [], kind: "chat", slack: { name: "Bad Name" } })).status, 400);
  } finally { await s.server.close(); s.bridge.close(); }
});
