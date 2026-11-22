/**
 * The skills DB's ingest off the serving thread (skills-db.ts `ingestOffThread`): one ingest of the inventory in `workerData`, on a
 * connection of its own that may wait 5 s for chat.sqlite's write lock, then one message with the result or the error.
 */
import { parentPort, workerData } from "node:worker_threads";
import { SkillsDb, type SkillsDbConfig } from "./skills-db.ts";

const { config, raw } = workerData as { config: SkillsDbConfig; raw: unknown };
const db = new SkillsDb(config, { run: async () => [], undo: async () => [] }, line => parentPort!.postMessage({ log: line }), 5000);
try {
  parentPort!.postMessage({ result: db.ingest(raw) });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.stack ?? error.message : String(error) });
} finally {
  db.close();
}
