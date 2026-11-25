import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { parseQuery } from "../src/core/query.ts";
import { mergePages, pageAsk, searchDurable, searchPrime } from "../src/core/search.ts";
import { makeDurable, makeIndex } from "./fixture.ts";

const T = Date.parse("2026-11-25T21:00:00Z");
const CHAT = "01a11af8-962e-773d-a19a-ee4104011987";
const JOB = "01a2147a-a4c3-7671-8d04-5367ff71735f";
const OTHER = "01a1164b-4a2d-742d-b27a-82f086ed0200";

/** Every statement the search ran that reads fts with a file filter, with the values it ran with. */
function fileFilteredRuns(db: DatabaseSync, search: () => void): { sql: string; values: SQLInputValue[] }[] {
  const runs: { sql: string; values: SQLInputValue[] }[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string): StatementSync => {
    const statement = prepare(sql);
    if (!/fts MATCH/.test(sql) || !/file IN \(SELECT id FROM files/.test(sql)) return statement;
    const all = statement.all.bind(statement), get = statement.get.bind(statement);
    statement.all = (...values: SQLInputValue[]) => { runs.push({ sql, values }); return all(...values); };
    statement.get = (...values: SQLInputValue[]) => { runs.push({ sql, values }); return get(...values); };
    return statement;
  };
  try { search(); } finally { db.prepare = prepare; }
  return runs;
}

// On 11-25 from 21:05 to 21:14Z a job's `chat=<ops guy>` searches on :5182 took 3 to 91 s: SQLite sought docs_meta (id=? AND file=?) once for each
// of the chat's 1,682 files on every fts hit. A file filter under fts must leave the docs seek to the id alone.
test("a chat, session or scope filter under fts seeks each hit's docs row by its id alone, never once per file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-history-plan-"));
  // A fresh database per search, since search.ts prepares each SQL shape once per database and the spy sees only new statements.
  let built = 0;
  const build = () => makeIndex(join(dir, `h${built++}.db`), [
    { session: CHAT, name: "ops guy (+observability)" },
    { session: JOB, root: CHAT, parent: CHAT, depth: 1, name: "mac vent keys" },
    { session: OTHER, name: "AI harness developer environment VP" },
  ], [
    { session: CHAT, at: T, kind: "user", text: "is the mac vent up" },
    { session: JOB, at: T + 1000, kind: "assistant", text: "the mac vent keys moved" },
    { session: OTHER, at: T + 2000, kind: "assistant", text: "mac vent is not ours" },
  ], { ftsKind: true, docsMeta: true });
  const asks = [
    { q: "mac vent", chat: CHAT, roots: null, total: 2 },
    { q: `mac vent in:"ops guy"`, chat: null, roots: null, total: 2 },
    { q: `mac vent ${JOB.slice(0, 8)}`, chat: null, roots: null, total: 1 },
    { q: "mac vent", chat: null, roots: [CHAT], total: 2 },
  ];
  for (const sort of ["newest", "relevant"] as const) {
    for (const ask of asks) {
      const db = build();
      let total = -1;
      const runs = fileFilteredRuns(db, () => {
        total = searchPrime(db, "us-metal02", parseQuery({ q: ask.q, chat: ask.chat }), pageAsk(sort, 20, null), ask.roots).total;
      });
      assert.equal(total, ask.total, `${sort} ${ask.q}: the exact total`);
      assert.ok(runs.length, `${sort} ${ask.q}: ran a file filter under fts`);
      for (const run of runs) {
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${run.sql}`).all(...run.values) as { detail: string }[]).map(row => row.detail);
        assert.ok(!plan.some(detail => /\bfile=\?/.test(detail)), `${sort} ${ask.q}: ${plan.join(" | ")}\n${run.sql}`);
      }
    }
  }
});

// The same searches read each match's whole docs row, text included, to test its file: "staging convex reads" in ops guy's chat read 4,444
// rows for 36 hits on 11-25. A newest search with a docs filter picks its ids through docs_meta and makes snippets for the page alone.
test("a newest search with a docs filter makes snippets only for the page it picked", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-history-pick-"));
  const db = makeIndex(join(dir, "h.db"), [{ session: CHAT, name: "ops guy (+observability)" }, { session: OTHER, name: "AI harness developer environment VP" }],
    Array.from({ length: 40 }, (_, n) => ({ session: n % 4 ? OTHER : CHAT, at: T + n * 1000, kind: n % 2 ? "assistant" : "user", text: `staging convex reads ${n}` })),
    { ftsKind: true, docsMeta: true });
  const sqls: string[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string): StatementSync => { sqls.push(sql); return prepare(sql); };
  const page = searchPrime(db, "us-metal02", parseQuery({ q: "staging convex reads", chat: CHAT, kind: "user" }), pageAsk("newest", 3, null), null);
  assert.equal(page.total, 10);
  assert.deepEqual(page.hits.map(item => item.hit.at), [T + 36_000, T + 32_000, T + 28_000, T + 24_000]);
  assert.ok(page.hits.every(item => item.hit.session === CHAT && item.hit.snippet.includes("<mark>staging</mark>")));
  assert.deepEqual(sqls.filter(sql => /snippet\(/.test(sql) && /ORDER BY/.test(sql)), [], "no query that sorts makes snippets");
});

// On 11-25 at 22:06Z a durable search for "search" (102,796 matches in pi-host's index) took 15.9 to 26.7 s, because its sorting query made a
// snippet for every match before the sort kept a page. Only the page's rows may get a snippet, in a query that sorts nothing.
test("a durable search makes snippets only for the page it picked, in both sorts, and keeps its order, scores and exact total", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-history-durable-plan-"));
  const db = makeDurable(join(dir, "d.sqlite"), [{ id: "t1", name: "ops guy" }], Array.from({ length: 30 }, (_, n) => ({
    thread: "t1", kind: n % 3 ? "pi.assistant" : "pi.user", author: n % 3 ? "ops guy" : "owner", at: T + n * 1000, text: `mac vent ${"step ".repeat(n)}${n}`,
  })));
  const sqls: string[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string): StatementSync => { sqls.push(sql); return prepare(sql); };
  for (const sort of ["newest", "relevant"] as const) {
    const ask = pageAsk(sort, 5, null);
    const page = searchDurable(db, 0, "us-metal02", parseQuery({ q: "mac vent" }), ask, null);
    assert.equal(page.total, 30, `${sort}: the exact total`);
    assert.equal(page.hits.length, 6, `${sort}: a page and one more`);
    assert.ok(page.hits.every(item => item.hit.snippet.includes("<mark>mac</mark>")), `${sort}: each hit has its snippet`);
    if (sort === "newest") assert.deepEqual(page.hits.map(item => item.hit.at), Array.from({ length: 6 }, (_, n) => T + (29 - n) * 1000));
    else {
      const scores = page.hits.map(item => item.score);
      assert.deepEqual(scores, [...scores].sort((a, b) => a - b), "relevant: lower scores first");
      assert.equal(mergePages([page], ask).hits.length, 5);
    }
  }
  const sorted = sqls.filter(sql => /snippet\(/.test(sql) && /ORDER BY/.test(sql));
  assert.deepEqual(sorted, [], "no query that sorts makes snippets");
});
