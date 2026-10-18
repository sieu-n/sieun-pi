// Guards the hazard found on 10-18 at 13:11Z: `sieun-pi hosts bridge` run while the chat service was up deleted the live mac.sock on start and again on exit.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { HostBridge, type Host, type HostsRegistry } from "../src/hosts.ts";

const { createRelay } = await import("../../prime-relay/relay.mjs" as string) as { createRelay: (config: { listen: string; port: number; daemonSocket: string; roots: string[]; token: string }) => Server };
const HELLO = '{"type":"daemon_hello"}\n';

async function rig(t: import("node:test").TestContext): Promise<{ home: string; dir: string; registry: HostsRegistry; hostsFile: string }> {
  const home = await mkdtemp(join(tmpdir(), "bridge-live-"));
  const daemonSocket = join(home, "daemon.sock");
  const daemon = createServer(client => client.end(HELLO));
  daemon.listen(daemonSocket);
  await once(daemon, "listening");
  const token = "t".repeat(40);
  await writeFile(join(home, "token"), token + "\n");
  const relay = createRelay({ listen: "127.0.0.1", port: 0, daemonSocket, roots: [], token });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const host: Host = { name: "mac", hostname: "bridge-live-test-mac", address: "127.0.0.1", relayPort: (relay.address() as { port: number }).port,
    token: `file:${join(home, "token")}`, daemonSocket, ssh: null, roles: {} };
  const registry: HostsRegistry = { version: 1, hosts: [host] };
  const hostsFile = join(home, "hosts.json");
  await writeFile(hostsFile, JSON.stringify(registry));
  t.after(() => { relay.close(); daemon.close(); });
  return { home, dir: join(home, ".local/state/sieun-pi/hosts"), registry, hostsFile };
}

async function hello(path: string): Promise<string> {
  const socket = createConnection(path);
  const parts: Buffer[] = [];
  socket.on("data", (part: Buffer) => parts.push(part));
  await once(socket, "end");
  return Buffer.concat(parts).toString("utf8");
}

test("`sieun-pi hosts bridge` beside the chat service's bridge leaves its socket alone and exits 0, and the service's socket keeps answering", async t => {
  const { home, dir, registry, hostsFile } = await rig(t);
  const service = new HostBridge(registry, { dir, self: null, replaceLive: true });
  await service.start();
  t.after(() => service.close());
  const path = service.socketPath("mac");
  const before = (await stat(path)).ino;

  const cli = new URL("../src/hosts-cli.mjs", import.meta.url).pathname;
  const { stdout } = await promisify(execFile)(process.execPath, [cli, "bridge"], { env: { ...process.env, HOME: home, SIEUN_PI_HOSTS: hostsFile } });
  assert.match(stdout, /mac: .*mac\.sock already answers, so the chat service serves it/);
  assert.equal((await stat(path)).ino, before, "the CLI left the service's socket file in place");
  assert.equal(await hello(path), HELLO, "the service's bridge still reaches the daemon");
});

test("a second bridge in process skips the live socket, a second service bridge replaces it without the first's close deleting it, and a dead file is replaced", async t => {
  const { dir, registry } = await rig(t);
  const first = new HostBridge(registry, { dir, self: null, replaceLive: true });
  await first.start();
  const path = first.socketPath("mac");

  const second = new HostBridge(registry, { dir, self: null });
  assert.deepEqual(await second.start(), { live: ["mac"] });
  await second.close();
  assert.equal(await hello(path), HELLO, "the first bridge keeps answering after the second closes");

  const restarted = new HostBridge(registry, { dir, self: null, replaceLive: true });
  await restarted.start();
  await first.close();
  assert.equal(await hello(path), HELLO, "the first bridge's close leaves the socket of the bridge that replaced it");
  await restarted.close();
  await assert.rejects(stat(path), "a bridge's close removes the socket it put there");

  await writeFile(path, "");
  const fresh = new HostBridge(registry, { dir, self: null });
  assert.deepEqual(await fresh.start(), { live: [] });
  t.after(() => fresh.close());
  assert.equal(await hello(path), HELLO, "a file no process answers on is replaced");
});
