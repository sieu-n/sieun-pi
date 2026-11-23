/**
 * The host routes and the caches as rows of chat.sqlite (server/kept-json.ts): each file renders back byte for byte, a write queues only
 * the rows that changed, and the files of the release before the move import once.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/kept-json.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChatDb, type Stmt } from "../../server/chat-db.ts";
import { drained } from "../../server/disk.ts";
import { MultiHost, ROUTES_FILE } from "../../server/host/multi-host.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import { JsonMove } from "../../server/json-move.ts";
import { CACHE_KIND, HOST_ROUTES_KIND, KeptJson, type SplitKind } from "../../server/kept-json.ts";
import { RelayHost } from "../../server/host/relay-host.ts";
import { FakeRelay } from "./fake-relay.ts";
import { start, until } from "./helpers.ts";

const dir = () => mkdtempSync(join(tmpdir(), "kept-json-"));
const row = (id: string, updatedAt: number, box = "metal") => ({ id, name: id, updatedAt, archived: false, box });
const indented = (value: unknown) => `${JSON.stringify(value, null, 1)}\n`;

/** A DB with the kind's tables and a KeptJson over it whose writes are counted. */
function kept(kind: SplitKind, file = join(dir(), "chat.sqlite")) {
  const chat = new ChatDb(file, { offThread: false });
  for (const step of kind.migrations) chat.db.exec(step);
  const writes: Stmt[][] = [];
  const write = chat.write.bind(chat);
  chat.write = (stmts, label) => {
    writes.push([...stmts]);
    return write(stmts, label);
  };
  return { chat, kept: new KeptJson(chat, kind), writes };
}

test("every shape renders back byte for byte, a group that does not fit stays whole, and no key is lost", async () => {
  const { chat, kept: store } = kept(CACHE_KIND);
  const cases: [string, unknown][] = [
    ["cache/boards.json", { "10": { a: 1 }, "2": null, b: [1, 2], __proto__x: 1 }],
    ["cache/step-owners.json", {}],
    ["cache/threads.json", { threads: [row("t1", 3), row("t2", 2)], trees: [["t1", { updatedAt: 3, nodes: [] }]] }],
    ["cache/threads.json", { threads: [row("t1", 3), row("t1", 2)], trees: [] }],
    ["cache/first-sends.json", { "t1:1": { to: 4 } }],
    ["cache/first-sends.json", { v: 2, scans: { "t1:1": { to: 4, first: 2 } } }],
    ["cache/agent-refs.json", { v: 2, refs: { t1: { host: "metal", ref: { agent: "ag_a" } } } }],
    ["relay/mac.json", { feedAfter: 7 }],
    ["search/meili.json", { v: 3, cursors: { metal: "12" } }],
  ];
  const proto = JSON.parse('{"__proto__": {"x": 1}, "y": 2}') as unknown;
  cases.push(["cache/feed-seen-dm.json", proto]);
  for (const [file, value] of cases) {
    await store.write(file, value);
    assert.equal(CACHE_KIND.dump(chat.db, file), indented(value), file);
    assert.equal(JSON.stringify(store.read(file)), JSON.stringify(value), file);
    assert.equal(CACHE_KIND.count(chat.db, file), CACHE_KIND.records(file, indented(value)), file);
  }
  assert.deepEqual(Object.keys(store.read("cache/feed-seen-dm.json") as object), ["__proto__", "y"]);
  const head = chat.db.prepare("SELECT head, groups FROM cache_heads WHERE file = 'cache/threads.json'").get() as { head: string; groups: string };
  assert.deepEqual([JSON.parse(head.head).threads.length, JSON.parse(head.groups)], [2, [{ path: ["trees"], by: "pair" }]], "two threads with one id stay whole in the head row");
  await chat.close();
});

test("a write queues only the rows that changed, and an order row only when the order changed", async () => {
  const { chat, kept: store, writes } = kept(HOST_ROUTES_KIND);
  const routes = { v: 1, threads: { t1: "metal", t2: "metal" }, rows: { metal: { live: [row("t1", 2), row("t2", 1)] } } };
  await store.write(ROUTES_FILE, routes);
  assert.equal(writes.length, 1);
  await store.write(ROUTES_FILE, structuredClone(routes));
  assert.equal(writes.length, 1, "the same routes write nothing");
  routes.rows.metal.live[1]!.name = "renamed";
  await store.write(ROUTES_FILE, routes);
  assert.deepEqual(writes.at(-1)!.map(s => s.params?.[2]), ["t2"], "one changed row is one statement");
  routes.rows.metal.live = [row("t2", 5), row("t1", 2)];
  (routes.threads as Record<string, string>).t3 = "mac";
  await store.write(ROUTES_FILE, routes);
  const sql = writes.at(-1)!.map(s => s.sql.split(" (")[0]);
  assert.deepEqual(sql.sort(), [
    "INSERT OR REPLACE INTO host_routes_orders", "INSERT OR REPLACE INTO host_routes_orders",
    "INSERT OR REPLACE INTO host_routes_parts", "INSERT OR REPLACE INTO host_routes_parts",
  ], "the new route, the changed row and the two orders that changed");
  assert.equal(HOST_ROUTES_KIND.dump(chat.db, ROUTES_FILE), `${JSON.stringify(routes)}\n`);
  routes.rows.metal.live = [row("t1", 2)];
  await store.write(ROUTES_FILE, routes);
  assert.equal(HOST_ROUTES_KIND.dump(chat.db, ROUTES_FILE), `${JSON.stringify(routes)}\n`);
  assert.equal(HOST_ROUTES_KIND.count(chat.db, ROUTES_FILE), 4);
  await chat.close();
});

test("host-routes.json imports once, a second boot imports nothing, and the routes and their export follow each thread list", async () => {
  const data = dir();
  const old = { v: 1, threads: { gone: "mac" }, rows: { mac: { live: [row("gone", 1, "mac")] } } };
  writeFileSync(join(data, ROUTES_FILE), `${JSON.stringify(old)}\n`);
  let chat = new ChatDb(join(data, "chat.sqlite"));
  let move = new JsonMove(chat, data, HOST_ROUTES_KIND, { exportDelayMs: 10 });
  assert.deepEqual(move.open(), { kind: "host-routes", imported: [ROUTES_FILE], records: 2, known: 0, archived: [] });
  const fixture = new FixtureHost();
  const host = new MultiHost("metal", [{ box: "metal", label: "metal", host: fixture }], data, { box: "metal", platform: "linux", home: "/", projects: [], agentsDir: "/" });
  host.keep(new KeptJson(chat, HOST_ROUTES_KIND, move));
  assert.equal(host.boxOf("gone"), "metal", "a route to a box this server does not have goes to its own");
  const made = await host.create({ name: "new one" });
  const listed = await host.threads();
  await new Promise(resolve => setImmediate(resolve));
  await chat.written();
  await move.flushExports();
  await drained();
  const file = JSON.parse(readFileSync(join(data, ROUTES_FILE), "utf8")) as typeof old;
  assert.equal(file.threads[made.id as "gone"], "metal");
  assert.deepEqual(file.rows.mac, old.rows.mac, "a box that did not answer keeps its rows");
  assert.equal((file.rows as Record<string, { live: unknown[] }>).metal!.live.length, listed.length);
  assert.deepEqual(move.check().items, []);
  await chat.close();

  chat = new ChatDb(join(data, "chat.sqlite"));
  move = new JsonMove(chat, data, HOST_ROUTES_KIND);
  assert.deepEqual(move.open().imported, [], "the boot after an export knows the file it wrote");
  const again = new MultiHost("metal", [{ box: "metal", label: "metal", host: new FixtureHost() }], data, { box: "metal", platform: "linux", home: "/", projects: [], agentsDir: "/" });
  again.keep(new KeptJson(chat, HOST_ROUTES_KIND, move));
  assert.equal((again as unknown as { routes: typeof old }).routes.threads[made.id as "gone"], "metal");
  await chat.close();
});

test("a cache file an older release wrote after a rollback imports again", async () => {
  const data = dir();
  mkdirSync(join(data, "cache"));
  writeFileSync(join(data, "cache", "boards.json"), indented({ a: 1 }));
  const chat = new ChatDb(join(data, "chat.sqlite"), { offThread: false });
  new JsonMove(chat, data, CACHE_KIND).open();
  writeFileSync(join(data, "cache", "boards.json"), indented({ a: 1, rollback: 2 }));
  const move = new JsonMove(chat, data, CACHE_KIND);
  assert.deepEqual(move.open().imported, ["cache/boards.json"]);
  assert.deepEqual(new KeptJson(chat, CACHE_KIND).read("cache/boards.json"), { a: 1, rollback: 2 });
  writeFileSync(join(data, "cache", "boards.json"), "{ not json");
  assert.deepEqual(new JsonMove(chat, data, CACHE_KIND).open().imported, ["cache/boards.json"]);
  assert.deepEqual(new KeptJson(chat, CACHE_KIND).read("cache/boards.json"), { a: 1, rollback: 2 }, "a file that is not JSON leaves the rows as they were");
  await chat.close();
});

test("with APPS_CHAT_DB_KINDS naming the cache kind, the server keeps its caches in chat.sqlite and a restart imports nothing", async () => {
  const data = dir();
  const before = process.env.APPS_CHAT_DB_KINDS;
  process.env.APPS_CHAT_DB_KINDS = "cache";
  try {
    const first = await start({ dataDir: data });
    assert.ok(first.app.store.caches, "the store keeps its caches in chat.sqlite");
    await first.close();
    const rows = new KeptJson(new ChatDb(join(data, "chat.sqlite"), { offThread: false }), CACHE_KIND);
    const threads = rows.read("cache/threads.json") as { threads: { id: string }[] } | undefined;
    assert.ok(threads && threads.threads.length > 0, "the thread list cache is in chat.sqlite");
    const lines: string[] = [];
    const second = await start({ dataDir: data, log: line => lines.push(line) });
    try {
      assert.deepEqual(lines.filter(line => line.includes("cache imported")), [], "the second boot imports no cache file");
      // A file can be behind while its export waits, but none is unknown to the DB or holds other records than an export of the same rows.
      const check = await second.get<{ items: { state: string }[] }>("/api/db/cache/check");
      assert.deepEqual(check.items.filter(item => item.state !== "behind"), []);
    } finally {
      await second.close();
    }
  } finally {
    if (before === undefined) delete process.env.APPS_CHAT_DB_KINDS;
    else process.env.APPS_CHAT_DB_KINDS = before;
  }
});

test("a relay's feed cursor kept in chat.sqlite answers its welcome and moves with each acked row", async () => {
  const data = dir();
  const chat = new ChatDb(join(data, "chat.sqlite"), { offThread: false });
  for (const step of CACHE_KIND.migrations) chat.db.exec(step);
  const kept = new KeptJson(chat, CACHE_KIND);
  await kept.write("relay/mac.json", { feedAfter: 7 });
  const relay = new FakeRelay("mac", "token");
  await relay.listening;
  const client = new RelayHost({ box: "mac", url: relay.url, token: "token", dataDir: data, redialWait: () => 20 });
  client.kept = kept;
  client.onFeed = async () => {};
  try {
    client.start();
    await until(async () => client.state().state, state => state === "up");
    assert.deepEqual(relay.welcomes, [7]);
    relay.feed({ seq: 8, thread: "t", conversation: 1, entry: 8, toolCallId: "c8", toolName: "send_message", requestId: "m:t:c8", text: "x", at: 1 });
    await until(async () => relay.acks, acks => acks.includes(8));
    await chat.written();
    assert.deepEqual(new KeptJson(chat, CACHE_KIND).read("relay/mac.json"), { feedAfter: 8 });
  } finally {
    await client.close();
    await relay.close();
    await chat.close();
  }
});
