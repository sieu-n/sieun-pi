// Guards the 10-18 Mac reads: from 10-08 a tab hidden for 30 s closed its socket, so each return pulled the sessions list and the thread again
// (1.0 MB of JSON over a 12 to 400 KB/s link), and a reconnect named nothing it held.
import assert from "node:assert/strict";
import { test } from "node:test";

type Fake = { url: string; sent: unknown[]; readyState: number; closed: boolean; onopen?: () => void; onclose?: () => void; onmessage?: (message: { data: unknown }) => void; send(text: string): void; close(): void };
const sockets: Fake[] = [];
const documentListeners = new Map<string, (() => void)[]>();
const fakeDocument = {
  visibilityState: "visible", baseURI: "https://box.example/cap/", body: { dataset: { chatToken: "t" } }, getElementById: () => null,
  addEventListener: (type: string, listener: () => void) => { documentListeners.set(type, [...documentListeners.get(type) ?? [], listener]); },
};
class FakeSocket implements Fake {
  static OPEN = 1; static CLOSING = 2;
  sent: unknown[] = []; readyState = 0; closed = false; onopen?: () => void; onclose?: () => void; onmessage?: (message: { data: unknown }) => void;
  constructor(readonly url: string) { sockets.push(this); }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.closed = true; this.readyState = 3; }
}
Object.assign(globalThis, { document: fakeDocument, window: { addEventListener: () => {} }, WebSocket: FakeSocket });

test("a hidden tab keeps its socket, and a reconnect subscribes with what the feed holds by then", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { subscribeFeed } = await import("../src/client/feeds.ts");
  let have = "a:1";
  subscribeFeed(() => ({ feed: "sessions", delta: true, have }), () => {});
  const first = sockets[0]!;
  first.readyState = 1; first.onopen?.();
  assert.deepEqual(first.sent, [{ type: "subscribe", sub: 1, feed: "sessions", delta: true, have: "a:1" }]);
  fakeDocument.visibilityState = "hidden";
  for (const listener of documentListeners.get("visibilitychange") ?? []) listener();
  // Pings keep coming while hidden; a minute later the socket is still the one.
  for (let second = 0; second < 60; second += 20) { t.mock.timers.tick(20_000); first.onmessage?.({ data: '{"event":"ping"}' }); }
  assert.equal(first.closed, false);
  assert.equal(sockets.length, 1);
  fakeDocument.visibilityState = "visible";
  for (const listener of documentListeners.get("visibilitychange") ?? []) listener();
  assert.equal(sockets.length, 1, "showing the tab again opens nothing");
  // A restart drops the socket: the next one names the rows the feed holds now.
  have = "a:2,b:3";
  first.readyState = 3; first.onclose?.();
  t.mock.timers.tick(1000);
  const second = sockets[1]!;
  second.readyState = 1; second.onopen?.();
  assert.deepEqual(second.sent, [{ type: "subscribe", sub: 1, feed: "sessions", delta: true, have: "a:2,b:3" }]);
});
