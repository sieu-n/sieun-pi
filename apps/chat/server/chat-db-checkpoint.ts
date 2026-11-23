/**
 * chat-db.ts's checkpoint thread: its own connection to chat.sqlite, which copies the WAL into the database every `everyMs` with a PASSIVE
 * checkpoint. A PASSIVE checkpoint takes no write lock and waits for no reader, so the writer thread commits while it runs; the writer
 * starts the WAL over at its next commit once a checkpoint copied all of it.
 */
import { workerData } from "node:worker_threads";
import { openDb } from "./chat-db.ts";

const { file, everyMs } = workerData as { file: string; everyMs: number };
const db = openDb(file);
db.exec("PRAGMA wal_autocheckpoint = 0");
setInterval(() => {
  try {
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  } catch {
    // A checkpoint another connection holds, or a busy file; the next tick copies what this one left.
  }
}, everyMs);
