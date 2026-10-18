// Guards 10-18 06:51Z: the VP of CI's branching diagram drew as raw code, because each sandboxed frame downloaded the 1.5 MB renderer uncached.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { test } from "node:test";
import { startChatServer } from "../src/chat-server.ts";
import type { ChatBackend } from "../src/chat-backend.ts";

function get(url: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end();
  });
}

test("a diagram frame loads no script over the network: its one inline script matches its policy, and the chat page fetches the renderer once", async t => {
  const asset = { body: Buffer.from("console.log('chat');"), etag: '"js"', contentType: "text/javascript" };
  const server = await startChatServer({ backend: { close: async () => {} } as unknown as ChatBackend, bundle: { js: asset, css: asset, version: "test" }, port: 0,
    capability: "cap", csrfToken: "token", stopToken: "stop", identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-render.sock" }, onStop: async () => {} });
  t.after(() => server.close());

  const frame = await get(new URL("/cap/render", server.url).href, { "sec-fetch-dest": "iframe", "sec-fetch-site": "cross-site" });
  assert.equal(frame.status, 200);
  const html = frame.body.toString();
  assert.doesNotMatch(html, /<script[^>]*\bsrc=/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]!);
  assert.equal(scripts.length, 1);
  const hash = "'sha256-" + createHash("sha256").update(scripts[0]!).digest("base64") + "'";
  assert.match(String(frame.headers["content-security-policy"]), new RegExp(`script-src ${hash.replace(/[+/]/g, "\\$&")} blob:;`));

  const page = { "sec-fetch-dest": "empty", "sec-fetch-site": "same-origin", "accept-encoding": "identity" };
  const renderer = await get(new URL("/cap/render.js", server.url).href, page);
  assert.equal(renderer.status, 200);
  assert.match(String(renderer.headers["content-type"]), /javascript/);
  assert.ok(renderer.body.length > 1_000_000);
  const again = await get(new URL("/cap/render.js", server.url).href, { ...page, "if-none-match": String(renderer.headers.etag) });
  assert.equal(again.status, 304);
});
