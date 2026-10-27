// Guards the 10-18 Mac reads: the Mac in Korea reads this box at about 370 KB/s, and app.js (651 KB), app.css (172 KB) and api/models (255 KB) went out raw.
import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { startChatServer } from "../src/chat-server.ts";
import type { ChatBackend } from "../src/chat-backend.ts";

function get(url: string, headers: Record<string, string>): Promise<{ status: number; encoding: string | undefined; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, encoding: res.headers["content-encoding"], body: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end();
  });
}

test("the page's script goes out gzipped to a browser that takes gzip, and raw to one that does not", async t => {
  const script = Buffer.from("console.log('chat');\n".repeat(4000));
  const asset = { body: script, etag: '"js"', contentType: "text/javascript" };
  const server = await startChatServer({ backend: { close: async () => {} } as unknown as ChatBackend, bundle: { js: asset, css: asset, version: "test" }, port: 0,
    capability: "cap", csrfToken: "token", stopToken: "stop", identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-gzip.sock" }, onStop: async () => {} });
  t.after(() => server.close());
  const url = new URL("/cap/app.js", server.url).href;
  const packed = await get(url, { "accept-encoding": "gzip, deflate, br" });
  assert.equal(packed.status, 200);
  assert.equal(packed.encoding, "gzip");
  assert.ok(packed.body.length * 20 < script.length);
  assert.deepEqual(gunzipSync(packed.body), script);
  const raw = await get(url, {});
  assert.equal(raw.encoding, undefined);
  assert.deepEqual(raw.body, script);
});
