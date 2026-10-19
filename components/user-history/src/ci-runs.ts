import { stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";

/** One run of the CI cache as `parseTrain` reads it: GitHub's run fields without its jobs. */
export type CachedRun = { id?: unknown; name?: unknown; path?: unknown; head_branch?: unknown; head_sha?: unknown; event?: unknown; status?: unknown;
  conclusion?: unknown; created_at?: unknown; updated_at?: unknown };
/** The CI cache (`trainFile`) with only what the chat reads: when it was fetched and each run. */
export type CiRuns = { fetchedAt?: unknown; runs: Record<string, { run: CachedRun }> };

const read = new Map<string, { key: string; runs: Promise<CiRuns | null> }>();

/**
 * The CI cache at `file`, parsed in a worker thread, once per version of the file (inode, size and mtime): null when it is missing or does not
 * parse. ci-cache rewrites the file every 30 s and it was 52 MB on 10-19, 80% of it the runs' jobs; each check-in measure parsed it whole on the
 * chat server's main thread (0.6 to 0.9 s) and the prod turns tick decoded and scanned it (0.25 s), every 30 s.
 */
export async function ciRuns(file: string): Promise<CiRuns | null> {
  const info = await stat(file, { bigint: true }).catch(() => null);
  if (!info) { read.delete(file); return null; }
  const key = `${info.ino}:${info.size}:${info.mtimeNs}`;
  const known = read.get(file);
  if (known?.key === key) return known.runs;
  const runs = parseInWorker(file);
  read.set(file, { key, runs });
  return runs;
}

function parseInWorker(file: string): Promise<CiRuns | null> {
  return new Promise(resolve => {
    const worker = new Worker(new URL("./ci-runs-worker.mjs", import.meta.url), { workerData: { file } });
    worker.unref();
    worker.once("message", (answer: { ok: true; cache: CiRuns } | { ok: false; error: string }) => { void worker.terminate(); resolve(answer.ok ? answer.cache : null); });
    worker.once("error", () => resolve(null));
    worker.once("exit", () => resolve(null));
  });
}
