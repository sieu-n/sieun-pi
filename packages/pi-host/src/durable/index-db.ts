/**
 * The host's one index over every durable thread file in a folder: the thread rows the chat lists, the wake each thread
 * last reported, the full-text search rows and the usage rows. Only pi-host writes it, and every row is derived from the
 * thread files, so a lost or stale index is rebuilt from them (`DurableThreads.reindex`).
 */
import { DatabaseSync } from "node:sqlite";
import type { FeedRow } from "../../../../components/prime-relay/agents/protocol.ts";

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
  /** With `withText`: the entry's whole indexed text, so a caller in the same process can build its own snippet. */
  text?: string;
}

export interface SearchQuery {
  q: string;
  threads?: string[];
  /** Only this conversation's entries; pair it with one thread in `threads`. */
  conversation?: number;
  /** Only entries whose author column is this, such as `owner`. */
  from?: string;
  /** Only what one agent said: its own entries in its thread and conversation, and the agent messages it sent as `id` anywhere. */
  by?: { thread: string; conversation: number; id: string };
  /** Leaves out agent messages whose text matches this LIKE pattern, such as the chat's copies of channel posts, which it searches itself. */
  skipAgentMessages?: string;
  /** Leaves out entries whose author column is this, such as `owner` for what agents said. */
  notFrom?: string;
  /** Only entries of these kinds, such as `pi.tool-result`. */
  kinds?: string[];
  /** Leaves out entries of these kinds. */
  skipKinds?: string[];
  /** Leaves out these entries by thread and entry id, with their copies in other threads, such as the chat's test sends for `from: "owner"`. */
  skipEntries?: { thread: string; entry: number }[];
  /** In relevance order, entries of these kinds rank after every other match, so tool output never buries what people wrote. */
  demoteKinds?: string[];
  /** Each hit also carries its whole indexed text. */
  withText?: boolean;
  after?: number;
  before?: number;
  limit?: number;
  offset?: number;
  sort?: "relevance" | "recent";
}

/** One page of hits, each with its snippet, and the exact count of every match; copies of one entry count and show once. */
export interface SearchPage {
  hits: SearchHit[];
  total: number;
}

export interface IndexedEntry {
  thread: string;
  conversation: number;
  entryId: number;
  kind: string;
  author: string;
  at: number;
  text: string;
  /** The speaking calls of a root assistant entry (feed.ts `speechOf`), kept until their results are indexed. */
  calls?: SpokenCall[];
  /** The outcome of a root speaking call's result: a sent one adds its outbox row. */
  result?: { toolCallId: string; sent: boolean };
}

/** One `send_message` or `tell_owner` call with its message, as the outbox keeps it until its result. */
export interface SpokenCall {
  toolCallId: string;
  toolName: string;
  text: string;
  to?: string;
  why?: string;
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
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT NOT NULL, conversation INTEGER NOT NULL, entry INTEGER NOT NULL, tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, to_room TEXT, why TEXT, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox_calls (
  thread TEXT NOT NULL, tool_call_id TEXT NOT NULL, conversation INTEGER NOT NULL, entry INTEGER NOT NULL, tool_name TEXT NOT NULL,
  text TEXT NOT NULL, to_room TEXT, why TEXT, PRIMARY KEY (thread, tool_call_id)
);
CREATE TABLE IF NOT EXISTS outbox_meta (id INTEGER PRIMARY KEY CHECK (id = 1), since INTEGER NOT NULL);
`;

type Row = Record<string, string | number | bigint | null | Uint8Array>;

function feedRowOf(row: Row): FeedRow {
  return {
    seq: Number(row.seq), thread: String(row.thread), conversation: Number(row.conversation), entry: Number(row.entry), toolCallId: String(row.tool_call_id),
    toolName: String(row.tool_name), requestId: String(row.request_id), text: String(row.text), ...(row.to_room === null ? {} : { to: String(row.to_room) }),
    ...(row.why === null ? {} : { why: String(row.why) }), at: Number(row.at),
  };
}

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
const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The word prefixes a query matches, the way the unicode61 tokenizer splits them: "pi-host" is "pi" and "host". */
export function snippetTerms(q: string): string[] {
  return [...new Set(fold(q.replace(/"/g, " ")).match(/[\p{L}\p{N}]+/gu) ?? [])];
}

/** Up to 24 words around the first match, each matching word in <mark>, with … where the text is cut, like FTS5's snippet(). */
export function snippetOf(text: string, terms: readonly string[], size = 24): string {
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map(m => ({ at: m.index, end: m.index + m[0].length, hit: terms.some(t => fold(m[0]).startsWith(t)) }));
  if (!words.length) return text.slice(0, 200);
  const first = Math.max(0, words.findIndex(w => w.hit));
  const from = Math.max(0, Math.min(first - Math.floor(size / 4), words.length - size));
  const shown = words.slice(from, from + size);
  const start = from === 0 ? 0 : shown[0]!.at;
  const end = from + size >= words.length ? text.length : shown.at(-1)!.end;
  let out = from === 0 ? "" : "…";
  let cursor = start;
  for (const word of shown) {
    if (!word.hit) continue;
    out += `${text.slice(cursor, word.at)}<mark>${text.slice(word.at, word.end)}</mark>`;
    cursor = word.end;
  }
  return `${out}${text.slice(cursor, end)}${end < text.length ? "…" : ""}`;
}

export function ftsQuery(q: string): string {
  const words = q.split(/\s+/).map(word => word.replace(/"/g, "")).filter(Boolean);
  return words.map(word => `"${word}"*`).join(" ");
}

/**
 * One page of matches and their exact count. Copies of one entry, such as an imported thread beside the archived thread it came from,
 * count once and show from the unarchived, newest thread: a copy keeps the entry's id, kind, author and time. It only reads, so the chat
 * runs it on its own read-only connection (`openIndexReadOnly`) as well as pi-host on its own.
 */
export function searchIndex(db: DatabaseSync, query: SearchQuery): SearchPage {
  const match = ftsQuery(query.q);
  if (!match) return { hits: [], total: 0 };
  const where = ["entries MATCH ?"];
  const values: (string | number)[] = [match];
  if (query.threads?.length) {
    where.push(`thread IN (${query.threads.map(() => "?").join(", ")})`);
    values.push(...query.threads);
  }
  if (query.conversation !== undefined) { where.push("CAST(conversation AS INTEGER) = ?"); values.push(query.conversation); }
  if (query.from) { where.push("author = ?"); values.push(query.from); }
  if (query.by) {
    where.push("((kind = 'agent.message' AND author = ?) OR (kind <> 'agent.message' AND author <> 'owner' AND thread = ? AND CAST(conversation AS INTEGER) = ?))");
    values.push(query.by.id, query.by.thread, query.by.conversation);
  }
  if (query.skipAgentMessages) { where.push("NOT (kind = 'agent.message' AND text LIKE ?)"); values.push(query.skipAgentMessages); }
  if (query.notFrom) { where.push("author <> ?"); values.push(query.notFrom); }
  if (query.kinds?.length) { where.push(`kind IN (${query.kinds.map(() => "?").join(", ")})`); values.push(...query.kinds); }
  if (query.skipKinds?.length) { where.push(`kind NOT IN (${query.skipKinds.map(() => "?").join(", ")})`); values.push(...query.skipKinds); }
  if (query.after !== undefined) { where.push("CAST(at AS INTEGER) >= ?"); values.push(query.after); }
  if (query.before !== undefined) { where.push("CAST(at AS INTEGER) < ?"); values.push(query.before); }
  const recent = query.sort === "recent";
  const demote = !recent && query.demoteKinds?.length ? query.demoteKinds : [];
  const tier = demote.length ? `(kind IN (${demote.map(() => "?").join(", ")}))` : "0";
  // A skipped entry leaves out the copy that would show and so every copy of it, such as the chat's test send and its import.
  const skips = query.skipEntries ?? [];
  const kept = ["copy = 1", ...skips.map(() => "NOT (thread = ? AND entry = ?)")].join(" AND ");
  const skipValues = skips.flatMap(skip => [skip.thread, skip.entry]);
  const firsts = `WITH m AS MATERIALIZED (
      SELECT rowid AS id, thread, kind, author, CAST(at AS INTEGER) AS at, CAST(entry_id AS INTEGER) AS entry, ${recent ? "0" : "rank"} AS score, ${tier} AS tier
      FROM entries WHERE ${where.join(" AND ")}
    ), firsts AS (
      SELECT m.id, m.thread, m.entry, m.at, m.score, m.tier, ROW_NUMBER() OVER (PARTITION BY m.entry, m.kind, m.author, m.at ORDER BY t.archived, t.updated_at DESC, m.id) AS copy
      FROM m LEFT JOIN threads t ON t.id = m.thread
    )`;
  const page = db.prepare(`${firsts}
    SELECT id, count(*) OVER () AS total FROM firsts WHERE ${kept} ORDER BY ${recent ? "at DESC" : "tier, score"}, id LIMIT ? OFFSET ?`)
    .all(...demote, ...values, ...skipValues, query.limit ?? 50, query.offset ?? 0) as Row[];
  const total = page.length
    ? Number(page[0]!.total)
    : skips.length
      ? Number((db.prepare(`${firsts} SELECT count(*) AS n FROM firsts WHERE ${kept}`).get(...demote, ...values, ...skipValues) as Row).n)
      : Number((db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM entries WHERE ${where.join(" AND ")}
        GROUP BY CAST(entry_id AS INTEGER), kind, author, CAST(at AS INTEGER))`).get(...values) as Row).n);
  if (!page.length) return { hits: [], total };
  // Each page row is read by rowid with no MATCH and gets its snippet here: FTS5's snippet() with "rowid IN (...)" ran the whole match
  // once per row, 1.1 s for the page of "a" (16,254 matches) on us-metal02.
  const read = db.prepare("SELECT thread, conversation, entry_id, kind, author, at, text FROM entries WHERE rowid = ?");
  const words = snippetTerms(query.q);
  return {
    total,
    hits: page.flatMap(({ id }) => {
      const row = read.get(Number(id)) as Row | undefined;
      return row ? [{
        thread: String(row.thread), conversation: Number(row.conversation), entryId: Number(row.entry_id), kind: String(row.kind),
        author: String(row.author), at: Number(row.at), snippet: snippetOf(String(row.text), words),
        ...(query.withText ? { text: String(row.text) } : {}),
      }] : [];
    }),
  };
}


/**
 * A read-only connection to pi-host's index.sqlite. In WAL mode a reader never waits for pi-host's writes and pi-host never waits for it,
 * so the chat searches while pi-host starts or works through its command queue.
 */
export function openIndexReadOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 2000;");
  return db;
}

/** The index version whose rows credit a child conversation's task input to the conversation that wrote it (threads.ts `taskAuthor`). */
const TASK_AUTHOR_VERSION = 1;

export class ThreadIndex {
  private readonly db: DatabaseSync;
  /** Set when this open changed the schema of derived rows, so every thread's search and usage rows are read again. */
  readonly rebuilt: boolean = false;
  /**
   * When this index first had an outbox. A result from before it adds no row, so the first release with the outbox, a rebuild of the
   * index or `resetEntries` never feeds a thread's old messages to the chat server as new ones.
   */
  readonly outboxSince: number;
  private readonly outboxListeners = new Set<(row: FeedRow) => void>();

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
    if (Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version) < TASK_AUTHOR_VERSION) {
      // An index from before task authors credited every child conversation's task input to the owner, so its search rows start over.
      this.db.exec(`DELETE FROM entries; DELETE FROM usage; UPDATE threads SET indexed_entry = 0; PRAGMA user_version = ${TASK_AUTHOR_VERSION};`);
      this.rebuilt = true;
    }
    this.db.prepare("INSERT OR IGNORE INTO outbox_meta (id, since) VALUES (1, ?)").run(Date.now());
    this.outboxSince = Number((this.db.prepare("SELECT since FROM outbox_meta WHERE id = 1").get() as Row).since);
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

  update(id: string, change: { name?: string; cwd?: string; provider?: string; modelId?: string; thinkingLevel?: string; archived?: boolean; failed?: boolean; preview?: string; children?: number; updatedAt?: number }): void {
    const sets: string[] = [];
    const values: (string | number)[] = [];
    const put = (column: string, value: string | number | undefined) => {
      if (value === undefined) return;
      sets.push(`${column} = ?`);
      values.push(value);
    };
    put("name", change.name);
    put("cwd", change.cwd);
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

  /**
   * Adds entries and usage rows once each: an entry at or below the thread's indexed mark is already in. A speaking call waits in
   * `outbox_calls` until its result, and a sent result adds its outbox row once per requestId; listeners hear each new row after the commit.
   */
  addEntries(thread: string, entries: readonly IndexedEntry[], usage: readonly UsageRow[]): void {
    const mark = this.indexedEntry(thread);
    const fresh = entries.filter(entry => entry.entryId > mark);
    const freshUsage = usage.filter(row => row.entryId > mark);
    if (!fresh.length && !freshUsage.length) return;
    const top = Math.max(mark, ...fresh.map(entry => entry.entryId), ...freshUsage.map(row => row.entryId));
    const insert = this.db.prepare("INSERT INTO entries (text, thread, conversation, entry_id, kind, author, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const insertUsage = this.db.prepare(`INSERT OR IGNORE INTO usage (thread, conversation, entry_id, model, at, input, output, cache_read, cache_write, cost,
      cost_input, cost_output, cost_cache_read, cost_cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const added: FeedRow[] = [];
    this.db.exec("BEGIN");
    try {
      for (const entry of fresh) if (entry.text) insert.run(entry.text, entry.thread, entry.conversation, entry.entryId, entry.kind, entry.author, entry.at);
      for (const entry of [...fresh].sort((a, b) => a.entryId - b.entryId)) {
        const row = this.speech(thread, entry);
        if (row) added.push(row);
      }
      for (const row of freshUsage) insertUsage.run(row.thread, row.conversation, row.entryId, row.model, row.at, row.input, row.output, row.cacheRead, row.cacheWrite, row.cost,
        row.costInput, row.costOutput, row.costCacheRead, row.costCacheWrite);
      this.db.prepare("UPDATE threads SET indexed_entry = ? WHERE id = ?").run(top, thread);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const row of added) {
      for (const listener of this.outboxListeners) {
        try {
          listener(row);
        } catch {
          // A feed whose connection broke stops on its disconnect; the row stays in the table for its next durable_feed.
        }
      }
    }
  }

  /** Keeps an entry's speaking calls, or turns a sent result into its outbox row; answers the row when one was added. */
  private speech(thread: string, entry: IndexedEntry): FeedRow | undefined {
    for (const call of entry.calls ?? []) {
      this.db.prepare(`INSERT OR REPLACE INTO outbox_calls (thread, tool_call_id, conversation, entry, tool_name, text, to_room, why)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(thread, call.toolCallId, entry.conversation, entry.entryId, call.toolName, call.text, call.to ?? null, call.why ?? null);
    }
    const result = entry.result;
    if (!result) return undefined;
    const call = this.db.prepare("SELECT * FROM outbox_calls WHERE thread = ? AND tool_call_id = ?").get(thread, result.toolCallId) as Row | undefined;
    if (!call) return undefined;
    this.db.prepare("DELETE FROM outbox_calls WHERE thread = ? AND tool_call_id = ?").run(thread, result.toolCallId);
    if (!result.sent || entry.at < this.outboxSince) return undefined;
    const added = this.db.prepare(`INSERT OR IGNORE INTO outbox (thread, conversation, entry, tool_call_id, tool_name, request_id, text, to_room, why, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(thread, Number(call.conversation), Number(call.entry), result.toolCallId, String(call.tool_name),
      `m:${thread}:${result.toolCallId}`, String(call.text), call.to_room, call.why, entry.at);
    if (!added.changes) return undefined;
    return feedRowOf(this.db.prepare("SELECT * FROM outbox WHERE seq = ?").get(Number(added.lastInsertRowid)) as Row);
  }

  /** Up to `limit` outbox rows after `after`, in seq order, and whether more follow. */
  readOutbox(after: number, limit = 500): { rows: FeedRow[]; more: boolean } {
    const rows = (this.db.prepare("SELECT * FROM outbox WHERE seq > ? ORDER BY seq LIMIT ?").all(after, limit + 1) as Row[]).map(feedRowOf);
    return { rows: rows.slice(0, limit), more: rows.length > limit };
  }

  /** Calls `listener` with each outbox row added from now on, in seq order; answers the unsubscribe. */
  onOutbox(listener: (row: FeedRow) => void): () => void {
    this.outboxListeners.add(listener);
    return () => this.outboxListeners.delete(listener);
  }

  search(query: SearchQuery): SearchPage {
    return searchIndex(this.db, query);
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
