// Guards 10-18 from 13:10Z, when the owner's MacBook Pro was offline on the tailnet with its lid closed: the chat service on us-metal02 dialed
// the Mac's relay every 15 s and logged "relay mac (100.66.173.18:7790) did not answer in 10000 ms", and a page whose URL named a Mac thread got
// its sidebar only after the thread's first frame, which waited 15 s per relay read of the thread's file, twice (30.0 s on a scratch serve with
// an unanswering Mac relay). Cold loads of the box page then showed an empty sidebar for 13.4 s, then 26 to 28 s.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { SessionSummary } from "prime-agent";

const home = mkdtempSync(join(tmpdir(), "mac-offline-first-frame-"));
process.env.HOME = home;
const { Catalog } = await import("../src/chat-catalog.ts");
const { ChatLabels } = await import("../src/chat-labels.ts");
const { ChatReadState } = await import("../src/chat-read-state.ts");
const { HostCatalogs, copyPath, mirrorPath } = await import("../src/host-catalogs.ts");
const { HostReach } = await import("../src/host-reach.ts");
const { HostBridge, parseHosts, selfHost } = await import("../src/hosts.ts");
const { ThreadOrigins } = await import("../src/thread-origin.ts");

const MAC_THREAD = "01a14e9a-0000-7000-8000-000000000001";
const NO_COPY = "01a14e9a-0000-7000-8000-000000000002";
const macFile = (id: string) => `/Users/sieunpark/.prime/agent/sessions/${id}.jsonl`;
const macRow = (id: string): SessionSummary => ({ sessionId: id, cwd: "/Users/sieunpark", sessionFile: macFile(id), messageCount: 3, name: `mac ${id.slice(-1)}`,
  modified: "2026-10-18T13:00:00.000Z", lastActivityAt: "2026-10-18T13:00:00.000Z" }) as unknown as SessionSummary;
const tailscale = (online: boolean) => JSON.stringify({ Peer: { "nodekey:1": { TailscaleIPs: ["127.0.0.1"], Online: online, LastSeen: "2026-10-18T13:10:00Z" } } });

/** A relay that takes every connection and never answers, as the Mac's does through Tailscale while the Mac sleeps; `refuse` closes the port. */
async function relay(t: TestContext): Promise<{ port: number; dials: () => number }> {
  let dials = 0;
  const held = new Set<Socket>();
  const server: Server = createServer(socket => { dials++; held.add(socket); socket.on("error", () => {}); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of held) socket.destroy(); server.close(); });
  return { port: (server.address() as { port: number }).port, dials: () => dials };
}

/** The Mac in hosts.json behind `relayPort`, its disk copy of the session list, a copy of one thread's file, and the box's catalog over it. */
async function boxWithMac(t: TestContext, relayPort: number, online: boolean) {
  const dir = mkdtempSync(join(home, "box-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(home, ".config/sieun-pi/relay-tokens"), { recursive: true });
  writeFileSync(join(home, ".config/sieun-pi/relay-tokens/mac"), "token\n");
  const registry = parseHosts({ version: 1, hosts: [
    { name: "us-metal02", hostname: "us-metal02", address: "127.0.0.2", relayPort: 1, token: "file:relay-tokens/mac", daemonSocket: join(dir, "box.sock"), roles: {} },
    { name: "mac", hostname: "Sieuns-MacBook-Pro", address: "127.0.0.1", relayPort, token: "file:relay-tokens/mac", daemonSocket: "/tmp/mac-daemon.sock", roles: {} }] });
  const self = selfHost(registry, "us-metal02");
  const mac = registry.hosts[1]!;
  assert.ok(copyPath("mac").startsWith(home + "/"), `the Mac copy ${copyPath("mac")} lies outside the test's HOME`);
  mkdirSync(join(home, ".cache/sieun-pi/hosts"), { recursive: true });
  writeFileSync(copyPath("mac"), JSON.stringify({ version: 1, fullAt: Date.now() - 3 * 3600_000, rows: [macRow(MAC_THREAD), macRow(NO_COPY)] }));
  const copy = mirrorPath(mac, macFile(MAC_THREAD));
  mkdirSync(join(copy, ".."), { recursive: true });
  writeFileSync(copy, JSON.stringify({ type: "session", version: 3, id: MAC_THREAD, timestamp: "2026-10-18T12:00:00.000Z", cwd: "/Users/sieunpark" }) + "\n");
  const bridge = new HostBridge(registry, { dir: join(dir, "bridges"), self });
  await bridge.start();
  t.after(() => bridge.close());
  const reach = new HostReach({ addressOf: name => registry.hosts.find(host => host.name === name)?.address, status: async () => tailscale(online), log: () => {} });
  const hosts = new HostCatalogs(registry, bridge, self, () => {}, true, reach);
  const reads = new ChatReadState(join(dir, "read-state.json"));
  const labels = new ChatLabels(join(dir, "labels.json"));
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const chats = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog(join(dir, "box.sock"), reads, labels, chats, new ThreadOrigins({ ids: async () => [] }), hosts);
  t.after(() => catalog.close());
  let connected = false;
  t.mock.method(catalog.client, "reconnect", async () => { connected = true; });
  t.mock.method(catalog.client, "waitForHello", async () => ({ appVersion: "0.9.8" }));
  t.mock.method(catalog.client, "request", async (command: { type: string }) => command.type === "list" ? { success: true, data: { sessions: [] } } : { success: true, data: { jobs: [] } });
  Object.defineProperty(catalog.client as unknown as object, "isConnected", { get: () => connected });
  await hosts.loaded();
  await catalog.refresh();
  return { catalog, hosts, mac, copy };
}

const timed = async <T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const started = performance.now();
  const value = await work();
  return { value, ms: performance.now() - started };
};

test("with the Mac offline on Tailscale, a Mac thread's first page reads this box's copy at once, and its copy never dials the relay", async (t: TestContext) => {
  const { port, dials } = await relay(t);
  const { catalog, hosts, mac, copy } = await boxWithMac(t, port, false);
  const frame = await timed(() => catalog.event());
  assert.ok(frame.ms < 1000, `the sidebar frame took ${Math.round(frame.ms)} ms`);
  assert.deepEqual(frame.value.sessions.filter(row => row.host === "mac").map(row => row.id).sort(), [MAC_THREAD, NO_COPY], "the Mac's last known rows are listed");
  // The two awaits of a thread's first page (ChatThreads.start): the catalog row, which brings the file copy up to date, and the file itself.
  const summary = await timed(() => catalog.summary(MAC_THREAD));
  assert.ok(summary.ms < 1000, `the summary took ${Math.round(summary.ms)} ms`);
  const file = await timed(() => catalog.localFile(summary.value!));
  assert.ok(file.ms < 1000, `the file copy took ${Math.round(file.ms)} ms`);
  assert.equal(file.value, copy);
  // A thread with no copy on this box fails at once with the reason, so its feed shows the error instead of a 15 s wait.
  const missing = await timed(() => hosts.mirror(mac, macFile(NO_COPY)).then(() => "read", (error: Error) => error.message));
  assert.ok(missing.ms < 1000, `the missing copy took ${Math.round(missing.ms)} ms`);
  assert.match(missing.value, /mac is offline \(Tailscale last seen .*\); this box has no copy/);
  assert.equal(dials(), 0, "nothing dialed the Mac's relay");
  assert.match(hosts.status()[0]!.error ?? "", /mac is offline/);
});

test("with the Mac on the tailnet but its relay refusing, the failed read is the last word: the next read gives the copy at once and reads again behind it", async (t: TestContext) => {
  const closed = createServer();
  await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve));
  const port = (closed.address() as { port: number }).port;
  await new Promise<void>(resolve => closed.close(() => resolve()));
  const { hosts, mac, copy } = await boxWithMac(t, port, true);
  await assert.rejects(hosts.mirror(mac, macFile(MAC_THREAD)), /ECONNREFUSED/);
  const again = await timed(() => hosts.mirror(mac, macFile(MAC_THREAD)));
  assert.ok(again.ms < 1000, `the second read took ${Math.round(again.ms)} ms`);
  assert.equal(again.value, copy);
});
