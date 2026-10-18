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
import { applyRosterUpdate, HostCatalogs, MIRROR_DIR, rosterMerge } from "../src/host-catalogs.ts";
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
  const internal = hosts as unknown as { remotes: Map<string, { rows: Map<string, SessionSummary>; subscribed: boolean; listed: boolean }> };
  internal.remotes.get("box")!.rows = new Map(rows.map(candidate => [candidate.sessionFile ?? candidate.sessionId, candidate]));
  internal.remotes.get("box")!.subscribed = true;
  internal.remotes.get("box")!.listed = true;
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

test("roster updates move the rows with no list: a new session joins, a changed one updates, a removed one is saved, and an unplaced removal asks for a roster list", () => {
  const start = new Map([["/s/a.jsonl", row("a", true, { sessionFile: "/s/a.jsonl" })], ["/s/b.jsonl", row("b", false, { sessionFile: "/s/b.jsonl" })]]);
  const agents = new Map<string, string>();
  const joined = applyRosterUpdate(start, agents, { changed: [{ agentId: "c", status: "running", summary: { ...row("c", true, { sessionFile: "/s/c.jsonl" }), activity: "working" } }] });
  assert.deepEqual([joined.unknown, [...joined.rows.keys()].sort()], [false, ["/s/a.jsonl", "/s/b.jsonl", "/s/c.jsonl"]]);
  assert.equal(joined.rows.get("/s/c.jsonl")?.rosterStatus, "running");
  const stopped = applyRosterUpdate(joined.rows, agents, { removed: ["c"] });
  assert.deepEqual([stopped.unknown, stopped.rows.get("/s/c.jsonl")?.activeSessionId, stopped.rows.get("/s/c.jsonl")?.activity], [false, undefined, "idle"]);
  assert.equal(stopped.rows.get("/s/c.jsonl")?.messageCount, 3, "a saved row keeps what the list said");
  assert.equal(applyRosterUpdate(start, new Map(), { removed: ["a"] }).rows.get("/s/a.jsonl")?.activeSessionId, undefined, "a top-level agent id is its session id");
  assert.equal(applyRosterUpdate(start, new Map(), { removed: ["parent#7"] }).unknown, true);
  assert.equal(applyRosterUpdate(start, new Map(), { changed: [], resync: true }).unknown, true);
});

test("a roster list lays live rows over the rows: one that left the roster is saved, and one that joined is added, with no full list", () => {
  const rows = new Map([["/s/a.jsonl", row("a", true, { sessionFile: "/s/a.jsonl" })], ["/s/b.jsonl", row("b", false, { sessionFile: "/s/b.jsonl" })]]);
  const next = rosterMerge(rows, [row("b", true, { sessionFile: "/s/b.jsonl" }), row("d", true, { sessionFile: "/s/d.jsonl" })]);
  assert.deepEqual([...next.entries()].map(([key, value]) => [key, value.activeSessionId ?? null]).sort(), [["/s/a.jsonl", null], ["/s/b.jsonl", "a-b"], ["/s/d.jsonl", "a-d"]]);
});
