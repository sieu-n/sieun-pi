// Guards release fbd5a0a0 on us-metal02, 10-23 01:20Z: it answered 3 s after each start and passed release-chat.mjs's 8 s hold, then the
// #interrupted pass of its first tick threw 30 s after each start, and the chat service crash-looped for 3.5 min (journalctl --user -u
// sieun-pi-chat: 5 "Main process exited, code=exited, status=1/FAILURE" from 01:20:49Z to 01:23:46Z) until a job rolled it back by hand.
// The service now reports the end of its first pass on GET /ready, and the release keeps the new release on trial until then.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRecord } from "../src/chat-brief.ts";
import type { ChatBackend } from "../src/chat-backend.ts";
import { startChatServer } from "../src/chat-server.ts";
import { Chats } from "../src/chats.ts";
import { IdIndex } from "../src/id-index.ts";
import { fakeThreads, row, source } from "./chats-helpers.ts";

const at = "2026-10-23T01:20:15Z";

test("the chats report ready only once the first tick and the #interrupted pass its #jobs pass queued have ended", async () => {
  const dir = await mkdtemp(join(tmpdir(), "first-pass-ready-"));
  try {
    const index = new IdIndex(join(dir, "chats.json"), "Chat index");
    await index.add("c1");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let swept = 0;
    const chats = new Chats(index, fakeThreads([]), async () => ({ lifecycle: "live" }), "b1", loadRecord(join(dir, "extension-loads.json")), {
      ...source(dir, {}, () => Date.parse(at) + 30_000, () => [row("c1", at, { chat: true, agents: [] })]),
      interrupted: async () => { swept++; await held; return null; } }, () => {});
    try {
      await chats.adopt();
      assert.equal(chats.ready, false, "a service that has not ticked is not ready");
      await chats.tick();
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(swept, 1, "the first tick queued the #interrupted pass");
      assert.equal(chats.ready, false, "the #interrupted pass still runs, as the pass that threw in fbd5a0a0 did");
      release();
      await chats.settled();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.equal(chats.ready, true);
    } finally { chats.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function status(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject); req.end();
  });
}

test("GET /ready answers 503 until the first pass ended and 200 after it, which release-chat.mjs waits for", async t => {
  const chats = { ready: false };
  const asset = { body: Buffer.from(""), etag: "e", contentType: "text/plain" };
  const server = await startChatServer({ backend: { chats, close: async () => {} } as unknown as ChatBackend, bundle: { js: asset, css: asset, version: "test" }, port: 0,
    capability: "cap", csrfToken: "token", stopToken: "stop", identity: { pid: process.pid, instanceId: "test", socketPath: "/isolated-root.sock" }, onStop: async () => {} });
  t.after(() => server.close());
  const ready = new URL("/ready", server.url).href;
  assert.equal(await status(ready), 503);
  chats.ready = true;
  assert.equal(await status(ready), 200);
});
