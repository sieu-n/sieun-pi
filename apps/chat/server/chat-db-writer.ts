/**
 * chat-db.ts's writer thread: its own connection to chat.sqlite, which commits each list of queued writes it gets in one transaction and
 * answers with the newest sequence number it stored, or with the error that kept it from committing.
 */
import type { StatementSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { applyBatches, openDb, type Batch } from "./chat-db.ts";

const db = openDb((workerData as { file: string }).file);
const prepared = new Map<string, StatementSync>();
parentPort!.on("message", (batches: Batch[]) => {
  try {
    const failed = applyBatches(db, batches, prepared);
    parentPort!.postMessage({ upTo: batches.at(-1)!.seq, failed });
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
