import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatBackend } from "../src/chat-backend.ts";
import { startChatServer } from "../src/chat-server.ts";

const chat = "01a14bcc-27a8-719f-bf2d-06519218c7eb";
const child = "01a14bcc-f1ee-7124-aedd-4ae3f0096d73";
const caller = "01a14bc8-861e-75b8-b9a1-5d6a977901a9";

async function fixture(archive: (id: string) => Promise<void>) {
  const backend = { chats: { ids: async () => new Set([chat]), archive }, threads: { archive }, catalog: { notify: async () => {} }, close: async () => {} } as unknown as ChatBackend;
  const asset = { body: Buffer.from(""), etag: '"test"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "test" }, port: 0, capability: "cap", csrfToken: "test-token", stopToken: "test-stop",
    identity: { pid: process.pid, instanceId: "test", socketPath: "/none" }, onStop: async () => {} });
  return { ...server, post: (id: string, headers: Record<string, string> = {}) => fetch(server.url + `api/threads/${id}/archive`, {
    method: "POST", headers: { "content-type": "application/json", origin: new URL(server.url).origin, "x-chat-token": "test-token", ...headers }, body: JSON.stringify({ ignored: "body-secret" }),
  }) };
}

test("archive audit records exact targets and unverified claims without request secrets", async t => {
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (line: string) => { lines.push(line); return true; });
  const archived: string[] = [];
  const server = await fixture(async id => {
    assert.equal(JSON.parse(lines.at(-1)!).outcome, "started");
    archived.push(id);
  });
  try {
    for (const id of [chat, child]) {
      const response = await server.post(id, { "x-chat-agent-session": caller, "user-agent": "node", cookie: "cookie-secret", authorization: "Bearer auth-secret", "x-other": "other-secret" });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    }
    assert.deepEqual(archived, [chat, child]);
    const events = lines.map(line => JSON.parse(line));
    assert.equal(events.length, 4);
    for (const [index, id] of [chat, child].entries()) {
      const [start, end] = events.slice(index * 2, index * 2 + 2);
      assert.deepEqual([start.outcome, end.outcome], ["started", "completed"]);
      assert.equal(start.targetSessionId, id);
      assert.equal(end.targetSessionId, id);
      assert.equal(start.requestId, end.requestId);
      assert.match(start.requestId, /^[0-9a-f-]{36}$/);
      assert.equal(start.event, "chat_archive");
      assert.deepEqual(start.unverifiedClientClaims, { sessionId: caller, userAgent: "node" });
      assert(Number.isFinite(Date.parse(start.at)));
      assert(Number.isFinite(Date.parse(end.at)));
    }
    assert.notEqual(events[0].requestId, events[2].requestId);
    assert(!lines.join("").includes("secret"));
    assert(!lines.join("").includes("test-token"));
    const before = lines.length;
    assert.equal((await server.post(chat, { "x-chat-token": "wrong" })).status, 403);
    assert.equal(lines.length, before);
    assert.deepEqual(archived, [chat, child]);
  } finally { await server.close(); }
});

test("archive audit records failure without serializing errors or invalid client claims", async t => {
  const lines: string[] = [];
  t.mock.method(process.stderr, "write", (line: string) => { lines.push(line); return true; });
  const server = await fixture(async () => { throw new Error("backend-secret"); });
  try {
    const response = await server.post(chat, { "x-chat-agent-session": "invalid-secret", "user-agent": "unknown-secret" });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "backend-secret" });
    const events = lines.map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.outcome), ["started", "failed"]);
    assert.equal(events[0].requestId, events[1].requestId);
    assert.deepEqual(events[0].unverifiedClientClaims, { sessionId: null, userAgent: "other" });
    assert(!lines.join("").includes("secret"));
  } finally { await server.close(); }
});

test("a failed audit write does not block a valid archive", async t => {
  t.mock.method(process.stderr, "write", () => { throw new Error("audit unavailable"); });
  const archived: string[] = [];
  const server = await fixture(async id => { archived.push(id); });
  try {
    assert.equal((await server.post(child)).status, 200);
    assert.deepEqual(archived, [child]);
  } finally { await server.close(); }
});
