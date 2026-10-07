import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { startChatServer } from "../src/chat-server.ts";
import type { ChatBackend } from "../src/chat-backend.ts";

type Frame = { sub?: number; event: string; data: unknown };

/** A backend with only the feeds: one sessions frame per subscriber, a thread "t1" with a snapshot, and every other thread missing. */
function fakeBackend() {
  const listeners = { sessions: 0, threads: 0 };
  const backend = {
    catalog: {
      subscribe(listener: (event: unknown) => void) {
        listeners.sessions++;
        queueMicrotask(() => listener({ type: "sessions", sessions: [], tags: [], daemon: "up" }));
        return () => { listeners.sessions--; };
      },
    },
    threads: {
      async subscribe(id: string, listener: (event: unknown) => void) {
        if (id !== "t1") throw new Error("Thread not found.");
        listeners.threads++;
        listener({ type: "snapshot", snapshot: { kind: "saved", id } });
        return () => { listeners.threads--; };
      },
    },
    close: async () => {},
  } as unknown as ChatBackend;
  return { backend, listeners };
}

async function serve() {
  const { backend, listeners } = fakeBackend();
  const asset = { body: Buffer.from(""), etag: '"x"', contentType: "text/plain" };
  const server = await startChatServer({ backend, bundle: { js: asset, css: asset, version: "build-7" }, port: 0, capability: "cap", csrfToken: "token", stopToken: "stop",
    identity: { pid: process.pid, instanceId: "i", socketPath: "/none" }, onStop: async () => {}, publicOrigin: "https://chat.example.ts.net" });
  const origin = new URL(server.url).origin;
  const wsUrl = (token = "token", path = "api/ws") => server.url.replace("http:", "ws:") + path + (token ? "?token=" + token : "");
  return { server, origin, wsUrl, listeners };
}

/** Opens a socket and collects its frames; `next` waits for the first unread frame that matches. */
function connect(url: string, headers: Record<string, string>): Promise<{ ws: WebSocket; next: (match: (frame: Frame) => boolean) => Promise<Frame> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const frames: Frame[] = [];
    const waiters: Array<() => void> = [];
    ws.on("message", raw => { frames.push(JSON.parse(raw.toString()) as Frame); for (const wake of waiters.splice(0)) wake(); });
    ws.once("unexpected-response", (_req, res) => reject(new Error("HTTP " + res.statusCode)));
    ws.once("error", reject);
    ws.once("open", () => resolve({ ws, next: match => new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error("No matching frame in " + JSON.stringify(frames))), 5000);
      const look = () => {
        const index = frames.findIndex(match);
        if (index >= 0) { clearTimeout(timer); done(frames.splice(index, 1)[0]!); } else waiters.push(look);
      };
      look();
    }) }));
  });
}

const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 20)); assert(check()); };

test("one socket carries the sessions, thread and login feeds", async () => {
  const { server, origin, wsUrl, listeners } = await serve();
  try {
    const { ws, next } = await connect(wsUrl(), { Origin: origin });
    ws.send(JSON.stringify({ type: "subscribe", sub: 1, feed: "sessions" }));
    assert.deepEqual(await next(frame => frame.sub === 1 && frame.event === "build"), { sub: 1, event: "build", data: { version: "build-7" } });
    assert.deepEqual((await next(frame => frame.sub === 1 && frame.event === "sessions")).data, { type: "sessions", sessions: [], tags: [], daemon: "up" });
    ws.send(JSON.stringify({ type: "subscribe", sub: 2, feed: "thread", id: "t1" }));
    assert.deepEqual((await next(frame => frame.sub === 2)).data, { type: "snapshot", snapshot: { kind: "saved", id: "t1" } });
    ws.send(JSON.stringify({ type: "subscribe", sub: 3, feed: "thread", id: "gone" }));
    assert.deepEqual(await next(frame => frame.sub === 3), { sub: 3, event: "thread", data: { type: "status", connection: "closed", error: "Thread not found." } });
    ws.send(JSON.stringify({ type: "subscribe", sub: 4, feed: "thread", id: "../bad id" }));
    assert.deepEqual((await next(frame => frame.sub === 4)).data, { type: "status", connection: "closed", error: "Invalid thread ID." });
    ws.send(JSON.stringify({ type: "subscribe", sub: 5, feed: "login" }));
    assert.deepEqual(await next(frame => frame.sub === 5), { sub: 5, event: "login", data: null });
    assert.deepEqual(listeners, { sessions: 1, threads: 1 });
    ws.send(JSON.stringify({ type: "unsubscribe", sub: 2 }));
    await until(() => listeners.threads === 0);
    ws.close();
    await until(() => listeners.sessions === 0);
  } finally { await server.close(); }
});

test("the socket needs the page origin and token, and drops a malformed message", async () => {
  const { server, origin, wsUrl } = await serve();
  try {
    await assert.rejects(connect(wsUrl(), { Origin: "http://evil.example" }), /HTTP 403/);
    await assert.rejects(connect(wsUrl(), {}), /HTTP 403/, "a client that sends no Origin is refused");
    await assert.rejects(connect(wsUrl("wrong"), { Origin: origin }), /HTTP 403/);
    await assert.rejects(connect(wsUrl(""), { Origin: origin }), /HTTP 403/);
    await assert.rejects(connect(wsUrl("token", "api/sessions/ws"), { Origin: origin }), /HTTP 404/);
    await assert.rejects(connect(wsUrl().replace("/cap/", "/other/"), { Origin: origin }), /HTTP 404/);
    await assert.rejects(connect(wsUrl(), { Origin: origin, Host: "evil.example" }), /HTTP 421/);
    const remote = await connect(wsUrl(), { Origin: "https://chat.example.ts.net", Host: "chat.example.ts.net" });
    remote.ws.close();
    await assert.rejects(connect(wsUrl(), { Origin: origin, Host: "chat.example.ts.net" }), /HTTP 403/, "the remote host needs the remote origin");
    const { ws } = await connect(wsUrl(), { Origin: origin });
    const closed = new Promise<number>(resolve => ws.once("close", code => resolve(code)));
    ws.send("not json");
    assert.equal(await closed, 1008);
  } finally { await server.close(); }
});

test("a feed the server cannot serve fails alone; the socket and its other feeds stay up", async () => {
  const { server, origin, wsUrl } = await serve();
  try {
    const { ws, next } = await connect(wsUrl(), { Origin: origin });
    let closed = false;
    ws.once("close", () => { closed = true; });
    ws.send(JSON.stringify({ type: "subscribe", sub: 1, feed: "sessions" }));
    ws.send(JSON.stringify({ type: "subscribe", sub: 2, feed: "weather" }));
    ws.send(JSON.stringify({ type: "subscribe", sub: 1, feed: "login" }));
    assert.deepEqual(await next(frame => frame.sub === 2), { sub: 2, event: "error", data: { message: "Unknown feed: weather." } });
    assert.deepEqual(await next(frame => frame.sub === 1 && frame.event === "error"), { sub: 1, event: "error", data: { message: "Feed 1 is already subscribed." } });
    assert.equal((await next(frame => frame.sub === 1 && frame.event === "sessions")).event, "sessions");
    ws.send(JSON.stringify({ type: "subscribe", sub: 3, feed: "thread", id: "t1" }));
    assert.deepEqual((await next(frame => frame.sub === 3)).data, { type: "snapshot", snapshot: { kind: "saved", id: "t1" } });
    assert.equal(closed, false);
    ws.close();
  } finally { await server.close(); }
});

test("closing the server ends open sockets", async () => {
  const { server, origin, wsUrl } = await serve();
  const { ws } = await connect(wsUrl(), { Origin: origin });
  const closed = new Promise<void>(resolve => ws.once("close", () => resolve()));
  await server.close();
  await closed;
});
