// Reads and parses the CI cache (src/ci-runs.ts) off the chat server's event loop, and sends back each run's fields without its jobs.
import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";

const FIELDS = ["id", "name", "path", "head_branch", "head_sha", "event", "status", "conclusion", "created_at", "updated_at"];
try {
  const cache = JSON.parse(await readFile(workerData.file, "utf8"));
  const runs = {};
  for (const [key, entry] of Object.entries(cache?.runs ?? {})) {
    const run = entry?.run;
    if (!run || typeof run !== "object") continue;
    const kept = {};
    for (const field of FIELDS) if (field in run) kept[field] = run[field];
    runs[key] = { run: kept };
  }
  parentPort.postMessage({ ok: true, cache: { fetchedAt: cache?.fetchedAt, runs } });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
