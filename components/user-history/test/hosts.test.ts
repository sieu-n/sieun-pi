import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
// @ts-expect-error The relay is plain JavaScript with no types, so it runs on a box with nothing but node.
import { createRelay, daemonWorking } from "../../prime-relay/relay.mjs";
import { HostBridge, hostHealth, listHostDir, parseHosts, readHostFile, roleUrl, selfHost, type Host, type HostsRegistry } from "../src/hosts.ts";

const TOKEN = "a".repeat(64);
let dir = "";
let relay: { close(callback: () => void): void; address(): { port: number } } | null = null;
let daemon: ReturnType<typeof createServer> | null = null;
let registry: HostsRegistry;
let remote: Host;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "hosts-test-"));
  await mkdir(join(dir, "sessions"));
  await writeFile(join(dir, "sessions", "s.jsonl"), "line one\nline two\n");
  await writeFile(join(dir, "secret"), "outside");
  await writeFile(join(dir, "token"), `${TOKEN}\n`);
  const daemonSocket = join(dir, "daemon.sock");
  // A daemon stand-in: greets like the real one and echoes every line back.
  daemon = createServer(socket => { socket.write("{\"type\":\"daemon_hello\"}\n"); socket.on("data", chunk => socket.write(chunk)); });
  await new Promise<void>(resolve => daemon!.listen(daemonSocket, resolve));
  relay = createRelay({ listen: "127.0.0.1", port: 0, daemonSocket, roots: [join(dir, "sessions")], token: TOKEN });
  await new Promise<void>(resolve => (relay as unknown as { listen(port: number, host: string, cb: () => void): void }).listen(0, "127.0.0.1", resolve));
  registry = parseHosts({ version: 1, hosts: [
    { name: "box", hostname: "box-host", address: "127.0.0.1", relayPort: relay!.address().port, token: `file:${join(dir, "token")}`, daemonSocket: "/tmp/x.sock", ssh: null,
      roles: { pool: { port: 7781 } } },
    { name: "here", hostname: "here-host.local", address: "127.0.0.1", relayPort: 1, token: "file:t", daemonSocket: daemonSocket, ssh: null, roles: {} },
  ] });
  remote = registry.hosts[0]!;
});

after(async () => {
  await new Promise<void>(resolve => relay!.close(() => resolve()));
  await new Promise<void>(resolve => daemon!.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

test("parseHosts refuses a role on two hosts, a duplicate name and a token that is not a file reference", () => {
  const host = { name: "a", hostname: "a", address: "100.1.1.1", relayPort: 7790, token: "file:x", daemonSocket: "/s", ssh: null, roles: { wiki: { port: 1 } } };
  assert.throws(() => parseHosts({ version: 1, hosts: [host, { ...host, name: "b" }] }), /role wiki is on a and b/);
  assert.throws(() => parseHosts({ version: 1, hosts: [host, host] }), /listed twice/);
  assert.throws(() => parseHosts({ version: 1, hosts: [{ ...host, token: "abc" }] }), /file:<path>/);
  assert.equal(roleUrl(parseHosts({ version: 1, hosts: [host] }), "wiki"), "http://100.1.1.1:1");
  assert.equal(roleUrl(parseHosts({ version: 1, hosts: [{ ...host, roles: { wiki: { port: 1, url: "https://box.ts.net:5176/" } } }] }), "wiki"), "https://box.ts.net:5176");
  assert.equal(roleUrl(parseHosts({ version: 1, hosts: [host] }), "chat"), null);
  assert.throws(() => parseHosts({ version: 1, hosts: [{ ...host, roles: { wiki: { port: 1, url: "box" } } }] }), /http\(s\) URL/);
});

test("selfHost matches the short hostname, so a .local suffix still finds this machine", () => {
  assert.equal(selfHost(registry, "Here-Host")?.name, "here");
  assert.equal(selfHost(registry, "elsewhere"), null);
});

test("the relay answers health with the token and refuses without it", async () => {
  const health = await hostHealth(remote);
  assert.equal(health.ok && health.daemon, "answering");
  const refused = await hostHealth({ ...remote, token: `file:${join(dir, "secret")}` });
  assert.deepEqual([refused.ok, !refused.ok && refused.error], [false, "relay answered 401"]);
});

test("reads go through the relay from an offset, list a folder, and stop at the roots", async () => {
  const file = join(dir, "sessions", "s.jsonl");
  assert.equal((await readHostFile(remote, file)).bytes.toString(), "line one\nline two\n");
  const tail = await readHostFile(remote, file, { from: 9 });
  assert.deepEqual([tail.bytes.toString(), tail.size], ["line two\n", 18]);
  assert.deepEqual([(await readHostFile(remote, file, { from: 18 })).bytes.length], [0]);
  assert.deepEqual((await listHostDir(remote, join(dir, "sessions"))).map(entry => entry.name), ["s.jsonl"]);
  await assert.rejects(readHostFile(remote, join(dir, "secret")), /403/);
  await assert.rejects(readHostFile(remote, join(dir, "sessions", "..", "secret")), /403/);
});

test("a bridge socket carries bytes both ways to the remote daemon socket, and the self host maps to its own socket", async () => {
  const bridge = new HostBridge(registry, { dir: join(dir, "bridge"), self: registry.hosts[1]! });
  await bridge.start();
  try {
    assert.equal(bridge.socketPath("here"), registry.hosts[1]!.daemonSocket);
    const socket = createConnection(bridge.socketPath("box"));
    const received: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    socket.write("{\"type\":\"list\"}\n");
    const expected = "{\"type\":\"daemon_hello\"}\n{\"type\":\"list\"}\n";
    for (let wait = 0; Buffer.concat(received).toString() !== expected && wait < 100; wait++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(Buffer.concat(received).toString(), expected);
    socket.destroy();
  } finally { await bridge.close(); }
  await assert.rejects(readFile(join(dir, "bridge", "box.sock")), /ENOENT/);
});

test("daemonWorking reads the daemon's roster through a protocol 7 envelope and is true only while a session works", async () => {
  const path = join(dir, "roster.sock");
  let rows: object[] = [];
  const commands: { type?: string; command?: { type?: string } }[] = [];
  const server = createServer(socket => {
    socket.write(JSON.stringify({ type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 } }) + "\n");
    socket.on("data", (chunk: Buffer) => {
      const command = JSON.parse(chunk.toString());
      commands.push(command);
      socket.write(JSON.stringify({ type: "response", id: command.id, success: true, data: { sessions: rows } }) + "\n");
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    rows = [{ sessionId: "a", activity: "idle" }];
    assert.equal(await daemonWorking(path), false);
    rows = [{ sessionId: "a", activity: "idle" }, { sessionId: "b", activity: "working" }];
    assert.equal(await daemonWorking(path), true);
    assert.deepEqual([commands[0]?.type, commands[0]?.command?.type], ["command", "list"]);
    assert.equal(await daemonWorking(join(dir, "missing.sock")), null);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
