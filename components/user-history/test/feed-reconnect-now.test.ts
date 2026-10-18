// Guards the 10-18 Mac reads: a socket that closed waited 1.24 to 1.43 s before the page opened the next one, most of the 1.07 to 2.07 s
// it took a reconnected page to be current again.
import assert from "node:assert/strict";
import { test } from "node:test";

type Fake = { readyState: number; closed: boolean; onopen?: () => void; onclose?: () => void; onmessage?: (message: { data: unknown }) => void };
const sockets: Fake[] = [];
class FakeSocket implements Fake {
  static OPEN = 1; static CLOSING = 2;
  readyState = 0; closed = false; onopen?: () => void; onclose?: () => void; onmessage?: (message: { data: unknown }) => void;
  constructor(readonly url: string) { sockets.push(this); }
  send() {}
  close() { this.closed = true; this.readyState = 3; }
}
Object.assign(globalThis, {
  document: { visibilityState: "visible", baseURI: "https://box.example/cap/", body: { dataset: { chatToken: "t" } }, getElementById: () => null, addEventListener: () => {} },
  window: { addEventListener: () => {} }, WebSocket: FakeSocket,
});

const open = (socket: Fake) => { socket.readyState = 1; socket.onopen?.(); };
const close = (socket: Fake) => { socket.readyState = 3; socket.onclose?.(); };

test("the first close of a stable socket reconnects at once, and only a reopen that fails again waits", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { subscribeFeed } = await import("../src/client/feeds.ts");
  subscribeFeed({ feed: "sessions" }, () => {});
  open(sockets[0]!);
  t.mock.timers.tick(60_000);
  close(sockets[0]!);
  assert.equal(sockets.length, 2, "the next socket opens in the same turn as the close");
  // The reopen fails: the one after it waits, 0.375 to 0.625 s, and the wait doubles from there.
  close(sockets[1]!);
  assert.equal(sockets.length, 2);
  t.mock.timers.tick(374);
  assert.equal(sockets.length, 2);
  t.mock.timers.tick(252);
  assert.equal(sockets.length, 3);
  close(sockets[2]!);
  t.mock.timers.tick(1251);
  assert.equal(sockets.length, 4);
  // Once a socket has held for 10 s, its close reconnects at once again.
  open(sockets[3]!);
  t.mock.timers.tick(10_000);
  close(sockets[3]!);
  assert.equal(sockets.length, 5);
});
