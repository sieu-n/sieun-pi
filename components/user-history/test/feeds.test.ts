import assert from "node:assert/strict";
import { test } from "node:test";

/** A stand-in browser: `document`, `window` and a WebSocket the test drives by hand. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  send(text: string) { this.sent.push(JSON.parse(text) as Record<string, unknown>); }
  close() { this.readyState = 3; }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  drop() { this.readyState = 3; this.onclose?.(); }
}

const timers: { at: number; run: () => void }[] = [];
const onVisibility: (() => void)[] = [];
function setVisibility(state: "visible" | "hidden") {
  (globalThis.document as { visibilityState: string }).visibilityState = state;
  for (const run of onVisibility) run();
}
let now = 0;
Object.assign(globalThis, {
  WebSocket: FakeSocket,
  document: { body: { dataset: { chatToken: "t" } }, baseURI: "http://127.0.0.1:5182/cap/", visibilityState: "visible",
    addEventListener: (type: string, run: () => void) => { if (type === "visibilitychange") onVisibility.push(run); } },
  window: { addEventListener() {} },
  setTimeout: (run: () => void, ms: number) => { const timer = { at: now + ms, run }; timers.push(timer); return timer; },
  clearTimeout: (timer: unknown) => { const index = timers.indexOf(timer as never); if (index >= 0) timers.splice(index, 1); },
});
Date.now = () => now;
/** Moves the clock to the next pending timer and runs it; returns how far the clock moved. */
function nextTimer(): number {
  timers.sort((a, b) => a.at - b.at);
  const timer = timers.shift();
  assert(timer, "a timer is pending");
  const waited = timer.at - now;
  now = timer.at;
  timer.run();
  return waited;
}
const latest = () => FakeSocket.all.at(-1)!;

const { subscribeFeed } = await import("../src/client/feeds.ts");

test("a feed the server rejects fails alone, and the socket keeps serving the others", () => {
  const errors: string[] = [];
  const events: string[] = [];
  subscribeFeed({ feed: "sessions" }, event => events.push(event), () => errors.push("sessions"));
  subscribeFeed({ feed: "refresh" }, () => {}, () => errors.push("refresh"));
  const socket = latest();
  socket.open();
  const refusedSub = socket.sent.find(message => message.feed === "refresh")!.sub;
  socket.receive({ sub: refusedSub, event: "error", data: { message: "Usage analytics is off in this chat." } });
  assert.deepEqual(errors, ["refresh"]);
  socket.receive({ sub: socket.sent.find(message => message.feed === "sessions")!.sub, event: "sessions", data: {} });
  assert.deepEqual(events, ["sessions"]);
  socket.drop();
  nextTimer();
  latest().open();
  assert.deepEqual(latest().sent.map(message => message.feed), ["sessions"], "a rejected feed is not sent again after a reconnect");
});

test("a socket that closes right after it opens backs off instead of reconnecting every half second", () => {
  const waits: number[] = [];
  for (let i = 0; i < 6; i++) {
    latest().open();
    latest().drop();
    waits.push(nextTimer());
  }
  assert(waits[5]! > 8000, "the sixth wait is past 8 s: " + waits.join(", "));
});

test("a tab hidden for 30 s closes its socket without an error, and showing it again resubscribes at once", () => {
  for (let i = 0; i < 6 && timers.length; i++) nextTimer();
  latest().open();
  const socket = latest();
  const errors: string[] = [];
  subscribeFeed({ feed: "thread", id: "t1" }, () => {}, () => errors.push("thread"));
  setVisibility("hidden");
  timers.sort((a, b) => a.at - b.at);
  // Compare with the deadline itself: the clock is fractional after the jittered retries, and `at - now` can come out as 30000.000000000007.
  const deadline = now + 30_000;
  while (timers.length && timers[0]!.at <= deadline) nextTimer();
  assert.equal(socket.readyState, 3, "the hidden tab closed its socket");
  const count = FakeSocket.all.length;
  for (let i = 0; i < 5 && timers.length; i++) nextTimer();
  assert.equal(FakeSocket.all.length, count, "a hidden tab does not reconnect");
  assert.deepEqual(errors, []);
  setVisibility("visible");
  assert.equal(FakeSocket.all.length, count + 1, "showing the tab reconnects without waiting");
  latest().open();
  assert(latest().sent.some(message => message.feed === "thread" && message.id === "t1"));
});
