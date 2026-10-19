import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type DutyMetric, type FlaggedSlice, PRECHECK_TARGET_MS } from "../../src/shared/chat-duties.ts";

/**
 * Read-only access to the estate's Grafana for the launch main bro duty prechecks (engage-reads.ts, watchlist-green.ts).
 * Grafana ds/query on obs.virev.ai serves the prod and staging Postgres datasources (estate_pg_prod, estate_pg_stg, user grafana_ro) and the
 * prod and staging Prometheus datasources (estate_prometheus, estate_prometheus_stg). The login is the admin pair in auto-sns-agent's
 * apps/infra/aws/secrets.env, the same one auto-sns-agent scripts/duties/crawler/crawler-pipeline.mjs uses.
 * The prod box us-metal01 answers the reads grafana_ro cannot make (watch_targets) through `ssh`, as owner_ro in a read-only transaction.
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
/** One query through Grafana ds/query (refId A); throws on an HTTP or query error. */
export type DsQuery = (query: Record<string, unknown>) => Promise<Frame[]>;

export function grafanaClient(fetcher: typeof fetch, auth: string, now: number, signal: AbortSignal): DsQuery {
  return async query => {
    const response = await fetcher(GRAFANA_QUERY, {
      method: "POST", signal, headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ queries: [{ refId: "A", ...query }], from: String(now - HOUR), to: String(now) }),
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

/** A number from a SQL cell; null and an empty cell stay null. */
export const num = (value: unknown): number | null => value === null || value === undefined || value === "" ? null : Number(value);
export const round1 = (value: number): number => Math.round(value * 10) / 10;
export const utc = (ms: number): string => `${new Date(ms).toISOString().slice(5, 16).replace("T", " ")}Z`;

const BOX = "root@64.34.205.243";

/** Runs a bash script on the prod box us-metal01 and returns its stdout; throws on a nonzero exit. */
export function ssh(script: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", BOX, "bash -s"], { stdio: ["pipe", "pipe", "pipe"], signal });
    let out = "";
    let err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(out) : reject(new Error(`ssh exit ${code}: ${(err || out).trim().slice(-300)}`)));
    child.stdin.end(script);
  });
}
