// Guards the 10-18 incident where a working Mac session's tunnel took one slim snapshot after another: a slow link backed up the Mac daemon's socket, the supervisor dropped the session's events and sent the whole snapshot again, and each resent snapshot backed the socket up again. A box scratch thread at 100 KB/s got 9 snapshots in 45 s, 3.45 MB, where reading the daemon at once sent 1 snapshot and every event in 0.70 MB.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const RELAY = "../../prime-relay/relay.mjs";
const { createRelay } = await import(RELAY) as { createRelay: (config: { listen: string; port: number; daemonSocket: string; roots: string[]; token: string }) => Server };
const line = Buffer.from(JSON.stringify({ type: "session_status", recap: "x".repeat(1000) }) + "\n");
const LINES = 64 * 1024;

test("the relay reads every byte the daemon writes while the box reads none, and the box then gets them all unchanged", async t => {
  const dir = await mkdtemp(join(tmpdir(), "relay-drain-"));
  const daemonSocket = join(dir, "daemon.sock");
  let flushed: Promise<void> | undefined;
  const daemon = createServer(client => {
    flushed = new Promise(resolve => {
      for (let n = 1; n < LINES; n++) client.write(line);
      client.write(line, () => resolve());
    });
    void flushed.then(() => client.end());
  });
  daemon.listen(daemonSocket);
  await once(daemon, "listening");
  const token = "t".repeat(40);
  await writeFile(join(dir, "token"), token + "\n");
  const relay = createRelay({ listen: "127.0.0.1", port: 0, daemonSocket, roots: [], token });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  t.after(() => { relay.close(); daemon.close(); });
  const port = (relay.address() as { port: number }).port;

  const box = await new Promise<Socket>((resolve, reject) => {
    const asked = request({ host: "127.0.0.1", port, path: "/v1/daemon", headers: { connection: "Upgrade", upgrade: "prime-daemon", authorization: `Bearer ${token}`,
      "x-prime-slim-snapshot": "images", "x-prime-line-delta": "1" } });
    asked.on("upgrade", (_response, socket, head) => { socket.pause(); if (head.length) socket.unshift(head); resolve(socket); });
    asked.on("error", reject);
    asked.end();
  });
  while (!flushed) await new Promise(resolve => setTimeout(resolve, 10));
  const drained = await Promise.race([flushed.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10_000))]);
  assert.ok(drained, `the daemon's ${LINES * line.length} bytes waited in its own socket while the box read nothing`);

  const parts: Buffer[] = [];
  box.on("data", (part: Buffer) => parts.push(part));
  box.resume();
  await once(box, "end");
  const got = Buffer.concat(parts);
  assert.equal(got.length, LINES * line.length);
  assert.ok(got.subarray(0, line.length).equals(line) && got.subarray(got.length - line.length).equals(line));
});
