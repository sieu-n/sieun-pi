/**
 * The server keeps an idle keep-alive connection longer than tailscale serve's 90 s idle timeout (http.ts KEEP_ALIVE_MS), so the proxy
 * closes it first and never sends a call into the server's close. With Node's default 5 s the server closed first, and a call sent on the
 * connection after that got no answer, which the proxy turns into a bare 502.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/keep-alive.test.ts
 */
import assert from "node:assert/strict";
import { connect, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { KEEP_ALIVE_MS, serve } from "../../server/http.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start();
});
after(async () => {
  await s.close();
});

/** Sends a call, waits `gapMs` on the same connection as a proxy's pool does, sends a second, and says what the second got. */
async function afterIdle(server: Server, gapMs: number): Promise<string> {
  const port = (server.address() as AddressInfo).port;
  const client = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  let received = "";
  let closed = "";
  client.on("data", data => (received += data.toString()));
  client.on("end", () => (closed ||= "the server ended the connection"));
  client.on("error", error => (closed ||= (error as NodeJS.ErrnoException).code ?? error.message));
  const request = "GET /api/ready HTTP/1.1\r\nHost: x\r\n\r\n";
  client.write(request);
  while (!received.includes("\r\n\r\n")) await sleep(10);
  await sleep(gapMs);
  const before = received.length;
  client.write(request, () => {});
  for (let waited = 0; waited < 1000 && !received.slice(before).includes("\r\n\r\n"); waited += 10) await sleep(10);
  client.destroy();
  const second = received.slice(before);
  return second.startsWith("HTTP/1.1 ") ? second.slice(9, 12) : `no answer (${closed || "nothing"})`;
}

const listening = async (keepAliveMs?: number) => {
  const server = serve(s.app);
  if (keepAliveMs !== undefined) server.keepAliveTimeout = keepAliveMs;
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return server;
};

test("the server keeps an idle connection past tailscale serve's 90 s idle timeout", async () => {
  assert.ok(KEEP_ALIVE_MS > 90_000);
  const server = await listening();
  try {
    assert.equal(server.keepAliveTimeout, KEEP_ALIVE_MS);
    assert.ok(server.headersTimeout > server.keepAliveTimeout);
    assert.equal(await afterIdle(server, 6000), "200", "a call 6 s after the last one answers on the same connection");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("with Node's default 5 s, a call 6 s after the last one meets a closed connection", async () => {
  const server = await listening(5000);
  try {
    assert.match(await afterIdle(server, 6000), /^no answer/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("a local fetch's connection closes after its answer, so a hand-over keeps none of pi-host's pool", async () => {
  const server = await listening();
  try {
    const port = (server.address() as AddressInfo).port;
    const answer = await fetch(`http://127.0.0.1:${port}/api/ready`);
    assert.equal(answer.headers.get("connection"), "close");
    const client = connect({ port, host: "127.0.0.1" });
    let received = "";
    client.on("data", data => (received += data.toString()));
    client.write("GET /api/ready HTTP/1.1\r\nHost: x\r\n\r\n");
    while (!received.includes("\r\n\r\n")) await sleep(10);
    client.destroy();
    assert.match(received, /connection: keep-alive/i, "a client that is not a local fetch keeps its connection");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
