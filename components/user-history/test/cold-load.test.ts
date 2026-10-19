// Guards the 10-18 cold loads from Korea (185 ms a round trip, 370 KB/s): app.js went out no-cache under one name, so every load revalidated it, and the page subscribed to the thread only after app.js ran, about four round trips before the first message.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { test } from "node:test";
import { brotliDecompressSync } from "node:zlib";
import { runInNewContext } from "node:vm";
import WebSocket from "ws";
import { bootFeedScript, bootTargetScript } from "../src/boot-feed.ts";
import { pageTarget } from "../src/client/permalink.ts";
import { startChatServer } from "../src/chat-server.ts";
import { inlineJson } from "../src/first-page.ts";
import { asset, packAsset } from "../src/chat-assets.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import type { ThreadEvent } from "../src/shared/types.ts";

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
  // Waits on the frames, not a fixed 100 ms: under the release build's load on 10-19 (c8fb6bf, 15:03Z) no frame had arrived after 100 ms.
  const until = async (done: () => boolean) => { while (!done()) await new Promise(resolve => setTimeout(resolve, 10)); };
  const shown = () => frames.filter(frame => frame.includes(":thread:") || frame.includes(":sessions:"));
  await new Promise(resolve => ws.once("open", resolve));
  await until(() => started.length > 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(started, ["thread"]);
  release();
  await until(() => shown().length >= 2);
  assert.deepEqual(started, ["thread", "sessions"]);
  assert.deepEqual(shown(), ["1:thread:snapshot", "2:sessions:sessions"]);
});
test("the boot script reads the thread from the hash, else ?t=, the way the page does", () => {
  const urls: Array<[string, string]> = [["", ""], ["", "#01a14d31-6ec0"], ["", "#01a14d31-6ec0@1792305420954"], ["", "#abc%40def"], ["", "#x@notanumber"],
    ["?t=01a14d31-6ec0", ""], ["?t=other", "#01a14d31-6ec0@1792305420954"], ["?x=1", ""]];
  for (const [search, hash] of urls) {
    const sockets: string[] = [];
    const window: Record<string, unknown> = {};
    runInNewContext(bootFeedScript, { window, URL, URLSearchParams, JSON, decodeURIComponent, location: { hash, search }, document: { baseURI: "https://box.example/cap/", body: { dataset: { chatToken: "t" } } },
      WebSocket: class { constructor(url: URL) { sockets.push(String(url)); } } });
    const subs = JSON.parse(new URL(sockets[0]!).searchParams.get("subs")!) as Array<{ feed: string; id?: string }>;
    assert.equal(subs.find(sub => sub.feed === "thread")?.id ?? null, pageTarget({ hash, search })?.id ?? null, search + hash);
  }
});

test("the boot script names the board this browser kept for the thread, and goes without it when storage throws", () => {
  const subsFor = (localStorage: unknown) => {
    const sockets: string[] = [];
    runInNewContext(bootFeedScript, { window: {}, URL, URLSearchParams, JSON, decodeURIComponent, localStorage, location: { hash: "#chat-a", search: "" },
      document: { baseURI: "https://box.example/cap/", body: { dataset: { chatToken: "t" } } }, WebSocket: class { constructor(url: URL) { sockets.push(String(url)); } } });
    return JSON.parse(new URL(sockets[0]!).searchParams.get("subs")!) as Array<{ feed: string; have?: { board: string } }>;
  };
  assert.deepEqual(subsFor({ getItem: () => JSON.stringify({ "chat-a": "7|2026-10-19T10:00:00Z" }) })[0]?.have, { board: "7|2026-10-19T10:00:00Z" });
  assert.equal(subsFor({ getItem: () => { throw new Error("private"); } })[0]?.have, undefined);
});

// Guards the 10-19 Mac cold loads of a hash-only thread URL: the server never sees the hash, so the shell had no first page and no still view, and the chat showed after app.js at 1.52 to 1.66 s instead of 0.88 to 1.38 s with ?t=.
test("a URL that names a thread only in its hash loads again with ?t=, before the shell asks for any asset", async t => {
  const cases: Array<[string, string, string | null]> = [["", "", null], ["", "#01a14d31-6ec0", "/cap/?t=01a14d31-6ec0#01a14d31-6ec0"],
    ["", "#01a14d31-6ec0@1792305420954", "/cap/?t=01a14d31-6ec0#01a14d31-6ec0@1792305420954"], ["?t=01a14d31-6ec0", "#01a14d31-6ec0@1792305420954", null],
    ["?t=other", "#01a14d31-6ec0", "/cap/?t=01a14d31-6ec0#01a14d31-6ec0"], ["?x=1", "#01a14d31-6ec0", "/cap/?x=1&t=01a14d31-6ec0#01a14d31-6ec0"],
    ["?t=01a14d31-6ec0", "", null], ["", "#not%20an%20id", null]];
  for (const [search, hash, expected] of cases) {
    const moves: string[] = [];
    runInNewContext(bootTargetScript, { URLSearchParams, decodeURIComponent, location: { pathname: "/cap/", hash, search, replace: (to: string) => { moves.push(to); } } });
    assert.deepEqual(moves, expected === null ? [] : [expected], search + hash);
    if (expected) assert.equal(pageTarget({ hash, search })?.id, new URLSearchParams(expected.slice(5).split("#")[0]).get("t"), search + hash);
  }
  const backend = { close: async () => {}, chats: { ids: async () => new Set<string>() } } as unknown as ChatBackend;
  const server = await startChatServer({ backend, bundle: { js: script, css: style, version: "test" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-cold-target.sock" }, onStop: async () => {} });
  t.after(() => server.close());
  const shell = await get(server.url);
  const html = shell.body.toString();
  assert.ok(html.indexOf(`<script>${bootTargetScript}</script>`) >= 0 && html.indexOf(`<script>${bootTargetScript}</script>`) < html.indexOf('rel="preload"'), html);
  assert.ok(String(shell.headers["content-security-policy"]).includes(`'sha256-${createHash("sha256").update(bootTargetScript).digest("base64")}'`));
});

// Guards the 10-18 07:30Z Aside reads from Korea after d74e001: the shell painted at 228 to 448 ms, but the newest message only at 1.25 to 1.63 s, because its socket is a new TCP and TLS connection through tailscale serve.
test("a shell with ?t= carries that thread's first frames inline, packed, and goes without them when they are slow", async t => {
  const snapshot = { type: "snapshot", snapshot: { messages: [{ role: "user", content: "</script><script>alert(1)</script>", timestamp: 1 }] } };
  let slow = false;
  const backend = { close: async () => {}, chats: { ids: async () => new Set<string>() },
    threads: { firstFrames: async (id: string) => { if (slow) await new Promise(resolve => setTimeout(resolve, 2000)); return id === "t1" ? inlineJson([snapshot as unknown as ThreadEvent]) : "[]"; } } } as unknown as ChatBackend;
  const server = await startChatServer({ backend, bundle: { js: script, css: style, version: "test" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-cold-inline.sock" }, onStop: async () => {} });
  t.after(() => server.close());
  const shell = await get(server.url + "?t=t1", { "accept-encoding": "gzip, deflate, br" });
  assert.equal(shell.headers["content-encoding"], "br");
  const html = brotliDecompressSync(shell.body).toString();
  const inline = /<script type="application\/json" id="boot-thread" data-id="t1">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(inline, html);
  assert.deepEqual(JSON.parse(inline[1]!), [snapshot]);
  assert.doesNotMatch((await get(server.url)).body.toString(), /boot-thread/);
  // The head goes out before the server has the page, so the browser fetches app.js and opens its socket meanwhile.
  slow = true;
  const started = Date.now();
  const firstChunk = await new Promise<number>((resolve, reject) => {
    const req = request(server.url + "?t=t1", res => { res.once("data", () => resolve(Date.now() - started)); res.resume(); });
    req.on("error", reject); req.end();
  });
  assert.ok(firstChunk < 300, `head after ${firstChunk} ms`);
  const late = Date.now();
  assert.doesNotMatch((await get(server.url + "?t=t1")).body.toString(), /boot-thread/);
  assert.ok(Date.now() - late < 1500);
});
