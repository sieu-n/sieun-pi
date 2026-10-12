import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatBackend } from "../src/chat-backend.ts";
import { ChatBookmarks } from "../src/chat-bookmarks.ts";
import { startChatServer } from "../src/chat-server.ts";
import { BOOKMARK_TEXT_MAX, bookmarkPreview, type Bookmark } from "../src/shared/bookmarks.ts";

const path = async () => join(await mkdtemp(join(tmpdir(), "chat-bookmarks-")), "bookmarks.json");

test("bookmarks: add lists newest first, a second add keeps the place and refreshes the text, remove takes one, clear empties the file", async () => {
  const file = await path();
  const bookmarks = new ChatBookmarks(file);
  assert.deepEqual(await bookmarks.list(), []);
  await bookmarks.apply({ op: "add", chat: "c1", at: 100, text: "first" });
  await bookmarks.apply({ op: "add", chat: "c2", at: 200, text: "second" });
  const again = await bookmarks.apply({ op: "add", chat: "c1", at: 100, text: "first, edited" });
  assert.deepEqual(again.map(b => [b.chat, b.at, b.text]), [["c2", 200, "second"], ["c1", 100, "first, edited"]]);
  assert.deepEqual((await new ChatBookmarks(file).list()).map(b => b.chat), ["c2", "c1"], "another reader sees the file");
  assert.deepEqual((await bookmarks.apply({ op: "remove", chat: "c2", at: 200 })).map(b => b.chat), ["c1"]);
  assert.deepEqual((await bookmarks.apply({ op: "remove", chat: "c2", at: 200 })).map(b => b.chat), ["c1"], "removing a missing bookmark is a no-op");
  assert.deepEqual(await bookmarks.apply({ op: "clear" }), []);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { bookmarks: [] });
});

test("bookmarkPreview: one line without the Reply quote, markdown marks or fences, cut with an ellipsis", () => {
  assert.equal(bookmarkPreview("> the old question\n\nYes, **ship** it.\n- [the page](wiki:x) has `code`"), "Yes, ship it. the page has code");
  assert.equal(bookmarkPreview("> only a quote"), "only a quote");
  assert.equal(bookmarkPreview("## Plan\n```ts\nconst a = 1;\n```"), "Plan const a = 1;");
  const long = bookmarkPreview("word ".repeat(200));
  assert.equal(long.length, BOOKMARK_TEXT_MAX);
  assert.ok(long.endsWith("…"));
});

test("api/bookmarks: GET lists; POST adds, removes and clears with the write token; bad input is 400 and a missing token 403", async () => {
  const bookmarks = new ChatBookmarks(await path());
  const backend = { bookmarks, close: async () => {} } as unknown as ChatBackend;
  const asset = { body: Buffer.from(""), etag: '"x"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "t" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "i", socketPath: "/none" }, onStop: async () => {} });
  const origin = new URL(server.url).origin;
  type Body = { bookmarks: Bookmark[]; error?: string };
  const get = async () => { const res = await fetch(server.url + "api/bookmarks"); return { status: res.status, body: await res.json() as Body }; };
  const post = async (body: unknown, token = "token") => {
    const res = await fetch(server.url + "api/bookmarks", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", "X-Chat-Token": token, Origin: origin } });
    return { status: res.status, body: await res.json() as Body };
  };
  try {
    assert.deepEqual(await get(), { status: 200, body: { bookmarks: [] } });
    assert.equal((await post({ op: "add", chat: "c1", at: 5, text: "hi" }, "wrong")).status, 403);
    assert.equal((await post({ op: "pin", chat: "c1", at: 5 })).status, 400);
    assert.equal((await post({ op: "add", chat: "c1", at: -1, text: "hi" })).status, 400);
    assert.equal((await post({ op: "add", chat: "c 1", at: 5, text: "hi" })).status, 400);
    assert.equal((await post({ op: "add", chat: "c1", at: 5, text: "x".repeat(BOOKMARK_TEXT_MAX + 1) })).status, 400);
    const added = await post({ op: "add", chat: "c1", at: 5, text: "hi" });
    assert.deepEqual([added.status, added.body.bookmarks.map(b => [b.chat, b.at, b.text])], [200, [["c1", 5, "hi"]]]);
    await post({ op: "add", chat: "c2", at: 9, text: "there" });
    assert.deepEqual((await post({ op: "remove", chat: "c1", at: 5 })).body.bookmarks.map(b => b.chat), ["c2"]);
    await post({ op: "add", chat: "c3", at: 1, text: "more" });
    assert.equal((await get()).body.bookmarks.length, 2);
    const cleared = await post({ op: "clear" });
    assert.deepEqual([cleared.status, cleared.body.bookmarks], [200, []]);
    assert.deepEqual((await get()).body.bookmarks, [], "clear all survives a fresh read");
  } finally { await server.close(); }
});
