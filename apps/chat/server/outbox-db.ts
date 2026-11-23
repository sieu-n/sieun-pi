/**
 * Where the outbox is kept. A server whose APPS_CHAT_DB_KINDS leaves out `outbox`, as the live unit (deploy/linux/sieun-pi-apps-chat.service)
 * does until the outbox move, keeps the lines of `outbox.jsonl`, read by replaying it (`JsonOutboxLog`). A server that names `outbox` keeps
 * rows in chat.sqlite (chat-db.ts): the owner's sends pi-host has not taken (`outbox_rows`), the other sends kept until pi-host takes them
 * (`outbox_kept`) and the request ids that finished in the last day (`outbox_done`), each in the order the outbox holds them. `OUTBOX`
 * imports the file once (json-move.ts) and writes it back for the week of exports as the outbox's compaction wrote it, the finished ids,
 * then the rows, then the kept sends.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ChatDb, Stmt } from "./chat-db.ts";
import { appendLater, readLatest, replaceLater, written } from "./disk.ts";
import type { JsonKind, JsonMove } from "./json-move.ts";
import type { KeptSubmit, OutboxRow } from "./outbox.ts";

/** A `set` patch writes null for a field it clears, since JSON drops undefined. */
export type Patch = { [K in keyof OutboxRow]?: OutboxRow[K] | null };
type Line = { t: "row"; row: OutboxRow } | { t: "set"; requestId: string; patch: Patch } | { t: "done"; requestId: string; at?: number } | { t: "submit"; send: KeptSubmit };

export const OUTBOX_FILE = "outbox.jsonl";

export function patchRow(row: OutboxRow, change: Patch): void {
  for (const [key, value] of Object.entries(change)) {
    if (value === null || value === undefined) delete (row as unknown as Record<string, unknown>)[key];
    else (row as unknown as Record<string, unknown>)[key] = value;
  }
}

export type OutboxState = { rows: Map<string, OutboxRow>; kept: Map<string, KeptSubmit>; done: Map<string, number> };

/** The outbox as `outbox.jsonl` replays; a `done` line with no time takes `now`. */
export function replayOutbox(text: string, now: number): OutboxState {
  const state: OutboxState = { rows: new Map(), kept: new Map(), done: new Map() };
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    if (line.t === "row") state.rows.set(line.row.requestId, line.row);
    else if (line.t === "submit") state.kept.set(line.send.input.requestId, line.send);
    else if (line.t === "set") {
      const row = state.rows.get(line.requestId);
      if (row) patchRow(row, line.patch);
    } else {
      state.rows.delete(line.requestId);
      state.kept.delete(line.requestId);
      state.done.set(line.requestId, line.at ?? now);
    }
  }
  return state;
}

/** The statements that write each kind of change; `ord` keeps the outbox's order, and a change to a held id keeps its place, as a Map's set does. */
export const outboxSql = {
  row: (row: OutboxRow, ord: number): Stmt => ({
    sql: "INSERT INTO outbox_rows (request_id, ord, body) VALUES (?, ?, ?) ON CONFLICT (request_id) DO UPDATE SET body = excluded.body",
    params: [row.requestId, ord, JSON.stringify(row)],
  }),
  /** A change to a row that is gone changes nothing, as its `set` line did. */
  set: (row: OutboxRow): Stmt => ({ sql: "UPDATE outbox_rows SET body = ? WHERE request_id = ?", params: [JSON.stringify(row), row.requestId] }),
  kept: (send: KeptSubmit, ord: number): Stmt => ({
    sql: "INSERT INTO outbox_kept (request_id, ord, body) VALUES (?, ?, ?) ON CONFLICT (request_id) DO UPDATE SET body = excluded.body",
    params: [send.input.requestId, ord, JSON.stringify(send)],
  }),
  done: (requestId: string, at: number, ord: number): Stmt[] => [
    { sql: "DELETE FROM outbox_rows WHERE request_id = ?", params: [requestId] },
    { sql: "DELETE FROM outbox_kept WHERE request_id = ?", params: [requestId] },
    { sql: "INSERT INTO outbox_done (request_id, ord, at) VALUES (?, ?, ?) ON CONFLICT (request_id) DO UPDATE SET at = excluded.at", params: [requestId, ord, at] },
  ],
  forget: (ids: readonly string[]): Stmt[] => ids.map(id => ({ sql: "DELETE FROM outbox_done WHERE request_id = ?", params: [id] })),
};

/** The outbox as the DB holds it, each table in its order, and the highest `ord` in use. */
export function readOutbox(db: DatabaseSync): OutboxState & { ord: number } {
  const rows = db.prepare("SELECT body FROM outbox_rows ORDER BY ord").all() as { body: string }[];
  const kept = db.prepare("SELECT body FROM outbox_kept ORDER BY ord").all() as { body: string }[];
  const done = db.prepare("SELECT request_id, at FROM outbox_done ORDER BY ord").all() as { request_id: string; at: number }[];
  const top = db.prepare("SELECT max(ord) AS ord FROM (SELECT ord FROM outbox_rows UNION ALL SELECT ord FROM outbox_kept UNION ALL SELECT ord FROM outbox_done)").get() as { ord: number | null };
  return {
    rows: new Map(rows.map(r => JSON.parse(r.body) as OutboxRow).map(row => [row.requestId, row])),
    kept: new Map(kept.map(r => JSON.parse(r.body) as KeptSubmit).map(send => [send.input.requestId, send])),
    done: new Map(done.map(d => [d.request_id, Number(d.at)])),
    ord: Number(top.ord ?? 0),
  };
}

/** The outbox file as the outbox's compaction writes it: the finished ids, then the open rows, then the kept sends. */
export function outboxText(state: OutboxState): string {
  const lines: Line[] = [
    ...[...state.done].map(([requestId, at]): Line => ({ t: "done", requestId, at })),
    ...[...state.rows.values()].map((row): Line => ({ t: "row", row })),
    ...[...state.kept.values()].map((send): Line => ({ t: "submit", send })),
  ];
  return lines.map(line => `${JSON.stringify(line)}\n`).join("");
}

const size = (state: OutboxState): number => state.rows.size + state.kept.size + state.done.size;

export const OUTBOX: JsonKind = {
  kind: "outbox",
  migrations: [
    "CREATE TABLE outbox_rows (request_id TEXT PRIMARY KEY, ord INTEGER NOT NULL, body TEXT NOT NULL); " +
    "CREATE TABLE outbox_kept (request_id TEXT PRIMARY KEY, ord INTEGER NOT NULL, body TEXT NOT NULL); " +
    "CREATE TABLE outbox_done (request_id TEXT PRIMARY KEY, ord INTEGER NOT NULL, at INTEGER NOT NULL)",
  ],
  files: dataDir => (existsSync(join(dataDir, OUTBOX_FILE)) ? [OUTBOX_FILE] : []),
  load(db, _file, text) {
    const state = replayOutbox(text, Date.now());
    db.exec("DELETE FROM outbox_rows; DELETE FROM outbox_kept; DELETE FROM outbox_done");
    let ord = 0;
    // The order the compaction writes them in, so a dump of a file the outbox compacted renders its bytes.
    for (const [id, at] of state.done) for (const s of outboxSql.done(id, at, ++ord)) db.prepare(s.sql).run(...(s.params ?? []));
    for (const row of state.rows.values()) { const s = outboxSql.row(row, ++ord); db.prepare(s.sql).run(...(s.params ?? [])); }
    for (const send of state.kept.values()) { const s = outboxSql.kept(send, ++ord); db.prepare(s.sql).run(...(s.params ?? [])); }
    return size(state);
  },
  records: (_file, text) => size(replayOutbox(text, Date.now())),
  count: db => size(readOutbox(db)),
  dump: db => outboxText(readOutbox(db)),
};

/**
 * Where the outbox keeps its rows: chat.sqlite (`DbOutboxLog`), or `outbox.jsonl` when APPS_CHAT_DB_KINDS leaves out `outbox`. Each write
 * records one change the outbox already made in memory.
 */
export interface OutboxLog {
  /** The outbox as stored, read once at start. */
  load(): OutboxState;
  row(row: OutboxRow): void;
  /** A change to a row; one to a row that is gone changes nothing. */
  set(row: OutboxRow, patch: Patch): void;
  kept(send: KeptSubmit): void;
  /** A request id finished: its row or kept send goes, and the id is kept for a day. */
  done(requestId: string, at: number): void;
  /** The finished ids in `gone` were dropped from `state`, at start and when the outbox empties. */
  compact(state: OutboxState, gone: readonly string[]): void;
  /** Settles once every change so far is stored. */
  written(): Promise<void>;
}

/** `outbox.jsonl`, one line per change through the disk queue, rewritten whole at each compaction, as before the move. */
export class JsonOutboxLog implements OutboxLog {
  private readonly file: string;

  constructor(dir: string) {
    this.file = join(dir, OUTBOX_FILE);
  }

  load(): OutboxState {
    const text = readLatest(this.file);
    return text === undefined ? { rows: new Map(), kept: new Map(), done: new Map() } : replayOutbox(text, Date.now());
  }

  private line(line: Line): void {
    appendLater(this.file, `${JSON.stringify(line)}\n`);
  }

  row(row: OutboxRow): void {
    this.line({ t: "row", row });
  }

  set(row: OutboxRow, patch: Patch): void {
    this.line({ t: "set", requestId: row.requestId, patch });
  }

  kept(send: KeptSubmit): void {
    this.line({ t: "submit", send });
  }

  done(requestId: string, at: number): void {
    this.line({ t: "done", requestId, at });
  }

  compact(state: OutboxState): void {
    replaceLater(this.file, outboxText(state));
  }

  written(): Promise<void> {
    return written(this.file);
  }
}

/** The outbox tables, written through chat-db.ts's writer thread; `move` is the outbox move while its week of exports lasts. */
export class DbOutboxLog implements OutboxLog {
  /** The place of the newest row, kept send or finished id, which keeps each table in the order the outbox's Maps hold. */
  private ord = 0;
  private last: Promise<void> = Promise.resolve();

  constructor(private readonly chat: ChatDb, private readonly move?: JsonMove) {}

  load(): OutboxState {
    const { ord, ...state } = readOutbox(this.chat.db);
    this.ord = ord;
    return state;
  }

  private write(stmts: readonly Stmt[], label: string): void {
    this.last = this.chat.write(stmts, label);
    this.move?.touch(OUTBOX_FILE);
  }

  row(row: OutboxRow): void {
    this.write([outboxSql.row(row, ++this.ord)], "outbox send");
  }

  set(row: OutboxRow): void {
    this.write([outboxSql.set(row)], "outbox change");
  }

  kept(send: KeptSubmit): void {
    this.write([outboxSql.kept(send, ++this.ord)], "outbox submit");
  }

  done(requestId: string, at: number): void {
    this.write(outboxSql.done(requestId, at, ++this.ord), "outbox done");
  }

  compact(_state: OutboxState, gone: readonly string[]): void {
    if (gone.length) this.write(outboxSql.forget(gone), "outbox forget");
  }

  written(): Promise<void> {
    return this.last;
  }
}
