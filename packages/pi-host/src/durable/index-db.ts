/**
 * The host's one index over every durable thread file in a folder: the thread rows the chat lists, the wake each thread
 * last reported, the full-text search rows and the usage rows. Only pi-host writes it, and every row is derived from the
 * thread files, so a lost or stale index is rebuilt from them (`DurableThreads.reindex`).
 */
import { DatabaseSync } from "node:sqlite";

export type ThreadStatus = "idle" | "running" | "sleeping" | "failed";

export interface ThreadRow {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  thinkingLevel: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  /** The Harness's last `wake()`: work can run now. */
  wakeActive: boolean;
  /** The earliest sleep not yet due. */
  wakeAt?: number;
  /** The last input settled unanswered and no input came after it. */
  failed: boolean;
  archived: boolean;
  preview: string;
  children: number;
}

export interface SearchHit {
  thread: string;
  conversation: number;
  entryId: number;
  kind: string;
  author: string;
  at: number;
  snippet: string;
}

export interface SearchQuery {
  q: string;
  threads?: string[];
  from?: string;
  after?: number;
  before?: number;
  limit?: number;
  sort?: "relevance" | "recent";
}

export interface IndexedEntry {
  thread: string;
  conversation: number;
  entryId: number;
  kind: string;
  author: string;
  at: number;
  text: string;
}

export interface UsageRow {
  thread: string;
  conversation: number;
  entryId: number;
  model: string;
  at: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
}

export interface UsageTotal {
  thread: string;
  model: string;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, model_id TEXT NOT NULL, thinking TEXT NOT NULL, cwd TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, wake_active INTEGER NOT NULL DEFAULT 0, wake_at INTEGER,
  failed INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, preview TEXT NOT NULL DEFAULT '', children INTEGER NOT NULL DEFAULT 0,
  indexed_entry INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS entries USING fts5(
  text, thread UNINDEXED, conversation UNINDEXED, entry_id UNINDEXED, kind UNINDEXED, author UNINDEXED, at UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS usage (
  thread TEXT NOT NULL, conversation INTEGER NOT NULL, entry_id INTEGER NOT NULL, model TEXT NOT NULL, at INTEGER NOT NULL,
  input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cost REAL NOT NULL,
  cost_input REAL NOT NULL DEFAULT 0, cost_output REAL NOT NULL DEFAULT 0, cost_cache_read REAL NOT NULL DEFAULT 0, cost_cache_write REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (thread, entry_id)
);
CREATE INDEX IF NOT EXISTS usage_at ON usage (at);
`;

type Row = Record<string, string | number | bigint | null | Uint8Array>;

function threadOf(row: Row): ThreadRow {
  return {
    id: String(row.id), name: String(row.name), provider: String(row.provider), modelId: String(row.model_id), thinkingLevel: String(row.thinking),
    cwd: String(row.cwd), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), wakeActive: Number(row.wake_active) === 1,
    ...(row.wake_at === null ? {} : { wakeAt: Number(row.wake_at) }), failed: Number(row.failed) === 1, archived: Number(row.archived) === 1,
    preview: String(row.preview), children: Number(row.children),
  };
}

export function statusOf(row: Pick<ThreadRow, "wakeActive" | "wakeAt" | "failed">): ThreadStatus {
  if (row.wakeActive) return "running";
  if (row.wakeAt !== undefined) return "sleeping";
  return row.failed ? "failed" : "idle";
}

/** FTS5 query text from what a person typed: each word becomes a quoted prefix term, so punctuation never breaks the parse. */
export function ftsQuery(q: string): string {
  const words = q.split(/\s+/).map(word => word.replace(/"/g, "")).filter(Boolean);
  return words.map(word => `"${word}"*`).join(" ");
}

export class ThreadIndex {
  private readonly db: DatabaseSync;
  /** Set when this open changed the schema of derived rows, so every thread's search and usage rows are read again. */
  readonly rebuilt: boolean = false;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
    const columns = (this.db.prepare("PRAGMA table_info(usage)").all() as Row[]).map(row => String(row.name));
    if (!columns.includes("cost_input")) {
      // An index from before the cost split: its usage rows lack the four costs, so every thread's derived rows start over.
      this.db.exec(`ALTER TABLE usage ADD COLUMN cost_input REAL NOT NULL DEFAULT 0; ALTER TABLE usage ADD COLUMN cost_output REAL NOT NULL DEFAULT 0;
        ALTER TABLE usage ADD COLUMN cost_cache_read REAL NOT NULL DEFAULT 0; ALTER TABLE usage ADD COLUMN cost_cache_write REAL NOT NULL DEFAULT 0;
        DELETE FROM entries; DELETE FROM usage; UPDATE threads SET indexed_entry = 0;`);
      this.rebuilt = true;
    }
  }

  close(): void {
    this.db.close();
  }

  insertThread(row: Omit<ThreadRow, "wakeActive" | "wakeAt" | "failed" | "archived" | "preview" | "children">): void {
    this.db.prepare(`INSERT OR IGNORE INTO threads (id, name, provider, model_id, thinking, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.name, row.provider, row.modelId, row.thinkingLevel, row.cwd, row.createdAt, row.updatedAt);
  }

  get(id: string): ThreadRow | undefined {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Row | undefined;
    return row ? threadOf(row) : undefined;
  }

  list(options: { archived?: boolean } = {}): ThreadRow[] {
    const rows = options.archived === undefined
      ? this.db.prepare("SELECT * FROM threads ORDER BY updated_at DESC").all()
      : this.db.prepare("SELECT * FROM threads WHERE archived = ? ORDER BY updated_at DESC").all(options.archived ? 1 : 0);
    return (rows as Row[]).map(threadOf);
  }

  /** Threads a fresh process must open: work could run, or a sleep is due by `now`. */
  due(now: number): string[] {
    return (this.db.prepare("SELECT id FROM threads WHERE wake_active = 1 OR (wake_at IS NOT NULL AND wake_at <= ?)").all(now) as Row[]).map(row => String(row.id));
  }

  /** The earliest sleep across threads that have no runnable work. */
  nextWake(): { id: string; at: number } | undefined {
    const row = this.db.prepare("SELECT id, wake_at FROM threads WHERE wake_active = 0 AND wake_at IS NOT NULL ORDER BY wake_at LIMIT 1").get() as Row | undefined;
    return row ? { id: String(row.id), at: Number(row.wake_at) } : undefined;
  }

  setWake(id: string, wake: { active: boolean; at?: number }): void {
    this.db.prepare("UPDATE threads SET wake_active = ?, wake_at = ? WHERE id = ?").run(wake.active ? 1 : 0, wake.at ?? null, id);
  }

  /** Marks a thread runnable before work is admitted, so a crash between the admit and the Harness's own wake still reopens it. */
  markActive(id: string, now: number): void {
    this.db.prepare("UPDATE threads SET wake_active = 1, failed = 0, updated_at = ? WHERE id = ?").run(now, id);
  }

  update(id: string, change: { name?: string; provider?: string; modelId?: string; thinkingLevel?: string; archived?: boolean; failed?: boolean; preview?: string; children?: number; updatedAt?: number }): void {
    const sets: string[] = [];
    const values: (string | number)[] = [];
    const put = (column: string, value: string | number | undefined) => {
      if (value === undefined) return;
      sets.push(`${column} = ?`);
      values.push(value);
    };
    put("name", change.name);
    put("provider", change.provider);
    put("model_id", change.modelId);
    put("thinking", change.thinkingLevel);
    put("archived", change.archived === undefined ? undefined : change.archived ? 1 : 0);
    put("failed", change.failed === undefined ? undefined : change.failed ? 1 : 0);
    put("preview", change.preview);
    put("children", change.children);
    put("updated_at", change.updatedAt);
    if (!sets.length) return;
    this.db.prepare(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }

  indexedEntry(id: string): number {
    const row = this.db.prepare("SELECT indexed_entry FROM threads WHERE id = ?").get(id) as Row | undefined;
    return row ? Number(row.indexed_entry) : 0;
  }

  /** Adds entries and usage rows once each: an entry at or below the thread's indexed mark is already in. */
  addEntries(thread: string, entries: readonly IndexedEntry[], usage: readonly UsageRow[]): void {
    const mark = this.indexedEntry(thread);
    const fresh = entries.filter(entry => entry.entryId > mark);
    const freshUsage = usage.filter(row => row.entryId > mark);
    if (!fresh.length && !freshUsage.length) return;
    const top = Math.max(mark, ...fresh.map(entry => entry.entryId), ...freshUsage.map(row => row.entryId));
    const insert = this.db.prepare("INSERT INTO entries (text, thread, conversation, entry_id, kind, author, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const insertUsage = this.db.prepare(`INSERT OR IGNORE INTO usage (thread, conversation, entry_id, model, at, input, output, cache_read, cache_write, cost,
      cost_input, cost_output, cost_cache_read, cost_cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.exec("BEGIN");
    try {
      for (const entry of fresh) if (entry.text) insert.run(entry.text, entry.thread, entry.conversation, entry.entryId, entry.kind, entry.author, entry.at);
      for (const row of freshUsage) insertUsage.run(row.thread, row.conversation, row.entryId, row.model, row.at, row.input, row.output, row.cacheRead, row.cacheWrite, row.cost,
        row.costInput, row.costOutput, row.costCacheRead, row.costCacheWrite);
      this.db.prepare("UPDATE threads SET indexed_entry = ? WHERE id = ?").run(top, thread);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  search(query: SearchQuery): SearchHit[] {
    const match = ftsQuery(query.q);
    if (!match) return [];
    const where = ["entries MATCH ?"];
    const values: (string | number)[] = [match];
    if (query.threads?.length) {
      where.push(`thread IN (${query.threads.map(() => "?").join(", ")})`);
      values.push(...query.threads);
    }
    if (query.from) { where.push("author = ?"); values.push(query.from); }
    if (query.after !== undefined) { where.push("CAST(at AS INTEGER) >= ?"); values.push(query.after); }
    if (query.before !== undefined) { where.push("CAST(at AS INTEGER) < ?"); values.push(query.before); }
    const order = query.sort === "recent" ? "CAST(at AS INTEGER) DESC" : "rank";
    const sql = `SELECT thread, conversation, entry_id, kind, author, at, snippet(entries, 0, '<mark>', '</mark>', '…', 24) AS snippet
      FROM entries WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`;
    const rows = this.db.prepare(sql).all(...values, query.limit ?? 50) as Row[];
    return rows.map(row => ({
      thread: String(row.thread), conversation: Number(row.conversation), entryId: Number(row.entry_id), kind: String(row.kind),
      author: String(row.author), at: Number(row.at), snippet: String(row.snippet),
    }));
  }

  usage(range: { since?: number; until?: number; threads?: string[] }): UsageTotal[] {
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (range.since !== undefined) { where.push("at >= ?"); values.push(range.since); }
    if (range.until !== undefined) { where.push("at < ?"); values.push(range.until); }
    if (range.threads?.length) { where.push(`thread IN (${range.threads.map(() => "?").join(", ")})`); values.push(...range.threads); }
    const sql = `SELECT thread, model, COUNT(*) AS turns, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read,
      SUM(cache_write) AS cache_write, SUM(cost) AS cost, SUM(cost_input) AS cost_input, SUM(cost_output) AS cost_output,
      SUM(cost_cache_read) AS cost_cache_read, SUM(cost_cache_write) AS cost_cache_write FROM usage ${where.length ? `WHERE ${where.join(" AND ")}` : ""} GROUP BY thread, model ORDER BY thread, model`;
    return (this.db.prepare(sql).all(...values) as Row[]).map(row => ({
      thread: String(row.thread), model: String(row.model), turns: Number(row.turns), input: Number(row.input), output: Number(row.output),
      cacheRead: Number(row.cache_read), cacheWrite: Number(row.cache_write), cost: Number(row.cost),
      costInput: Number(row.cost_input), costOutput: Number(row.cost_output), costCacheRead: Number(row.cost_cache_read), costCacheWrite: Number(row.cost_cache_write),
    }));
  }

  /** Drops a thread's derived search and usage rows, so the next backfill reads its whole file again. */
  resetEntries(thread: string): void {
    this.db.prepare("DELETE FROM entries WHERE thread = ?").run(thread);
    this.db.prepare("DELETE FROM usage WHERE thread = ?").run(thread);
    this.db.prepare("UPDATE threads SET indexed_entry = 0 WHERE id = ?").run(thread);
  }
}
