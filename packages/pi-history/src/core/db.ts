import { mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 3;

/** Each entry moves the database from version i to i + 1. */
const MIGRATIONS: string[] = [
  `CREATE TABLE files(
    id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, session TEXT NOT NULL, root TEXT NOT NULL, parent TEXT, depth INTEGER NOT NULL,
    name TEXT, cwd TEXT, created INTEGER, indexed_to INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, mtime INTEGER NOT NULL DEFAULT 0,
    indexed_at INTEGER);
  CREATE INDEX files_session ON files(session);
  CREATE INDEX files_root ON files(root);
  CREATE TABLE docs(
    id INTEGER PRIMARY KEY,
    file INTEGER NOT NULL, entry TEXT, at INTEGER NOT NULL, line_offset INTEGER NOT NULL,
    kind TEXT NOT NULL,
    tool TEXT, tool_call_id TEXT, author TEXT, is_error INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL);
  CREATE INDEX docs_file_at ON docs(file, at);
  CREATE VIRTUAL TABLE fts USING fts5(text, content='docs', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
  CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);`,
  `DROP TABLE fts;
  CREATE VIRTUAL TABLE fts USING fts5(text, kind, content='docs', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
  INSERT INTO fts(fts) VALUES('rebuild');`,
  `CREATE INDEX docs_meta ON docs(id, file, kind, is_error, author);`,
];

export function defaultDbPath(): string {
  return platform() === "darwin"
    ? join(homedir(), "Library/Application Support/pi-history/history.db")
    : join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "pi-history/history.db");
}

export function getMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

function schemaVersion(db: DatabaseSync): number {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  return hasMeta ? Number(getMeta(db, "schema_version") ?? 0) : 0;
}

export function migrate(db: DatabaseSync): void {
  const from = schemaVersion(db);
  if (from > SCHEMA_VERSION) throw new Error(`pi-history: database schema ${from} is newer than this code's ${SCHEMA_VERSION}`);
  for (let v = from; v < SCHEMA_VERSION; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[v]!);
      setMeta(db, "schema_version", String(v + 1));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

/**
 * `manualCheckpoint` turns off SQLite's checkpoint inside COMMIT. On the 9 GB us-metal02 index that checkpoint made commits of 1 to 2 docs
 * take 300 to 735 ms (slow step log, 10-28 03:01Z), so the indexer leaves it to the checkpoint thread in main.ts.
 */
export function openDb(path: string = defaultDbPath(), options: { readOnly?: boolean; manualCheckpoint?: boolean } = {}): DatabaseSync {
  if (!options.readOnly) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
  if (options.readOnly) return db;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db);
  if (options.manualCheckpoint) db.exec("PRAGMA wal_autocheckpoint = 0");
  return db;
}
