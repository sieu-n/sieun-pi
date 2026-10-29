import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { checkCleanup } from "./test-org-cleanup.ts";

/**
 * The api portal vp chat's "Portal matches crawler" precheck (`node --import tsx scripts/duties/portal-parity.ts`). No model call.
 * It answers the owner's "is all apis working that work in crawler api work for api portal? all working in prod?" on prod and staging:
 * 1. It reads four openapi.json files: crawler.virev.ai and staging-crawler.virev.ai (each env's crawler routes), api.virev.ai (prod) and
 *    staging-api.virev.ai (through the Vercel automation bypass).
 * 2. On each env it calls every documented non-DM /v1 operation once with its own docs example. Staging calls go out under throwaway test
 *    orgs that it seeds through the staging Convex /api/test/seed route and deletes again through /api/test/cleanup. Prod calls use
 *    VIREV_API_KEY_PROD and skip only the writes SPEC-93 never makes on prod. The paid reads SPEC-93 leaves out of its prod run for cost
 *    (intelligence profile, contact and custom reads) are called here once a UTC day, and the run output lists what each prod call cost.
 * 3. It sorts each answer: 2xx works, an `upstream_*` or `capacity_exhausted` code is a crawler cause (the portal passes crawler errors on that way), anything
 *    else is a portal cause, and a call it could not make or judge is unprobed. A page-1 answer with a cursor gets one page-2 call.
 * 4. It maps answers to crawler routes through portal-parity.routes.json: an env scores a route its own crawler lists, the route works there
 *    when one of its /v1 operations works there, and a route with no /v1 operation in that env's openapi is missing there.
 * A source it cannot read, an env's crawler openapi included, gives -1 for that env's share, a source_errors count and a flagged slice.
 *
 * Sources for the targets in portal-parity.duty.json (the JSON cannot hold comments):
 * - prod_working_pct >= 100 and staging_working_pct >= 100: the owner's words ask for every crawler route, and board goal p18 "Every crawler
 *   route works through our public API the same as in the crawler".
 * - routes_failing_portal <= 0 and routes_failing_crawler <= 0: the same ask, split by who fixes it.
 * Comparing a body against the crawler's own answer is left out: it needs a matched crawler call per route with the portal's parameter
 * renames, which this precheck does not rebuild. Board item p11 owns the 5 differing routes.
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Each env's crawler openapi. Each env scores a route only when its own crawler lists it, because on 2026-10-27 the staging crawler moved
 * every platform to /api/live/<network>/<op> (auto-sns-agent bcb1732a0d and the six commits after it) while prod kept the old routes until
 * the next promote, and the 10-28 00:02Z run scored staging against prod's crawler and counted 63 renamed routes as portal failures.
 */
export const CRAWLER_OPENAPI: Record<"prod" | "staging", string> = { prod: "https://crawler.virev.ai/openapi.json", staging: "https://staging-crawler.virev.ai/openapi.json" };
const PROD_OPENAPI = "https://api.virev.ai/openapi.json";
/**
 * The prod org key: VIREV_API_KEY_PROD from the environment, else decrypted from apps/api-portal/.env with the repo's dotenvx.
 * The key source in apps/llm-wiki/specs/envs/prod.json exits 1 since auto-sns-agent 4a68dc4b85 (2026-10-18 11:28Z), which left
 * the 12:36Z run with prod_working_pct -1 and 150 routes unprobed. The key is never printed.
 */
const PROD_KEY_CMD = "cd apps/api-portal && npx dotenvx get VIREV_API_KEY_PROD -f .env";
/** The "could not measure" value, the same one auto-sns-agent scripts/duties/ci/ci-guarantees.mjs prints. */
export const UNMEASURED = 999999;
/**
 * Test orgs per run. The portal allows 100 REST calls a minute per org (DEFAULT_REQUESTS_PER_MINUTE.rest in
 * apps/virev-demo/convex/apiPortal/rateLimits.ts) and 5 open crawl jobs per org (the 429 rate_limited message, measured on staging 2026-10-12).
 * The run makes about 110 calls and 9 of them start jobs, so 3 orgs keep each under both limits.
 */
export const ORGS = 3;
/** Fake staging balance per org: the audit's full staging run cost about $0.27 (findings-brief.md), so $1 covers a third of a run several times. */
const BALANCE_MICROS = 1_000_000;
/**
 * A call runs until the env answers, with no cut of this run's own: on 10-19 the 70 s page-1 cut this run had left 11 to 59 prod routes
 * unprobed, because the calls past the portal's 100 a minute started at the next clock minute. apps/api-portal sets no maxDuration, so
 * Vercel's function limit (300 s by default with fluid compute) ends a call the portal never answers. Node's fetch gives up on an answer
 * with no headers after the same 300 s (undici's default headersTimeout), so the run sees that call as UND_ERR_HEADERS_TIMEOUT and counts it
 * as a portal failure (`NO_ANSWER`): a customer waits as long and gets nothing. At the 10-20 00:00Z daily run 16 prod calls ended this way at
 * 300.0 to 300.6 s and showed as unprobed. The precheck's timeoutMs in portal-parity.duty.json is a soft target, and the runner lets a run
 * go past it (c98).
 */
const NO_ANSWER = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
/**
 * The portal allows an org 100 REST calls in each clock minute (DEFAULT_REQUESTS_PER_MINUTE.rest and currentWindowStart in
 * apps/virev-demo/convex/apiPortal/rateLimits.ts), so an env's calls start one every 60 s / (100 x its orgs) (pacedSlot): prod's one org one
 * every 0.6 s, staging's ORGS one every 0.2 s.
 */
const ORG_PER_MINUTE = 100;
/**
 * The per-minute pace of an env's calls with these orgs. Staging was unpaced until 10-23: at 08:40:03Z the run started 173 staging calls in
 * one second, the one crawler-api process took about 233 requests at once, its /api/live reads took 11.8 s at p50 and two Home widget reads
 * answered 504 at the search app's 4.6 s cut. The same 168 crawler GETs replayed at once on 10-23 13:40Z waited 1.2 s at p50 for a DB
 * session; started one every 0.2 s they waited 0 ms at p50 and 117 ms at most, and the calls took 164 ms at p50 against 2.7 s.
 */
export function perMinute(orgs: readonly unknown[]): number {
  return ORG_PER_MINUTE * Math.max(1, orgs.length);
}
/** Response keys that carry the next page, and the query parameter that takes it back. */
const CURSOR_KEYS = ["next_cursor", "cursor", "continuationToken", "continuation_token", "next_page_id"] as const;

interface Param { name: string; in: string; required?: boolean; example?: unknown; schema?: { example?: unknown }; examples?: Record<string, { value?: unknown }> }
export interface Operation { parameters?: Param[]; requestBody?: { content?: Record<string, { example?: unknown; examples?: Record<string, { value?: unknown }>; schema?: { example?: unknown } }> }; "x-example-query"?: Record<string, unknown> }
export type OpenApi = { paths?: Record<string, Record<string, Operation>> };
/**
 * One crawler route and the /v1 operations that reach it. `envs` limits the entry to those envs, for a route whose crawler path stayed while
 * the portal side changed on one env only, such as the Douyin stored reads that prod still pauses by design and staging serves.
 */
export interface Route { crawler: string; group: string; portal: string[]; byDesign?: string; envs?: Env[] }
export interface ProbeRequest { method: string; path: string; query: Record<string, string>; body?: unknown }
export type Verdict = "ok" | "crawler" | "portal" | "unprobed" | "skipped";
export interface ProbeResult { op: string; verdict: Verdict; status: number; ms: number; code?: string | undefined; note: string; costUsd?: number }
/**
 * `ms` holds each "<env> <op>" call's last answer time, which orders the next run's page-1 calls slowest first. `paidAt` holds when each
 * paid prod read last got an answer, so the run calls it once a UTC day.
 */
export interface ParityState { verdicts: Record<string, Verdict>; ms?: Record<string, number>; paidAt?: Record<string, number> }
/** The saved state, or undefined for none. The duty runner seeds STATE_FILE with "{}" before the first run, which has no verdicts. */
export function parseState(text: string): ParityState | undefined {
  const state = JSON.parse(text) as Partial<ParityState> | null;
  if (!state || typeof state.verdicts !== "object" || state.verdicts === null) return undefined;
  const record = (value: unknown) => typeof value === "object" && value !== null ? value as Record<string, number> : undefined;
  const ms = record(state.ms), paidAt = record(state.paidAt);
  return { verdicts: state.verdicts, ...(ms ? { ms } : {}), ...(paidAt ? { paidAt } : {}) };
}

/** Every operation in an openapi document as "METHOD /path". */
export function operations(doc: OpenApi): Map<string, Operation> {
  const out = new Map<string, Operation>();
  for (const [path, ops] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(ops)) if (["get", "post", "put", "patch", "delete"].includes(method)) out.set(`${method.toUpperCase()} ${path}`, op);
  }
  return out;
}

/** DM operations are never called: a send reaches a real Instagram user (c37), and board item p12 owns DM. */
export const isDm = (op: string) => / \/v1\/instagram\/dm(\/|$)/.test(op);
/** A route map entry "GET /v1/x job" is GET /v1/x in job mode. */
export const JOB = " job";
export const baseOp = (op: string) => op.endsWith(JOB) ? op.slice(0, -JOB.length) : op;
/**
 * The job-mode request of an operation: its docs example with max_pages 2. The docs say "The default request creates a durable job (202).
 * Use max_pages=1 for one synchronous Page response (200)" (GET /v1/instagram/user_feed), so 2 is the smallest job.
 */
export function jobRequest(request: ProbeRequest): ProbeRequest {
  return { ...request, query: { ...request.query, max_pages: "2" } };
}
/** Operations whose path id comes from an earlier answer in the same run. */
export const CHAINED = /\{(job_id|snapshot_id)\}/;

/**
 * Operations whose query input comes only from another operation's answer in this run, called with the first item id of that answer.
 * A Xiaohongshu note opens only with the xsec_token an explore answer issues, so note_detail's fixed docs example answered 502
 * acquisition_credential_unavailable on staging on 2026-10-28 at 00:02Z, while 10 of 10 notes from an explore answer opened there at 01:4xZ.
 */
export const QUERY_CHAINS: Readonly<Record<string, { from: string; param: string }>> = {
  "GET /v1/xiaohongshu/note_detail": { from: "GET /v1/xiaohongshu/explore", param: "note_id" },
};

/** The first item id of a list answer, whose `data` is the list or holds it as `items`. */
export function firstItemId(body: unknown): string | undefined {
  const data = (body as { data?: unknown } | null)?.data;
  const list = Array.isArray(data) ? data : (data as { items?: unknown } | null)?.items;
  const id = Array.isArray(list) ? (list[0] as { id?: unknown } | undefined)?.id : undefined;
  return typeof id === "string" && id ? id : undefined;
}
/**
 * Runs the chained operations of one id with every read answered before any write starts, so a cancel or a delete never ends the job or
 * snapshot that a read of the same run is about to read. On staging, where the cancel is called, the reads and the cancel used to start
 * together: on 10-20 at 14:23:57Z POST /v1/jobs/{job_id}/cancel reached staging Convex 33 ms before GET /v1/jobs/{job_id}/results, which
 * then read a cancelled job and answered 502 upstream_error "The crawl job failed". The cancel came first at every staging run that scored the
 * results route as a crawler failure (10-19 05:16Z and 06:05Z, 10-20 14:23Z), and at the 14:37Z run both reads came 4 ms before it and passed.
 */
export async function readsThenWrites<E extends readonly [string, ...unknown[]], T>(entries: readonly E[], run: (entry: E) => Promise<T>): Promise<T[]> {
  const isRead = (entry: E) => entry[0].startsWith("GET ");
  const reads = await Promise.all(entries.filter(isRead).map(run));
  return [...reads, ...await Promise.all(entries.filter(entry => !isRead(entry)).map(run))];
}

/** The batch statuses the docs name as still running: GET /v1/batch/snapshot/{snapshot_id} answers 409 snapshot_not_ready while a job is in one. */
const BATCH_RUNNING = new Set(["starting", "running"]);
export const SNAPSHOT_READ = "GET /v1/batch/snapshot/{snapshot_id}";
/** One progress read a second keeps a job's polls at 60 a minute, under the 100 calls a minute its org may make (ORG_PER_MINUTE). */
export const BATCH_POLL_MS = 1_000;
/**
 * The longest a docs-example job can run: its 3 rows run at once (MAX_INFLIGHT_PER_ORG is 8 in auto-sns-agent convex/apiPortal/batch/model.ts),
 * and each row makes at most MAX_ITEM_ATTEMPTS 3 calls, each ended by Vercel's 300 s function limit, with retry waits of 10 s and 20 s
 * (RETRY_BASE_MS doubling) between them.
 */
export const BATCH_DEADLINE_MS = 3 * 300_000 + 10_000 + 20_000;

/** The fields of a batch progress answer this run reads. */
export interface BatchProgress { status?: unknown; rows_total?: unknown; rows_ready?: unknown; rows_failed?: unknown }

/**
 * Polls GET /v1/batch/progress/{snapshot_id} until the job leaves `starting` and `running`, as the docs tell a caller to before it downloads
 * ("poll `progress`, download the finished snapshot"). On 10-29 at 02:25Z the run read a snapshot 0.8 s after its trigger and got 409
 * snapshot_not_ready, and a staging repro at 05:33Z read 409 1.0 s after the trigger, then ready on the first progress read and 200 on the download.
 * It stops early on a progress answer that is not 2xx and once BATCH_DEADLINE_MS has passed, and gives the number of progress reads and the
 * last progress the job answered.
 */
export async function untilBatchEnds(read: () => Promise<{ status: number; body: unknown }>, now: () => number = Date.now,
  sleep: (ms: number) => Promise<unknown> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<{ reads: number; progress?: BatchProgress }> {
  const end = now() + BATCH_DEADLINE_MS;
  for (let reads = 1; ; reads++) {
    const answer = await read();
    const progress = (answer.body as { data?: BatchProgress } | null)?.data;
    const ok = answer.status >= 200 && answer.status < 300;
    if (!ok || typeof progress?.status !== "string" || !BATCH_RUNNING.has(progress.status) || now() >= end) return ok && progress ? { reads, progress } : { reads };
    await sleep(BATCH_POLL_MS);
  }
}

/**
 * Why a finished job counts as broken, or null when it does not: a job whose every row failed still ends `ready` and downloads 200 with no
 * rows. Until 10-29 the trigger docs example sent `q` rows to instagram.web_profile_info, every row failed invalid_request, and d2 scored the
 * snapshot read as working on both envs.
 */
export function batchRowsBroken(progress: BatchProgress | undefined): string | null {
  const { rows_total: total, rows_ready: ready, rows_failed: failed } = progress ?? {};
  if (typeof total !== "number" || total < 1 || ready !== 0) return null;
  return `every row of the job failed (rows_failed ${String(failed)} of ${total})`;
}

const exampleOf = (param: Param) => param.example ?? param.schema?.example ?? Object.values(param.examples ?? {})[0]?.value;

/**
 * The docs example request of an operation: the curated `x-example-query` when the docs carry one, else every required parameter's example,
 * else the first optional parameter with an example (for one-of pairs like id or url, where sending both is a 400). Null names what is missing.
 */
export function buildRequest(op: string, operation: Operation, ids: Record<string, string> = {}): ProbeRequest | { missing: string } {
  const [method, template] = op.split(" ") as [string, string];
  let path = template;
  const query: Record<string, string> = {};
  const params = operation.parameters ?? [];
  for (const param of params.filter(p => p.in === "path")) {
    const value = ids[param.name] ?? (CHAINED.test(`{${param.name}}`) ? undefined : exampleOf(param));
    if (value === undefined) return { missing: `no ${param.name} from an earlier answer in this run` };
    path = path.replace(`{${param.name}}`, encodeURIComponent(String(value)));
  }
  if (operation["x-example-query"]) Object.assign(query, Object.fromEntries(Object.entries(operation["x-example-query"]).map(([k, v]) => [k, String(v)])));
  else {
    for (const param of params.filter(p => p.in === "query" && p.required)) {
      const value = exampleOf(param);
      if (value === undefined) return { missing: `required query ${param.name} has no docs example` };
      query[param.name] = String(value);
    }
    if (!Object.keys(query).length) {
      const first = params.find(p => p.in === "query" && exampleOf(p) !== undefined);
      if (first) query[first.name] = String(exampleOf(first));
    }
  }
  if (!operation.requestBody) return { method, path, query };
  const content = operation.requestBody.content?.["application/json"];
  const body = content?.example ?? Object.values(content?.examples ?? {})[0]?.value ?? content?.schema?.example;
  return body === undefined ? { missing: "the request body has no docs example" } : { method, path, query, body };
}

/**
 * The portal's code for the crawler's 503 fleet_exhausted: every logged-in reader the crawler may spend on the read is busy
 * (apps/api-portal/src/lib/server/gateway.ts), so the fix is in the crawler's reader fleet, not the portal.
 */
const CRAWLER_CAPACITY = "capacity_exhausted";
/**
 * The portal's 503 on job results when a closed crawl route, such as the Instagram feed breaker, failed the job (auto-sns-agent
 * 2a71670a01, apps/api-portal/src/lib/server/crawl-jobs.ts): the fix is in the crawler.
 */
const CRAWLER_CLOSED = "temporarily_unavailable";
const JOB_FINISHED = "job_finished";
/** The portal's 429 when the org's calls this clock minute reached its limit; it answers with Retry-After (apps/api-portal/src/lib/server/gateway.ts). */
const RATE_LIMITED = "rate_limit_exceeded";

/** The error code of a portal error body, if any. */
export function errorCode(body: unknown): string | undefined {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Who a probe answer blames. 2xx works. `upstream_*` is the crawler, because the portal passes crawler failures on with that code
 * (audit findings-brief.md). 429 and 402 come from this run's own test orgs, and status 0 is a call that got no answer, so those are unprobed.
 * Every other answer is the portal's: a 503 batch_unavailable, a 400 on the docs example or on the portal's own cursor, a 5xx of its own.
 */
export function classify(status: number, body: unknown): { verdict: Verdict; code?: string | undefined } {
  const code = errorCode(body);
  if (status >= 200 && status < 300) return { verdict: "ok" };
  // A cancel of a job that already ended answers 409 job_finished with the job's real state, which is the route working.
  if (status === 409 && code === JOB_FINISHED) return { verdict: "ok", code };
  if (status === 0 || status === 429 || status === 402) return { verdict: "unprobed", code };
  if (code?.startsWith("upstream_") || code === CRAWLER_CAPACITY || code === CRAWLER_CLOSED) return { verdict: "crawler", code };
  return { verdict: "portal", code };
}

/**
 * The next-page token in a page-1 answer and the parameter the operation takes it in, or null when there is no next page to try.
 * An answer that says `has_more: false` has no next page: on 2026-10-18 prod GET /v1/facebook/live/profile/events for nasa answered
 * `has_more: false` and `cursor: null` with the Page's `next_page_id`, and sending that id as `cursor` hung prod for 90 s.
 */
export function nextPage(operation: Operation, body: unknown): { param: string; value: string } | null {
  const accepts = new Set((operation.parameters ?? []).filter(p => p.in === "query").map(p => p.name));
  const record = body as { data?: Record<string, unknown>; meta?: Record<string, unknown> } | null;
  for (const holder of [record?.data, record?.meta, record as Record<string, unknown> | null]) {
    if (!holder || typeof holder !== "object" || Array.isArray(holder)) continue;
    if (holder.has_more === false) return null;
    for (const key of CURSOR_KEYS) {
      const value = holder[key];
      if (typeof value !== "string" || !value) continue;
      const param = accepts.has(key) ? key : accepts.has("cursor") ? "cursor" : accepts.has("continuationToken") ? "continuationToken" : null;
      if (param) return { param, value };
    }
  }
  return null;
}

/**
 * Ids for chained operations from this run's answers, with the index of the answer that gave each: a job id from any 202 job receipt,
 * a snapshot id from the batch trigger. Jobs are owner-checked, so the chained call must use the test org of that answer.
 */
export function chainIds(bodies: readonly unknown[]): Record<string, { value: string; from: number }> {
  const ids: Record<string, { value: string; from: number }> = {};
  bodies.forEach((body, from) => {
    const data = (body as { data?: Record<string, unknown> } | null)?.data;
    if (!data) return;
    if (!ids.job_id && typeof data.batch_id === "string" && data.batch_id.startsWith("job_")) ids.job_id = { value: data.batch_id, from };
    if (!ids.snapshot_id && typeof data.snapshot_id === "string") ids.snapshot_id = { value: data.snapshot_id, from };
  });
  return ids;
}

/** The two envs the duty measures, as the owner asked ("all working in prod?", "local-staging-prod"). */
export const ENVS = ["prod", "staging"] as const;
export type Env = typeof ENVS[number];
/** The "could not measure" value of a share: below any target, so a run that measured nothing never looks on target. */
export const UNMEASURED_PCT = -1;
/** How one crawler route does through the portal on one env. `skipped` is a route SPEC-93 does not call on prod because it is a write. */
export type RouteVerdict = "works" | "missing" | "portal" | "crawler" | "unprobed" | "skipped";

/** Whether a route entry applies to an env: it names no envs, or names this one. */
export const appliesTo = (route: Route, env: Env) => !route.envs || route.envs.includes(env);

/**
 * The routes an env scores: not byDesign, applying to the env, and listed in that env's crawler openapi. With that openapi unread
 * (`crawlerOps` null) every applying route counts, and the env's share is unmeasured.
 */
export function scoredRoutes(routes: readonly Route[], env: Env, crawlerOps: Map<string, Operation> | null): Route[] {
  return routes.filter(route => !route.byDesign && appliesTo(route, env) && (!crawlerOps || crawlerOps.has(route.crawler)));
}

/** A route's verdict on one env from that env's documented operations (null when unread) and that env's probe results. */
export function routeVerdict(route: Route, ops: Map<string, Operation> | null, byOp: ReadonlyMap<string, ProbeResult>): RouteVerdict {
  if (!ops) return "unprobed";
  const listed = route.portal.filter(op => ops.has(baseOp(op)));
  if (!listed.length) return "missing";
  const results = listed.map(op => byOp.get(op));
  if (results.some(result => result?.verdict === "ok")) return "works";
  if (results.every(result => result?.verdict === "skipped")) return "skipped";
  if (results.some(result => result?.verdict === "portal")) return "portal";
  if (results.some(result => result?.verdict === "crawler")) return "crawler";
  return "unprobed";
}

/**
 * The duty's metrics. The headline is the share of customer crawler routes whose /v1 route works on prod; staging_working_pct is the same on
 * staging. Each env scores the routes its own crawler openapi lists (scoredRoutes), and an env whose crawler openapi is unread has an
 * unmeasured share. routes_failing_portal counts routes that fail on either env for a portal cause (no /v1 route there, or a portal error), and
 * routes_failing_crawler those that fail with an upstream crawler error and no portal cause. Every other count goes to the run detail.
 */
export function parityMetrics(input: {
  routes: readonly Route[]; crawler: Record<Env, OpenApi | null>; docs: Record<Env, OpenApi | null>; probes: Record<Env, readonly ProbeResult[]>;
  sourceErrors: readonly string[]; previous?: ParityState | undefined; at: number; prodCostUsd?: number; paid?: ReadonlySet<string>;
  cleanupErrors?: readonly string[];
}): { output: PrecheckOutput; state: ParityState } {
  const { routes, at } = input;
  const cleanupErrors = input.cleanupErrors ?? [];
  const flagged: FlaggedSlice[] = [...input.sourceErrors, ...cleanupErrors].map(excerpt => ({ at, kind: "source_error", excerpt: excerpt.slice(0, 300) }));
  const crawlerOps = Object.fromEntries(ENVS.map(env => [env, input.crawler[env] && operations(input.crawler[env]!)])) as Record<Env, Map<string, Operation> | null>;
  const listedSomewhere = (route: Route) => ENVS.some(env => appliesTo(route, env) && (!crawlerOps[env] || crawlerOps[env]!.has(route.crawler)));
  for (const route of routes) if (!listedSomewhere(route)) flagged.push({ at, kind: "crawler_route_gone", excerpt: `${route.crawler} is in neither crawler openapi it applies to; drop it from portal-parity.routes.json if that is meant` });
  for (const route of routes) if (route.byDesign && listedSomewhere(route)) flagged.push({ at, kind: "by_design", excerpt: `${route.crawler}${route.envs ? ` on ${route.envs.join(", ")}` : ""}: ${route.byDesign}` });
  const scoredBy = Object.fromEntries(ENVS.map(env => [env, scoredRoutes(routes, env, crawlerOps[env])])) as Record<Env, Route[]>;
  const scored = routes.filter(route => ENVS.some(env => scoredBy[env].includes(route)));
  const metrics: Record<string, number> = {};
  const verdicts: Record<Env, Map<Route, RouteVerdict>> = { prod: new Map(), staging: new Map() };
  for (const env of ENVS) {
    const doc = input.docs[env];
    const ops = doc && operations(doc);
    const byOp = new Map(input.probes[env].map(probe => [probe.op, probe]));
    for (const route of scoredBy[env]) verdicts[env].set(route, crawlerOps[env] ? routeVerdict(route, ops, byOp) : "unprobed");
    const count = (verdict: RouteVerdict) => [...verdicts[env].values()].filter(value => value === verdict).length;
    const judged = scoredBy[env].length - count("skipped");
    metrics[`${env}_routes_scored`] = scoredBy[env].length;
    metrics[`${env}_working_pct`] = ops && crawlerOps[env] && input.probes[env].length && judged ? Math.round(1000 * count("works") / judged) / 10 : UNMEASURED_PCT;
    for (const verdict of ["works", "missing", "portal", "crawler", "unprobed", "skipped"] as const) metrics[`${env}_routes_${verdict}`] = count(verdict);
    metrics[`${env}_v1_ops_called`] = input.probes[env].filter(probe => probe.verdict !== "skipped").length;
    const missing = scoredBy[env].filter(route => verdicts[env].get(route) === "missing");
    const byGroup = new Map<string, string[]>();
    for (const route of missing) byGroup.set(route.group, [...(byGroup.get(route.group) ?? []), route.crawler]);
    for (const [group, list] of byGroup) flagged.push({ at, kind: `missing_${env}`, item: group, excerpt: `${group}: ${list.length} crawler routes with no /v1 route on ${env}: ${list.join(", ")}`.slice(0, 600) });
    for (const probe of input.probes[env]) {
      if (probe.verdict === "ok") continue;
      flagged.push({ at, kind: probe.verdict === "unprobed" || probe.verdict === "skipped" ? `${probe.verdict}_${env}` : `broken_${probe.verdict}_${env}`,
        excerpt: `${probe.op} on ${env}: ${probe.status || "no answer"}${probe.code ? ` ${probe.code}` : ""} after ${probe.ms} ms, ${probe.note}`.slice(0, 400) });
      const before = input.previous?.verdicts[`${env} ${probe.op}`] ?? (env === "staging" ? input.previous?.verdicts[probe.op] : undefined);
      if (before === "ok" && (probe.verdict === "portal" || probe.verdict === "crawler")) flagged.push({ at, kind: "regression", excerpt: `${probe.op} worked on ${env} at the last run and now fails (${probe.status} ${probe.code ?? ""})`.trim() });
    }
  }
  const either = (wanted: RouteVerdict[]) => scored.filter(route => ENVS.some(env => { const verdict = verdicts[env].get(route); return verdict !== undefined && wanted.includes(verdict); }));
  const portalRoutes = either(["missing", "portal"]);
  const portalSet = new Set(portalRoutes);
  metrics.routes_failing_portal = portalRoutes.length;
  metrics.routes_failing_crawler = either(["crawler"]).filter(route => !portalSet.has(route)).length;
  metrics.routes_scored = scored.length;
  metrics.source_errors = input.sourceErrors.length + cleanupErrors.length;
  // A run whose staging test orgs were not deleted never passes: its staging share is unmeasured (test-org-cleanup.ts).
  if (cleanupErrors.length) metrics.staging_working_pct = UNMEASURED_PCT;
  if (input.prodCostUsd !== undefined) metrics.prod_cost_usd = Math.round(input.prodCostUsd * 10_000) / 10_000;
  const paid = input.probes.prod.filter(probe => probe.costUsd).sort((a, b) => b.costUsd! - a.costUsd!);
  if (paid.length) flagged.push({ at, kind: "prod_cost", excerpt: `Prod cost per call, highest first: ${paid.map(probe => `${probe.op} $${probe.costUsd}`).join(", ")}`.slice(0, 600) });
  const state: ParityState = { verdicts: { ...input.previous?.verdicts } };
  for (const env of ENVS) for (const probe of input.probes[env]) if (probe.verdict !== "skipped" && probe.verdict !== "unprobed") state.verdicts[`${env} ${probe.op}`] = probe.verdict;
  state.ms = { ...input.previous?.ms };
  for (const env of ENVS) for (const probe of input.probes[env]) if (probe.ms > 0) state.ms[`${env} ${probe.op}`] = probe.ms;
  state.paidAt = { ...input.previous?.paidAt };
  for (const probe of input.probes.prod) if (input.paid?.has(probe.op) && probe.ms > 0 && ["ok", "portal", "crawler"].includes(probe.verdict)) state.paidAt[probe.op] = at;
  return { output: { metrics, flagged }, state };
}

// ---- I/O ----

const sh = (command: string, cwd: string) => new Promise<string>((resolve, reject) => {
  execFile("/bin/sh", ["-c", command], { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
});

async function getJson(url: string, headers: Record<string, string> = {}): Promise<OpenApi> {
  const response = await fetch(url, { headers, redirect: "manual" });
  if (response.status !== 200) throw new Error(`GET ${url} gave HTTP ${response.status}`);
  return await response.json() as OpenApi;
}

interface Org { id: string; key: string; keyId?: string | undefined }

async function seedOrg(convex: string, secret: string, index: number, at: number): Promise<Org> {
  const key = `kb_live_${randomBytes(16).toString("hex")}`;
  const id = `org_duty_parity_${at}_${index}`;
  const response = await fetch(`${convex}/api/test/seed`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ keyHash: createHash("sha256").update(key).digest("hex"), keyPrefix: key.slice(0, 16), name: "portal parity duty", orgId: id,
      actorUserId: "duty|portal-parity", balanceMicros: BALANCE_MICROS, secret }),
  });
  if (!response.ok) throw new Error(`staging /api/test/seed gave HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`);
  return { id, key, keyId: ((await response.json()) as { keyId?: string }).keyId };
}

async function cleanupOrg(convex: string, secret: string, org: Org): Promise<void> {
  const post = (path: string, body: object) => fetch(`${convex}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, secret }) });
  if (org.keyId) await post("/api/test/revoke-key", { keyId: org.keyId });
  await checkCleanup(post("/api/test/cleanup", { orgId: org.id }), org.id);
}

type Answer = ProbeResult & { body: unknown; retryAfterS?: number };

async function probe(base: string, extra: Record<string, string>, org: Org, op: string, request: ProbeRequest, note: string): Promise<Answer> {
  const url = new URL(base + request.path);
  for (const [key, value] of Object.entries(request.query)) url.searchParams.set(key, value);
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: request.method,
      headers: { authorization: `Bearer ${org.key}`, ...extra, ...(request.body === undefined ? {} : { "content-type": "application/json" }) },
      body: request.body === undefined ? null : JSON.stringify(request.body),
      redirect: "manual",
    });
    const text = await response.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = null; }
    const { verdict, code } = classify(response.status, body);
    const message = (body as { error?: { message?: string } } | null)?.error?.message;
    const retryAfterS = Number(response.headers.get("retry-after"));
    return { op, verdict, status: response.status, ms: Date.now() - start, code, note: message ? `${note}: ${message}` : body === null && text ? `${note}: not JSON: ${text.slice(0, 80)}` : note, body,
      ...(Number.isFinite(retryAfterS) && retryAfterS > 0 ? { retryAfterS } : {}) };
  } catch (error) {
    const ms = Date.now() - start;
    const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    if (typeof cause === "string" && NO_ANSWER.has(cause))
      return { op, verdict: "portal", status: 0, ms, code: "no_answer", note: `${note}: the portal sent no answer in ${Math.round(ms / 1000)} s (${cause})`, body: null };
    return { op, verdict: "unprobed", status: 0, ms, note: `${note}: ${error instanceof Error ? error.message : String(error)}`, body: null };
  }
}

/**
 * Cancels one job this run started, so it stops holding one of the org's 5 open job slots. The staging cancel answered in 756 ms on 10-15.
 * True when the job holds no slot any more: 200 cancelled, 409 job_finished, or 404 for a job the portal no longer has.
 */
async function cancelJob(base: string, extra: Record<string, string>, org: Org, id: string): Promise<boolean> {
  return fetch(`${base}/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: { authorization: `Bearer ${org.key}`, ...extra }, signal: AbortSignal.timeout(10_000) })
    .then(response => { void response.body?.cancel(); return [200, 404, 409].includes(response.status); }).catch(() => false);
}

/**
 * Prod jobs a run opened and has not cancelled yet, one file per run, `<pid>.json` under JOBS_DIR. A run that dies before its last cancel
 * leaves its first job open: on 10-19 runs started at 02:25Z, 03:04Z, 17:09Z and 17:12Z, none of them a duty run, left 4 prod user_feed jobs
 * running 4 to 19 h while the crawler retried them, which held 4 of the prod org's 5 job slots, so job-mode calls got 429. So each run first
 * cancels the jobs in the file of every run whose process is gone (`cancelLeftovers`).
 */
const JOBS_DIR = process.env.PORTAL_PARITY_JOBS_DIR || join(homedir(), ".cache/virev/portal-parity-jobs");

export interface JobLedger { add(id: string): Promise<void>; drop(id: string): Promise<void> }

/** This run's file of open jobs. It writes on each change and deletes the file once no job is open. */
export function jobLedger(dir: string, pid = process.pid): JobLedger {
  const file = join(dir, `${pid}.json`);
  const ids = new Set<string>();
  let writing = Promise.resolve();
  const save = () => writing = writing.then(async () => {
    if (!ids.size) return void await rm(file, { force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify([...ids]) + "\n");
  }).catch(() => undefined);
  return { add: id => { ids.add(id); return save(); }, drop: id => { ids.delete(id); return save(); } };
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The open jobs in the files of runs whose process is gone. */
export async function leftoverJobs(dir: string, alive: (pid: number) => boolean = pidAlive): Promise<{ file: string; ids: string[] }[]> {
  const out: { file: string; ids: string[] }[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const pid = Number(name.replace(/\.json$/, ""));
    if (!name.endsWith(".json") || !Number.isSafeInteger(pid) || pid <= 0 || alive(pid)) continue;
    const ids: unknown = await readFile(join(dir, name), "utf8").then(text => JSON.parse(text) as unknown).catch(() => []);
    out.push({ file: join(dir, name), ids: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [] });
  }
  return out;
}

/** Cancels the prod jobs that runs which are gone left open, and keeps in their files only the ones whose cancel got no answer. */
export async function cancelLeftovers(base: string, org: Org): Promise<void> {
  for (const { file, ids } of await leftoverJobs(JOBS_DIR)) {
    const kept = (await Promise.all(ids.map(async id => await cancelJob(base, {}, org, id) ? null : id))).filter(id => id !== null);
    await (kept.length ? writeFile(file, JSON.stringify(kept) + "\n") : rm(file, { force: true }));
  }
}

/**
 * The start gate of a run with a per-minute quota: one call every 60 s / perMinute, so no clock minute holds more than perMinute starts.
 * Until 10-21 the gate let a minute's whole quota start at once and held the rest for the next minute, so each prod minute opened with 100
 * calls in one second. At 03:48:05Z on 10-21 that put 245 api-portal request lines in one second and 72 to 75 crawler-api requests a second
 * at 03:48:08Z and 03:49:01Z, and the 13 prod /api/profiles reads in those seconds took 1.0 s at p50 and 3.2 s at p95, against 51 ms and
 * 0.18 s for the other 227 reads of that hour (otel_traces and otel_logs, board goal p8). The spacing is the portal's own limit, spread out.
 */
export function pacedSlot(perMinute: number, now: () => number = Date.now, sleep: (ms: number) => Promise<unknown> = ms => new Promise(resolve => setTimeout(resolve, ms))): () => Promise<void> {
  const gap = 60_000 / perMinute;
  let next = 0;
  return async () => {
    const at = Math.max(now(), next);
    next = at + gap;
    const wait = at - now();
    if (wait > 0) await sleep(wait);
  };
}

interface ProbeTarget { env: Env; base: string; doc: OpenApi; orgs: Org[]; headers: Record<string, string>; skip: ReadonlyMap<string, string>; held?: ReadonlyMap<string, ProbeResult>; perMinute?: number; spend?: { usd: number }; lastMs?: Record<string, number> | undefined; ledger?: JobLedger }

/**
 * Calls every documented non-DM operation of one env once with its docs example, the job-mode route entries with max_pages 2, the chained
 * operations with ids from this run, and page 2 of each page-1 answer with a cursor. An operation in `skip` is not called, and one in `held`
 * gives its held result without a call. With `perMinute`, calls start one every 60 s / perMinute (pacedSlot), inside the limit the portal
 * counts per clock minute. With `spend`, each call's meta.cost goes on its result and into the run's total.
 */
async function probeEnv(target: ProbeTarget, routes: readonly Route[]): Promise<ProbeResult[]> {
  const { env, base, doc, orgs, skip } = target;
  routes = routes.filter(route => appliesTo(route, env));
  const slot = target.perMinute ? pacedSlot(target.perMinute) : async () => {};
  // Another caller on the same key, such as a second run of this duty, also fills the portal's minute: on 10-19 at 15:10Z a push run of d2
  // and a hand run together got 52 prod answers of 429 rate_limit_exceeded. So a 429 rate_limit_exceeded waits its Retry-After and calls again.
  const call = async (org: Org, op: string, request: ProbeRequest, note: string): Promise<Answer> => {
    await slot();
    let result = await probe(base, target.headers, org, op, request, note);
    for (let waits = 1; result.status === 429 && result.code === RATE_LIMITED; waits++) {
      await new Promise(resolve => setTimeout(resolve, (result.retryAfterS ?? 1) * 1000));
      await slot();
      const again = await probe(base, target.headers, org, op, request, note);
      result = { ...again, note: `${again.note}, after ${waits} rate limit wait${waits === 1 ? "" : "s"}` };
    }
    if (!target.spend) return result;
    const costUsd = money((result.body as { meta?: { cost?: unknown } } | null)?.meta?.cost);
    target.spend.usd += costUsd;
    return { ...result, costUsd };
  };
  const preset = (op: string): (ProbeResult & { body: unknown }) | undefined => {
    const held = target.held?.get(baseOp(op));
    if (held) return { ...held, op, body: null };
    return skip.has(baseOp(op)) ? { op, verdict: "skipped", status: 0, ms: 0, note: `not called on ${env}: ${skip.get(baseOp(op))}`, body: null } : undefined;
  };
  const all = operations(doc);
  // A byDesign route is not scored, so its own operations are not called: on 10-20 at 01:52Z the staging Douyin posts call alone ran 147.7 s,
  // the slowest of the run, and the precheck took 168 s.
  const scoredOps = new Set(routes.filter(route => !route.byDesign).flatMap(route => route.portal.map(baseOp)));
  const notScored = new Set(routes.filter(route => route.byDesign).flatMap(route => route.portal.map(baseOp)).filter(op => !scoredOps.has(op)));
  const ops = [...all].filter(([op]) => !isDm(op) && !notScored.has(op));
  const later: [string, Operation][] = [];
  const fedLater: [string, Operation][] = [];
  const first = ops.filter(([op, operation]) => {
    if (CHAINED.test(op)) { later.push([op, operation]); return false; }
    if (QUERY_CHAINS[op]) { fedLater.push([op, operation]); return false; }
    return true;
  });
  // With perMinute, calls start one every 60 s / perMinute. The calls slowest at the last run go first, so
  // the run ends sooner, and a call with no time on record counts as slowest.
  const lastMs = (op: string) => target.lastMs?.[`${env} ${op}`] ?? Number.POSITIVE_INFINITY;
  first.sort(([a], [b]) => lastMs(b) - lastMs(a));
  // A job entry this env does not document is not called: the map holds both grammars' job rows, and each env documents one of them.
  const jobOps = [...new Set(routes.flatMap(route => route.portal).filter(op => op.endsWith(JOB) && all.has(baseOp(op)) && !notScored.has(baseOp(op))))];
  // The portal allows an org 5 open crawl jobs (the 429 rate_limited message, measured on staging 10-12 and prod 10-15), and a run has more
  // job-mode entries than that. So job calls go one at a time, and every job after the first, which the chained calls read, is cancelled
  // as soon as its receipt comes back. The first one is cancelled once the chained calls have read it: on 2026-10-18 a prod run 8 min
  // after another got 429 'At most 5 crawl jobs' on 8 job rows, because the earlier run's jobs still held the org's slots.
  const opened: { org: Org; id: string }[] = [];
  const cancel = async (org: Org, id: string) => { if (await cancelJob(base, target.headers, org, id)) await target.ledger?.drop(id); };
  const jobsRun = (async () => {
    const results: (ProbeResult & { body: unknown })[] = [];
    for (const [index, op] of jobOps.entries()) {
      const before = preset(op);
      if (before) { results.push(before); continue; }
      const operation = all.get(baseOp(op));
      const request = operation && buildRequest(baseOp(op), operation);
      if (!request || "missing" in request) { results.push({ op, verdict: "unprobed" as const, status: 0, ms: 0, note: request ? request.missing : `not in the ${env} openapi`, body: null }); continue; }
      const org = orgs[index % orgs.length]!;
      const result = await call(org, op, jobRequest(request), "docs example in job mode");
      const id = chainIds([result.body]).job_id?.value;
      if (id) await target.ledger?.add(id);
      if (id && results.some(earlier => chainIds([earlier.body]).job_id)) await cancel(org, id);
      else if (id) opened.push({ org, id });
      results.push(result);
    }
    return results;
  })();
  // Page 2 starts as soon as its own page 1 answers. Waiting for the slowest page 1 left page 2 as little as 30 s on 10-17, and a
  // staging page 2 that answers in 1.5 s alone took over 30 s under the run's own load.
  // The chained calls wait for page 1 only, so a slow page 2 does not hold them.
  const pageTwo = new Map<string, ProbeResult & { body: unknown }>();
  const pageTwoRuns: Promise<void>[] = [];
  const phase1Run = Promise.all(first.map(async ([op, operation], index) => {
    const before = preset(op);
    if (before) return before;
    const request = buildRequest(op, operation);
    if ("missing" in request) return { op, verdict: "unprobed" as const, status: 0, ms: 0, note: request.missing, body: null };
    const org = orgs[index % orgs.length]!;
    const result = await call(org, op, request, "docs example");
    const next = result.verdict === "ok" ? nextPage(operation, result.body) : null;
    if (next) pageTwoRuns.push(call(org, `${op} page 2`, { ...request, query: { ...request.query, [next.param]: next.value } }, `page 2 with its own ${next.param}`)
      .then(second => { pageTwo.set(op, second); }));
    return result;
  }));
  const [jobs, phase1] = await Promise.all([jobsRun, phase1Run]);
  const sources = [...jobs.map((result, index) => ({ result, org: index % orgs.length })), ...phase1.map((result, index) => ({ result, org: index % orgs.length }))];
  const chained = chainIds(sources.map(source => source.result.body));
  const ids = Object.fromEntries(Object.entries(chained).map(([name, id]) => [name, id.value]));
  const phase2 = await readsThenWrites(later, async ([op, operation]) => {
    const before = preset(op);
    if (before) return before;
    const request = buildRequest(op, operation, ids);
    if ("missing" in request) return { op, verdict: "unprobed" as const, status: 0, ms: 0, note: request.missing, body: null };
    const name = CHAINED.exec(op)![1]!;
    const org = orgs[sources[chained[name]!.from]!.org]!;
    if (op !== SNAPSHOT_READ) return call(org, op, request, "id from this run, same test org");
    const { reads, progress } = await untilBatchEnds(() => call(org, "GET /v1/batch/progress/{snapshot_id}", { method: "GET", path: `/v1/batch/progress/${encodeURIComponent(ids.snapshot_id!)}`, query: {} }, "progress poll"));
    const result = await call(org, op, request, `id from this run, same test org, after ${reads} progress read${reads === 1 ? "" : "s"}`);
    const broken = result.verdict === "ok" ? batchRowsBroken(progress) : null;
    return broken ? { ...result, verdict: "portal" as const, code: "batch_rows_failed", note: `${result.note}: ${broken}` } : result;
  });
  const fed = await Promise.all(fedLater.map(async ([op, operation]) => {
    const before = preset(op);
    if (before) return before;
    const chain = QUERY_CHAINS[op]!;
    const index = first.findIndex(([name]) => name === chain.from);
    const source = index >= 0 ? phase1[index] : undefined;
    const value = source?.verdict === "ok" ? firstItemId(source.body) : undefined;
    if (!value) return { op, verdict: "unprobed" as const, status: 0, ms: 0, note: `no ${chain.param} from a ${chain.from} answer in this run`, body: null };
    const request = buildRequest(op, operation);
    if ("missing" in request) return { op, verdict: "unprobed" as const, status: 0, ms: 0, note: request.missing, body: null };
    return call(orgs[index % orgs.length]!, op, { ...request, query: { ...request.query, [chain.param]: value } }, `${chain.param} from this run's ${chain.from} answer`);
  }));
  await Promise.all([...pageTwoRuns, ...opened.map(job => cancel(job.org, job.id))]);
  // A page-2 failure counts against the operation: a customer cannot get past page 1. A page 2 the run did not reach leaves page 1's verdict.
  const out: ProbeResult[] = [];
  for (const result of [...phase1, ...jobs, ...phase2, ...fed]) {
    const second = pageTwo.get(result.op);
    const failed = second && (second.verdict === "portal" || second.verdict === "crawler" || (second.verdict === "unprobed" && second.status === 0 && second.ms > 0));
    const { body: _body, ...plain } = failed ? { ...second, op: result.op, note: `page 1 worked, ${second.note}` } : result;
    out.push(plain);
  }
  return out;
}

/** A money string or number from a portal answer's meta.cost, as SPEC-93's session reads it. */
function money(value: unknown): number {
  const number = typeof value === "number" ? value : Number(String(value ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

/**
 * SPEC-93 skips a case on prod for cost (`prod-cost`, its $0.15 run cap) or because it writes. This duty calls the cost skips anyway, once a
 * UTC day: they are the paid intelligence reads customers pay the most for, and the 10-19 plan audit found that no run checked them on prod.
 * The duty reran every 15 min on 10-19 (d2.last-runs.json), and contact/complete alone cost $0.05 a call that day, so a run later the same
 * day reuses the day's answer.
 */
const PAID = "prod-cost";
const utcDay = (ms: number) => Math.floor(ms / 86_400_000);

/**
 * The operations SPEC-93 never calls on prod, read from auto-sns-agent apps/llm-wiki/specs/lib/api-portal/<group>.mjs, the cases the prod
 * spec run uses. An operation every case of which skips on prod for cost is `paid`; one with any other skip reason is in `skip`, with it.
 */
async function prodSkips(): Promise<{ skip: Map<string, string>; paid: Set<string> }> {
  const lib = join(REPO, "apps/llm-wiki/specs/lib");
  const portal = await import(pathToFileURL(join(lib, "api-portal.mjs")).href) as { SKIP_REASONS: Record<string, string> };
  const cases: { op: string; skip?: { prod?: { reason: string } } }[] = [];
  for (const file of (await readdir(join(lib, "api-portal"))).filter(name => name.endsWith(".mjs")))
    cases.push(...((await import(pathToFileURL(join(lib, "api-portal", file)).href)) as { default: typeof cases }).default);
  const byOp = new Map<string, (string | undefined)[]>();
  for (const one of cases) byOp.set(one.op, [...(byOp.get(one.op) ?? []), one.skip?.prod?.reason]);
  const skip = new Map<string, string>();
  const paid = new Set<string>();
  for (const [op, reasons] of byOp) {
    if (!reasons.every(reason => reason)) continue;
    const other = reasons.find(reason => reason !== PAID);
    if (other) skip.set(op, `${other}, ${portal.SKIP_REASONS[other] ?? "SPEC-93 skips it on prod"}`);
    else paid.add(op);
  }
  return { skip, paid };
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("portal-parity: OUTPUT_FILE is not set\n"); process.exit(2); }
  const start = Date.now();
  const stateFile = process.env.STATE_FILE;
  const previous = stateFile ? await readFile(stateFile, "utf8").then(parseState).catch(() => undefined) : undefined;
  const routes = (JSON.parse(await readFile(join(HERE, "portal-parity.routes.json"), "utf8")) as { routes: Route[] }).routes;
  const sourceErrors: string[] = [];
  const cleanupErrors: string[] = [];
  const attempt = async <T>(what: string, run: () => Promise<T>): Promise<T | null> => {
    try { return await run(); } catch (error) { sourceErrors.push(`${what}: ${error instanceof Error ? error.message : String(error)}`); return null; }
  };
  type EnvFile = { urls: Record<string, string>; keySources: Record<string, { cmd: string }> };
  const readEnv = (name: string) => attempt(`auto-sns-agent apps/llm-wiki/specs/envs/${name}.json`, async () =>
    JSON.parse(await readFile(join(REPO, `apps/llm-wiki/specs/envs/${name}.json`), "utf8")) as EnvFile);
  const [env, prodEnv] = await Promise.all([readEnv("staging"), readEnv("prod")]);
  const [crawlerProd, crawlerStaging, prod, bypass, secret, prodKey, skips] = await Promise.all([
    attempt(CRAWLER_OPENAPI.prod, () => getJson(CRAWLER_OPENAPI.prod)),
    attempt(CRAWLER_OPENAPI.staging, () => getJson(CRAWLER_OPENAPI.staging)),
    attempt(PROD_OPENAPI, () => getJson(PROD_OPENAPI)),
    env ? attempt("VERCEL_AUTOMATION_BYPASS_SECRET key source", () => sh(env.keySources.VERCEL_AUTOMATION_BYPASS_SECRET!.cmd, REPO)) : null,
    env ? attempt("CONVEX_WEBHOOK_SECRET key source", () => sh(env.keySources.CONVEX_WEBHOOK_SECRET!.cmd, REPO)) : null,
    process.env.VIREV_API_KEY_PROD || attempt("VIREV_API_KEY_PROD from apps/api-portal/.env", () => sh(PROD_KEY_CMD, REPO)),
    attempt("SPEC-93 prod skips in apps/llm-wiki/specs/lib/api-portal", prodSkips),
  ]);
  const base = env?.urls.apiPortal ?? "";
  const staging = bypass ? await attempt(`${base}/openapi.json`, () => getJson(`${base}/openapi.json`, { "x-vercel-protection-bypass": bypass })) : null;
  const probes: Record<Env, ProbeResult[]> = { prod: [], staging: [] };
  const orgs: Org[] = [];
  const spend = { usd: 0 };
  const held = new Map<string, ProbeResult>();
  for (const op of skips?.paid ?? []) {
    const at = previous?.paidAt?.[op];
    const verdict = previous?.verdicts[`prod ${op}`];
    if (at !== undefined && verdict && utcDay(at) === utcDay(start))
      held.set(op, { op, verdict, status: 0, ms: 0, note: `paid read, answer of ${new Date(at).toISOString()} reused; called again on the next UTC day` });
  }
  const prodOrg: Org | null = prodKey ? { id: "prod", key: prodKey } : null;
  if (prodOrg && prodEnv) await attempt("cancel of prod jobs that earlier runs left open", () => cancelLeftovers(prodEnv.urls.apiPortal!, prodOrg));
  try {
    if (env && staging && bypass && secret) {
      const seeded = await attempt("staging test org seed", () => Promise.all(Array.from({ length: ORGS }, (_, index) => seedOrg(env.urls.convex!, secret, index, start))));
      if (seeded) orgs.push(...seeded);
    }
    await Promise.all([
      orgs.length && staging && bypass ? probeEnv({ env: "staging", base, doc: staging, orgs, headers: { "x-vercel-protection-bypass": bypass }, skip: new Map(), perMinute: perMinute(orgs), lastMs: previous?.ms }, routes)
        .then(results => { probes.staging = results; }) : null,
      prod && prodOrg && skips && prodEnv ? probeEnv({ env: "prod", base: prodEnv.urls.apiPortal!, doc: prod, orgs: [prodOrg], headers: {}, skip: skips.skip, held, perMinute: perMinute([prodOrg]), spend, lastMs: previous?.ms, ledger: jobLedger(JOBS_DIR) }, routes)
        .then(results => { probes.prod = results; }) : null,
    ]);
  } finally {
    if (env && secret) await Promise.all(orgs.map(org => cleanupOrg(env.urls.convex!, secret, org).catch((error: unknown) =>
      cleanupErrors.push(error instanceof Error ? error.message : `cleanup of test org ${org.id} failed: ${String(error)}`))));
  }
  const result = parityMetrics({ routes, cleanupErrors, crawler: { prod: crawlerProd, staging: crawlerStaging }, docs: { prod, staging }, probes, sourceErrors, previous, at: start, ...(skips ? { paid: skips.paid } : {}), ...(probes.prod.length ? { prodCostUsd: spend.usd } : {}) });
  await writeFile(output, JSON.stringify(result.output, null, 2) + "\n");
  if (stateFile && (probes.prod.length || probes.staging.length)) await writeFile(stateFile, JSON.stringify(result.state) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
