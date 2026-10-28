import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type DutyMetric, type FlaggedSlice, PRECHECK_TARGET_MS } from "../../src/shared/chat-duties.ts";

/**
 * Read-only access to the estate's Grafana for the launch main bro duty prechecks (engage-reads.ts, watchlist-green.ts).
 * Grafana ds/query on obs.virev.ai serves the prod and staging Postgres datasources (estate_pg_prod, estate_pg_stg, user grafana_ro) and the
 * prod and staging Prometheus datasources (estate_prometheus, estate_prometheus_stg). The login is the admin pair in auto-sns-agent's
 * apps/infra/aws/secrets.env, the same one auto-sns-agent scripts/duties/crawler/crawler-pipeline.mjs uses.
 * prodReader below runs the prod reads that the parsers take as psql lines, through estate_pg_prod as well.
 * A metric whose source failed gets `missValue`, a number that misses any target, so a broken source never reads as green.
 */

export const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
const GRAFANA_QUERY = "https://obs.virev.ai/api/ds/query";
export const PG = { prod: "estate_pg_prod", staging: "estate_pg_stg" } as const;
export const PROM = { prod: "estate_prometheus", staging: "estate_prometheus_stg" } as const;
export const UNMEASURED = 999_999;
/**
 * Every source read ends by this deadline. The runner's soft precheck target is PRECHECK_TARGET_MS (120 s, src/shared/chat-duties.ts), and writing
 * the output took under 1 s in the 2026-10-12 runs, so the 10 s left keeps the run inside its target even when a source hangs.
 */
export const SOURCE_DEADLINE_MS = PRECHECK_TARGET_MS - 10_000;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The value for a metric that was not measured: it misses any target, and its size says it is not a real count. */
export const missValue = (metric: Pick<DutyMetric, "op" | "target">): number =>
  metric.op === "<=" ? Math.max(UNMEASURED, metric.target + 1) : Math.min(-UNMEASURED, metric.target - 1);

/** Gives every duty metric a number: a key in `unmeasured`, or with no finite value, gets missValue(). Returns the keys it replaced. */
export function settle(dutyMetrics: readonly DutyMetric[], metrics: Record<string, number>, unmeasured: ReadonlySet<string>): string[] {
  const replaced: string[] = [];
  for (const metric of dutyMetrics) {
    const value = metrics[metric.key];
    if (unmeasured.has(metric.key) || typeof value !== "number" || !Number.isFinite(value)) { metrics[metric.key] = missValue(metric); replaced.push(metric.key); }
  }
  for (const key of Object.keys(metrics)) if (!dutyMetrics.some(metric => metric.key === key)) delete metrics[key];
  return replaced;
}

export const unmeasuredFlag = (replaced: readonly string[], at: number): FlaggedSlice => ({
  at, kind: "unmeasured",
  excerpt: `Not measured this run, so the value is ${UNMEASURED} or -${UNMEASURED} and counts as a miss: ${replaced.join(", ")}. Fix the source_error first.`.slice(0, 300),
});

/** The Grafana basic auth header from the KEY=value lines of secrets.env; throws when a key is missing or still encrypted. */
export function grafanaAuth(secrets: string): string {
  const get = (key: string): string => {
    const value = new RegExp(`^${key}=(.*)$`, "m").exec(secrets)?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (!value || value.startsWith("encrypted:")) throw new Error(`${key} is missing or encrypted in apps/infra/aws/secrets.env`);
    return value;
  };
  return `Basic ${Buffer.from(`${get("GRAFANA_ADMIN_USER")}:${get("GRAFANA_ADMIN_PASSWORD")}`).toString("base64")}`;
}

export const readGrafanaAuth = async (): Promise<string> => grafanaAuth(await readFile(join(REPO, "apps/infra/aws/secrets.env"), "utf8"));

interface Frame { schema: { fields: { name: string; labels?: Record<string, string> }[] }; data: { values: unknown[][] } }
/** One query through Grafana ds/query (refId A) over the hour to now, or over `span`; throws on an HTTP or query error. */
export type DsQuery = (query: Record<string, unknown>, span?: { from: number; to: number }) => Promise<Frame[]>;

export function grafanaClient(fetcher: typeof fetch, auth: string, now: number, signal: AbortSignal): DsQuery {
  return async (query, span = { from: now - HOUR, to: now }) => {
    const response = await fetcher(GRAFANA_QUERY, {
      method: "POST", signal, headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ queries: [{ refId: "A", ...query }], from: String(span.from), to: String(span.to) }),
    });
    const body = await response.json().catch(() => null) as { results?: { A?: { error?: string; frames?: Frame[] } }; message?: string } | null;
    const result = body?.results?.A;
    if (!response.ok || !result || result.error) throw new Error(`Grafana HTTP ${response.status}: ${String(result?.error ?? body?.message ?? "no result").slice(0, 200)}`);
    return result.frames ?? [];
  };
}

/** The rows of a table frame as objects. */
export function frameRows(frames: readonly Frame[]): Record<string, unknown>[] {
  const frame = frames[0];
  if (!frame) return [];
  const names = frame.schema.fields.map(field => field.name);
  const columns = frame.data.values;
  return Array.from({ length: columns[0]?.length ?? 0 }, (_, row) => Object.fromEntries(names.map((name, column) => [name, columns[column]?.[row]])));
}

/** The latest value and labels of each series in an instant-query answer. */
export function frameSeries(frames: readonly Frame[]): { labels: Record<string, string>; value: number }[] {
  return frames.filter(frame => frame.schema.fields.length > 1 && (frame.data.values[1]?.length ?? 0) > 0)
    .map(frame => ({ labels: frame.schema.fields[1]!.labels ?? {}, value: Number(frame.data.values[1]!.at(-1)) }));
}

export const sqlRows = async (query: DsQuery, uid: string, rawSql: string): Promise<Record<string, unknown>[]> =>
  frameRows(await query({ datasource: { uid }, rawSql, format: "table" }));

export const promInstant = async (query: DsQuery, uid: string, expr: string): Promise<{ labels: Record<string, string>; value: number }[]> =>
  frameSeries(await query({ datasource: { uid }, expr, instant: true, range: false }));

/** Every point of each series in a range-query answer over [from, to], one point every `stepMs`. */
export const promRange = async (query: DsQuery, uid: string, expr: string, from: number, to: number, stepMs: number): Promise<{ labels: Record<string, string>; points: [number, number][] }[]> =>
  (await query({ datasource: { uid }, expr, instant: false, range: true, intervalMs: stepMs, maxDataPoints: Math.ceil((to - from) / stepMs) + 1 }, { from, to }))
    .filter(frame => frame.schema.fields.length > 1)
    .map(frame => ({ labels: frame.schema.fields[1]!.labels ?? {}, points: (frame.data.values[0] ?? []).map((t, index): [number, number] => [Number(t), Number(frame.data.values[1]![index])]) }));

/** A number from a SQL cell; null and an empty cell stay null. */
export const num = (value: unknown): number | null => value === null || value === undefined || value === "" ? null : Number(value);
export const round1 = (value: number): number => Math.round(value * 10) / 10;
export const utc = (ms: number): string => `${new Date(ms).toISOString().slice(5, 16).replace("T", " ")}Z`;

/**
 * The prod reads that need more columns than the Grafana panels also go through estate_pg_prod, as grafana_ro, whose role sets
 * default_transaction_read_only (auto-sns-agent apps/infra/metal/config/postgres/grafana-ro-prod.sql, which lists each column it may read).
 * Until 10-27 they ran as owner_ro over wg-prod to 10.250.12.1:5432; owner rule c180 (2026-10-27) took prod off us-metal02, and
 * wg-quick@wg-prod stopped there at 23:13:54Z on 10-27, so a d2 run at 23:30Z failed "prod rows: The operation was aborted".
 * A ProdRead answers with psql's unaligned tab-separated lines (`psql -tA -F '\t'`), which the duty parsers read: a boolean prints t or f
 * and a null an empty cell. Grafana refuses a frame with two columns of one name, so every prod read names its columns.
 */
export type ProdRead = (sql: string) => Promise<string>;

export const cellText = (value: unknown): string =>
  value === null || value === undefined ? "" : typeof value === "boolean" ? (value ? "t" : "f") : String(value);

/** The rows of a table frame as psql's unaligned lines, cells in column order, each line ending in a newline. */
export function frameLines(frames: readonly Frame[]): string {
  const columns = frames[0]?.data.values ?? [];
  return Array.from({ length: columns[0]?.length ?? 0 }, (_, row) => `${columns.map(column => cellText(column[row])).join("\t")}\n`).join("");
}

/** Runs one SQL statement on prod through Grafana's estate_pg_prod and returns its rows as psql's lines; throws on an HTTP or query error. */
export const prodReader = (query: DsQuery): ProdRead => async sql => frameLines(await query({ datasource: { uid: PG.prod }, rawSql: sql, format: "table" }));
