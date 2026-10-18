// Guards the 10-18 cold loads from Korea (185 ms a round trip, 370 KB/s): app.js went out no-cache under one name, so every load revalidated it, and the page subscribed to the thread only after app.js ran, about four round trips before the first message.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { test } from "node:test";
import { brotliDecompressSync } from "node:zlib";
import { runInNewContext } from "node:vm";
import WebSocket from "ws";
import { bootFeedScript } from "../src/boot-feed.ts";
import { parseHash } from "../src/client/permalink.ts";
import { startChatServer } from "../src/chat-server.ts";
import { asset, packAsset } from "../src/chat-assets.ts";
import type { ChatBackend } from "../src/chat-backend.ts";

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end();
  });
}

const script = packAsset(asset(Buffer.from("console.log('chat');\n".repeat(4000)), "text/javascript; charset=utf-8"));
const style = packAsset(asset(Buffer.from("body{color:red}\n".repeat(400)), "text/css; charset=utf-8"));

test("the shell names hashed assets that go out immutable and brotli-packed, and its inline boot script is allowed by the CSP", async t => {
  const backend = { close: async () => {}, chats: { ids: async () => new Set(["chat-a", "chat-b"]) } } as unknown as ChatBackend;
  const server = await startChatServer({ backend, bundle: { js: script, css: style, version: "test" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-cold.sock" }, onStop: async () => {} });
  t.after(() => server.close());
  const shell = await get(server.url);
  const html = shell.body.toString();
  const js = /src="(app\.[0-9a-f]{16}\.js)"/.exec(html)?.[1];
  const css = /href="(app\.[0-9a-f]{16}\.css)"/.exec(html)?.[1];
  assert.ok(js && css, html);
  assert.match(html, /data-chats="chat-a,chat-b"/);
  const inline = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  assert.ok(String(shell.headers["content-security-policy"]).includes(`'sha256-${createHash("sha256").update(inline).digest("base64")}'`));
  const packed = await get(new URL(js, server.url).href, { "accept-encoding": "gzip, deflate, br" });
  assert.equal(packed.headers["content-encoding"], "br");
  assert.equal(packed.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.deepEqual(brotliDecompressSync(packed.body), script.body);
  assert.equal((await get(new URL(css, server.url).href)).headers["cache-control"], "public, max-age=31536000, immutable");
  // A tab from before a restart still asks for the plain or an old name; it gets the current build, revalidated.
  const old = await get(new URL("app.0123456789abcdef.js", server.url).href);
  assert.equal(old.status, 200);
  assert.equal(old.headers["cache-control"], "no-cache");
});

test("feeds named in the socket URL start on the upgrade, the thread's snapshot before the sessions list", async t => {
  const started: string[] = [];
  let release!: () => void;
  const opened = new Promise<void>(resolve => { release = resolve; });
  const backend = {
    close: async () => {},
    catalog: { subscribe: (listener: (event: unknown) => void) => { started.push("sessions"); listener({ type: "sessions", sessions: [], tags: [], daemon: "up" }); return () => {}; }, childUsage: () => [] },
        // Like ChatThreads.subscribe: it resolves once the thread is open and its snapshot went to the listener.
    threads: { state: () => null, subscribe: async (_id: string, send: (event: unknown) => void) => { started.push("thread"); await opened; send({ type: "snapshot", snapshot: { messages: [] } }); return () => {}; } },
  } as unknown as ChatBackend;
  const server = await startChatServer({ backend, bundle: { js: script, css: style, version: "test" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-cold-ws.sock" }, onStop: async () => {} });
  t.after(() => server.close());
  const subs = JSON.stringify([{ sub: 1, feed: "thread", id: "t1" }, { sub: 2, feed: "sessions", delta: true }]);
  const url = new URL("api/ws?token=token&subs=" + encodeURIComponent(subs), server.url).href.replace("http", "ws");
  const ws = new WebSocket(url, { headers: { origin: new URL(server.url).origin } });
  t.after(() => ws.close());
  const frames: string[] = [];
  ws.on("message", raw => { const frame = JSON.parse(String(raw)) as { sub: number; event: string; data: { type?: string } }; frames.push(`${frame.sub}:${frame.event}:${frame.data?.type ?? ""}`); });
  await new Promise(resolve => ws.once("open", resolve));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(started, ["thread"]);
  release();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(started, ["thread", "sessions"]);
  assert.deepEqual(frames.filter(frame => frame.includes(":thread:") || frame.includes(":sessions:")), ["1:thread:snapshot", "2:sessions:sessions"]);
});

test("the boot script reads the thread from the hash the way the page does", () => {
  for (const hash of ["", "#01a14d31-6ec0", "#01a14d31-6ec0@1792305420954", "#abc%40def", "#x@notanumber"]) {
    const sockets: string[] = [];
    const window: Record<string, unknown> = {};
    runInNewContext(bootFeedScript, { window, URL, JSON, decodeURIComponent, location: { hash }, document: { baseURI: "https://box.example/cap/", body: { dataset: { chatToken: "t" } } },
      WebSocket: class { constructor(url: URL) { sockets.push(String(url)); } } });
    const subs = JSON.parse(new URL(sockets[0]!).searchParams.get("subs")!) as Array<{ feed: string; id?: string }>;
    assert.equal(subs.find(sub => sub.feed === "thread")?.id ?? null, parseHash(hash)?.id ?? null, hash);
  }
});
