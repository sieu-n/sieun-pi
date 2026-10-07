import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { UsageBucket, UsageGroup, UsageSummary, UsageWindow } from "../shared/usage.ts";
import { Ingest } from "./ingest.ts";
import { databaseSources, fileRoots } from "./sources.ts";
import { QueryError, UsageStore, type StoredCall } from "./store.ts";

/**
 * The usage worker thread: it owns usage.duckdb, the ingest and the throughput window, so file reads, JSON parsing
 * and DuckDB never run on the chat's event loop. The main thread sends `{ id, method, args }` and gets `{ id, value }`
 * or `{ id, error, status }` back.
 */
export type WorkerOptions = { dataDir: string; home?: string; debounceMs?: number; sweepMs?: number; offline?: boolean };
export type WorkerRequest = { id: number; method: "summary" | "series" | "models" | "daily" | "idle"; args: unknown[] };

const port = parentPort;
if (!port) throw new Error("usage worker: no parent port");
const options = workerData as WorkerOptions;
const windowMs = 61 * 60_000;

/** Tokens per call that ended in the last 61 minutes, keyed like the store so a merged copy never counts twice. */
const recent = new Map<bigint, { endedAt: number; total: number; output: number }>();
function remember(id: bigint, endedAt: number, total: number, output: number): void {
  if (endedAt < Date.now() - windowMs) return;
  const prior = recent.get(id);
  recent.set(id, prior ? { endedAt: Math.max(prior.endedAt, endedAt), total: Math.max(prior.total, total), output: Math.max(prior.output, output) } : { endedAt, total, output });
}

const store = await UsageStore.open(join(options.dataDir, "usage.duckdb"));
for (const row of await store.recent(Date.now() - windowMs)) remember(row.id, row.endedAt, row.total, row.output);
const ingest = new Ingest({
  store, roots: fileRoots(options.home), databases: databaseSources(options.home), pricesPath: join(options.dataDir, "litellm-prices.json"),
  ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }), ...(options.sweepMs === undefined ? {} : { sweepMs: options.sweepMs }),
  ...(options.offline ? { fetchPrices: async () => { throw new Error("offline"); } } : {}),
  onCalls: (calls: StoredCall[]) => { for (const c of calls) remember(c.id, c.endedAt, c.input + c.output + c.cacheRead + c.cacheWrite + c.reasoning, c.output + c.reasoning); },
  log: line => process.stderr.write(line + "\n"),
});
await ingest.start();

let totals: { at: number; synced: number | null; value: Awaited<ReturnType<UsageStore["totals"]>> } | null = null;
let sources: { at: number; synced: number | null; value: Awaited<ReturnType<UsageStore["sources"]>> } | null = null;

function localMidnight(now: number): number { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
const offsetMs = (now: number) => -new Date(now).getTimezoneOffset() * 60_000;

async function summary(): Promise<UsageSummary> {
  const now = Date.now();
  const sparkSeconds = new Array<number>(60).fill(0), sparkMinutes = new Array<number>(60).fill(0);
  let second = { total: 0, output: 0 }, minute = { total: 0, output: 0 };
  for (const [id, call] of recent) {
    const age = now - call.endedAt;
    if (age > windowMs) { recent.delete(id); continue; }
    if (age < 0) continue;
    if (age < 60_000) { sparkSeconds[59 - Math.floor(age / 1000)]! += call.total; second.total += call.total; second.output += call.output; }
    if (age < 3_600_000) { sparkMinutes[59 - Math.floor(age / 60_000)]! += call.total; minute.total += call.total; minute.output += call.output; }
  }
  // Cached between ingest passes; a finished pass (a new lastSyncAt) or the age limit reads them again.
  const synced = ingest.status.lastSyncAt;
  if (!totals || totals.synced !== synced || now - totals.at > 5000 || ingest.status.state !== "idle") totals = { at: now, synced, value: await store.totals(now - 86_400_000, localMidnight(now)) };
  if (!sources || sources.synced !== synced || now - sources.at > 10_000) sources = { at: now, synced, value: await store.sources() };
  second = { total: second.total / 60, output: second.output / 60 };
  minute = { total: minute.total / 60, output: minute.output / 60 };
  return {
    at: now, perSecond: second, perMinute: minute, perDay: { total: totals.value.total, output: totals.value.output },
    sparkSeconds, sparkMinutes, costToday: totals.value.costToday, ingest: { ...ingest.status, sources: sources.value },
  };
}

async function handle(request: WorkerRequest): Promise<unknown> {
  const now = Date.now();
  if (request.method === "summary") return summary();
  if (request.method === "series") return store.series(request.args[0] as UsageWindow, request.args[1] as UsageBucket, request.args[2] as UsageGroup, now, offsetMs(now));
  if (request.method === "models") return { models: await store.modelRows(request.args[0] as UsageWindow, now) };
  if (request.method === "daily") return store.daily(offsetMs(now));
  if (request.method === "idle") { await ingest.idle(); return null; }
  throw new QueryError("Unknown usage request.");
}

port.on("message", (message: WorkerRequest | { close: true }) => {
  if ("close" in message) {
    ingest.close();
    void ingest.idle().then(() => store.close()).finally(() => process.exit(0));
    return;
  }
  handle(message).then(value => port.postMessage({ id: message.id, value }),
    (error: unknown) => port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error), status: error instanceof QueryError ? 400 : 500 }));
});
port.postMessage({ ready: true });
