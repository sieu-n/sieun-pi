// Guards the 10-20 finding that the chat socket compressed every frame: ws applies perMessageDeflate's threshold only when the server drops its
// compression context, so each small thread event waited for a zlib slot on libuv's 4-thread pool, which the chat service shares with its file
// reads. On the live service at box load 250 a Mac chat's first reply frame reached a deflate socket 60 to 700 ms after a socket without it.
import assert from "node:assert/strict";
import { pbkdf2 } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import WebSocket from "ws";
import { FeedSockets, type FeedSend } from "../src/chat-socket.ts";

test("a small feed frame goes out at once while every libuv pool thread is busy, and a big one still arrives whole", async t => {
  let send: FeedSend | undefined;
  const feeds = new FeedSockets((_feed, feedSend) => { send = feedSend; return () => {}; });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => feeds.accept(req, socket, head));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { feeds.close(); server.close(); });
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  await once(client, "open");
  t.after(() => client.close());
  const got: { at: number; text: string }[] = [];
  client.on("message", data => got.push({ at: Date.now(), text: data.toString() }));
  client.send(JSON.stringify({ type: "subscribe", sub: 1, feed: "login" }));
  for (let wait = 0; !send && wait < 200; wait++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(client.extensions.includes("permessage-deflate"), "the client did not negotiate compression, so the test proves nothing");

  const busy: Promise<unknown>[] = [];
  const started = Date.now();
  for (let index = 0; index < 8; index++) busy.push(new Promise(resolve => pbkdf2("p", "s", 400_000, 32, "sha256", resolve)));
  await new Promise(resolve => setTimeout(resolve, 20));
  const sentAt = Date.now();
  send!("message_update", { text: "ok" });
  for (let wait = 0; !got.length && wait < 2000; wait++) await new Promise(resolve => setTimeout(resolve, 2));
  const late = got[0] ? got[0].at - sentAt : Infinity;
  await Promise.all(busy);
  const pool = Date.now() - started;
  assert.ok(pool > 300, `the pool was busy only ${pool} ms, so the test proves nothing`);
  assert.ok(late < pool / 2, `the small frame took ${late} ms while the pool was busy for ${pool} ms`);
  assert.match(got[0]!.text, /"ok"/);

  const big = "x".repeat(200_000);
  send!("snapshot", { big });
  for (let wait = 0; got.length < 2 && wait < 2000; wait++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal((JSON.parse(got[1]!.text) as { data: { big: string } }).data.big, big);
});
