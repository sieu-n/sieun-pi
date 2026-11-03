/** An index from before the cost split gains the four cost columns and drops its derived rows, so the threads backfill them again. */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ThreadIndex } from "../../src/durable/index.ts";
import { snippetOf, snippetTerms } from "../../src/durable/index-db.ts";

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
  assert.deepEqual(migrated.usage({}), []);
  migrated.close();

  const again = new ThreadIndex(path);
  assert.equal(again.rebuilt, false);
  again.close();
});

// 11-03 on us-metal02: the chat's Usage page asked `usage` 9 times for 7 days, and each GROUP BY over the 36k usage rows took 23 to 276 ms.
test("a range on whole hours sums the hourly table to the same totals as the usage rows, through adds, a reset and a reopen", () => {
  const H = 3_600_000;
  const path = join(dir, "hours.sqlite");
  const index = new ThreadIndex(path);
  for (const id of ["a", "b"]) index.insertThread({ id, name: id, provider: "anthropic", modelId: "m", thinkingLevel: "high", cwd: "/", createdAt: 1, updatedAt: 1 });
  const row = (thread: string, entryId: number, at: number, model = "anthropic/m") => ({ thread, conversation: 1, entryId, model, at, input: entryId * 3,
    output: entryId * 5, cacheRead: entryId * 7, cacheWrite: entryId, cost: entryId * 0.013, costInput: entryId * 0.001, costOutput: entryId * 0.01,
    costCacheRead: entryId * 0.0007, costCacheWrite: entryId * 0.0013 });
  const rows = Array.from({ length: 60 }, (_, i) => row(i % 2 ? "a" : "b", i + 1, 10 * H + i * 997_331, i % 3 ? "anthropic/m" : "openai/n"));
  index.addEntries("a", [], rows.filter(r => r.thread === "a"));
  index.addEntries("b", [], rows.filter(r => r.thread === "b"));
  index.addEntries("a", [], rows.filter(r => r.thread === "a"));
  const raw = (since: number, until: number, threads?: string[]) => index.usage({ since: since + 1, until: until + 1, ...(threads ? { threads } : {}) });
  const expected = (since: number, until: number, threads?: string[]) => {
    const kept = rows.filter(r => r.at >= since && r.at < until && (!threads || threads.includes(r.thread)));
    const seen = new Map<string, { thread: string; model: string; turns: number; input: number; cost: number }>();
    for (const r of kept) {
      const sum = seen.get(`${r.thread}|${r.model}`) ?? { thread: r.thread, model: r.model, turns: 0, input: 0, cost: 0 };
      seen.set(`${r.thread}|${r.model}`, { ...sum, turns: sum.turns + 1, input: sum.input + r.input, cost: sum.cost + r.cost });
    }
    return [...seen.values()].sort((x, y) => x.thread.localeCompare(y.thread) || x.model.localeCompare(y.model));
  };
  const check = (since: number, until: number, threads?: string[], idx: ThreadIndex = index) => {
    const got = idx.usage({ since, until, ...(threads ? { threads } : {}) });
    const want = expected(since, until, threads);
    assert.deepEqual(got.map(t => [t.thread, t.model, t.turns, t.input]), want.map(t => [t.thread, t.model, t.turns, t.input]));
    for (const [n, t] of got.entries()) assert.ok(Math.abs(t.cost - want[n]!.cost) < 1e-9, `${t.thread} ${t.model} cost ${t.cost} against ${want[n]!.cost}`);
  };
  check(10 * H, 27 * H);
  check(12 * H, 15 * H);
  check(11 * H, 20 * H, ["a"]);
  assert.deepEqual(index.usage({ since: 13 * H, until: 14 * H }).map(t => t.turns), expected(13 * H, 14 * H).map(t => t.turns));
  assert.ok(raw(12 * H, 15 * H).length > 0, "a range off the hour still reads the usage rows");
  index.resetEntries("a");
  rows.splice(0, rows.length, ...rows.filter(r => r.thread === "b"));
  check(10 * H, 27 * H);
  index.close();

  const old = new DatabaseSync(path);
  old.exec("DROP TRIGGER usage_hours_add; DROP TRIGGER usage_hours_drop; DROP TABLE usage_hours;");
  old.close();
  const reopened = new ThreadIndex(path);
  assert.equal(reopened.rebuilt, false);
  check(10 * H, 27 * H, undefined, reopened);
  reopened.close();
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
