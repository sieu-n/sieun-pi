/**
 * The indexer's own thread. Its synchronous steps (up to 1 s on a 1 MB chunk of big tool output, seen 10-28 on us-metal02) would
 * otherwise hold the main thread, where every search waits for its request, worker replies and response.
 */
import { basename } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { openDb } from "./core/db.ts";
import { ToolOutputPolicy } from "./core/exclude.ts";
import { Indexer } from "./core/indexer.ts";

export interface IndexerWorkerData {
  dbPath: string;
  dirs: string[];
}

/** How often the worker posts its status to the main thread, which answers /v1/status from the last copy. */
export const STATUS_EVERY_MS = 1000;

const { dbPath, dirs } = workerData as IndexerWorkerData;
const db = openDb(dbPath);
const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
const policy = new ToolOutputPolicy(db, dirs.find((d) => basename(d) === "sessions") ?? dirs[0]!);
const indexer = new Indexer({ db, dbPath, dirs, log, policy });
const post = () => parentPort!.postMessage({ type: "status", status: indexer.status() });
const timer = setInterval(post, STATUS_EVERY_MS);
parentPort!.on("message", async (message: { type: string }) => {
  if (message.type !== "stop") return;
  clearInterval(timer);
  await indexer.stop();
  db.close();
  parentPort!.postMessage({ type: "stopped" });
  parentPort!.close();
});
post();
await indexer.start();
post();
