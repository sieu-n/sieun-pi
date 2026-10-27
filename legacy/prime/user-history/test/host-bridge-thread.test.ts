// Guards 10-19 on us-metal02: with the bridge sockets on the chat service's main thread, which read 100% busy, a get_state through mac.sock
// took 0.27 to 3.6 s against 0.19 s straight to the Mac relay (~/work/mac-feel-check).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BridgeThread } from "../src/host-bridge-thread.ts";
import { HostBridge, type HostsRegistry } from "../src/hosts.ts";

// The relay and the client run in processes of their own, so a blocked main thread here can hold up only the bridge.
const RELAY = `require("node:http").createServer((q, s) => { s.statusCode = 404; s.end(); }).on("upgrade", (q, socket) => {
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: prime-daemon\\r\\n\\r\\n");
  let buffer = "";
  socket.on("data", chunk => { buffer += chunk; for (let at; (at = buffer.indexOf("\\n")) >= 0; buffer = buffer.slice(at + 1)) {
    const { id } = JSON.parse(buffer.slice(0, at)); socket.write(JSON.stringify({ type: "response", id, success: true }) + "\\n"); } });
}).listen(0, "127.0.0.1", function () { process.stdout.write(String(this.address().port) + "\\n"); });`;
// One get_state every 50 ms for 4 s; prints "ready" at the first answer, then each command's send time and round trip.
const CLIENT = `const socket = require("node:net").createConnection(process.argv[1]); const sent = new Map(); const done = []; let n = 0, buffer = "";
socket.on("data", chunk => { buffer += chunk; for (let at; (at = buffer.indexOf("\\n")) >= 0; buffer = buffer.slice(at + 1)) {
  const { id } = JSON.parse(buffer.slice(0, at)); if (!done.length) process.stdout.write("ready\\n"); done.push([sent.get(id), Date.now() - sent.get(id)]); } });
const ask = () => { const id = String(++n); sent.set(id, Date.now()); socket.write(JSON.stringify({ type: "command", id, command: { type: "get_state" } }) + "\\n"); };
socket.on("connect", () => { ask(); const timer = setInterval(ask, 50); setTimeout(() => { clearInterval(timer); setTimeout(() => { process.stdout.write(JSON.stringify(done) + "\\n"); process.exit(0); }, 4000); }, 4000); });`;

test("a Mac read through the bridge socket answers while the main thread is blocked", async t => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-thread-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const relay = spawn(process.execPath, ["-e", RELAY], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => relay.kill());
  const port = Number(await new Promise<string>(resolve => relay.stdout.once("data", chunk => resolve(String(chunk).trim()))));
  writeFileSync(join(dir, "token"), "t");
  const registry: HostsRegistry = { version: 1, hosts: [{ name: "mac", hostname: "mac-test", address: "127.0.0.1", relayPort: port, token: `file:${join(dir, "token")}`,
    daemonSocket: "/nonexistent/daemon.sock", ssh: null, roles: {} }] };
  const thread = new BridgeThread(registry, { dir: join(dir, "bridges"), self: null, replaceLive: true });
  await thread.start();
  t.after(() => thread.close());
  const client = spawn(process.execPath, ["-e", CLIENT, new HostBridge(registry, { dir: join(dir, "bridges"), self: null }).socketPath("mac")], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => client.kill());
  let out = "";
  client.stdout.on("data", chunk => { out += chunk; });
  for (let waited = 0; !out.includes("ready") && waited < 20_000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
  const blockedAt = Date.now();
  while (Date.now() - blockedAt < 3000) { /* the main thread busy, as the chat service's was */ }
  await new Promise(resolve => client.once("exit", resolve));
  const answers = JSON.parse(out.slice(out.indexOf("\n") + 1)) as [number, number][];
  const inBlock = answers.filter(([at]) => at > blockedAt + 200 && at < blockedAt + 2800).map(([, ms]) => ms);
  assert.ok(inBlock.length >= 20, `${inBlock.length} reads sent inside the block`);
  assert.ok(Math.max(...inBlock) < 1000, `slowest read sent inside a 3000 ms block took ${Math.max(...inBlock)} ms`);
});
