import { DatabaseSync, type StatementSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEntry } from "./store.ts";

/**
 * A local harness store's memory entries: `memory.sqlite` next to `harness_state.json`, so an agent's memory can hold tens of thousands
 * of entries. Each write touches one row, and a search ranks the whole store with SQLite FTS5's BM25 in milliseconds. The JSON file rewrote
 * every entry on each write (5.2 s at 50,000 entries) and its search scanned every entry (3.2 s p50), measured in
 * ~/work/agent-memory-scale/before-search on 11-26.
 *
 * The kernel's `harness.py` reads and writes the same file with the same schema and the same `memoryTerms` tokenizer
 * (`test/fixtures/memory-terms.json` holds the cases both must pass). The global store stays in `harness_state.json`, which Prime and
 * prime-sync share.
 */

export const MEMORY_DB = "memory.sqlite";
export const memoryDbPath = (dir: string): string => join(dir, MEMORY_DB);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, path TEXT NOT NULL DEFAULT 'general', source TEXT NOT NULL DEFAULT 'agent',
  metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
  extra TEXT NOT NULL DEFAULT '{}'
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_terms USING fts5(id_terms, title_terms, content_terms, tokenize = 'unicode61 remove_diacritics 0');
CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO memory_meta (key, value) VALUES ('revision', '0');
`;

/** Hangul, kana and CJK ideographs, which carry no spaces between words, so they index as character bigrams. */
const CJK_CHARS = "\\u1100-\\u11ff\\u3040-\\u30ff\\u3130-\\u318f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af\\u{20000}-\\u{3347f}";
const CJK = new RegExp(`[${CJK_CHARS}]`, "u");
const CJK_SPLIT = new RegExp(`[${CJK_CHARS}]+|[^${CJK_CHARS}]+`, "gu");
const RUN = /[\p{L}\p{N}\p{M}]+/gu;
const STOP = new Set(
  ("the and for that this with from are was were you your but not have has had its into than then them they will would can could should about " +
    "there their what when which who how all any been being our out use used using via per one two also just only some more most such each other over very")
    .split(" "),
);

/**
 * The words of `text` the index and the query share: lowercase letter and digit runs of three or more characters (two when a digit is in
 * them, so `p9` and `c74` stay), minus common English words, and each Hangul, kana or CJK run as its character bigrams. Owner messages mix
 * Korean and English, and a Korean word has no space inside a phrase, so `카테고리하고` still meets `카테고리`.
 */
export function memoryTerms(text: string): string[] {
  const out: string[] = [];
  for (const run of text.toLowerCase().match(RUN) ?? []) {
    for (const piece of CJK.test(run) ? (run.match(CJK_SPLIT) ?? []) : [run]) {
      if (CJK.test(piece)) {
        // By code point, as Python counts them, so a character outside the BMP stays whole.
        const chars = Array.from(piece);
        if (chars.length === 1) out.push(piece);
        for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
      } else if ((piece.length >= 3 || (piece.length === 2 && /\d/.test(piece))) && !STOP.has(piece)) {
        out.push(piece);
      }
    }
  }
  return out;
}

const termsText = (text: string): string => memoryTerms(text).join(" ");

/** The FTS5 query for `text`: its distinct terms, any of which may match. Empty when the text has none. */
export function memoryQuery(text: string): string {
  // A lone CJK character is a word, which an indexed bigram starts with, so it matches as a prefix.
  return [...new Set(memoryTerms(text))].map(term => `"${term.replaceAll('"', '""')}"${Array.from(term).length === 1 && CJK.test(term) ? "*" : ""}`).join(" OR ");
}

type Row = { id: string; title: string; content: string; path: string; source: string; metadata: string; created_at: string; updated_at: string; version: number; extra: string };
const KNOWN = new Set(["id", "kind", "title", "content", "path", "scope", "source", "metadata", "created_at", "updated_at", "version", "reference", "arguments"]);

const parse = (text: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};

function entryOf(row: Row): HarnessEntry {
  return {
    ...parse(row.extra),
    id: row.id, kind: "memory", title: row.title, content: row.content, path: row.path, scope: "local", reference: {}, arguments: {},
    metadata: parse(row.metadata), source: row.source, created_at: row.created_at, updated_at: row.updated_at, version: Number(row.version),
  };
}

interface Db {
  db: DatabaseSync;
  get: StatementSync;
  all: StatementSync;
  recent: StatementSync;
  changed: StatementSync;
  upsert: StatementSync;
  rowid: StatementSync;
  dropTerms: StatementSync;
  addTerms: StatementSync;
  remove: StatementSync;
  bump: StatementSync;
  revision: StatementSync;
  count: StatementSync;
  search: StatementSync;
}

const open = new Map<string, Db>();

/** The store's connection, opened once per process. `create` false gives undefined for a store that has no file yet. */
function db(dir: string, create = true): Db | undefined {
  const file = memoryDbPath(dir);
  const kept = open.get(file);
  if (kept) return kept;
  if (!create && !existsSync(file)) return undefined;
  mkdirSync(dir, { recursive: true });
  const handle = new DatabaseSync(file);
  // mmap reads share the OS page cache across pi-host's loop, its digest worker and the kernels, instead of copying pages per connection.
  handle.exec("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA mmap_size = 268435456;");
  handle.exec(SCHEMA);
  const made: Db = {
    db: handle,
    get: handle.prepare("SELECT * FROM memory WHERE id = ?"),
    all: handle.prepare("SELECT * FROM memory ORDER BY updated_at DESC, id"),
    recent: handle.prepare("SELECT * FROM memory ORDER BY updated_at DESC, id LIMIT ?"),
    changed: handle.prepare("SELECT * FROM memory WHERE updated_at > ? ORDER BY updated_at DESC, id"),
    upsert: handle.prepare(`INSERT INTO memory (id, title, content, path, source, metadata, created_at, updated_at, version, extra) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, path = excluded.path, source = excluded.source,
      metadata = excluded.metadata, created_at = excluded.created_at, updated_at = excluded.updated_at, version = excluded.version, extra = excluded.extra`),
    rowid: handle.prepare("SELECT rowid AS r FROM memory WHERE id = ?"),
    dropTerms: handle.prepare("DELETE FROM memory_terms WHERE rowid = ?"),
    addTerms: handle.prepare("INSERT INTO memory_terms (rowid, id_terms, title_terms, content_terms) VALUES (?,?,?,?)"),
    remove: handle.prepare("DELETE FROM memory WHERE id = ?"),
    bump: handle.prepare("UPDATE memory_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'"),
    revision: handle.prepare("SELECT value FROM memory_meta WHERE key = 'revision'"),
    count: handle.prepare("SELECT count(*) AS n FROM memory"),
    search: handle.prepare(`SELECT m.*, bm25(memory_terms, 1.0, 2.0, 1.0) AS score FROM memory_terms JOIN memory m ON m.rowid = memory_terms.rowid
      WHERE memory_terms MATCH ? ORDER BY score LIMIT ?`),
  };
  open.set(file, made);
  return made;
}

function inTransaction<T>(store: Db, work: () => T): T {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    store.bump.run();
    store.db.exec("COMMIT");
    return result;
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

function put(store: Db, entry: HarnessEntry): void {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) if (!KNOWN.has(key)) extra[key] = value;
  store.upsert.run(entry.id, entry.title, entry.content, entry.path || "general", entry.source || "agent", JSON.stringify(entry.metadata ?? {}),
    entry.created_at ?? "", entry.updated_at ?? "", entry.version ?? 1, JSON.stringify(extra));
  const { r } = store.rowid.get(entry.id) as { r: number };
  store.dropTerms.run(r);
  store.addTerms.run(r, termsText(entry.id.replaceAll("_", " ")), termsText(entry.title), termsText(entry.content));
}

/** Writes entries in one transaction, each replacing the entry with its id. */
export function putMemory(dir: string, entries: readonly HarnessEntry[]): void {
  if (!entries.length) return;
  const store = db(dir)!;
  inTransaction(store, () => { for (const entry of entries) put(store, entry); });
  // A bulk write, such as the first move of a store, goes into the main file at once, so later reads come through mmap and not the WAL.
  if (entries.length >= 500) store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

/** Removes entries by id; returns how many existed. */
export function deleteMemory(dir: string, ids: readonly string[]): number {
  const store = db(dir, false);
  if (!store || !ids.length) return 0;
  return inTransaction(store, () => {
    let gone = 0;
    for (const id of ids) {
      const row = store.rowid.get(id) as { r: number } | undefined;
      if (!row) continue;
      store.dropTerms.run(row.r);
      store.remove.run(id);
      gone++;
    }
    return gone;
  });
}

export function getMemory(dir: string, id: string): HarnessEntry | undefined {
  const row = db(dir, false)?.get.get(id) as Row | undefined;
  return row ? entryOf(row) : undefined;
}

/** Every entry, newest first. */
export function listMemory(dir: string): HarnessEntry[] {
  return ((db(dir, false)?.all.all() ?? []) as Row[]).map(entryOf);
}

/** The `limit` newest entries. */
export function recentMemory(dir: string, limit: number): HarnessEntry[] {
  return ((db(dir, false)?.recent.all(limit) ?? []) as Row[]).map(entryOf);
}

/** Entries whose `updated_at` is after `since` (ISO time), newest first. */
export function changedMemory(dir: string, since: string): HarnessEntry[] {
  return ((db(dir, false)?.changed.all(since) ?? []) as Row[]).map(entryOf);
}

export function countMemory(dir: string): number {
  return Number((db(dir, false)?.count.get() as { n: number } | undefined)?.n ?? 0);
}

/** A number that grows on every write from any process, which a cache or a digest fingerprint compares. */
export function memoryRevision(dir: string): number {
  return Number((db(dir, false)?.revision.get() as { value: string } | undefined)?.value ?? 0);
}

/** The `limit` entries that best match `text`, best first, with FTS5's BM25 score (lower is better). */
export function searchMemory(dir: string, text: string, limit: number): { entry: HarnessEntry; score: number }[] {
  const query = memoryQuery(text);
  const store = query ? db(dir, false) : undefined;
  if (!store) return [];
  return (store.search.all(query, limit) as (Row & { score: number })[]).map(row => ({ entry: entryOf(row), score: row.score }));
}

/** Closes every open store, for tests that remove their folders. */
export function closeMemoryStores(): void {
  for (const store of open.values()) store.db.close();
  open.clear();
}
