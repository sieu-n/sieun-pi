// Guards the 10-18 cold reloads from Korea: the chat restarted onto new client code dozens of times a day, and each open page then reloaded and pulled the new app.js (190 KB packed) over the 185 ms link, 11 to 22 s on the owner's Mac.
import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import WebSocket from "ws";
import { startChatServer } from "../src/chat-server.ts";
import { asset, packAsset } from "../src/chat-assets.ts";
import { warmAssets } from "../src/client/build-reload.ts";
import type { ChatBackend } from "../src/chat-backend.ts";

const script = packAsset(asset(Buffer.from("console.log('chat');\n"), "text/javascript; charset=utf-8"));
const style = packAsset(asset(Buffer.from("body{color:red}\n"), "text/css; charset=utf-8"));

test("the build event names the hashed assets the shell loads", async t => {
  const backend = { close: async () => {}, chats: { ids: async () => new Set<string>() },
    catalog: { subscribe: (listener: (event: unknown) => void) => { listener({ type: "sessions", sessions: [], tags: [], daemon: "up" }); return () => {}; } } } as unknown as ChatBackend;
  const server = await startChatServer({ backend, bundle: { js: script, css: style, version: "v2" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-build-warm.sock" }, onStop: async () => {} });
  t.after(() => server.close());
  const html = await new Promise<string>((resolve, reject) => {
    const req = request(server.url, res => { let text = ""; res.on("data", chunk => { text += String(chunk); }); res.on("end", () => resolve(text)); });
    req.on("error", reject); req.end();
  });
  const shellAssets = [/src="(app\.[0-9a-f]{16}\.js)"/.exec(html)?.[1], /href="(app\.[0-9a-f]{16}\.css)"/.exec(html)?.[1]];
  const url = new URL("api/ws?token=token&subs=" + encodeURIComponent(JSON.stringify([{ sub: 1, feed: "sessions", delta: true }])), server.url).href.replace("http", "ws");
  const ws = new WebSocket(url, { headers: { origin: new URL(server.url).origin } });
  t.after(() => ws.close());
  const build = await new Promise<{ version: string; assets: string[] }>(resolve => ws.on("message", raw => {
    const frame = JSON.parse(String(raw)) as { event: string; data: { version: string; assets: string[] } };
    if (frame.event === "build") resolve(frame.data);
  }));
  assert.equal(build.version, "v2");
  assert.deepEqual(build.assets, shellAssets);
});

test("warmAssets fetches each asset under the page's base and resolves when one fails", async () => {
  (globalThis as { document?: unknown }).document = { baseURI: "https://box.example/cap/" };
  const asked: string[] = [];
  await warmAssets(["app.0123456789abcdef.js", "app.fedcba9876543210.css"], async url => { asked.push(url); if (url.endsWith(".css")) throw new Error("offline"); });
  assert.deepEqual(asked, ["https://box.example/cap/app.0123456789abcdef.js", "https://box.example/cap/app.fedcba9876543210.css"]);
});
