import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import type { ChatBackend, ChatModel, ChatSession } from "../src/chat-backend.ts";
import { parseChatImages } from "../src/chat-images.ts";
import { renderChatMessages } from "../src/page.ts";
import { startChatServer } from "../src/chat-server.ts";

const session: ChatSession = { sessionId: "test-session", name: "Test session", cwd: "/test", kind: "root", status: "idle", canSend: true };

const testModel: ChatModel = { provider: "test", id: "vision", name: "Test vision", contextWindow: 100000, input: ["text", "image"] };
const testImage = parseChatImages([{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=" }])[0];
assert(testImage);

async function fixture(send: ChatBackend["send"] = async () => {}) {
  let closes = 0;
  let modelChanges = 0;
  const backend: ChatBackend = {
    async list() { return [session]; },
    async read(id) {
      assert.equal(id, session.sessionId);
      return { session, queueCount: 0, controls: { kind: "live", currentModel: testModel, canChangeModel: true },
        usage: { kind: "native-session", inputTokens: 100, outputTokens: 25, cost: .01, context: null, providerLimits: "unavailable" },
        messages: [
          { id: "u1", role: "user", text: "Hello <script>bad()</script>", streaming: false, images: [] },
          { id: "a1", role: "assistant", text: "**Reply** [blocked](https://example.com)", streaming: false, images: [] },
        ] };
    },
    async models(id) { assert.equal(id, session.sessionId); return { sessionId: id, models: [testModel], configuredProviders: ["test"] }; },
    async setModel(input) { assert.deepEqual(input, { sessionId: session.sessionId, provider: "test", modelId: "vision" }); modelChanges++; return testModel; },
    send,
    async close() { closes++; },
  };
  const server = await startChatServer({ backend, initialSessionId: session.sessionId });
  const pageResponse = await fetch(server.url);
  assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();
  const token = html.match(/[a-f0-9]{64}/)?.[0];
  assert(token, "page carries its per-server write authorization");
  const headers = { "Content-Type": "application/json", "Origin": new URL(server.url).origin, "X-Chat-Token": token };
  return { ...server, html, headers, closes: () => closes, modelChanges: () => modelChanges };
}

function message(requestId = "request_1234567890") {
  return JSON.stringify({ sessionId: session.sessionId, message: "Hello", requestId });
}

test("chat HTTP serves only its capability URL and sanitized transcript", async () => {
  const app = await fixture();
  try {
    const list = await fetch(app.url + "api/sessions");
    assert.equal(list.headers.get("cache-control"), "no-store");
    assert.equal(list.headers.get("access-control-allow-origin"), null);
    assert.match(list.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    const listing = await list.json();
    assert.equal(listing.sessions[0].id, session.sessionId);
    const view = await (await fetch(app.url + "api/session?id=test-session")).json();
    assert.match(view.html, /&lt;script&gt;/);
    assert.doesNotMatch(view.html, /<script|href=|<img/);
    assert.match(view.html, /<strong>Reply<\/strong>/);
    assert.equal((await fetch(new URL("/", app.url))).status, 404);
    assert.equal((await fetch(app.url + "api/session")).status, 400);
    assert.equal((await fetch(app.url + "api/message")).status, 405);
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(app.url, { headers: { Host: "evil.example" } }, res => { res.resume(); resolve(res.statusCode); });
      req.once("error", reject); req.end();
    });
    assert.equal(badHost, 421);
  } finally { await app.close(); }
  assert.equal(app.closes(), 1);
});

test("chat HTTP requires same-origin JSON and token before sending", async () => {
  let sends = 0;
  const app = await fixture(async () => { sends++; });
  try {
    for (const headers of [
      { "Content-Type": "application/json" },
      { ...app.headers, "Origin": "https://evil.example" },
      { ...app.headers, "X-Chat-Token": "wrong" },
      { ...app.headers, "Sec-Fetch-Site": "cross-site" },
    ]) {
      assert.equal((await fetch(app.url + "api/message", { method: "POST", headers, body: message() })).status, 403);
    }
    assert.equal((await fetch(app.url + "api/message", { method: "POST", headers: { ...app.headers, "Content-Type": "text/plain" }, body: message() })).status, 415);
    assert.equal((await fetch(app.url + "api/message", { method: "POST", headers: app.headers, body: "{}" })).status, 400);
    assert.equal((await fetch(app.url + "api/message", { method: "POST", headers: app.headers, body: "{" })).status, 400);
    assert.equal((await fetch(app.url + "api/message", { method: "POST", headers: app.headers, body: JSON.stringify({ sessionId: session.sessionId, message: " ", requestId: "request_1234567890" }) })).status, 400);
    assert.equal((await fetch(app.url + "api/message", { method: "POST", headers: app.headers, body: "x".repeat(13 * 1024 * 1024) })).status, 413);
    assert.equal(sends, 0);
  } finally { await app.close(); }
});

test("duplicate concurrent POSTs have one native admission and conflicting payloads reject", async () => {
  let sends = 0;
  const app = await fixture(async input => { sends++; assert.equal(input.sessionId, session.sessionId); });
  try {
    const responses = await Promise.all([1, 2].map(() => fetch(app.url + "api/message", { method: "POST", headers: app.headers, body: message() })));
    for (const response of responses) assert.deepEqual(await response.json(), { accepted: true });
    assert.equal(sends, 1);
    const conflict = await fetch(app.url + "api/message", { method: "POST", headers: app.headers,
      body: JSON.stringify({ sessionId: "another", message: "Hello", requestId: "request_1234567890" }) });
    assert.equal(conflict.status, 409);
    assert.equal(sends, 1);
  } finally { await app.close(); }
});

test("uncertain native send is never retried with the same request ID", async () => {
  let sends = 0;
  const app = await fixture(async () => { sends++; throw new Error("Native connection closed"); });
  try {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(app.url + "api/message", { method: "POST", headers: app.headers, body: message() });
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /Check the conversation before sending again/);
    }
    assert.equal(sends, 1);
  } finally { await app.close(); }
});

test("close chat releases the adapter once", async () => {
  const app = await fixture();
  const response = await fetch(app.url + "api/close", { method: "POST", headers: app.headers, body: "{}" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { closed: true });
  await app.close();
  assert.equal(app.closes(), 1);
});

test("model catalog and usage are native projections; model changes require write authorization", async () => {
  const app = await fixture();
  try {
    const catalog = await (await fetch(app.url + "api/models?id=" + session.sessionId)).json();
    assert.deepEqual(catalog, { sessionId: session.sessionId, models: [testModel], configuredProviders: ["test"] });
    const view = await (await fetch(app.url + "api/session?id=" + session.sessionId)).json();
    assert.equal(view.usage.inputTokens, 100);
    assert.equal(view.usage.providerLimits, "unavailable");
    assert.equal(view.controls.currentModel.id, "vision");
    const body = JSON.stringify({ sessionId: session.sessionId, provider: "test", modelId: "vision" });
    assert.equal((await fetch(app.url + "api/model", { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 403);
    assert.equal(app.modelChanges(), 0);
    const changed = await fetch(app.url + "api/model", { method: "POST", headers: app.headers, body });
    assert.deepEqual(await changed.json(), { model: testModel });
    assert.equal(app.modelChanges(), 1);
    assert.equal((await fetch(app.url + "api/model", { method: "POST", headers: app.headers, body: "{}" })).status, 400);
  } finally { await app.close(); }
});

test("image-only sends keep native data and duplicate identity includes image bytes", async () => {
  let sends = 0;
  const app = await fixture(async input => {
    sends++;
    assert.equal(input.message, "");
    assert.deepEqual(input.images, [testImage]);
  });
  try {
    const input = { sessionId: session.sessionId, message: "", images: [testImage], requestId: "image_request_1234567" };
    for (let i = 0; i < 2; i++) {
      const response = await fetch(app.url + "api/message", { method: "POST", headers: app.headers, body: JSON.stringify(input) });
      assert.deepEqual(await response.json(), { accepted: true });
    }
    assert.equal(sends, 1);
    const otherImage = { type: "image", mimeType: "image/gif", data: Buffer.from("GIF89a").toString("base64") };
    assert.equal((await fetch(app.url + "api/message", { method: "POST", headers: app.headers, body: JSON.stringify({ ...input, images: [otherImage] }) })).status, 409);
    assert.equal(sends, 1);
    const hostile = { type: "image", mimeType: "image/svg+xml", data: Buffer.from('<svg onload="alert(1)"/>').toString("base64") };
    assert.equal((await fetch(app.url + "api/message", { method: "POST", headers: app.headers, body: JSON.stringify({ ...input, requestId: "bad_image_request_12345", images: [hostile] }) })).status, 400);
    assert.equal(sends, 1);
  } finally { await app.close(); }
});

test("interactive image markup uses only validated data and labelled buttons", () => {
  const html = renderChatMessages([{ id: "image-user", role: "user", text: "", streaming: false, images: [testImage] }]);
  assert.match(html, /<button class="chat-image-button" type="button" aria-label="Open attached image 1">/);
  assert.match(html, /src="data:image\/png;base64,/);
  assert.doesNotMatch(html, /https?:|<script|onerror/);
});
