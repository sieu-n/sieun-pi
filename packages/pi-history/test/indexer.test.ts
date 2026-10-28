import assert from "node:assert/strict";
import { statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { getMeta, openDb, SCHEMA_VERSION } from "../src/core/db.ts";
import { Indexer, placeOf } from "../src/core/indexer.ts";
import { agentMessage, append, assistant, CHILD, digest, header, named, ROOT, tempHome, toolResult, until, user, write } from "./helpers.ts";

const open: Indexer[] = [];
after(async () => {
  for (const ix of open) await ix.stop();
});

function docs(ix: Indexer, path?: string) {
  const sql = `SELECT d.kind, d.author, d.tool, d.text, f.path FROM docs d JOIN files f ON f.id = d.file ${path ? "WHERE f.path = ?" : ""} ORDER BY d.id`;
  return (path ? ix.db.prepare(sql).all(path) : ix.db.prepare(sql).all()) as { kind: string; author: string; tool: string | null; text: string; path: string }[];
}

test("placeOf takes the root from session-artifacts and counts sub- folders", () => {
  assert.deepEqual(placeOf(`/h/.prime/agent/session-artifacts/${ROOT}/sub-a/sub-b/${CHILD}.jsonl`, CHILD), { root: ROOT, depth: 2 });
  assert.deepEqual(placeOf(`/h/.prime/agent/sessions/${ROOT}.jsonl`, ROOT), { root: ROOT, depth: 0 });
});

test("backfill, append, partial line and a truncated rewrite", async () => {
  const t = tempHome();
  write(t.rootFile, header(ROOT), named("vp chat"), user("find the 검색 bug"), digest(), assistant("looking now", { name: "ipython", code: "print(1)" }), toolResult("1"));
  write(t.childFile, header(CHILD, join(t.home, "sessions", `${ROOT}.jsonl`)), named("indexer"), agentMessage("vp chat", "build it"));
  const db = openDb(join(t.home, "history.db"));
  const ix = new Indexer({ db, dirs: t.dirs, sweepMs: 100 });
  open.push(ix);
  await ix.start();
  await ix.idle();

  const rootDocs = docs(ix, t.rootFile);
  assert.deepEqual(rootDocs.map((d) => d.kind), ["user", "assistant", "thinking", "tool_call", "tool_result"]);
  assert.deepEqual(rootDocs.map((d) => d.author), ["owner", "vp chat", "vp chat", "vp chat", "vp chat"]);
  const child = db.prepare("SELECT session, root, parent, depth, name, cwd FROM files WHERE path = ?").get(t.childFile);
  assert.deepEqual({ ...child }, { session: CHILD, root: ROOT, parent: ROOT, depth: 2, name: "indexer", cwd: "/work" });
  assert.deepEqual(docs(ix, t.childFile).map((d) => [d.kind, d.author]), [["agent_message", "vp chat"]]);
  assert.equal(ix.status().mode, "tail");
  assert.equal(ix.status().backfillPct, 100);

  const half = user("second question");
  append(t.rootFile, user("did it land?"), half.slice(0, 20));
  await until("the appended line", () => docs(ix, t.rootFile).some((d) => d.text === "did it land?"));
  assert.ok(!docs(ix, t.rootFile).some((d) => d.text === "second question"));
  append(t.rootFile, half.slice(20));
  await until("the completed partial line", () => docs(ix, t.rootFile).some((d) => d.text === "second question"));
  assert.equal(docs(ix, t.rootFile).filter((d) => d.text === "did it land?").length, 1);
  const st = ix.status();
  assert.ok(st.lagP50Ms !== undefined && st.lagP99Ms !== undefined, "tail docs leave lag samples");

  truncateSync(t.rootFile, 0);
  append(t.rootFile, header(ROOT), user("rewritten from scratch"));
  await until("the rewritten file", () => {
    const d = docs(ix, t.rootFile);
    return d.length === 1 && d[0]!.text === "rewritten from scratch";
  });
  const fts = db.prepare("SELECT count(*) AS n FROM fts WHERE fts MATCH 'looking'").get() as { n: number };
  assert.equal(fts.n, 0, "the rewrite drops the old docs from the FTS index too");
  const hit = db.prepare("SELECT d.text FROM fts JOIN docs d ON d.id = fts.rowid WHERE fts MATCH 'rewritten'").all();
  assert.equal(hit.length, 1);
});

test("a crash between chunks resumes from indexed_to without duplicate docs", async () => {
  const t = tempHome();
  const body = [header(ROOT), named("big")];
  for (let i = 0; i < 300; i++) body.push(user(`question ${i} ${"x".repeat(200)}`));
  write(t.rootFile, ...body);
  const path = join(t.home, "history.db");
  const first = new Indexer({ db: openDb(path), dirs: t.dirs, chunkBytes: 4096 });
  for (let i = 0; i < 5; i++) assert.equal(first.step(t.rootFile), false);
  const partial = Number((first.db.prepare("SELECT count(*) AS n FROM docs").get() as { n: number }).n);
  assert.ok(partial > 0 && partial < 300);
  first.db.close();

  const db = openDb(path);
  const second = new Indexer({ db, dirs: t.dirs, chunkBytes: 4096 });
  open.push(second);
  await second.start();
  await second.idle();
  const rows = db.prepare("SELECT text, count(*) AS n FROM docs GROUP BY text HAVING n > 1").all();
  assert.deepEqual(rows, []);
  assert.equal(second.status().docs, 300);
  assert.equal(Number((db.prepare("SELECT count(*) AS n FROM fts WHERE fts MATCH 'question'").get() as { n: number }).n), 300);
});

test("docs from different files in the same millisecond get distinct ids in time order", async () => {
  const t = tempHome();
  const at = Date.parse("2026-10-28T02:00:00.000Z");
  const { line } = await import("./helpers.ts");
  const msg = (text: string) => line({ type: "message", message: { role: "user", content: [{ type: "text", text }] } }, at);
  write(t.rootFile, header(ROOT), msg("one"), msg("two"));
  write(t.childFile, header(CHILD), msg("three"));
  const db = openDb(join(t.home, "history.db"));
  const ix = new Indexer({ db, dirs: t.dirs });
  open.push(ix);
  await ix.start();
  await ix.idle();
  const ids = db.prepare("SELECT id FROM docs WHERE at = ? ORDER BY id").all(at).map((r: any) => Number(r.id));
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) assert.equal(Math.floor(id / 1024), at);
});

test("fts indexes kind beside text, for new docs and for a version 1 database it migrates", async () => {
  const t = tempHome();
  write(t.rootFile, header(ROOT), named("vp chat"), assistant("kindcheck plan"));
  const path = join(t.home, "history.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE files(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, session TEXT NOT NULL, root TEXT NOT NULL, parent TEXT, depth INTEGER NOT NULL,
    name TEXT, cwd TEXT, created INTEGER, indexed_to INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, mtime INTEGER NOT NULL DEFAULT 0, indexed_at INTEGER);
  CREATE TABLE docs(id INTEGER PRIMARY KEY, file INTEGER NOT NULL, entry TEXT, at INTEGER NOT NULL, line_offset INTEGER NOT NULL, kind TEXT NOT NULL,
    tool TEXT, tool_call_id TEXT, author TEXT, is_error INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL);
  CREATE VIRTUAL TABLE fts USING fts5(text, content='docs', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
  CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO meta VALUES('schema_version', '1');
  INSERT INTO files(id, path, session, root, depth) VALUES(1, '/gone.jsonl', 'old', 'old', 0);
  INSERT INTO docs(id, file, at, line_offset, kind, text) VALUES(1024, 1, 1, 0, 'thinking', 'oldthought here');
  INSERT INTO fts(rowid, text) VALUES(1024, 'oldthought here');`);
  old.close();

  const db = openDb(path);
  assert.equal(getMeta(db, "schema_version"), String(SCHEMA_VERSION));
  const ix = new Indexer({ db, dirs: t.dirs });
  open.push(ix);
  await ix.start();
  await ix.idle();
  const kinds = (match: string) => (db.prepare("SELECT d.kind FROM fts JOIN docs d ON d.id = fts.rowid WHERE fts MATCH ? ORDER BY d.id").all(match) as { kind: string }[]).map((r) => r.kind);
  assert.deepEqual(kinds('{text} : oldthought AND kind : "thinking"'), ["thinking"]);
  assert.deepEqual(kinds('{text} : kindcheck NOT kind : "thinking"'), ["assistant"]);
  assert.deepEqual(kinds('{text} : kindcheck AND kind : "thinking"'), ["thinking"]);

  truncateSync(t.rootFile, 0);
  append(t.rootFile, header(ROOT), user("after"));
  await until("the rewrite", () => kinds("{text} : kindcheck").length === 0);
  db.exec("INSERT INTO fts(fts, rank) VALUES('integrity-check', 1)");
});

test("a big append to one file does not hold a small append to another", async () => {
  const t = tempHome();
  write(t.rootFile, header(ROOT), named("big"));
  write(t.childFile, header(CHILD), named("small"));
  const db = openDb(join(t.home, "history.db"));
  const ix = new Indexer({ db, dirs: t.dirs, sweepMs: 60_000 });
  open.push(ix);
  await ix.start();
  await ix.idle();
  const lines: string[] = [];
  for (let i = 0; i < 40_000; i++) lines.push(user(`bulk ${i} ${"word ".repeat(80)}`));
  append(t.rootFile, lines.join(""));
  await new Promise((r) => setTimeout(r, 50));
  append(t.childFile, user("smallappend"));
  const progress = () => db.prepare("SELECT indexed_to, size FROM files WHERE path = ?").get(t.rootFile) as { indexed_to: number; size: number };
  const bigSize = statSync(t.rootFile).size;
  const atSmall = await until("the small append", () => {
    const hit = db.prepare("SELECT count(*) AS n FROM fts WHERE fts MATCH 'smallappend'").get() as { n: number };
    return Number(hit.n) === 1 && progress().indexed_to;
  });
  assert.ok(atSmall < bigSize / 2, `the small append waited for ${atSmall} of ${bigSize} bytes of the big one`);
  await ix.idle();
});
