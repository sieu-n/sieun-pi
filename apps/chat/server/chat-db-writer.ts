/**
 * chat-db.ts's writer thread: its own connection to chat.sqlite, which commits each list of queued writes it gets in one transaction and
 * answers with the newest sequence number it stored, or with the error that kept it from committing. It leaves the WAL's checkpoints to
 * chat-db-checkpoint.ts, so no commit waits for one, and truncates the WAL back to `WAL_KEEP_BYTES` when it starts it over.
 */
import type { StatementSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { applyBatches, openDb, WAL_KEEP_BYTES, type Batch } from "./chat-db.ts";

const db = openDb((workerData as { file: string }).file);
db.exec(`PRAGMA wal_autocheckpoint = 0; PRAGMA journal_size_limit = ${WAL_KEEP_BYTES};`);
const prepared = new Map<string, StatementSync>();
parentPort!.on("message", (batches: Batch[]) => {
  try {
    const failed = applyBatches(db, batches, prepared);
    parentPort!.postMessage({ upTo: batches.at(-1)!.seq, failed });
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
