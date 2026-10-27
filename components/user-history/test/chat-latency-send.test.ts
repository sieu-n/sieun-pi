// Guards d7's 17:57Z, 18:06Z and 18:16Z minutes on 10-27: render.js, the 1.5 MB gzipped diagram renderer, took 1.2 to 2.3 s on its way to the
// Mac in Korea while the service had handed it over at once, and d7 counted each minute dirty as the chat's own slow read.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { takeLatency, timeRead } from "../src/chat-latency.ts";

test("a read counts until the service hands its response over, and a slow client's transfer goes to sendMs", async t => {
  const body = Buffer.alloc(32 << 20, 120);
  const server = createServer((req, res) => {
    timeRead(req, res, "/");
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
    res.end(body);
  });
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  takeLatency();
  const port = (server.address() as { port: number }).port;
  const socket = connect(port, "127.0.0.1");
  socket.pause();
  socket.write("GET /render.js HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  // The client reads nothing for 1.5 s, as a slow link does, then takes the whole body.
  await sleep(1500);
  const done = new Promise<void>(resolve => { socket.on("end", resolve); socket.on("close", () => resolve()); });
  socket.resume();
  socket.on("data", () => {});
  await done;
  await sleep(50);
  const line = takeLatency();
  assert.ok(line, "the read was timed");
  assert.equal(line.send, "render.js");
  assert.ok((line.sendMs ?? 0) >= 1000, `the transfer took ${line.sendMs} ms`);
  assert.ok(line.readMs < 500, `the service's part read ${line.readMs} ms`);
});
