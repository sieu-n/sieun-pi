// us-metal02 to the Mac, 07:54:35Z on 10-18: a burst of mirror reads opened 70 new relay connections at once, each paying a 185 ms TCP handshake,
// because Node's default agent and the relay's 5 s keep-alive closed the sockets between bursts.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readHostFile, type Host } from "../src/hosts.ts";

test("relay reads reuse one open connection across an idle gap past the relay's old 5 s keep-alive", async t => {
  const dir = await mkdtemp(join(tmpdir(), "relay-keepalive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const token = "k".repeat(40);
  await writeFile(join(dir, "token"), token);
  await mkdir(join(dir, "sessions"));
  const file = join(dir, "sessions", "a.jsonl");
  await writeFile(file, "line\n");
  const relayModule = "../../prime-relay/relay.mjs";
  const { createRelay } = await import(relayModule) as { createRelay: (config: object) => Server };
  const server = createRelay({ listen: "127.0.0.1", port: 0, daemonSocket: join(dir, "none.sock"), roots: [join(dir, "sessions")], token });
  let connections = 0;
  server.on("connection", () => { connections++; });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { (server as Server & { closeAllConnections(): void }).closeAllConnections(); server.close(() => resolve()); }));
  const host: Host = { name: "mac", hostname: "mac", address: "127.0.0.1", relayPort: (server.address() as AddressInfo).port, token: `file:${join(dir, "token")}`,
    daemonSocket: "/tmp/none.sock", ssh: null, roles: {} };
  assert.equal((await readHostFile(host, file)).bytes.toString(), "line\n");
  await new Promise(resolve => setTimeout(resolve, 7000));
  assert.equal((await readHostFile(host, file, { from: 2 })).bytes.toString(), "ne\n");
  assert.equal(connections, 1);
});
