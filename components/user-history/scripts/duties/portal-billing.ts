import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DutyMetric, FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { DAY, MINUTE, REPO, SOURCE_DEADLINE_MS, frameRows, grafanaClient, readGrafanaAuth, settle, unmeasuredFlag, utc } from "./estate-reads.ts";

/**
 * The api portal vp chat's "Portal billing" precheck (`node --import tsx scripts/duties/portal-billing.ts`). No model call. It reads prod and
 * staging, and its only writes are 8 probe calls, one throwaway staging test org it seeds and deletes, and $0.0005 to $0.002 a day on the
 * VIREV_API_KEY_PROD org.
 * It answers the owner's question after portal billing broke three times in a week, each found by luck: does every call cost what its answer is
 * worth? On 10-18 a crawl preset billed empty pages (a18c147dc9), a burst skipped the rate count and intelligence.profile served bundles free
 * (cb6b4904eb, 0982ee03ca), and Hacker News presets charged $0.0005 for a missing user, a missing item and a zero-hit search (a07e3b3337).
 * 1. billing_mismatches_24h, the headline: prod /v1 calls of the last 24 h whose charge does not match the answer. It pairs each api-portal
 *    request line the Vercel drain writes to otel_logs (ClickHouse, ServiceName api-portal, one START line per request with its status and
 *    duration) with the prod Convex apiPortalUsage row of the same catalog operation written inside that request. A 2xx of a priced operation
 *    with no row is a call served free; a priced row that pairs only with a non-2xx answer is a charge for an error. Operations come from
 *    apps/api-portal/src/lib/server/operations.ts at the commit prod runs (newest READY api-portal production deployment). 202 job answers
 *    are left out, since their charge is the crawlJob row written when the job ends.
 * 2. uncounted_calls_24h: prod calls that logged `[gateway] rate_check_failed` or `[gateway] deduct_failed` and still answered 2xx, joined on
 *    vercel.requestId. Prod's gateway at a8f85b4206 lets a call through when the rate check fails (failMode open); 0982ee03ca answers 503.
 * 3. empty_charged_probe: one call each to a missing Hacker News user, a zero-hit Hacker News search and a missing Instagram profile, which
 *    must cost $0, and to Hacker News user pg, which must cost the price its openapi x-dashboard-cost names when it answers 2xx and $0 when it
 *    does not, on staging-api.virev.ai (a seeded test org) and api.virev.ai (VIREV_API_KEY_PROD). The charge is the sum of that env's
 *    apiPortalUsage rows for the answer's request_id, so it reads the ledger, never the answer's own meta.cost.
 *
 * Targets in portal-billing.duty.json (the JSON cannot hold comments): all three are <= 0, because a mismatch is money the customer should
 * not pay or a call the portal gave away, and the gateway's own rule since 10-18 is that both never happen.
 * A source that failed makes the metrics it feeds read missValue() and adds a source_error flag.
 * Both 24 h counts give `lastEventAt`, the epoch ms of the newest call they count (a served-free call's start, a charge-on-error row's
 * creation, an uncounted call's newest failure line), and none when the count is 0. On 10-20 uncounted_calls_24h still read prod's
 * fail-open rate check calls after the fix, so a count no new call raised now reads quiet and a fresh one reads live.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DUTY_FILE = join(HERE, "portal-billing.duty.json");
const OPERATIONS = "apps/api-portal/src/lib/server/operations.ts";
const CLICKHOUSE = { uid: "grafana_clickhouse", type: "grafana-clickhouse-datasource" };
/**
 * A request's row lands while it runs, and the request line's duration leaves out the hop from Vercel's proxy and a cold start. On 10-19 every
 * prod row of the last 24 h paired within 3 s past the line's end and 1 s left 173 unpaired, so 10 s holds with room.
 */
export const PAIR_SLACK_MS = 10_000;
/** Calls this close to either end of the 24 h window may have their row or line outside it, so they are not judged. */
export const EDGE_MS = 10 * MINUTE;
/**
 * The drain drops a few request lines in bursts: on 10-19, 99 of 17,924 prod rows (0.6%) had no line, all in our own monitor bursts. Below
 * 90% paired the drain or the query is broken, and a zero would only mean nothing was read.
 */
export const MIN_PAIRED_SHARE = 0.9;
/**
 * Each probe call ends by this deadline, so one hung route leaves only its own probe unjudged. On 10-21 at 04:15Z prod probes answered in 1.8 to
 * 5.1 s and staging's Hacker News 502s in 12.7 s, while staging's instagram missing profile call never answered and aborted the whole staging
 * source at the 110 s source deadline twice; the seed and ledger reads after it took 0.6 s, so 60 s leaves them room.
 */
export const PROBE_DEADLINE_MS = 60_000;

export interface Operation { id: string; path: string; method: string; costMicros: number }
/** One prod request line: its Vercel request id, method, path without query, status, start (proxy timestamp) and duration in ms. */
export interface RequestLine { rid: string; method: string; path: string; status: number; start: number; durationMs: number }
/** One apiPortalUsage row. `source.kind` is batch, crawlJob, reversal or void, or absent for a plain /v1 call. */
export interface UsageRow { requestId: string; operation: string; costMicros: number; createdAt: number; orgId?: string; source?: { kind: string } }
export interface Probe { name: string; path: string; query: Record<string, string>; empty: boolean }
export interface ProbeResult { env: Env; probe: string; status: number; requestId?: string; expected: number; charged?: number; error?: string }
export type Env = "staging" | "prod";

/** The probe calls, the same on both envs. Each ends in a ledger read of its request_id. */
export const PROBES: readonly Probe[] = [
  { name: "hn missing user", path: "/v1/crawl/hackernews/profile", query: { id: "zzq_nouser_8f3k2x" }, empty: true },
  { name: "hn zero-hit search", path: "/v1/crawl/hackernews/search", query: { q: "zzqxv8f3k2xnohitsqq" }, empty: true },
  { name: "instagram missing profile", path: "/v1/instagram/profile", query: { q: "zzq_nouser_8f3k2x_q" }, empty: true },
  { name: "hn user pg", path: "/v1/crawl/hackernews/profile", query: { id: "pg" }, empty: false },
];

export type Source = "prod catalog" | "prod requests" | "prod ledger" | "gateway failures" | "staging probes" | "prod probes";
export const FEEDS: Readonly<Record<Source, readonly string[]>> = {
  "prod catalog": ["billing_mismatches_24h"],
  "prod requests": ["billing_mismatches_24h"],
  "prod ledger": ["billing_mismatches_24h"],
  "gateway failures": ["uncounted_calls_24h"],
  "staging probes": ["empty_charged_probe"],
  "prod probes": ["empty_charged_probe"],
};

/** One gateway failure group: `lastAt` is the epoch ms of its newest failure line. */
export interface Uncounted { kind: string; status: string; path: string; calls: number; lastAt: number }
export interface BillingData {
  now: number;
  sha?: string;
  operations?: Operation[];
  requests?: RequestLine[];
  ledger?: UsageRow[];
  uncounted?: Uncounted[];
  probes: ProbeResult[];
  errors: { source: Source; message: string }[];
}

// ---- pure ----

/** The catalog operation of a request: same method, path matching the catalog path with `{param}` as one segment, fewest params first. */
export function operationMatcher(operations: readonly Operation[]): (method: string, path: string) => Operation | undefined {
  const compiled = operations.map(op => ({ op, params: (op.path.match(/\{/g) ?? []).length,
    pattern: new RegExp(`^${op.path.split(/\{[^}]+\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")}$`) }))
    .sort((a, b) => a.params - b.params);
  return (method, path) => compiled.find(entry => entry.op.method === method && entry.pattern.test(path))?.op;
}

/**
 * Pairs request intervals [start, start + duration + slack] with row times, one row each: requests in order of their end, each taking the
 * earliest free row at or after its start. That order pairs the most requests possible. Returns the pairs, the unpaired requests and rows.
 */
export function pair<R extends { start: number; durationMs: number }, U extends { createdAt: number }>(requests: readonly R[], rows: readonly U[], slackMs: number) {
  const sortedRows = [...rows].sort((a, b) => a.createdAt - b.createdAt);
  const used = new Array<boolean>(sortedRows.length).fill(false);
  const pairs: [R, U][] = [];
  const unpaired: R[] = [];
  for (const request of [...requests].sort((a, b) => (a.start + a.durationMs) - (b.start + b.durationMs))) {
    const end = request.start + request.durationMs + slackMs;
    let low = 0, high = sortedRows.length;
    while (low < high) { const mid = (low + high) >> 1; if (sortedRows[mid]!.createdAt < request.start) low = mid + 1; else high = mid; }
    while (low < sortedRows.length && used[low]) low++;
    if (low < sortedRows.length && sortedRows[low]!.createdAt <= end) { used[low] = true; pairs.push([request, sortedRows[low]!]); }
    else unpaired.push(request);
  }
  return { pairs, unpaired, rowsLeft: sortedRows.filter((_, index) => !used[index]) };
}

export interface Reconciled { servedFree: { op: string; line: RequestLine }[]; chargedOnError: { op: string; line: RequestLine; row: UsageRow }[]; paired: number; rows: number; lineless: number }

/** Matches prod request lines to ledger rows per operation over [now - 24 h, now], leaving EDGE_MS at both ends unjudged. */
export function reconcile(operations: readonly Operation[], requests: readonly RequestLine[], ledger: readonly UsageRow[], now: number): Reconciled {
  const from = now - DAY + EDGE_MS, to = now - EDGE_MS;
  const inWindow = (at: number) => at >= from && at <= to;
  const opOf = operationMatcher(operations);
  const price = new Map(operations.map(op => [op.id, op.costMicros]));
  const undone = new Set(ledger.filter(row => row.source?.kind === "reversal" || row.source?.kind === "void").map(row => row.requestId));
  const lines = new Map<string, RequestLine[]>();
  for (const line of requests) {
    if (line.status === 202) continue;
    const op = opOf(line.method, line.path);
    if (op) lines.set(op.id, [...lines.get(op.id) ?? [], line]);
  }
  const rows = new Map<string, UsageRow[]>();
  for (const row of ledger) if (!row.source || row.source.kind === "batch") rows.set(row.operation, [...rows.get(row.operation) ?? [], row]);
  const result: Reconciled = { servedFree: [], chargedOnError: [], paired: 0, rows: 0, lineless: 0 };
  for (const op of new Set([...lines.keys(), ...rows.keys()])) {
    const all = lines.get(op) ?? [];
    const ok = pair(all.filter(line => line.status >= 200 && line.status < 300), rows.get(op) ?? [], PAIR_SLACK_MS);
    const failed = pair(all.filter(line => line.status >= 300), ok.rowsLeft, PAIR_SLACK_MS);
    if ((price.get(op) ?? 0) > 0) for (const line of ok.unpaired) if (inWindow(line.start)) result.servedFree.push({ op, line });
    for (const [line, row] of failed.pairs)
      if (row.costMicros > 0 && !undone.has(row.requestId) && inWindow(row.createdAt)) result.chargedOnError.push({ op, line, row });
    result.paired += ok.pairs.filter(([, row]) => inWindow(row.createdAt)).length;
    result.rows += (rows.get(op) ?? []).filter(row => inWindow(row.createdAt)).length;
    result.lineless += failed.rowsLeft.filter(row => inWindow(row.createdAt)).length;
  }
  return result;
}

/** "$0.0005" as micros, the unit apiPortalUsage stores. */
export const micros = (cost: string): number => {
  const match = /^\$(\d+(?:\.\d+)?)$/.exec(cost.trim());
  if (!match) throw new Error(`unreadable x-dashboard-cost ${cost}`);
  return Math.round(Number(match[1]) * 1_000_000);
};

/** What a probe answer must cost: its price only for the known-good input answered 2xx, else nothing. */
export const expectedCharge = (probe: Probe, status: number, price: number): number => !probe.empty && status >= 200 && status < 300 ? price : 0;

const counts = <T>(items: readonly T[], key: (item: T) => string): string =>
  [...items.reduce((map, item) => map.set(key(item), (map.get(key(item)) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} x${count}`).join(", ");

/** The duty's metrics and flags from what the sources returned. */
export function report(data: BillingData, dutyMetrics: readonly DutyMetric[]): PrecheckOutput {
  const at = data.now;
  const flagged: FlaggedSlice[] = [];
  const metrics: Record<string, number> = {};
  const lastEventAt: Record<string, number> = {};
  const unmeasured = new Set<string>();
  const sourceError = (source: Source, message: string) => {
    for (const key of FEEDS[source]) unmeasured.add(key);
    flagged.push({ at, kind: "source_error", excerpt: `${source}: ${message}`.slice(0, 300) });
  };
  for (const error of data.errors) sourceError(error.source, error.message);

  if (data.operations && data.requests && data.ledger) {
    const result = reconcile(data.operations, data.requests, data.ledger, at);
    const share = result.rows ? result.paired / result.rows : 1;
    if (share < MIN_PAIRED_SHARE) sourceError("prod requests", `only ${result.paired} of ${result.rows} prod ledger rows paired with a drained request line (${Math.round(share * 1000) / 10}%), so the api-portal drain into otel_logs lost lines`);
    else {
      metrics.billing_mismatches_24h = result.servedFree.length + result.chargedOnError.length;
      if (metrics.billing_mismatches_24h) lastEventAt.billing_mismatches_24h = Math.max(...result.servedFree.map(entry => entry.line.start), ...result.chargedOnError.map(entry => entry.row.createdAt));
      if (result.servedFree.length) flagged.push({ at, kind: "served_free", excerpt: `${result.servedFree.length} prod 2xx answers of priced operations have no apiPortalUsage row at prod's ${data.sha?.slice(0, 10) ?? "deployed commit"}: ${counts(result.servedFree, entry => entry.op)}; e.g. ${result.servedFree.slice(0, 3).map(entry => `${entry.line.rid} ${entry.line.path} ${utc(entry.line.start)}`).join(", ")}`.slice(0, 300) });
      if (result.chargedOnError.length) flagged.push({ at, kind: "charged_on_error", excerpt: `${result.chargedOnError.length} prod charges pair only with an error answer: ${counts(result.chargedOnError, entry => `${entry.op} ${entry.line.status}`)}; e.g. ${result.chargedOnError.slice(0, 3).map(entry => `${entry.row.requestId} ${entry.row.costMicros} micros ${utc(entry.row.createdAt)}`).join(", ")}`.slice(0, 300) });
    }
  }

  if (data.uncounted) {
    const served = data.uncounted.filter(row => row.status.startsWith("2"));
    metrics.uncounted_calls_24h = served.reduce((sum, row) => sum + row.calls, 0);
    if (metrics.uncounted_calls_24h) lastEventAt.uncounted_calls_24h = Math.max(...served.filter(row => row.calls > 0).map(row => row.lastAt));
    if (served.length) {
      const byKind = new Map<string, number>();
      for (const row of served) byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + row.calls);
      const paths = [...served].sort((a, b) => b.calls - a.calls).slice(0, 4).map(row => `${row.path} x${row.calls}`).join(", ");
      flagged.push({ at, kind: "uncounted", excerpt: `${metrics.uncounted_calls_24h} prod calls answered 2xx after the gateway failed to count or charge them in 24 h at prod's ${data.sha?.slice(0, 10) ?? "deployed commit"}: ${[...byKind].map(([kind, n]) => `${kind} x${n}`).join(", ")}; top ${paths}`.slice(0, 300) });
    }
  }

  const judged = data.probes.filter(result => result.charged !== undefined);
  const misses = judged.filter(result => result.charged !== result.expected);
  if (!unmeasured.has("empty_charged_probe") && judged.length) metrics.empty_charged_probe = misses.length;
  for (const miss of misses) flagged.push({ at, kind: "probe_charge", excerpt: `${miss.env} ${miss.probe} answered ${miss.status} and was charged ${miss.charged} micros where ${miss.expected} is right (request ${miss.requestId})` });
  for (const result of data.probes.filter(entry => entry.charged === undefined))
    flagged.push({ at, kind: "probe_unjudged", excerpt: `${result.env} ${result.probe}: ${result.error ?? "no request id or ledger row read"}`.slice(0, 300) });

  const replaced = settle(dutyMetrics, metrics, unmeasured);
  if (replaced.length) flagged.push(unmeasuredFlag(replaced, at));
  for (const key of unmeasured) delete lastEventAt[key];
  return { metrics, flagged, ...Object.keys(lastEventAt).length ? { lastEventAt } : {} };
}

// ---- I/O ----

const sh = (command: string, cwd: string, signal: AbortSignal) => new Promise<string>((resolve, reject) => {
  execFile("/bin/sh", ["-c", command], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, signal }, (error, stdout, stderr) =>
    error ? reject(new Error(`${error.message.split("\n")[0]} ${String(stderr).trim().slice(-200)}`)) : resolve(stdout));
});
const lastLine = (text: string) => text.trim().split("\n").at(-1)?.trim() ?? "";

interface EnvFile { urls: { apiPortal: string; convex: string }; keySources: Record<string, { cmd: string }> }
const envFile = async (name: Env): Promise<EnvFile> => JSON.parse(await readFile(join(REPO, `apps/llm-wiki/specs/envs/${name}.json`), "utf8")) as EnvFile;
/** The Convex deployment name of an env's site URL: https://befitting-sparrow-356.convex.site is befitting-sparrow-356. */
const deploymentOf = (env: EnvFile) => new URL(env.urls.convex).hostname.split(".")[0]!;

/** An admin client for one Convex deployment, authorized by the owner's Convex CLI login, the way `convex run --deployment-name` is. */
async function convexAdmin(deployment: string, signal: AbortSignal) {
  const accessToken = (JSON.parse(await readFile(join(homedir(), ".convex/config.json"), "utf8")) as { accessToken: string }).accessToken;
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "convex-client": "npm-cli-1.34.0" };
  const auth = await fetch("https://api.convex.dev/api/deployment/authorize_within_current_project", { method: "POST", headers, signal,
    body: JSON.stringify({ selectedDeploymentName: deployment, projectSelection: { kind: "deploymentName", deploymentName: deployment, deploymentType: null } }) });
  const credentials = await auth.json().catch(() => null) as { adminKey?: string; url?: string } | null;
  if (!auth.ok || !credentials?.adminKey || !credentials.url) throw new Error(`Convex authorize for ${deployment} gave HTTP ${auth.status}`);
  const { adminKey, url } = credentials;
  return async (path: string, args: unknown): Promise<unknown> => {
    const response = await fetch(`${url}/api/query`, { method: "POST", signal,
      headers: { authorization: `Convex ${adminKey}`, "content-type": "application/json", "convex-client": "npm-cli-1.34.0" },
      body: JSON.stringify({ path, args, format: "json" }) });
    const body = await response.json().catch(() => null) as { status?: string; errorMessage?: string; value?: unknown } | null;
    if (body?.status !== "success") throw new Error(`${deployment} ${path}: HTTP ${response.status} ${String(body?.errorMessage ?? "no value").slice(0, 160)}`);
    return body.value;
  };
}

/** apiPortalUsage rows created at or after `since`, newest first, through the CLI's table reader. */
async function ledgerSince(query: (path: string, args: unknown) => Promise<unknown>, since: number): Promise<UsageRow[]> {
  const rows: UsageRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await query("_system/cli/tableData", { table: "apiPortalUsage", order: "desc", paginationOpts: { numItems: 1000, cursor } }) as
      { page: (UsageRow & { _creationTime: number })[]; isDone: boolean; continueCursor: string };
    for (const row of page.page) if (row._creationTime >= since) rows.push(row);
    if (page.isDone || !page.page.length || page.page.at(-1)!._creationTime < since) return rows;
    cursor = page.continueCursor;
  }
}

/** The commit of the newest READY api-portal production deployment (vercelApi in auto-sns-agent scripts/repo/env/vercel-blobs.mjs). */
async function prodSha(): Promise<string> {
  const vercel = await import(pathToFileURL(join(REPO, "scripts/repo/env/vercel-blobs.mjs")).href) as {
    vercelApi: (path: string, options: { query: Record<string, string> }) => Promise<{ deployments?: { meta?: { githubCommitSha?: string } }[] }>;
    TEAM_ID: string; APPS: Record<string, { projectId: string }>;
  };
  const answer = await vercel.vercelApi("/v6/deployments", { query: { projectId: vercel.APPS["api-portal"]!.projectId, teamId: vercel.TEAM_ID, target: "production", state: "READY", limit: "1" } });
  const commit = answer.deployments?.[0]?.meta?.githubCommitSha;
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("the newest READY api-portal production deployment names no commit");
  return commit;
}

/** API_OPERATIONS from operations.ts at `sha`, imported from a temp copy. */
async function catalogAt(sha: string, signal: AbortSignal): Promise<Operation[]> {
  const source = await sh(`git cat-file -e ${sha}^{commit} 2>/dev/null || git fetch --quiet origin main; git show ${sha}:${OPERATIONS}`, REPO, signal);
  const dir = await mkdtemp(join(tmpdir(), "portal-billing-"));
  try {
    const file = join(dir, "operations.ts");
    await writeFile(file, source);
    const mod = await import(pathToFileURL(file).href) as { API_OPERATIONS?: Record<string, Operation> };
    const operations = Object.values(mod.API_OPERATIONS ?? {});
    if (!operations.length) throw new Error(`${OPERATIONS} at ${sha.slice(0, 10)} has no API_OPERATIONS`);
    return operations;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const PROD_LOGS = "ServiceName = 'api-portal' AND ResourceAttributes['deployment.environment.name'] = 'production'";
/** One row per prod /v1 request from the START line the Vercel drain writes, over the window plus EDGE_MS before it. */
export const REQUESTS_SQL = (now: number) => `SELECT LogAttributes['vercel.requestId'] AS rid, any(LogAttributes['vercel.proxy.method']) AS method,
 any(splitByChar('?', LogAttributes['vercel.proxy.path'])[1]) AS path, any(LogAttributes['vercel.statusCode']) AS status,
 any(LogAttributes['vercel.proxy.timestamp']) AS start, max(toInt64OrZero(extract(Body, 'Duration: (\\\\d+) ms'))) AS duration
FROM otel_logs WHERE Timestamp >= fromUnixTimestamp64Milli(${now - DAY - EDGE_MS}) AND ${PROD_LOGS}
 AND LogAttributes['vercel.source'] = 'lambda' AND LogAttributes['vercel.type'] = 'stdout' AND Body LIKE 'START RequestId%' AND LogAttributes['vercel.path'] LIKE '/v1/%'
GROUP BY rid`;
/** Prod calls of the last 24 h with a gateway count or charge failure line, by failure, the answer's status and route. */
export const UNCOUNTED_SQL = (now: number) => `SELECT f.kind AS kind, r.status AS status, r.path AS path, count() AS calls, max(f.at) AS last FROM
(SELECT LogAttributes['vercel.requestId'] AS rid, if(Body LIKE '[gateway] rate_check_failed%', 'rate_check_failed', 'deduct_failed') AS kind,
 toUnixTimestamp64Milli(max(Timestamp)) AS at FROM otel_logs
 WHERE Timestamp >= fromUnixTimestamp64Milli(${now - DAY}) AND ${PROD_LOGS} AND LogAttributes['vercel.type'] = 'stderr'
 AND (Body LIKE '[gateway] rate_check_failed%' OR Body LIKE '[gateway] deduct_failed%') GROUP BY rid, kind) AS f
LEFT JOIN
(SELECT LogAttributes['vercel.requestId'] AS rid, any(LogAttributes['vercel.statusCode']) AS status, any(LogAttributes['vercel.path']) AS path FROM otel_logs
 WHERE Timestamp >= fromUnixTimestamp64Milli(${now - DAY - EDGE_MS}) AND ${PROD_LOGS} AND LogAttributes['vercel.source'] = 'lambda'
 AND LogAttributes['vercel.type'] = 'stdout' AND Body LIKE 'START RequestId%' GROUP BY rid) AS r
ON f.rid = r.rid GROUP BY kind, status, path`;

/** Calls the probes on one env and reads that env's ledger for each answer's request_id. */
async function probeEnv(env: Env, key: string, headers: Record<string, string>, query: (path: string, args: unknown) => Promise<unknown>, signal: AbortSignal): Promise<ProbeResult[]> {
  const file = await envFile(env);
  const doc = await (await fetch(`${file.urls.apiPortal}/openapi.json`, { headers, signal })).json() as { paths: Record<string, { get?: { "x-dashboard-cost"?: string } }> };
  const started = Date.now();
  const results = await Promise.all(PROBES.map(async (probe): Promise<ProbeResult> => {
    const url = new URL(file.urls.apiPortal + probe.path);
    for (const [name, value] of Object.entries(probe.query)) url.searchParams.set(name, value);
    try {
      const cost = doc.paths[probe.path]?.get?.["x-dashboard-cost"];
      if (!cost) throw new Error(`${env} openapi has no x-dashboard-cost for GET ${probe.path}`);
      const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(PROBE_DEADLINE_MS)]);
      const response = await fetch(url, { headers: { ...headers, authorization: `Bearer ${key}` }, signal: probeSignal });
      const body = await response.json().catch(() => null) as { meta?: { request_id?: string }; error?: { request_id?: string } } | null;
      const requestId = body?.meta?.request_id ?? body?.error?.request_id;
      const result: ProbeResult = { env, probe: probe.name, status: response.status, expected: expectedCharge(probe, response.status, micros(cost)) };
      return requestId ? { ...result, requestId } : { ...result, error: `HTTP ${response.status} with no request_id` };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return { env, probe: probe.name, status: 0, expected: 0, error: timedOut ? `no answer in ${PROBE_DEADLINE_MS / 1000} s` : error instanceof Error ? error.message : String(error) };
    }
  }));
  const rows = await ledgerSince(query, started - MINUTE);
  return results.map(result => result.requestId === undefined ? result
    : { ...result, charged: rows.filter(row => row.requestId === result.requestId).reduce((sum, row) => sum + row.costMicros, 0) });
}

/** Staging probes run under a throwaway org seeded through the staging Convex test routes, deleted again at the end. */
async function stagingProbes(signal: AbortSignal): Promise<ProbeResult[]> {
  const file = await envFile("staging");
  const [bypass, secret] = await Promise.all(["VERCEL_AUTOMATION_BYPASS_SECRET", "CONVEX_WEBHOOK_SECRET"].map(async name => lastLine(await sh(file.keySources[name]!.cmd, REPO, signal))));
  if (!bypass || !secret) throw new Error("the staging bypass secret or CONVEX_WEBHOOK_SECRET is empty");
  const query = await convexAdmin(deploymentOf(file), signal);
  const key = `kb_live_${randomBytes(16).toString("hex")}`;
  const orgId = `org_duty_billing_${Date.now()}`;
  const post = (path: string, body: object) => fetch(`${file.urls.convex}${path}`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, secret }) });
  const seeded = await post("/api/test/seed", { keyHash: createHash("sha256").update(key).digest("hex"), keyPrefix: key.slice(0, 16), name: "portal billing duty", orgId,
    actorUserId: "duty|portal-billing", balanceMicros: 1_000_000 });
  if (!seeded.ok) throw new Error(`staging /api/test/seed gave HTTP ${seeded.status}: ${(await seeded.text()).slice(0, 160)}`);
  const keyId = ((await seeded.json()) as { keyId?: string }).keyId;
  try {
    return await probeEnv("staging", key, { "x-vercel-protection-bypass": bypass }, query, signal);
  } finally {
    if (keyId) await post("/api/test/revoke-key", { keyId }).catch(() => undefined);
    await post("/api/test/cleanup", { orgId }).catch(() => undefined);
  }
}

async function prodProbes(signal: AbortSignal): Promise<ProbeResult[]> {
  const key = process.env.VIREV_API_KEY_PROD || lastLine(await sh("cd apps/api-portal && npx --no-install dotenvx get VIREV_API_KEY_PROD -f .env", REPO, signal));
  if (!key.startsWith("kb_live_")) throw new Error("VIREV_API_KEY_PROD from apps/api-portal/.env is not a kb_live_ key");
  return probeEnv("prod", key, {}, await convexAdmin(deploymentOf(await envFile("prod")), signal), signal);
}

async function measure(now: number, signal: AbortSignal): Promise<BillingData> {
  const data: BillingData = { now, probes: [], errors: [] };
  const step = async <T>(source: Source, run: () => Promise<T>): Promise<T | undefined> => {
    try { return await run(); } catch (error) { data.errors.push({ source, message: error instanceof Error ? error.message : String(error) }); return undefined; }
  };
  const clickhouse = step("prod requests", async () => {
    const query = grafanaClient(fetch, await readGrafanaAuth(), now, signal);
    return async (rawSql: string) => frameRows(await query({ datasource: CLICKHOUSE, rawSql, format: 1, queryType: "sql" }));
  });
  const [operations, requests, ledger, uncounted, staging, prod] = await Promise.all([
    step("prod catalog", async () => { const sha = await prodSha(); data.sha = sha; return catalogAt(sha, signal); }),
    clickhouse.then(read => read && step("prod requests", async () => (await read(REQUESTS_SQL(now))).map((row): RequestLine => ({
      rid: String(row.rid), method: String(row.method), path: String(row.path), status: Number(row.status), start: Number(row.start), durationMs: Number(row.duration) || 0,
    })).filter(line => Number.isFinite(line.start) && line.status > 0))),
    step("prod ledger", async () => ledgerSince(await convexAdmin(deploymentOf(await envFile("prod")), signal), now - DAY - EDGE_MS)),
    clickhouse.then(read => read ? step("gateway failures", async () => (await read(UNCOUNTED_SQL(now))).map((row): Uncounted => ({
      kind: String(row.kind), status: String(row.status ?? ""), path: String(row.path ?? ""), calls: Number(row.calls), lastAt: Number(row.last),
    }))) : (data.errors.push({ source: "gateway failures", message: "no ClickHouse read" }), undefined)),
    step("staging probes", () => stagingProbes(signal)),
    step("prod probes", () => prodProbes(signal)),
  ]);
  if (operations) data.operations = operations;
  if (requests) {
    if (!requests.length) data.errors.push({ source: "prod requests", message: "otel_logs holds no api-portal /v1 request line for the last 24 h" });
    else data.requests = requests;
  }
  if (ledger) data.ledger = ledger;
  if (uncounted) data.uncounted = uncounted;
  data.probes = [...staging ?? [], ...prod ?? []];
  return data;
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("portal-billing: OUTPUT_FILE is not set\n"); process.exit(2); }
  const dutyMetrics = (JSON.parse(await readFile(DUTY_FILE, "utf8")) as { metrics: DutyMetric[] }).metrics;
  const now = Date.now();
  const result = report(await measure(now, AbortSignal.timeout(SOURCE_DEADLINE_MS)), dutyMetrics);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(`portal-billing: ${Object.entries(result.metrics).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
