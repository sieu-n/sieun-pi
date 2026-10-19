// Guards the 10-19 cold loads from the Mac (195 ms a round trip): app.js went out as one 697 KB file, 197 KB brotli, and ended 0.4 to 0.8 s
// after the shell, though Settings, the agents dialog, the reader, the prompt view, the plan view and the job drawer open only on a click.
import assert from "node:assert/strict";
import { test } from "node:test";
import { brotliCompressSync } from "node:zlib";
import { request } from "node:http";
import { asset, compileClient, cssRules, mergeCss, packAsset } from "../src/chat-assets.ts";
import { startChatServer } from "../src/chat-server.ts";
import type { ChatBackend } from "../src/chat-backend.ts";

const br = (body: Uint8Array) => brotliCompressSync(body).length;

test("the views a page opens on a click load as chunks of their own, and the shell preloads every chunk app.js imports at once", async () => {
  const { js, css, chunks, preload } = await compileClient();
  const eager = br(js) + preload.reduce((sum, name) => sum + br(chunks[name]!), 0);
  const all = br(js) + Object.values(chunks).reduce((sum, body) => sum + br(body), 0);
  assert.ok(preload.every(name => name in chunks));
  assert.ok(eager < all * 0.85, `eager ${eager} B of ${all} B brotli`);
  for (const name of preload) assert.ok(Buffer.from(js).toString().includes(name) || preload.some(other => Buffer.from(chunks[other]!).toString().includes(name)), name);
  const lazyNames = Object.keys(chunks).filter(name => !preload.includes(name));
  assert.ok(lazyNames.length >= 6, lazyNames.join(" "));
  const text = Buffer.from(css).toString();
  assert.equal(new Set(cssRules(text)).size, cssRules(text).length, "app.css repeats no rule");
});

test("app.css takes each lazy stylesheet's rules once, quoted braces and at-rules whole", () => {
  const main = '.a{color:red}@media (max-width:10px){.a{color:blue}}.q:after{content:"}"}';
  const merged = mergeCss(main, ['.a{color:red}.b{color:green}', '.b{color:green}@keyframes k{0%{opacity:0}to{opacity:1}}']);
  assert.deepEqual(cssRules(merged), [".a{color:red}", "@media (max-width:10px){.a{color:blue}}", '.q:after{content:"}"}', ".b{color:green}", "@keyframes k{0%{opacity:0}to{opacity:1}}"]);
  assert.equal(mergeCss(main, [main]), main);
});

function get(url: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, res => { let body = ""; res.on("data", (chunk: Buffer) => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body })); });
    req.on("error", reject); req.end();
  });
}

test("the shell names the preloaded chunks, and each chunk goes out immutable", async t => {
  const script = packAsset(asset(Buffer.from("import './chunk.AAAA1111.js';"), "text/javascript; charset=utf-8"));
  const chunk = packAsset(asset(Buffer.from("export const x = 1;"), "text/javascript; charset=utf-8"));
  const lazy = packAsset(asset(Buffer.from("export const y = 2;"), "text/javascript; charset=utf-8"));
  const style = packAsset(asset(Buffer.from("body{}"), "text/css; charset=utf-8"));
  const backend = { close: async () => {}, chats: { ids: async () => new Set<string>() } } as unknown as ChatBackend;
  const server = await startChatServer({ backend, bundle: { js: script, css: style, version: "test", chunks: { "chunk.AAAA1111.js": chunk, "chunk.BBBB2222.js": lazy }, preload: ["chunk.AAAA1111.js"] },
    port: 0, capability: "cap", csrfToken: "token", stopToken: "stop", identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-split.sock" }, onStop: async () => {} });
  t.after(() => server.close());
  const html = (await get(server.url)).body;
  assert.match(html, /<link rel="modulepreload" href="chunk\.AAAA1111\.js">/);
  assert.doesNotMatch(html, /chunk\.BBBB2222/);
  for (const name of ["chunk.AAAA1111.js", "chunk.BBBB2222.js"]) {
    const served = await get(new URL(name, server.url).href);
    assert.equal(served.status, 200);
    assert.equal(served.headers["cache-control"], "public, max-age=31536000, immutable");
  }
  assert.equal((await get(new URL("chunk.CCCC3333.js", server.url).href)).status, 404);
});
