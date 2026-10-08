import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { USAGE_METRICS, type UsageBucket, type UsageGroup, type UsageMetric, type UsageRate, type UsageSummary, type UsageWindow } from "../shared/usage.ts";
import { Ingest } from "./ingest.ts";
import { sessionRates } from "./rates.ts";
import { databaseSources, fileRoots } from "./sources.ts";
import { QueryError, UsageStore, type CallTokens, type StoredCall } from "./store.ts";

/**
 * The usage worker thread: it owns usage.duckdb, the ingest and the throughput window, so file reads, JSON parsing
 * and DuckDB never run on the chat's event loop. The main thread sends `{ id, method, args }` and gets `{ id, value }`
 * or `{ id, error, status }` back.
 */
export type WorkerOptions = { dataDir: string; home?: string; debounceMs?: number; sweepMs?: number; offline?: boolean };
export type WorkerRequest = { id: number; method: "summary" | "series" | "models" | "daily" | "rates" | "idle"; args: unknown[] };

const port = parentPort;
if (!port) throw new Error("usage worker: no parent port");
const options = workerData as WorkerOptions;
const windowMs = 61 * 60_000;

/** Tokens per kind per call that ended in the last 61 minutes, keyed like the store so a merged copy never counts twice. */
const recent = new Map<bigint, { endedAt: number } & CallTokens>();
function remember(id: bigint, endedAt: number, tokens: CallTokens): void {
  if (endedAt < Date.now() - windowMs) return;
  const prior = recent.get(id);
  // A streamed copy merges up, like the store's upsert: the larger count per kind wins.
  recent.set(id, prior ? { endedAt: Math.max(prior.endedAt, endedAt), input: Math.max(prior.input, tokens.input), output: Math.max(prior.output, tokens.output),
    cacheRead: Math.max(prior.cacheRead, tokens.cacheRead), cacheWrite: Math.max(prior.cacheWrite, tokens.cacheWrite) } : { endedAt, ...tokens });
}
const zeroRate = (): UsageRate => ({ output: 0, input: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const zeroSpark = (): Record<UsageMetric, number[]> => ({ output: new Array<number>(60).fill(0), input: new Array<number>(60).fill(0), cacheRead: new Array<number>(60).fill(0), cacheWrite: new Array<number>(60).fill(0), total: new Array<number>(60).fill(0) });
const withTotal = (tokens: CallTokens): UsageRate => ({ ...tokens, total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite });
const addRate = (into: UsageRate, tokens: UsageRate): void => { for (const metric of USAGE_METRICS) into[metric] += tokens[metric]; };
const addSpark = (into: Record<UsageMetric, number[]>, tokens: UsageRate, index: number): void => { for (const metric of USAGE_METRICS) into[metric][index]! += tokens[metric]; };

const store = await UsageStore.open(join(options.dataDir, "usage.duckdb"));
for (const row of await store.recent(Date.now() - windowMs)) remember(row.id, row.endedAt, row);
const ingest = new Ingest({
  store, roots: fileRoots(options.home), databases: databaseSources(options.home), pricesPath: join(options.dataDir, "litellm-prices.json"),
  ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }), ...(options.sweepMs === undefined ? {} : { sweepMs: options.sweepMs }),
  ...(options.offline ? { fetchPrices: async () => { throw new Error("offline"); } } : {}),
  onCalls: (calls: StoredCall[]) => { for (const c of calls) remember(c.id, c.endedAt, { input: c.input, output: c.output + c.reasoning, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite }); },
  log: line => process.stderr.write(line + "\n"),
});
await ingest.start();

let totals: { at: number; synced: number | null; value: Awaited<ReturnType<UsageStore["totals"]>> } | null = null;
let sources: { at: number; synced: number | null; value: Awaited<ReturnType<UsageStore["sources"]>> } | null = null;

function localMidnight(now: number): number { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
const offsetMs = (now: number) => -new Date(now).getTimezoneOffset() * 60_000;

async function summary(): Promise<UsageSummary> {
  const now = Date.now();
  const sparkSeconds = zeroSpark(), sparkMinutes = zeroSpark();
  const second = zeroRate(), minute = zeroRate();
  for (const [id, call] of recent) {
    const age = now - call.endedAt;
    if (age > windowMs) { recent.delete(id); continue; }
    if (age < 0) continue;
    const tokens = withTotal(call);
    if (age < 60_000) { addSpark(sparkSeconds, tokens, 59 - Math.floor(age / 1000)); addRate(second, tokens); }
    if (age < 3_600_000) { addSpark(sparkMinutes, tokens, 59 - Math.floor(age / 60_000)); addRate(minute, tokens); }
  }
  // Cached between ingest passes; a finished pass (a new lastSyncAt) or the age limit reads them again.
  const synced = ingest.status.lastSyncAt;
  if (!totals || totals.synced !== synced || now - totals.at > 5000 || ingest.status.state !== "idle") totals = { at: now, synced, value: await store.totals(now - 86_400_000, localMidnight(now)) };
  if (!sources || sources.synced !== synced || now - sources.at > 10_000) sources = { at: now, synced, value: await store.sources() };
  for (const metric of USAGE_METRICS) { second[metric] /= 60; minute[metric] /= 60; }
  return {
    at: now, perSecond: second, perMinute: minute, perDay: withTotal(totals.value.tokens),
    sparkSeconds, sparkMinutes, costToday: totals.value.costToday, ingest: { ...ingest.status, sources: sources.value },
  };
}

async function handle(request: WorkerRequest): Promise<unknown> {
  const now = Date.now();
  if (request.method === "summary") return summary();
  if (request.method === "series") return store.series(request.args[0] as UsageWindow, request.args[1] as UsageBucket, request.args[2] as UsageGroup, request.args[3] as UsageMetric, now, offsetMs(now));
  if (request.method === "models") return { models: await store.modelRows(request.args[0] as UsageWindow, now) };
  if (request.method === "daily") return store.daily(offsetMs(now));
  if (request.method === "rates") return sessionRates(await store.sessionCalls(request.args[0] as string[], now - 86_400_000), now);
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
