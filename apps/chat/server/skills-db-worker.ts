/**
 * The skills DB's work off the serving thread (skills-db.ts `ingestOffThread` and `viewOffThread`), on a connection of its own: one ingest
 * of the inventory in `workerData`, which may wait 5 s for chat.sqlite's write lock, or one build of the view as JSON, then one message
 * with the result or the error.
 */
import { parentPort, workerData } from "node:worker_threads";
import { SkillsDb, type SkillsDbConfig } from "./skills-db.ts";

const { config, raw, view } = workerData as { config: SkillsDbConfig; raw?: unknown; view?: true };
const db = new SkillsDb(config, { run: async () => [], undo: async () => [] }, line => parentPort!.postMessage({ log: line }), 5000);
try {
  parentPort!.postMessage(view ? { view: JSON.stringify(db.viewWithoutScan()) } : { result: db.ingest(raw) });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.stack ?? error.message : String(error) });
} finally {
  db.close();
}
