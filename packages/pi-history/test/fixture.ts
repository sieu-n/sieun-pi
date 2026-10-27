/** A pi-history index in the schema API.md fixes, filled from a few rows, for tests of the query side. */
import { DatabaseSync } from "node:sqlite";

export const SCHEMA = `
CREATE TABLE files(
  id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, session TEXT NOT NULL, root TEXT NOT NULL, parent TEXT, depth INTEGER NOT NULL,
  name TEXT, cwd TEXT, created INTEGER, indexed_to INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, mtime INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER);
CREATE INDEX files_session ON files(session);
CREATE INDEX files_root ON files(root);
CREATE TABLE docs(
  id INTEGER PRIMARY KEY, file INTEGER NOT NULL, entry TEXT, at INTEGER NOT NULL, line_offset INTEGER NOT NULL,
  kind TEXT NOT NULL, tool TEXT, tool_call_id TEXT, author TEXT, is_error INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL);
CREATE INDEX docs_file_at ON docs(file, at);
CREATE VIRTUAL TABLE fts USING fts5(text, content='docs', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
`;

export interface FixtureFile { session: string; root?: string; parent?: string; depth?: number; name?: string; path?: string; size?: number; indexedTo?: number }
export interface FixtureDoc { session: string; at: number; kind: string; text: string; author?: string; tool?: string; toolCallId?: string; isError?: boolean }

/** `ftsKind` builds fts with `kind` as a second column, the schema the api worker asked the indexer for. */
export function makeIndex(path: string, files: FixtureFile[], docs: FixtureDoc[], { ftsKind = false } = {}): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(ftsKind ? SCHEMA.replace("fts5(text,", "fts5(text, kind,") : SCHEMA);
  const ids = new Map<string, number>();
  for (const file of files) {
    const result = db.prepare(`INSERT INTO files(path, session, root, parent, depth, name, size, indexed_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      file.path ?? `/fixture/${file.session}.jsonl`, file.session, file.root ?? file.session, file.parent ?? null, file.depth ?? 0, file.name ?? null,
      file.size ?? 1000, file.indexedTo ?? file.size ?? 1000);
    ids.set(file.session, Number(result.lastInsertRowid));
  }
  const seq = new Map<number, number>();
  for (const doc of docs) {
    const n = seq.get(doc.at) ?? 0;
    seq.set(doc.at, n + 1);
    const id = doc.at * 1024 + n;
    const file = ids.get(doc.session);
    if (file === undefined) throw new Error(`fixture doc names no file: ${doc.session}`);
    db.prepare(`INSERT INTO docs(id, file, at, line_offset, kind, tool, tool_call_id, author, is_error, text) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`)
      .run(id, file, doc.at, doc.kind, doc.tool ?? null, doc.toolCallId ?? null, doc.author ?? (doc.kind === "user" ? "owner" : "agent"), doc.isError ? 1 : 0, doc.text);
    if (ftsKind) db.prepare("INSERT INTO fts(rowid, text, kind) VALUES (?, ?, ?)").run(id, doc.text, doc.kind);
    else db.prepare("INSERT INTO fts(rowid, text) VALUES (?, ?)").run(id, doc.text);
  }
  return db;
}

/** A pi-host durable index with the tables index-db.ts creates, holding a few entries. */
export function makeDurable(path: string, threads: { id: string; name: string }[], entries: { thread: string; kind: string; author: string; at: number; text: string }[]): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE VIRTUAL TABLE entries USING fts5(text, thread UNINDEXED, conversation UNINDEXED, entry_id UNINDEXED, kind UNINDEXED, author UNINDEXED, at UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2');`);
  for (const thread of threads) db.prepare("INSERT INTO threads(id, name) VALUES (?, ?)").run(thread.id, thread.name);
  entries.forEach((entry, index) => db.prepare("INSERT INTO entries(text, thread, conversation, entry_id, kind, author, at) VALUES (?, ?, 0, ?, ?, ?, ?)")
    .run(entry.text, entry.thread, index + 1, entry.kind, entry.author, entry.at));
  return db;
}
