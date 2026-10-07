import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { USAGE_METRICS, type UsageMetric, type UsageModelRow, type UsageRate, type UsageSeries, type UsageSummary } from "../shared/usage.ts";

/**
 * Publishes this Mac's token usage to the public virev.ai/sieun page through Convex.
 *
 * Every 5 s it reads the in-process usage summary and POSTs a small live payload (rates and the last 60 s per token
 * kind) to each enabled target. When the last push and this one are both all zero it skips the POST and sends a
 * heartbeat once a minute instead, so an idle Mac costs nothing. Every 10 min it POSTs a daily payload (every day on
 * record by kind, model and source, plus the model tables for 24 h, 7 d, 30 d and all time).
 *
 * The page is public, so payloads are built field by field from an allowlist: numbers, model ids and source names.
 * No prompt, path, cwd, session id, call id, account or ingest error is ever read into a payload.
 *
 * Config: ~/Library/Application Support/sieun-usage-push/config.json (0600). A missing file turns the publisher off.
 * A failing target backs off from 10 s to 5 min on its own and never delays the chat.
 */

export type PushTarget = { name: string; siteUrl: string; key: string; enabled: boolean };
export type PublishConfig = { slug: string; targets: PushTarget[] };

/** What the publisher needs from UsageService. */
export type UsageSource = {
  summary(): Promise<UsageSummary>;
  series(window: "all", bucket: "day", group: "none" | "model" | "source", metric?: UsageMetric): Promise<UsageSeries>;
  models(window: "24h" | "7d" | "30d" | "all"): Promise<{ models: UsageModelRow[] }>;
};

export const defaultConfigPath = (home = homedir()): string => join(home, "Library", "Application Support", "sieun-usage-push", "config.json");

export async function readPublishConfig(path = defaultConfigPath()): Promise<PublishConfig | null> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch { return null; }
  const raw = JSON.parse(text) as Partial<PublishConfig>;
  if (typeof raw.slug !== "string" || !Array.isArray(raw.targets)) throw new Error(`${path}: needs slug and targets`);
  const targets = raw.targets.filter((t): t is PushTarget => typeof t?.name === "string" && typeof t.siteUrl === "string" && typeof t.key === "string" && typeof t.enabled === "boolean");
  return { slug: raw.slug, targets };
}

/** Rotation: a new random key for one target, written to the config (0600). Returns the SHA-256 to store in that tier's Convex. */
export async function rotateKey(target: { name: string; siteUrl: string; enabled: boolean }, slug = "sieun", path = defaultConfigPath()): Promise<{ sha256: string }> {
  const config = (await readPublishConfig(path)) ?? { slug, targets: [] };
  const key = randomBytes(32).toString("base64url");
  const next = { ...target, key };
  config.targets = [...config.targets.filter(t => t.name !== target.name), next];
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  return { sha256: sha256Hex(key) };
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

// ---- payload pickers (the privacy allowlist) ----

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,79}$/;
const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A model id goes out only when it looks like a model id; anything else (a path, a free-text label) becomes "other". */
export const publicModel = (model: string): string => MODEL_ID.test(model) && !model.includes("..") ? model : "other";
export const publicSource = (source: string): string => SOURCE_ID.test(source) ? source : "other";

const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value * 100) / 100) : 0;
const nullableNum = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : null;
const rate = (value: Partial<UsageRate> | undefined): UsageRate => ({ output: num(value?.output), input: num(value?.input), cacheRead: num(value?.cacheRead), cacheWrite: num(value?.cacheWrite), total: num(value?.total) });

export type LivePayload = {
  slug: string; at: number; perSecond: UsageRate; perMinute: UsageRate; perDay: UsageRate;
  seconds: Record<UsageMetric, number[]>; costToday: number | null;
};

export function livePayload(slug: string, summary: UsageSummary): LivePayload {
  const seconds = {} as Record<UsageMetric, number[]>;
  for (const metric of USAGE_METRICS) seconds[metric] = (summary.sparkSeconds?.[metric] ?? []).slice(-60).map(num);
  return { slug, at: summary.at, perSecond: rate(summary.perSecond), perMinute: rate(summary.perMinute), perDay: rate(summary.perDay), seconds, costToday: nullableNum(summary.costToday) };
}

export const isQuiet = (payload: LivePayload): boolean => payload.perSecond.total === 0 && payload.seconds.total.every(value => value === 0);

type GroupSeries = { keys: string[]; values: number[][] };
export type DailyPayload = {
  slug: string; at: number;
  days: { t: number; tokens: UsageRate; costUsd: number | null; calls: number }[];
  groups: { model: Record<UsageMetric, GroupSeries>; source: Record<UsageMetric, GroupSeries> };
  models: { d1: PublicModelRow[]; d7: PublicModelRow[]; d30: PublicModelRow[]; all: PublicModelRow[] };
};
type PublicModelRow = { source: string; model: string; calls: number; tokens: UsageRate; costUsd: number | null; medianOutputTps: number | null };

/** One grouped series re-keyed through the allowlist and aligned to `days`; keys that map to the same public name are summed. */
export function groupSeries(series: UsageSeries, days: readonly number[], name: (key: string) => string): GroupSeries {
  const keys: string[] = [];
  const index = new Map<string, number>();
  for (const key of series.keys) {
    const out = name(key);
    if (!index.has(out)) { index.set(out, keys.length); keys.push(out); }
  }
  const byDay = new Map(series.points.map(point => [point.t, point.byKey ?? {}]));
  const values = days.map(t => {
    const row = new Array<number>(keys.length).fill(0);
    for (const [key, value] of Object.entries(byDay.get(t) ?? {})) {
      const at = index.get(name(key));
      if (at !== undefined) row[at]! += num(value);
    }
    return row;
  });
  return { keys, values };
}

const modelRow = (row: UsageModelRow): PublicModelRow => ({
  source: publicSource(row.source), model: publicModel(row.model), calls: num(row.calls),
  tokens: rate(row.tokens), costUsd: nullableNum(row.costUsd), medianOutputTps: nullableNum(row.medianOutputTps),
});

export async function dailyPayload(slug: string, usage: UsageSource, now = Date.now()): Promise<DailyPayload> {
  const base = await usage.series("all", "day", "none");
  const days = base.points.map(point => ({ t: point.t, tokens: rate(point.tokens), costUsd: nullableNum(point.costUsd), calls: num(point.calls) }));
  const ts = days.map(day => day.t);
  const groups = { model: {} as Record<UsageMetric, GroupSeries>, source: {} as Record<UsageMetric, GroupSeries> };
  for (const metric of USAGE_METRICS) {
    const [byModel, bySource] = await Promise.all([usage.series("all", "day", "model", metric), usage.series("all", "day", "source", metric)]);
    groups.model[metric] = groupSeries(byModel, ts, publicModel);
    groups.source[metric] = groupSeries(bySource, ts, publicSource);
  }
  const [d1, d7, d30, all] = await Promise.all([usage.models("24h"), usage.models("7d"), usage.models("30d"), usage.models("all")]);
  const rows = (answer: { models: UsageModelRow[] }) => answer.models.map(modelRow);
  return { slug, at: now, days, groups, models: { d1: rows(d1), d7: rows(d7), d30: rows(d30), all: rows(all) } };
}

// ---- the publisher ----

type TargetState = { target: PushTarget; nextAt: number; backoffMs: number; lastError: string | null };
export type PublisherOptions = {
  fetch?: typeof fetch; now?: () => number; log?: (line: string) => void;
  liveMs?: number; heartbeatMs?: number; dailyMs?: number; timeoutMs?: number;
};

export class UsagePublisher {
  private readonly targets: TargetState[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly liveMs: number;
  private readonly heartbeatMs: number;
  private readonly dailyMs: number;
  private readonly timeoutMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private lastQuiet = false;
  private lastLiveAt = 0;
  private lastDailyAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly usage: UsageSource, private readonly config: PublishConfig, private readonly options: PublisherOptions = {}) {
    this.targets = config.targets.filter(target => target.enabled).map(target => ({ target, nextAt: 0, backoffMs: 10_000, lastError: null }));
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.liveMs = options.liveMs ?? 5000;
    this.heartbeatMs = options.heartbeatMs ?? 60_000;
    this.dailyMs = options.dailyMs ?? 10 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 4000;
  }

  /** Starts the 5 s loop. No enabled target means no timer at all. */
  start(): void {
    if (this.timer || this.targets.length === 0) return;
    this.timer = setInterval(() => { void this.tick(); }, this.liveMs);
    this.timer.unref();
    void this.tick();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass: maybe a live push, maybe a daily push. Never throws. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const summary = await this.usage.summary();
      // While the usage worker builds or fails, it reports zeros; publishing them would show a false idle.
      if (summary.ingest.state === "error" || summary.ingest.state === "building") return;
      const now = this.now();
      const live = livePayload(this.config.slug, summary);
      const quiet = isQuiet(live);
      if (!(quiet && this.lastQuiet && now - this.lastLiveAt < this.heartbeatMs)) {
        await this.pushAll("live", live);
        this.lastLiveAt = now;
      }
      this.lastQuiet = quiet;
      if (now - this.lastDailyAt >= this.dailyMs) {
        this.lastDailyAt = now;
        await this.pushAll("daily", await dailyPayload(this.config.slug, this.usage, now));
      }
    } catch (error) {
      this.options.log?.(`usage publish: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.busy = false;
    }
  }

  private async pushAll(kind: "live" | "daily", payload: LivePayload | DailyPayload): Promise<void> {
    const body = JSON.stringify(payload);
    await Promise.all(this.targets.map(state => this.push(state, kind, body)));
  }

  private async push(state: TargetState, kind: "live" | "daily", body: string): Promise<void> {
    const now = this.now();
    if (now < state.nextAt) return;
    try {
      const response = await this.fetchImpl(`${state.target.siteUrl.replace(/\/+$/, "")}/api/sieun-usage/${kind}`, {
        method: "POST", body, signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "content-type": "application/json", authorization: `Bearer ${state.target.key}` },
      });
      if (!response.ok) throw new Error(`${response.status}`);
      state.backoffMs = 10_000;
      state.nextAt = 0;
      if (state.lastError) this.options.log?.(`usage publish ${state.target.name}: recovered`);
      state.lastError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== state.lastError) this.options.log?.(`usage publish ${state.target.name} ${kind}: ${message}; retry in ${state.backoffMs / 1000} s`);
      state.lastError = message;
      state.nextAt = now + state.backoffMs;
      state.backoffMs = Math.min(state.backoffMs * 2, 5 * 60_000);
    }
  }
}

/** Starts the publisher when a config file exists; returns a stop function. The chat backend calls this once. */
export async function startUsagePublisher(usage: UsageSource, log?: (line: string) => void, path = defaultConfigPath()): Promise<() => void> {
  let config: PublishConfig | null;
  try { config = await readPublishConfig(path); }
  catch (error) { log?.(`usage publish: ${error instanceof Error ? error.message : String(error)}`); return () => {}; }
  if (!config) return () => {};
  const publisher = new UsagePublisher(usage, config, log ? { log } : {});
  publisher.start();
  return () => publisher.close();
}
