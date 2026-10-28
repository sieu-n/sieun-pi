/**
 * Copies the WAL back into the database on its own connection and thread, because the indexer's connection runs with
 * wal_autocheckpoint = 0 (db.ts openDb `manualCheckpoint`). A PASSIVE checkpoint never blocks the indexer's commits or the query readers.
 */
import { DatabaseSync } from "node:sqlite";
import { workerData } from "node:worker_threads";

/** A tail minute on us-metal02 writes a few MB of WAL and backfill about 20 MB/s, so a 5 s cadence keeps the WAL to tens of MB. */
export const CHECKPOINT_EVERY_MS = 5000;

const { dbPath } = workerData as { dbPath: string };
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA wal_autocheckpoint = 0");
setInterval(() => {
  const began = performance.now();
  try {
    db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
  } catch (err) {
    process.stderr.write(`${new Date().toISOString()} pi-history: checkpoint failed: ${(err as Error).message}\n`);
  }
  const took = Math.round(performance.now() - began);
  if (took >= 1000) process.stderr.write(`${new Date().toISOString()} pi-history: checkpoint took ${took} ms\n`);
}, CHECKPOINT_EVERY_MS);
