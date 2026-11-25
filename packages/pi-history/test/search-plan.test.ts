import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { parseQuery } from "../src/core/query.ts";
import { pageAsk, searchPrime } from "../src/core/search.ts";
import { makeIndex } from "./fixture.ts";

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
