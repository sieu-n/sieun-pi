/**
 * chat.sqlite as the store of every record the chat server owns: rooms, posts, agents, read marks, Later, wakes and the host routes, beside
 * the skills DB that already lives there (skills-db.ts). The owner asked for it in #sw-factory-build: "so idempotent, db owns ownership"
 * (11-22, msg mwqwgfsi) and "idempotent and clean (like docker compose up -> goes up)" (11-23, msg mwtd0iuy). The plan is
 * wiki:domains/devops/sw-factory/design/one-database.html.
 *
 * The server stays the one process that writes these records, and each store keeps its records in memory as it did with the JSON files, so
 * a read never waits on the DB. A write goes through `write`, which queues it for a worker thread with its own connection: a commit appends
 * to the WAL file, and on 11-04 at a box load of 300 such ext4 writes held the main thread 60 of a 70 ms send (disk.ts). The worker runs
 * the queued writes in the order they were queued, many in one transaction, and `written` settles once a write is committed.
 *
 * Every write carries a sequence number that the same transaction stores in `db_writes`, so applying a write twice changes nothing: a
 * process that exits with writes still queued applies them on its own connection (`flushSync`), and the worker skips any it finds applied.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { sealedFor } from "./disk.ts";

/** One SQL statement with its parameters, as `write` queues it. */
export type Stmt = { sql: string; params?: readonly SQLInputValue[] };
/** Queued statements with their sequence number, as the worker gets them. */
export type Batch = { seq: number; stmts: readonly Stmt[] };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS db_writes (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS db_kinds (kind TEXT PRIMARY KEY, version INTEGER NOT NULL, imported_at TEXT, export_until TEXT);
CREATE TABLE IF NOT EXISTS db_files (
  kind TEXT NOT NULL, path TEXT NOT NULL, how TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
  records INTEGER, at TEXT NOT NULL, PRIMARY KEY (kind, path, sha256)
);
`;

/** How long a connection waits for chat.sqlite's write lock. The skills ingest worker held it 6.2 s at box load 234 on 11-22 (skills-db.ts). */
export const LOCK_WAIT_MS = 30_000;

/** Opens chat.sqlite in WAL mode with this module's tables. */
export function openDb(file: string, busyMs = LOCK_WAIT_MS): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = ${busyMs};`);
  db.exec(SCHEMA);
  return db;
}

/** The newest sequence number a committed write stored. */
export function appliedSeq(db: DatabaseSync): number {
  const row = db.prepare("SELECT seq FROM db_writes WHERE id = 1").get() as { seq?: number | bigint } | undefined;
  return Number(row?.seq ?? 0);
}

/** A write whose statements failed, with its sequence number and the error. */
export type Failed = { seq: number; error: string };

/**
 * Applies `batches` on `db` in one transaction, leaving out each batch whose sequence number the DB already stored. When a statement fails,
 * the transaction is rolled back and each batch is tried alone, so one bad write costs only itself; its number is stored all the same, so it
 * is not tried again. Used by the worker, by the inline writer and by `flushSync`.
 */
export function applyBatches(db: DatabaseSync, batches: readonly Batch[], prepared: Map<string, StatementSync> = new Map()): Failed[] {
  if (!batches.length) return [];
  const prep = (sql: string) => {
    let stmt = prepared.get(sql);
    if (!stmt) prepared.set(sql, (stmt = db.prepare(sql)));
    return stmt;
  };
  const run = (some: readonly Batch[]) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const applied = appliedSeq(db);
      for (const batch of some) {
        if (batch.seq <= applied) continue;
        for (const stmt of batch.stmts) prep(stmt.sql).run(...(stmt.params ?? []));
      }
      const top = Math.max(applied, ...some.map(b => b.seq));
      prep("INSERT INTO db_writes (id, seq) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq").run(top);
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  };
  try {
    run(batches);
    return [];
  } catch (error) {
    if (/SQLITE_BUSY|database is locked/i.test(String(error))) throw error;
    if (batches.length === 1) {
      run([{ seq: batches[0]!.seq, stmts: [] }]);
      return [{ seq: batches[0]!.seq, error: error instanceof Error ? error.message : String(error) }];
    }
  }
  return batches.flatMap(batch => applyBatches(db, [batch], prepared));
}

type Queued = Batch & { label: string; settle: () => void; done: Promise<void> };
type FromWorker = { upTo: number; failed: Failed[] } | { error: string };

export type ChatDbOptions = {
  /** Writes go through a worker thread, as on the serving process; specs and tools may run them on the calling thread instead. */
  offThread?: boolean;
  log?: (line: string) => void;
};

export class ChatDb {
  /** The calling thread's connection: reads, the boot's imports and the last writes of an exiting process. */
  readonly db: DatabaseSync;
  private seq: number;
  private readonly queue: Queued[] = [];
  /** How many batches at the head of the queue the worker has now. */
  private sent = 0;
  private worker: Worker | null = null;
  private readonly offThread: boolean;
  private readonly log: (line: string) => void;
  private readonly prepared = new Map<string, StatementSync>();
  private closed = false;

  constructor(readonly file: string, options: ChatDbOptions = {}) {
    this.db = openDb(file);
    this.seq = appliedSeq(this.db);
    this.offThread = options.offThread ?? true;
    this.log = options.log ?? (() => {});
  }

  /**
   * Queues `stmts` as one write, which commits whole or not at all, after every write queued before it. The promise settles once it is
   * committed, or once it failed and was logged. A server that handed its data dir to a successor drops it (disk.ts `seal`).
   */
  write(stmts: readonly Stmt[], label = "write"): Promise<void> {
    if (this.closed) throw new Error(`chat db: ${label} after close`);
    if (!stmts.length || sealedFor(this.file)) return Promise.resolve();
    let settle!: () => void;
    const done = new Promise<void>(resolve => (settle = resolve));
    this.queue.push({ seq: ++this.seq, stmts, label, settle, done });
    queueMicrotask(() => this.pump());
    return done;
  }

  /** Settles once every write queued so far is committed or failed. */
  written(): Promise<void> {
    return this.queue.at(-1)?.done ?? Promise.resolve();
  }

  /** How many writes wait for their commit. */
  get pending(): number {
    return this.queue.length;
  }

  private pump(): void {
    if (this.sent > 0 || !this.queue.length || this.closed) return;
    if (!this.offThread) return this.settle(this.queue.length, applyBatches(this.db, this.queue, this.prepared));
    const worker = this.ensureWorker();
    this.sent = this.queue.length;
    worker.postMessage(this.queue.map(({ seq, stmts }) => ({ seq, stmts })));
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./chat-db-writer.ts", import.meta.url), { workerData: { file: this.file } });
    worker.unref();
    worker.on("message", (message: FromWorker) => {
      if ("error" in message) {
        // The worker could not commit, such as a lock held past LOCK_WAIT_MS; the same writes go to it again.
        this.log(`chat db: ${this.sent} writes did not commit and go again: ${message.error}`);
        this.sent = 0;
        setTimeout(() => this.pump(), 1000).unref();
        return;
      }
      const count = this.queue.findIndex(q => q.seq > message.upTo);
      this.settle(count < 0 ? this.queue.length : count, message.failed);
      this.pump();
    });
    worker.on("error", (error: Error) => this.log(`chat db: the writer thread failed: ${error.stack ?? error.message}`));
    worker.on("exit", code => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (this.closed) return;
      // A writer that ended took no batch with it: they stay queued, and a new writer skips the ones it finds stored.
      this.log(`chat db: the writer thread exited with ${code}; a new one takes the ${this.queue.length} queued writes`);
      this.sent = 0;
      queueMicrotask(() => this.pump());
    });
    return (this.worker = worker);
  }

  private settle(count: number, failed: readonly Failed[]): void {
    const done = this.queue.splice(0, count);
    this.sent = 0;
    for (const f of failed) this.log(`chat db: write ${done.find(q => q.seq === f.seq)?.label ?? f.seq} failed and was left out: ${f.error}`);
    for (const q of done) q.settle();
  }

  /**
   * Commits every queued write on this thread, for a process that is exiting. The worker may be committing some of them at the same time;
   * the write lock orders the two, and each side leaves out the batches the other stored.
   */
  flushSync(): void {
    if (!this.queue.length) return;
    try {
      const failed = applyBatches(this.db, this.queue, this.prepared);
      this.settle(this.queue.length, failed);
    } catch (error) {
      this.log(`chat db: ${this.queue.length} writes were not committed at exit: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Waits for the queued writes, then ends the worker and closes the connection. */
  async close(): Promise<void> {
    await this.written();
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    await worker?.terminate();
    this.db.close();
  }
}
