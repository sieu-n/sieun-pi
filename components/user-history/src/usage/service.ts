import { Worker } from "node:worker_threads";
import { USAGE_METRICS, type UsageBucket, type UsageGroup, type UsageMetric, type UsageModelRow, type UsageRate, type UsageSeries, type UsageSummary, type UsageWindow } from "../shared/usage.ts";
import type { TokenRate } from "../shared/types.ts";
import type { WorkerOptions, WorkerRequest } from "./worker.ts";

/**
 * The chat's usage analytics. One worker thread (src/usage/worker.ts) does all reading and DuckDB work; this side only
 * posts requests, so the HTTP and WebSocket loop never waits on a file or a query. A crashed worker starts again after
 * a backoff (10 s doubling to 5 min) and builds on the same usage.duckdb.
 */
export class UsageError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const windows: readonly UsageWindow[] = ["1h", "24h", "7d", "30d", "90d", "all"];
const buckets: readonly UsageBucket[] = ["second", "minute", "hour", "day"];
const groups: readonly UsageGroup[] = ["none", "source", "model", "kind"];
export const parseWindow = (value: string | null): UsageWindow => {
  if (value !== null && (windows as readonly string[]).includes(value)) return value as UsageWindow;
  throw new UsageError(400, `Use window ${windows.join(", ")}.`);
};
export const parseBucket = (value: string | null): UsageBucket => {
  if (value !== null && (buckets as readonly string[]).includes(value)) return value as UsageBucket;
  throw new UsageError(400, `Use bucket ${buckets.join(", ")}.`);
};
export const parseGroup = (value: string | null): UsageGroup => {
  if (value === null) return "none";
  if ((groups as readonly string[]).includes(value)) return value as UsageGroup;
  throw new UsageError(400, `Use group ${groups.join(", ")}.`);
};
/** The token kind the series sums per key; output when the query names none. */
export const parseMetric = (value: string | null): UsageMetric => {
  if (value === null) return "output";
  if ((USAGE_METRICS as readonly string[]).includes(value)) return value as UsageMetric;
  throw new UsageError(400, `Use metric ${USAGE_METRICS.join(", ")}.`);
};

const feedMs = 2000;
const closeMs = 2000;
/** The worker answers in milliseconds once it runs; while it opens the database, the feed shows "building" instead of waiting. */
const summaryWaitMs = 5000;

export class UsageService {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly listeners = new Set<(summary: UsageSummary) => void>();
  private feed: ReturnType<typeof setInterval> | null = null;
  private restart: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 10_000;
  private closed = false;
  private lastError: string | null = null;

  constructor(private readonly options: WorkerOptions & { log?(line: string): void }) {}

  /** Never throws: a worker that cannot start is logged, retried with backoff and reported as state "error". */
  start(): void {
    if (this.closed || this.worker) return;
    const { log: _log, ...data } = this.options;
    let worker: Worker;
    try { worker = new Worker(new URL("./worker-entry.mjs", import.meta.url), { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 1024 } }); }
    catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.options.log?.(`usage worker: ${this.lastError}`);
      this.retry();
      return;
    }
    this.worker = worker;
    worker.unref();
    worker.on("message", (message: { id?: number; ready?: boolean; value?: unknown; error?: string; status?: number }) => {
      if (message.ready) { this.backoffMs = 10_000; this.lastError = null; return; }
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error !== undefined) waiter?.reject(new UsageError(message.status ?? 500, message.error));
      else waiter?.resolve(message.value);
    });
    worker.on("error", (error: Error) => { this.lastError = error.message; this.options.log?.(`usage worker: ${error.message}`); });
    worker.on("exit", code => {
      this.worker = null;
      for (const waiter of this.pending.values()) waiter.reject(new UsageError(503, this.lastError ?? `The usage worker stopped (${code}).`));
      this.pending.clear();
      if (this.closed) return;
      this.retry();
    });
  }

  private retry(): void {
    if (this.closed || this.restart) return;
    this.restart = setTimeout(() => { this.restart = null; this.start(); }, this.backoffMs);
    this.restart.unref();
    this.backoffMs = Math.min(this.backoffMs * 2, 5 * 60_000);
  }

  private call<T>(method: WorkerRequest["method"], args: unknown[] = []): Promise<T> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new UsageError(503, this.lastError ?? "Usage analytics is starting."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      try { worker.postMessage({ id, method, args } satisfies WorkerRequest); }
      catch (error) { this.pending.delete(id); reject(new UsageError(503, error instanceof Error ? error.message : String(error))); }
    });
  }

  /** Never rejects: while the worker is down or failing, an empty summary with ingest state "error" (or "building" while it starts). */
  summary(): Promise<UsageSummary> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<UsageSummary>(resolve => { timer = setTimeout(() => resolve(this.unavailable("Usage analytics is starting.")), summaryWaitMs); timer.unref(); });
    const answer = this.call<UsageSummary>("summary").catch((error: unknown) => this.unavailable(error instanceof Error ? error.message : String(error)));
    return Promise.race([answer, slow]).finally(() => clearTimeout(timer));
  }

  private unavailable(message: string): UsageSummary {
    const starting = this.worker !== null && this.lastError === null;
    const zero = (): UsageRate => ({ output: 0, input: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    const spark = (): Record<UsageMetric, number[]> => ({ output: new Array<number>(60).fill(0), input: new Array<number>(60).fill(0), cacheRead: new Array<number>(60).fill(0), cacheWrite: new Array<number>(60).fill(0), total: new Array<number>(60).fill(0) });
    return { at: Date.now(), perSecond: zero(), perMinute: zero(), perDay: zero(), sparkSeconds: spark(), sparkMinutes: spark(), costToday: null,
      ingest: { state: starting ? "building" : "error", filesDone: 0, filesTotal: 0, lastSyncAt: null, error: starting ? null : this.lastError ?? message, sources: [] } };
  }
  series(window: UsageWindow, bucket: UsageBucket, group: UsageGroup, metric: UsageMetric = "output"): Promise<UsageSeries> { return this.call("series", [window, bucket, group, metric]); }
  models(window: UsageWindow): Promise<{ models: UsageModelRow[] }> { return this.call("models", [window]); }
  daily(): Promise<unknown> { return this.call("daily"); }
  /** Output tokens per second per session id (src/usage/rates.ts), for the threads the Agents card lists; a worker that is down answers with no rates. */
  rates(sessionIds: readonly string[]): Promise<Record<string, TokenRate>> { return sessionIds.length ? this.call<Record<string, TokenRate>>("rates", [sessionIds]).catch(() => ({})) : Promise.resolve({}); }
  /** Resolves when the ingest has finished every pass queued so far (tests and measurements). */
  idle(): Promise<void> { return this.call("idle"); }

  /** The `usage` feed: one summary now, then one about every 2 s while anyone listens. */
  subscribe(listener: (summary: UsageSummary) => void): () => void {
    this.listeners.add(listener);
    void this.summary().then(summary => { if (this.listeners.has(listener)) listener(summary); }, () => {});
    if (!this.feed) {
      let busy = false;
      this.feed = setInterval(() => {
        if (busy) return;
        busy = true;
        this.summary().then(summary => { for (const each of this.listeners) each(summary); }, () => {}).finally(() => { busy = false; });
      }, feedMs);
      this.feed.unref();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.feed) { clearInterval(this.feed); this.feed = null; }
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.feed) clearInterval(this.feed);
    if (this.restart) clearTimeout(this.restart);
    this.listeners.clear();
    const worker = this.worker;
    if (!worker) return;
    // Bounded: the chat's stop and its exit-75 restart never wait on DuckDB. A clean close takes well under a second;
    // after 2 s the thread is terminated (DuckDB's WAL keeps the file consistent), and after 3 s close() returns anyway.
    const exited = new Promise<void>(resolve => worker.once("exit", () => resolve()));
    try { worker.postMessage({ close: true }); } catch { /* already gone */ }
    const timers: ReturnType<typeof setTimeout>[] = [];
    const deadline = new Promise<void>(resolve => {
      timers.push(setTimeout(() => { void worker.terminate().catch(() => {}); }, closeMs));
      timers.push(setTimeout(resolve, closeMs + 1000));
    });
    await Promise.race([exited, deadline]);
    for (const timer of timers) clearTimeout(timer);
  }
}
