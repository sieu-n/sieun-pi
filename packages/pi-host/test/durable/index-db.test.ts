/** An index from before the cost split gains the four cost columns and drops its derived rows, so the threads backfill them again. */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ThreadIndex } from "../../src/durable/index.ts";
import { openIndexReadOnly, readIndexRows, readUsageRows, snippetOf, snippetTerms, statusOf } from "../../src/durable/index-db.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-host-index-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("an index without the cost split is rebuilt, and a current one is not", () => {
  const path = join(dir, "index.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, model_id TEXT NOT NULL, thinking TEXT NOT NULL, cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, wake_active INTEGER NOT NULL DEFAULT 0, wake_at INTEGER, failed INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, preview TEXT NOT NULL DEFAULT '', children INTEGER NOT NULL DEFAULT 0, indexed_entry INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE usage (thread TEXT NOT NULL, conversation INTEGER NOT NULL, entry_id INTEGER NOT NULL, model TEXT NOT NULL, at INTEGER NOT NULL,
    input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cost REAL NOT NULL, PRIMARY KEY (thread, entry_id));
    INSERT INTO threads (id, name, provider, model_id, thinking, cwd, created_at, updated_at, indexed_entry) VALUES ('t1', 'old', 'anthropic', 'claude-opus-5-5', 'high', '/', 1, 1, 40);
    INSERT INTO usage VALUES ('t1', 1, 12, 'anthropic/claude-opus-5-5', 1, 10, 10, 0, 0, 0.5);`);
  old.close();

  const migrated = new ThreadIndex(path);
  assert.equal(migrated.rebuilt, true);
  assert.equal(migrated.indexedEntry("t1"), 0);
  migrated.close();
  const readBack = openIndexReadOnly(path);
  assert.deepEqual(readUsageRows(readBack, undefined).rows, [], "the rebuilt index drops the usage rows its threads backfill again");
  readBack.close();

  const again = new ThreadIndex(path);
  assert.equal(again.rebuilt, false);
  again.close();
});

test("a search returns one page with snippets and the exact count, and narrows to a conversation or to what one agent said", () => {
  const index = new ThreadIndex(join(dir, "search.sqlite"));
  index.insertThread({ id: "t2", name: "search", provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high", cwd: "/", createdAt: 1, updatedAt: 1 });
  const entries = Array.from({ length: 30 }, (_, i) => ({
    thread: "t2", conversation: i % 3 === 0 ? 2 : 1, entryId: i + 1, kind: i % 5 === 0 ? "agent.message" : i % 2 ? "pi.user" : "pi.assistant",
    author: i % 5 === 0 ? "t2:2" : i % 2 ? "owner" : "anthropic/claude-opus-5-5", at: 1000 + i, text: `relay check number ${i}`,
  }));
  index.addEntries("t2", entries, []);
  const page = index.search({ q: "relay", limit: 5, offset: 5, sort: "recent" });
  assert.equal(page.total, 30);
  assert.deepEqual(page.hits.map(hit => hit.entryId), [25, 24, 23, 22, 21]);
  assert.ok(page.hits.every(hit => hit.snippet.includes("<mark>relay</mark>")));
  assert.equal(index.search({ q: "relay", threads: ["t2"], conversation: 2 }).total, entries.filter(e => e.conversation === 2).length);
  const said = entries.filter(e => (e.kind === "agent.message" && e.author === "t2:2") || (e.kind !== "agent.message" && e.author !== "owner" && e.conversation === 2));
  assert.equal(index.search({ q: "relay", by: { thread: "t2", conversation: 2, id: "t2:2" }, limit: 100 }).total, said.length);
  assert.equal(index.search({ q: "relay", by: { thread: "other", conversation: 2, id: "t2:2" } }).total, entries.filter(e => e.kind === "agent.message").length);
  assert.equal(index.search({ q: "relay", from: "owner" }).total, entries.filter(e => e.author === "owner").length);
  index.close();
});

test("durable_index_read gives the rows after a cursor a page at a time, and reads a rebuilt index from its first row", () => {
  const index = new ThreadIndex(join(dir, "read.sqlite"));
  index.insertThread({ id: "t3", name: "read", provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high", cwd: "/", createdAt: 1, updatedAt: 1 });
  const entry = (i: number) => ({ thread: "t3", conversation: 1, entryId: i, kind: "pi.user", author: "owner", at: 1000 + i, text: `row ${i} `.padEnd(100, "x") });
  index.addEntries("t3", Array.from({ length: 10 }, (_, i) => entry(i + 1)), []);
  const first = index.read(undefined);
  assert.equal(first.more, false);
  assert.deepEqual(first.rows.map(row => row.entryId), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(first.rows[0], { thread: "t3", conversation: 1, entryId: 1, kind: "pi.user", author: "owner", at: 1001, text: entry(1).text });
  assert.deepEqual(index.read(first.cursor).rows, []);
  index.addEntries("t3", [entry(11)], []);
  assert.deepEqual(index.read(first.cursor).rows.map(row => row.entryId), [11]);
  index.close();

  const db = new DatabaseSync(join(dir, "read.sqlite"), { readOnly: true });
  const pages: number[][] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = readIndexRows(db, cursor, 350);
    pages.push(page.rows.map(row => row.entryId));
    cursor = page.cursor;
    if (!page.more) break;
  }
  assert.deepEqual(pages, [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11]]);
  assert.deepEqual(readIndexRows(db, "999").rows.length, 11, "a cursor past the last row means the index was rebuilt");
  db.close();
});

test("readUsageRows gives the usage rows after a cursor from a time on, and starts again from the first row once a row is deleted", () => {
  const path = join(dir, "usage-read.sqlite");
  const index = new ThreadIndex(path);
  const readUsage = (cursor: string | undefined, since?: number) => {
    const db = openIndexReadOnly(path);
    try { return readUsageRows(db, cursor, since); } finally { db.close(); }
  };
  index.insertThread({ id: "u1", name: "usage", provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high", cwd: "/", createdAt: 1, updatedAt: 1 });
  const usage = (entryId: number, at: number) => ({ thread: "u1", conversation: 1, entryId, model: "anthropic/claude-opus-5-5", at, input: 1, output: 2, cacheRead: 3,
    cacheWrite: 4, cost: 1.5, costInput: 0.1, costOutput: 0.2, costCacheRead: 0.3, costCacheWrite: 0.9 });
  index.addEntries("u1", [], [usage(1, 100), usage(2, 5000), usage(3, 6000)]);
  const first = readUsage(undefined, 1000);
  assert.equal(first.restart, true);
  assert.equal(first.more, false);
  assert.deepEqual(first.rows.map(row => row.entryId), [2, 3], "a row older than since is left out");
  assert.deepEqual(first.rows[0], usage(2, 5000));
  const quiet = readUsage(first.cursor, 1000);
  assert.deepEqual([quiet.rows, quiet.restart, quiet.cursor], [[], false, first.cursor]);
  index.addEntries("u1", [], [usage(4, 7000)]);
  assert.deepEqual(readUsage(first.cursor, 1000).rows.map(row => row.entryId), [4]);
  const before = readUsage(undefined).cursor;
  index.resetEntries("u1");
  index.addEntries("u1", [], [usage(1, 100), usage(2, 5000)]);
  const again = readUsage(before);
  assert.equal(again.restart, true, "the delete changed the drop count, so the rows read from the first one");
  assert.deepEqual(again.rows.map(row => row.entryId), [1, 2]);
  index.close();

  const db = new DatabaseSync(join(dir, "usage-read.sqlite"), { readOnly: true });
  const pages: number[][] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = readUsageRows(db, cursor, 0, 1);
    pages.push(page.rows.map(row => row.entryId));
    cursor = page.cursor;
    if (!page.more) break;
  }
  assert.deepEqual(pages, [[1], [2]]);
  db.close();
});

test("copies of one entry in an imported thread and its archived source count and show once, from the unarchived thread", () => {
  const index = new ThreadIndex(join(dir, "copies.sqlite"));
  for (const [id, archived] of [["old", true], ["new", false]] as const) {
    index.insertThread({ id, name: "vent", provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high", cwd: "/", createdAt: 1, updatedAt: 1 });
    if (archived) index.update(id, { archived: true });
    index.addEntries(id, Array.from({ length: 6 }, (_, i) => ({
      thread: id, conversation: 1, entryId: i + 1, kind: "pi.assistant", author: "anthropic/claude-opus-5-5", at: 1000 + i, text: `the guard allows it ${i}`,
    })), []);
  }
  index.addEntries("new", [
    { thread: "new", conversation: 1, entryId: 7, kind: "agent.message", author: "owner", at: 2000, text: "[#vent-dev · post 2 from You (owner) · reply here]\n\nis the guard up" },
    { thread: "new", conversation: 1, entryId: 8, kind: "pi.user", author: "owner", at: 2001, text: "[#not a channel copy] the guard again" },
  ], []);
  const all = index.search({ q: "guard", limit: 100 });
  assert.equal(all.total, 8);
  assert.equal(all.hits.length, 8);
  assert.ok(all.hits.every(hit => hit.thread === "new"));
  const skipped = index.search({ q: "guard", limit: 3, offset: 3, skipAgentMessages: "[#% · post % from %", sort: "recent" });
  assert.equal(skipped.total, 7);
  assert.deepEqual(skipped.hits.map(hit => hit.entryId), [4, 3, 2]);
  assert.equal(index.search({ q: "guard", offset: 50 }).total, 8);
  assert.equal(index.search({ q: "guard", threads: ["old"] }).total, 6);
  index.close();
});

test("tool output ranks after what people wrote, and kinds, authors and the whole text narrow or widen a search", () => {
  const index = new ThreadIndex(join(dir, "kinds.sqlite"));
  index.insertThread({ id: "t3", name: "kinds", provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high", cwd: "/", createdAt: 1, updatedAt: 1 });
  index.addEntries("t3", [
    { thread: "t3", conversation: 1, entryId: 1, kind: "pi.tool-result", author: "tool:bash", at: 1000, text: "otter otter otter otter in a log" },
    { thread: "t3", conversation: 1, entryId: 2, kind: "pi.user", author: "owner", at: 1001, text: "where is the otter" },
    { thread: "t3", conversation: 1, entryId: 3, kind: "pi.assistant", author: "anthropic/claude-opus-5-5", at: 1002, text: "The otter sits in the log." },
  ], []);
  assert.deepEqual(index.search({ q: "otter" }).hits.map(hit => hit.entryId)[0], 1);
  const demoted = index.search({ q: "otter", demoteKinds: ["pi.tool-result"], withText: true });
  assert.equal(demoted.total, 3);
  assert.equal(demoted.hits.at(-1)!.entryId, 1);
  assert.equal(demoted.hits.find(hit => hit.entryId === 2)!.text, "where is the otter");
  assert.equal(index.search({ q: "otter", demoteKinds: ["pi.tool-result"], sort: "recent" }).hits[0]!.entryId, 3);
  assert.deepEqual(index.search({ q: "otter", kinds: ["pi.tool-result"] }).hits.map(hit => hit.entryId), [1]);
  assert.equal(index.search({ q: "otter", skipKinds: ["pi.tool-result"] }).total, 2);
  assert.deepEqual(index.search({ q: "otter", notFrom: "owner" }).hits.map(hit => hit.entryId).sort(), [1, 3]);
  assert.equal(index.search({ q: "otter" }).hits[0]!.text, undefined);
  index.close();
});

test("a snippet marks word prefixes around the first match and cuts long text with an ellipsis", () => {
  const long = `${Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ")} the Pi-host relay is Ünder load ${Array.from({ length: 40 }, (_, i) => `z${i}`).join(" ")}`;
  const snippet = snippetOf(long, snippetTerms('"pi-host" under'));
  assert.match(snippet, /^…w35 .*<mark>Pi<\/mark>-<mark>host<\/mark> relay is <mark>Ünder<\/mark> load .*…$/);
  assert.equal(snippetOf("all good here", snippetTerms("go")), "all <mark>good</mark> here");
});

// 11-23: agent factory's work thread failed 11 turns in compaction and read sleeping all day, because a sleeping job held a wake.
test("a failed root turn reads failed ahead of a pending wake, a job's input keeps it, and new root work clears it", () => {
  const index = new ThreadIndex(join(dir, "failed.sqlite"));
  index.insertThread({ id: "w", name: "work", provider: "anthropic", modelId: "m", thinkingLevel: "high", cwd: "/", createdAt: 1, updatedAt: 1 });
  index.update("w", { failed: true });
  index.setWake("w", { active: false, at: 5_000 }, 10);
  assert.equal(statusOf(index.get("w")!), "failed");
  index.markActive("w", 2, false);
  assert.equal(statusOf(index.get("w")!), "running");
  index.setWake("w", { active: false, at: 6_000 }, 10);
  assert.equal(statusOf(index.get("w")!), "failed", "an input to a job conversation leaves the root's failure");
  index.markActive("w", 3);
  index.setWake("w", { active: false, at: 7_000 }, 10);
  assert.equal(statusOf(index.get("w")!), "sleeping");
  index.close();
});

test("a rebuild of the index and a thread's reset keep the usage rows of calls that left no entry", () => {
  const path = join(dir, "usage-keep.sqlite");
  const usage = (entryId: number) => ({ thread: "k1", conversation: 1, entryId, model: "anthropic/claude-opus-5-5", at: 100, input: 1, output: 2, cacheRead: 3,
    cacheWrite: 4, cost: 1.5, costInput: 0.1, costOutput: 0.2, costCacheRead: 0.3, costCacheWrite: 0.9 });
  const ids = () => {
    const db = openIndexReadOnly(path);
    try { return readUsageRows(db, undefined).rows.map(row => row.entryId).sort((a, b) => a - b); } finally { db.close(); }
  };
  let index = new ThreadIndex(path);
  index.insertThread({ id: "k1", name: "keep", provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high", cwd: "/", createdAt: 1, updatedAt: 1 });
  index.addEntries("k1", [], [usage(1), usage(2)]);
  index.addUsage(usage(-7));
  assert.deepEqual(ids(), [-7, 1, 2]);
  index.resetEntries("k1");
  assert.deepEqual(ids(), [-7], "a thread's reset drops only the rows its backfill writes again");
  index.addEntries("k1", [], [usage(1)]);
  index.close();
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA user_version = 0");
  raw.close();
  index = new ThreadIndex(path);
  assert.equal(index.rebuilt, true);
  assert.deepEqual(ids(), [-7], "the rebuild keeps the refine row");
  index.close();
});

test("an index from before the move to the usage store loses usage_hours and its triggers, and keeps its usage rows", () => {
  const path = join(dir, "hours-gone.sqlite");
  const usage = (entryId: number) => ({ thread: "h1", conversation: 1, entryId, model: "anthropic/claude-opus-5-5", at: 3_600_000 * entryId, input: 1, output: 2,
    cacheRead: 3, cacheWrite: 4, cost: 1.5, costInput: 0.1, costOutput: 0.2, costCacheRead: 0.3, costCacheWrite: 0.9 });
  let index = new ThreadIndex(path);
  index.insertThread({ id: "h1", name: "hours", provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high", cwd: "/", createdAt: 1, updatedAt: 1 });
  index.addEntries("h1", [], [usage(1), usage(2)]);
  index.close();
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE usage_hours (thread TEXT NOT NULL, model TEXT NOT NULL, hour INTEGER NOT NULL, turns INTEGER NOT NULL, PRIMARY KEY (hour, thread, model)) WITHOUT ROWID;
    CREATE TRIGGER usage_hours_add AFTER INSERT ON usage BEGIN INSERT INTO usage_hours (thread, model, hour, turns) VALUES (NEW.thread, NEW.model, NEW.at / 3600000, 1); END;
    CREATE TRIGGER usage_hours_drop AFTER DELETE ON usage BEGIN DELETE FROM usage_hours WHERE thread = OLD.thread; END;`);
  old.close();
  index = new ThreadIndex(path);
  index.addEntries("h1", [], [usage(3)]);
  index.close();
  const db = openIndexReadOnly(path);
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'usage_hours%'").all() as { name: string }[]).map(row => row.name);
  assert.deepEqual(names, [], "the table and both triggers are gone");
  assert.deepEqual(readUsageRows(db, undefined).rows.map(row => row.entryId), [1, 2, 3], "the usage rows stay, and a new one is written");
  db.close();
});
