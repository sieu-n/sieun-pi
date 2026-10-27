import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { startChatServer } from "../src/chat-server.ts";
import type { ChatBackend } from "../src/chat-backend.ts";

const ORIGIN = "https://box.example.ts.net";
const NAVIGATE = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

function get(url: string, headers: Record<string, string>): Promise<{ status: number; location: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, res => { res.resume(); resolve({ status: res.statusCode ?? 0, location: res.headers.location }); });
    req.on("error", reject); req.end();
  });
}

test("the bare tailnet URL opens the chat only for the tailnet owner's navigations", async t => {
  const asset = { body: Buffer.from(""), etag: "e", contentType: "text/plain" };
  const server = await startChatServer({ backend: { close: async () => {} } as unknown as ChatBackend, bundle: { js: asset, css: asset, version: "test" }, port: 0,
    capability: "cap", csrfToken: "token", stopToken: "stop", publicOrigin: ORIGIN, tailnetOwner: async () => "owner@example.com",
    identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-root.sock" }, onStop: async () => {} });
  t.after(() => server.close());
  const root = new URL("/", server.url).href;
  const tailnet = { host: new URL(ORIGIN).host, ...NAVIGATE };
  assert.deepEqual(await get(root, { ...tailnet, "sec-fetch-site": "cross-site", "tailscale-user-login": "owner@example.com" }), { status: 302, location: "/cap/" });
  assert.equal((await get(root, { ...tailnet, "tailscale-user-login": "someone@example.com" })).status, 404);
  assert.equal((await get(root, tailnet)).status, 404);
  assert.equal((await get(root, { host: new URL(ORIGIN).host, "tailscale-user-login": "owner@example.com", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" })).status, 404);
});
