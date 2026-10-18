import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { DaemonClient, SessionSummary } from "prime-agent";
// @ts-expect-error The relay is plain JavaScript with no types, so it runs on a box with nothing but node.
import { createRelay } from "../../prime-relay/relay.mjs";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { HostCatalogs, MIRROR_DIR } from "../src/host-catalogs.ts";
import { HostBridge, parseHosts } from "../src/hosts.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const row = (id: string, live: boolean, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ sessionId: id, cwd: "/tmp", sessionFile: `/nowhere/${id}.jsonl`, messageCount: 3, created: "2026-10-18T00:00:00Z", ...(live ? { activeSessionId: `a-${id}` } : {}), ...extra }) as SessionSummary;

/** HostCatalogs with its network parts replaced: the box lists `rows`, and its client is a marker object. */
function stubHosts(rows: SessionSummary[]) {
  const registry = parseHosts({ version: 1, hosts: [
    { name: "mac", hostname: "mac-host", address: "127.0.0.1", relayPort: 1, token: "file:t", daemonSocket: "/tmp/mac.sock", ssh: null, roles: {} },
    { name: "box", hostname: "box-host", address: "127.0.0.1", relayPort: 1, token: "file:t", daemonSocket: "/tmp/box.sock", ssh: null, roles: {} },
  ] });
  const hosts = new HostCatalogs(registry, new HostBridge(registry, { dir: "/tmp/bridge-test", self: registry.hosts[0]! }), registry.hosts[0]!);
  const boxClient = hosts.client("box")!;
  const internal = hosts as unknown as { remotes: Map<string, { rows: SessionSummary[]; subscribed: boolean }> };
  internal.remotes.get("box")!.rows = rows;
  internal.remotes.get("box")!.subscribed = true;
  hosts.start = () => {};
  return { hosts, boxClient, remote: internal.remotes.get("box")! };
}

function catalog(t: TestContext, hosts: HostCatalogs) {
  const reads = new ChatReadState("unused");
  const labels = new ChatLabels("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const ids = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const result = new Catalog("/tmp/mac.sock", reads, labels, ids, new ThreadOrigins({ ids: async () => [] }), hosts);
  Object.defineProperty(result.client, "isConnected", { get: () => true });
  t.mock.method(result.client, "reconnect", async () => {});
  t.mock.method(result.client, "waitForHello", async () => ({ appVersion: "0.9.8", serverCapabilities: [] }));
  t.mock.method(result.client, "request", async (command: { type: string }) => command.type === "list"
    ? { success: true, data: { sessions: [{ ...row("here", true), sessionFile: undefined }] } } : { success: true, data: { jobs: [] } });
  t.after(() => result.close());
  return result;
}

test("the catalog lists every box, tags each row with its host, and routes a command to the daemon that runs the session", async t => {
  const { hosts, boxClient } = stubHosts([row("there", true), row("saved-there", false)]);
  const c = catalog(t, hosts);
  await c.refresh();
  const rows = await c.rows();
  assert.deepEqual(rows.map(candidate => [candidate.id, candidate.host]).sort(), [["here", "mac"], ["saved-there", "box"], ["there", "box"]],
    "the box's saved row is listed though its file is on the box's disk");
  assert.equal(c.clientFor("a-there"), boxClient as DaemonClient);
  assert.equal(c.clientFor("there"), boxClient as DaemonClient);
  assert.equal(c.clientFor("a-here"), c.client);
  assert.equal(c.hostOf("there"), "box");
  assert.equal(c.hostOf("here"), null);
  assert.equal(c.socketPathFor("box"), "/tmp/bridge-test/box.sock");
  assert.equal(c.socketPathFor("mac"), "/tmp/mac.sock");
  assert.equal(c.socketPathFor(null), "/tmp/mac.sock");
  assert.equal(c.isOtherHost("box"), true);
  assert.equal(c.isOtherHost("mac"), false);
  assert.equal(await c.localFile(row("here", true, { sessionFile: "/x/here.jsonl" })), "/x/here.jsonl");
});

test("a box whose daemon stopped answering keeps its rows as saved ones until it answers again", async t => {
  const { hosts, remote } = stubHosts([row("there", true)]);
  const c = catalog(t, hosts);
  await c.refresh();
  remote.subscribed = false;
  hosts.onChange();
  await new Promise(resolve => setImmediate(resolve));
  const there = (await c.rows()).find(candidate => candidate.id === "there");
  assert.equal(there?.host, "box");
  assert.equal(there?.kind, "saved");
});

test("mirror copies another box's session file through its relay and fetches only the bytes added since", async t => {
  const dir = await mkdtemp(join(tmpdir(), "host-mirror-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "sessions"));
  const file = join(dir, "sessions", "s.jsonl");
  await writeFile(file, "{\"a\":1}\n");
  await writeFile(join(dir, "token"), `${"b".repeat(64)}\n`);
  const relay = createRelay({ listen: "127.0.0.1", port: 0, daemonSocket: join(dir, "none.sock"), roots: [join(dir, "sessions")], token: "b".repeat(64) });
  await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => relay.close(() => resolve())));
  const registry = parseHosts({ version: 1, hosts: [{ name: "box-mirror-test", hostname: "box", address: "127.0.0.1", relayPort: relay.address().port,
    token: `file:${join(dir, "token")}`, daemonSocket: "/tmp/box.sock", ssh: null, roles: {} }] });
  const hosts = new HostCatalogs(registry, new HostBridge(registry, { dir: join(dir, "bridge"), self: null }), null);
  t.after(() => { hosts.close(); return rm(join(MIRROR_DIR, "box-mirror-test"), { recursive: true, force: true }); });
  const local = await hosts.mirror(registry.hosts[0]!, file);
  assert.equal(await readFile(local, "utf8"), "{\"a\":1}\n");
  await appendFile(file, "{\"b\":2}\n");
  assert.equal(await readFile(await hosts.mirror(registry.hosts[0]!, file), "utf8"), "{\"a\":1}\n{\"b\":2}\n");
  await writeFile(file, "{}\n");
  assert.equal(await readFile(await hosts.mirror(registry.hosts[0]!, file), "utf8"), "{}\n", "a shorter file on the box is fetched whole");
});
