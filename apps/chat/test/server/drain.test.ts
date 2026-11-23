/**
 * On SIGTERM the server stops taking calls and answers the calls in flight before the process ends (http.ts `drain`). A release restart
 * used to end the process mid-call, so a change in flight failed with "Load failed" in the owner's browser. An open live socket does not
 * hold the stop, and a call that never answers holds it only up to the cap.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/drain.test.ts
 */
import assert from "node:assert/strict";
import { connect, type AddressInfo } from "node:net";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { drain, lingerForwarding, serve } from "../../server/http.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start();
});
after(async () => {
  await s.close();
});

const listening = async () => {
  const server = serve(s.app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

/**
 * Holds the App's room header call `ms` (forever when undefined). `entered` resolves once the server reads the call, and a test starts the
 * drain only then. A test that slept 100 ms instead failed with ECONNRESET at box load 150 to 290 on 11-23: the event loop stalled after
 * fetch's connect, the sleep ended before the server took the connection, and the drain's close reset it in the listen queue.
 */
const holdHeader = (ms?: number) => {
  const header = s.app.header.bind(s.app);
  let enter = () => {};
  const entered = new Promise<void>(resolve => (enter = resolve));
  s.app.header = async id => {
    enter();
    if (ms === undefined) return new Promise(() => {});
    await sleep(ms);
    return header(id);
  };
  return { entered, restore: () => (s.app.header = header) };
};

test("a call in flight answers before the drain ends, while a live socket stays open", async () => {
  const { server, base } = await listening();
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/live`);
  await new Promise(resolve => socket.once("open", resolve));
  const held = holdHeader(400);
  try {
    const call = fetch(`${base}/api/c/${s.app.agents.list()[0]!.room}`);
    await held.entered;
    const started = performance.now();
    await drain(server);
    const took = performance.now() - started;
    const answer = await call;
    assert.equal(answer.status, 200, "the call in flight answers");
    assert.ok(took >= 250 && took < 1500, `the drain waited for the call and not for the socket: ${took.toFixed(0)} ms`);
    await assert.rejects(fetch(`${base}/api/me`), "a new call is refused once the drain starts");
  } finally {
    held.restore();
    socket.close();
  }
});

test("a call that never answers holds the drain only up to its cap", async () => {
  const { server, base } = await listening();
  const held = holdHeader();
  try {
    void fetch(`${base}/api/c/${s.app.agents.list()[0]!.room}`).catch(() => undefined);
    await held.entered;
    const started = performance.now();
    await drain(server, 300);
    const took = performance.now() - started;
    assert.ok(took >= 280 && took < 1000, `the drain ended at its cap: ${took.toFixed(0)} ms`);
  } finally {
    held.restore();
    server.closeAllConnections();
  }
});

test("a client that keeps its idle connection half open after the server ends it does not hold the drain", async () => {
  // On 11-22, 4 of 5 live hand-overs waited out the 2 s cap with no call in flight: http's server keeps an ended connection half open
  // until its client closes it.
  const { server, base } = await listening();
  const port = Number(new URL(base).port);
  const client = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  const answered = new Promise<void>(resolve => client.on("data", data => { if (data.toString().includes("\r\n\r\n")) resolve(); }));
  client.write("GET /api/ready HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n");
  await answered;
  const ended = new Promise<void>(resolve => client.once("end", () => resolve()));
  try {
    // The drain ends the idle connection about 100 ms in (http.ts SILENT_MS); one that waited for the client's close would run to its 10 s cap.
    // A 300 ms bound here failed at 330 ms in a parallel run on 11-23, a busy event loop and not the fault.
    const started = performance.now();
    const line = await drain(server, 10_000);
    const took = performance.now() - started;
    await ended;
    assert.ok(took < 2000, `the drain ended without the client's close: ${took.toFixed(0)} ms (${line})`);
    assert.match(line, /ended 1 idle connections \(1 not closed/);
  } finally {
    client.destroy();
  }
});

test("a call in flight when the drain starts answers with Connection: close", async () => {
  const { server, base } = await listening();
  const held = holdHeader(300);
  try {
    // A browser's call: http.ts gives every call with fetch's own user-agent Connection: close anyway (`oneShot`), drain or not.
    const call = fetch(`${base}/api/c/${s.app.agents.list()[0]!.room}`, { headers: { "user-agent": "Mozilla/5.0" } });
    await held.entered;
    const drained = drain(server);
    const answer = await call;
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get("connection"), "close");
    await drained;
  } finally {
    held.restore();
  }
});

test("a call a client sends on its idle connection just after the drain starts still answers, also when the event loop stalls", async () => {
  // A polling client sends its next call a moment after each answer; on 11-22 calls that met a connection the drain had just ended got
  // no answer. The client here sends right after the drain starts, and the server's event loop then stalls 150 ms, longer than the 100 ms
  // a connection that answered stays open (http.ts SILENT_MS), as the skills inventory's parse stalled it on 11-23 while the call sat unread.
  const { server, base } = await listening();
  const client = connect({ port: Number(new URL(base).port), host: "127.0.0.1", allowHalfOpen: true });
  let received = "";
  const answers = (n: number) => new Promise<void>(resolve => {
    const on = () => {
      if (received.split("HTTP/1.1 200").length - 1 >= n) {
        client.off("data", on);
        resolve();
      }
    };
    client.on("data", data => { received += data.toString(); on(); });
  });
  const request = "GET /api/ready HTTP/1.1\r\nHost: x\r\n\r\n";
  client.write(request);
  await answers(1);
  try {
    const drained = drain(server);
    const second = answers(2);
    client.write(request);
    const stalled = performance.now() + 150;
    while (performance.now() < stalled);
    await Promise.race([second, sleep(1000).then(() => { throw new Error(`no answer to the call sent during the drain: ${JSON.stringify(received.slice(-200))}`); })]);
    assert.match(received.slice(received.lastIndexOf("HTTP/1.1 200")), /connection: close/i);
    await drained;
  } finally {
    client.destroy();
  }
});

test("in a hand-over, a call on a kept connection goes to the new server and answers with Connection: close", async () => {
  // A call a client sends on its idle connection while the old server ends it gets no answer, and tailscale serve turns that into a bare 502
  // that it does not retry for a POST. The old server keeps the connection and passes the call on instead.
  const { server, base } = await listening();
  const port = Number(new URL(base).port);
  const client = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  let received = "";
  client.on("data", data => (received += data.toString()));
  client.write("GET /api/ready HTTP/1.1\r\nHost: x\r\n\r\n");
  while (!received.includes("\r\n\r\n")) await sleep(10);
  const line = await drain(server, 2000, "forward");
  assert.match(line, /keeping 1 connections/);
  const successor = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => res.end(`new server got ${req.method} ${req.url} ${body}`));
  });
  await new Promise<void>(resolve => successor.listen(port, "127.0.0.1", resolve));
  try {
    const before = received.length;
    client.write("POST /api/rooms HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}");
    for (let waited = 0; waited < 2000 && !received.slice(before).includes("new server got"); waited += 10) await sleep(10);
    const answer = received.slice(before);
    assert.match(answer, /^HTTP\/1\.1 200/);
    assert.match(answer, /connection: close/i);
    assert.match(answer, /new server got POST \/api\/rooms \{\}/);
    const lingered = lingerForwarding(server, 3000);
    const started = performance.now();
    assert.match(await lingered, /0 still open at the end/);
    assert.ok(performance.now() - started < 1000, "the old server stops once its client closed the connection");
  } finally {
    client.destroy();
    successor.close();
  }
});

test("the old server stays at most its bound while a client keeps a connection open", async () => {
  const { server, base } = await listening();
  const client = connect({ port: Number(new URL(base).port), host: "127.0.0.1", allowHalfOpen: true });
  await new Promise(resolve => client.once("connect", resolve));
  await sleep(50);
  try {
    await drain(server, 2000, "forward");
    const started = performance.now();
    assert.match(await lingerForwarding(server, 500), /1 still open at the end/);
    assert.ok(performance.now() - started < 1000);
  } finally {
    client.destroy();
  }
});
