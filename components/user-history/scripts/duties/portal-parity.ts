import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The api portal vp chat's "Portal matches crawler" precheck (`node --import tsx scripts/duties/portal-parity.ts`). No model call.
 * It answers the owner's "is all apis working that work in crawler api work for api portal? all working in prod?" on prod and staging:
 * 1. It reads three openapi.json files: crawler.virev.ai (the crawler routes), api.virev.ai (prod) and staging-api.virev.ai (through the
 *    Vercel automation bypass).
 * 2. On each env it calls every documented non-DM /v1 operation once with its own docs example. Staging calls go out under throwaway test
 *    orgs that it seeds through the staging Convex /api/test/seed route and deletes again through /api/test/cleanup. Prod calls use
 *    VIREV_API_KEY_PROD, skip the operations SPEC-93 never calls on prod (writes, and calls over the owner's prod run cap), and stop at that cap.
 * 3. It sorts each answer: 2xx works, an `upstream_*` or `capacity_exhausted` code is a crawler cause (the portal passes crawler errors on that way), anything
 *    else is a portal cause, and a call it could not make or judge is unprobed. A page-1 answer with a cursor gets one page-2 call.
 * 4. It maps answers to crawler routes through portal-parity.routes.json: a route works on an env when one of its /v1 operations works there,
 *    and a route with no /v1 operation in that env's openapi is missing there.
 * A source it cannot read gives -1 for its share, a source_errors count and a flagged slice. With no crawler openapi it scores every route in the map.
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
const CRAWLER_OPENAPI = "https://crawler.virev.ai/openapi.json";
const PROD_OPENAPI = "https://api.virev.ai/openapi.json";
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
 * The runner kills a precheck at 120 s (PRECHECK_TIMEOUT_MS in src/shared/chat-duties.ts). Page-1 calls stop at 70 s and page-2 and chained
 * calls at 100 s after start, which leaves time for cleanup. A call cut off this way is unprobed, never broken. On 2026-10-12 the slowest
 * staging answers were upstream timeouts at 32 s, and the audit's slowest crawler call took 12.7 s.
 */
const PHASE1_MS = 70_000;
const PHASE2_MS = 100_000;
/**
 * Prod has one org, the VIREV_API_KEY_PROD org, and the portal allows an org 100 REST calls in each clock minute (DEFAULT_REQUESTS_PER_MINUTE.rest
 * and currentWindowStart in apps/virev-demo/convex/apiPortal/rateLimits.ts), so prod calls past 100 in a minute wait for the next one.
 */
const PROD_PER_MINUTE = 100;
/** Response keys that carry the next page, and the query parameter that takes it back. */
const CURSOR_KEYS = ["next_cursor", "cursor", "continuationToken", "continuation_token", "next_page_id"] as const;

interface Param { name: string; in: string; required?: boolean; example?: unknown; schema?: { example?: unknown }; examples?: Record<string, { value?: unknown }> }
export interface Operation { parameters?: Param[]; requestBody?: { content?: Record<string, { example?: unknown; examples?: Record<string, { value?: unknown }>; schema?: { example?: unknown } }> }; "x-example-query"?: Record<string, unknown> }
export type OpenApi = { paths?: Record<string, Record<string, Operation>> };
export interface Route { crawler: string; group: string; portal: string[]; byDesign?: string }
export interface ProbeRequest { method: string; path: string; query: Record<string, string>; body?: unknown }
export type Verdict = "ok" | "crawler" | "portal" | "unprobed" | "skipped";
export interface ProbeResult { op: string; verdict: Verdict; status: number; ms: number; code?: string | undefined; note: string }
export interface ParityState { verdicts: Record<string, Verdict> }
/** The saved state, or undefined for none. The duty runner seeds STATE_FILE with "{}" before the first run, which has no verdicts. */
export function parseState(text: string): ParityState | undefined {
  const state = JSON.parse(text) as Partial<ParityState> | null;
  return state && typeof state.verdicts === "object" && state.verdicts !== null ? { verdicts: state.verdicts } : undefined;
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
const JOB_FINISHED = "job_finished";

/** The error code of a portal error body, if any. */
export function errorCode(body: unknown): string | undefined {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Who a probe answer blames. 2xx works. `upstream_*` is the crawler, because the portal passes crawler failures on with that code
 * (audit findings-brief.md). 429 and 402 come from this run's own test orgs, and status 0 is this run's own cutoff, so those are unprobed.
 * Every other answer is the portal's: a 503 batch_unavailable, a 400 on the docs example or on the portal's own cursor, a 5xx of its own.
 */
export function classify(status: number, body: unknown): { verdict: Verdict; code?: string | undefined } {
  const code = errorCode(body);
  if (status >= 200 && status < 300) return { verdict: "ok" };
  // A cancel of a job that already ended answers 409 job_finished with the job's real state, which is the route working.
  if (status === 409 && code === JOB_FINISHED) return { verdict: "ok", code };
  if (status === 0 || status === 429 || status === 402) return { verdict: "unprobed", code };
  if (code?.startsWith("upstream_") || code === CRAWLER_CAPACITY) return { verdict: "crawler", code };
  return { verdict: "portal", code };
}

/** The next-page token in a page-1 answer and the parameter the operation takes it in, or null when there is no next page to try. */
export function nextPage(operation: Operation, body: unknown): { param: string; value: string } | null {
  const accepts = new Set((operation.parameters ?? []).filter(p => p.in === "query").map(p => p.name));
  const record = body as { data?: Record<string, unknown>; meta?: Record<string, unknown> } | null;
  for (const holder of [record?.data, record?.meta, record as Record<string, unknown> | null]) {
    if (!holder || typeof holder !== "object" || Array.isArray(holder)) continue;
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
/** How one crawler route does through the portal on one env. `skipped` is a route SPEC-93 does not call on prod (owner's prod cost cap, or a write). */
export type RouteVerdict = "works" | "missing" | "portal" | "crawler" | "unprobed" | "skipped";

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
 * staging. routes_failing_portal counts routes that fail on either env for a portal cause (no /v1 route there, or a portal error), and
 * routes_failing_crawler those that fail with an upstream crawler error and no portal cause. Every other count goes to the run detail.
 */
export function parityMetrics(input: {
  routes: readonly Route[]; crawler: OpenApi | null; docs: Record<Env, OpenApi | null>; probes: Record<Env, readonly ProbeResult[]>;
  sourceErrors: readonly string[]; previous?: ParityState | undefined; at: number; prodCostUsd?: number;
}): { output: PrecheckOutput; state: ParityState } {
  const { routes, at } = input;
  const flagged: FlaggedSlice[] = input.sourceErrors.map(excerpt => ({ at, kind: "source_error", excerpt: excerpt.slice(0, 300) }));
  const crawlerOps = input.crawler && operations(input.crawler);
  const live = routes.filter(route => !crawlerOps || crawlerOps.has(route.crawler));
  for (const route of routes) if (crawlerOps && !crawlerOps.has(route.crawler)) flagged.push({ at, kind: "crawler_route_gone", excerpt: `${route.crawler} is no longer in the crawler openapi; drop it from portal-parity.routes.json if that is meant` });
  for (const route of live) if (route.byDesign) flagged.push({ at, kind: "by_design", excerpt: `${route.crawler}: ${route.byDesign}` });
  const scored = live.filter(route => !route.byDesign);
  const metrics: Record<string, number> = {};
  const verdicts: Record<Env, Map<Route, RouteVerdict>> = { prod: new Map(), staging: new Map() };
  for (const env of ENVS) {
    const doc = input.docs[env];
    const ops = doc && operations(doc);
    const byOp = new Map(input.probes[env].map(probe => [probe.op, probe]));
    for (const route of scored) verdicts[env].set(route, routeVerdict(route, ops, byOp));
    const count = (verdict: RouteVerdict) => [...verdicts[env].values()].filter(value => value === verdict).length;
    const judged = scored.length - count("skipped");
    metrics[`${env}_working_pct`] = ops && input.probes[env].length && judged ? Math.round(1000 * count("works") / judged) / 10 : UNMEASURED_PCT;
    for (const verdict of ["works", "missing", "portal", "crawler", "unprobed", "skipped"] as const) metrics[`${env}_routes_${verdict}`] = count(verdict);
    metrics[`${env}_v1_ops_called`] = input.probes[env].filter(probe => probe.verdict !== "skipped").length;
    const missing = scored.filter(route => verdicts[env].get(route) === "missing");
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
  const either = (wanted: RouteVerdict[]) => scored.filter(route => ENVS.some(env => wanted.includes(verdicts[env].get(route)!)));
  const portalRoutes = either(["missing", "portal"]);
  const portalSet = new Set(portalRoutes);
  metrics.routes_failing_portal = portalRoutes.length;
  metrics.routes_failing_crawler = either(["crawler"]).filter(route => !portalSet.has(route)).length;
  metrics.routes_scored = scored.length;
  metrics.source_errors = input.sourceErrors.length;
  if (input.prodCostUsd !== undefined) metrics.prod_cost_usd = Math.round(input.prodCostUsd * 10_000) / 10_000;
  const state: ParityState = { verdicts: { ...input.previous?.verdicts } };
  for (const env of ENVS) for (const probe of input.probes[env]) if (probe.verdict !== "skipped" && probe.verdict !== "unprobed") state.verdicts[`${env} ${probe.op}`] = probe.verdict;
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
  await post("/api/test/cleanup", { orgId: org.id });
}

async function probe(base: string, extra: Record<string, string>, org: Org, op: string, request: ProbeRequest, deadline: number, note: string): Promise<ProbeResult & { body: unknown }> {
  const url = new URL(base + request.path);
  for (const [key, value] of Object.entries(request.query)) url.searchParams.set(key, value);
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: request.method,
      headers: { authorization: `Bearer ${org.key}`, ...extra, ...(request.body === undefined ? {} : { "content-type": "application/json" }) },
      body: request.body === undefined ? null : JSON.stringify(request.body),
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      redirect: "manual",
    });
    const text = await response.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = null; }
    const { verdict, code } = classify(response.status, body);
    const message = (body as { error?: { message?: string } } | null)?.error?.message;
    return { op, verdict, status: response.status, ms: Date.now() - start, code, note: message ? `${note}: ${message}` : body === null && text ? `${note}: not JSON: ${text.slice(0, 80)}` : note, body };
  } catch (error) {
    return { op, verdict: "unprobed", status: 0, ms: Date.now() - start, note: `${note}: ${error instanceof Error ? error.message : String(error)}`, body: null };
  }
}

/** Cancels one job this run started, so it stops holding one of the org's 5 open job slots. A failed cancel only costs that slot. The staging cancel answered in 756 ms on 10-15. */
async function cancelJob(base: string, extra: Record<string, string>, org: Org, id: string): Promise<void> {
  await fetch(`${base}/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: { authorization: `Bearer ${org.key}`, ...extra }, signal: AbortSignal.timeout(10_000) })
    .then(response => response.body?.cancel()).catch(() => undefined);
}

interface ProbeTarget { env: Env; base: string; doc: OpenApi; orgs: Org[]; headers: Record<string, string>; skip: ReadonlyMap<string, string>; perMinute?: number; budget?: { capUsd: number; spent: number } }

/**
 * Calls every documented non-DM operation of one env once with its docs example, the job-mode route entries with max_pages 2, the chained
 * operations with ids from this run, and page 2 of each page-1 answer with a cursor. An operation in `skip` is not called. With `perMinute`,
 * a call waits for the next clock minute once this minute has that many, the way the portal counts its limit; on prod a call does not start
 * once the run spent the owner's prod cap.
 */
async function probeEnv(target: ProbeTarget, routes: readonly Route[], start: number): Promise<ProbeResult[]> {
  const { env, base, doc, orgs, skip } = target;
  const minutes = new Map<number, number>();
  const call = async (org: Org, op: string, request: ProbeRequest, deadline: number, note: string): Promise<ProbeResult & { body: unknown }> => {
    for (let minute = Math.floor(Date.now() / 60_000); target.perMinute && (minutes.get(minute) ?? 0) >= target.perMinute; minute++)
      await new Promise(resolve => setTimeout(resolve, (minute + 1) * 60_000 - Date.now()));
    const minute = Math.floor(Date.now() / 60_000);
    minutes.set(minute, (minutes.get(minute) ?? 0) + 1);
    if (target.budget && target.budget.spent >= target.budget.capUsd)
      return { op, verdict: "skipped", status: 0, ms: 0, note: `not called: this run spent the prod cap of $${target.budget.capUsd}`, body: null };
    const result = await probe(base, target.headers, org, op, request, deadline, note);
    if (target.budget) target.budget.spent += money((result.body as { meta?: { cost?: unknown } } | null)?.meta?.cost);
    return result;
  };
  const skipped = (op: string) => ({ op, verdict: "skipped" as const, status: 0, ms: 0, note: `not called on ${env}: ${skip.get(baseOp(op))}`, body: null });
  const all = operations(doc);
  const ops = [...all].filter(([op]) => !isDm(op));
  const later: [string, Operation][] = [];
  const first = ops.filter(([op, operation]) => { if (CHAINED.test(op)) { later.push([op, operation]); return false; } return true; });
  const jobOps = [...new Set(routes.flatMap(route => route.portal).filter(op => op.endsWith(JOB)))];
  // The portal allows an org 5 open crawl jobs (the 429 rate_limited message, measured on staging 10-12 and prod 10-15), and a run has more
  // job-mode entries than that. So job calls go one at a time, and every job after the first, which the chained calls read, is cancelled
  // as soon as its receipt comes back.
  const jobsRun = (async () => {
    const results: (ProbeResult & { body: unknown })[] = [];
    for (const [index, op] of jobOps.entries()) {
      if (skip.has(baseOp(op))) { results.push(skipped(op)); continue; }
      const operation = all.get(baseOp(op));
      const request = operation && buildRequest(baseOp(op), operation);
      if (!request || "missing" in request) { results.push({ op, verdict: "unprobed" as const, status: 0, ms: 0, note: request ? request.missing : `not in the ${env} openapi`, body: null }); continue; }
      const org = orgs[index % orgs.length]!;
      const result = await call(org, op, jobRequest(request), start + PHASE1_MS, "docs example in job mode");
      const id = chainIds([result.body]).job_id?.value;
      if (id && results.some(earlier => chainIds([earlier.body]).job_id)) await cancelJob(base, target.headers, org, id);
      results.push(result);
    }
    return results;
  })();
  const phase1Run = Promise.all(first.map(async ([op, operation], index) => {
    if (skip.has(op)) return skipped(op);
    const request = buildRequest(op, operation);
    if ("missing" in request) return { op, verdict: "unprobed" as const, status: 0, ms: 0, note: request.missing, body: null };
    return call(orgs[index % orgs.length]!, op, request, start + PHASE1_MS, "docs example");
  }));
  const [jobs, phase1] = await Promise.all([jobsRun, phase1Run]);
  const sources = [...jobs.map((result, index) => ({ result, org: index % orgs.length })), ...phase1.map((result, index) => ({ result, org: index % orgs.length }))];
  const chained = chainIds(sources.map(source => source.result.body));
  const ids = Object.fromEntries(Object.entries(chained).map(([name, id]) => [name, id.value]));
  const phase2 = await Promise.all([
    ...later.map(async ([op, operation]) => {
      if (skip.has(op)) return skipped(op);
      const request = buildRequest(op, operation, ids);
      if ("missing" in request) return { op, verdict: "unprobed" as const, status: 0, ms: 0, note: request.missing, body: null };
      const name = CHAINED.exec(op)![1]!;
      return call(orgs[sources[chained[name]!.from]!.org]!, op, request, start + PHASE2_MS, "id from this run, same test org");
    }),
    ...phase1.flatMap((result, index) => {
      const operation = first[index]![1];
      const next = result.verdict === "ok" ? nextPage(operation, result.body) : null;
      const request = next && buildRequest(result.op, operation);
      if (!next || !request || "missing" in request) return [];
      return [call(orgs[index % orgs.length]!, `${result.op} page 2`, { ...request, query: { ...request.query, [next.param]: next.value } }, start + PHASE2_MS, `page 2 with its own ${next.param}`)];
    }),
  ]);
  // A page-2 failure counts against the operation: a customer cannot get past page 1. A page 2 the run did not reach leaves page 1's verdict.
  const pageTwo = new Map(phase2.filter(result => result.op.endsWith(" page 2")).map(result => [result.op.slice(0, -" page 2".length), result]));
  const out: ProbeResult[] = [];
  for (const result of [...phase1, ...jobs, ...phase2.filter(result => !result.op.endsWith(" page 2"))]) {
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
 * The operations SPEC-93 never calls on prod, with the reason: every case of the operation skips on prod (a write, or over the owner's prod
 * cost cap). Read from auto-sns-agent apps/llm-wiki/specs/lib/api-portal/<group>.mjs, the cases the prod spec run uses.
 */
async function prodSkips(): Promise<{ skip: Map<string, string>; capUsd: number }> {
  const lib = join(REPO, "apps/llm-wiki/specs/lib");
  const portal = await import(pathToFileURL(join(lib, "api-portal.mjs")).href) as { PROD_RUN_CAP_USD: number; SKIP_REASONS: Record<string, string> };
  const cases: { op: string; skip?: { prod?: { reason: string } } }[] = [];
  for (const file of (await readdir(join(lib, "api-portal"))).filter(name => name.endsWith(".mjs")))
    cases.push(...((await import(pathToFileURL(join(lib, "api-portal", file)).href)) as { default: typeof cases }).default);
  const byOp = new Map<string, (string | undefined)[]>();
  for (const one of cases) byOp.set(one.op, [...(byOp.get(one.op) ?? []), one.skip?.prod?.reason]);
  const skip = new Map<string, string>();
  for (const [op, reasons] of byOp) if (reasons.every(reason => reason)) skip.set(op, `${reasons[0]}, ${portal.SKIP_REASONS[reasons[0]!] ?? "SPEC-93 skips it on prod"}`);
  return { skip, capUsd: portal.PROD_RUN_CAP_USD };
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("portal-parity: OUTPUT_FILE is not set\n"); process.exit(2); }
  const start = Date.now();
  const stateFile = process.env.STATE_FILE;
  const previous = stateFile ? await readFile(stateFile, "utf8").then(parseState).catch(() => undefined) : undefined;
  const routes = (JSON.parse(await readFile(join(HERE, "portal-parity.routes.json"), "utf8")) as { routes: Route[] }).routes;
  const sourceErrors: string[] = [];
  const attempt = async <T>(what: string, run: () => Promise<T>): Promise<T | null> => {
    try { return await run(); } catch (error) { sourceErrors.push(`${what}: ${error instanceof Error ? error.message : String(error)}`); return null; }
  };
  type EnvFile = { urls: Record<string, string>; keySources: Record<string, { cmd: string }> };
  const readEnv = (name: string) => attempt(`auto-sns-agent apps/llm-wiki/specs/envs/${name}.json`, async () =>
    JSON.parse(await readFile(join(REPO, `apps/llm-wiki/specs/envs/${name}.json`), "utf8")) as EnvFile);
  const [env, prodEnv] = await Promise.all([readEnv("staging"), readEnv("prod")]);
  const [crawler, prod, bypass, secret, prodKey, skips] = await Promise.all([
    attempt(CRAWLER_OPENAPI, () => getJson(CRAWLER_OPENAPI)),
    attempt(PROD_OPENAPI, () => getJson(PROD_OPENAPI)),
    env ? attempt("VERCEL_AUTOMATION_BYPASS_SECRET key source", () => sh(env.keySources.VERCEL_AUTOMATION_BYPASS_SECRET!.cmd, REPO)) : null,
    env ? attempt("CONVEX_WEBHOOK_SECRET key source", () => sh(env.keySources.CONVEX_WEBHOOK_SECRET!.cmd, REPO)) : null,
    prodEnv ? attempt("VIREV_API_KEY_PROD key source", () => sh(prodEnv.keySources.VIREV_API_KEY_PROD!.cmd, REPO)) : null,
    attempt("SPEC-93 prod skips in apps/llm-wiki/specs/lib/api-portal", prodSkips),
  ]);
  const base = env?.urls.apiPortal ?? "";
  const staging = bypass ? await attempt(`${base}/openapi.json`, () => getJson(`${base}/openapi.json`, { "x-vercel-protection-bypass": bypass })) : null;
  const probes: Record<Env, ProbeResult[]> = { prod: [], staging: [] };
  const orgs: Org[] = [];
  const budget = skips ? { capUsd: skips.capUsd, spent: 0 } : undefined;
  try {
    if (env && staging && bypass && secret) {
      const seeded = await attempt("staging test org seed", () => Promise.all(Array.from({ length: ORGS }, (_, index) => seedOrg(env.urls.convex!, secret, index, start))));
      if (seeded) orgs.push(...seeded);
    }
    await Promise.all([
      orgs.length && staging && bypass ? probeEnv({ env: "staging", base, doc: staging, orgs, headers: { "x-vercel-protection-bypass": bypass }, skip: new Map() }, routes, start)
        .then(results => { probes.staging = results; }) : null,
      prod && prodKey && skips && prodEnv ? probeEnv({ env: "prod", base: prodEnv.urls.apiPortal!, doc: prod, orgs: [{ id: "prod", key: prodKey }], headers: {}, skip: skips.skip, perMinute: PROD_PER_MINUTE, ...(budget ? { budget } : {}) }, routes, start)
        .then(results => { probes.prod = results; }) : null,
    ]);
  } finally {
    if (env && secret) await Promise.all(orgs.map(org => cleanupOrg(env.urls.convex!, secret, org).catch((error: unknown) =>
      sourceErrors.push(`cleanup of test org ${org.id} failed: ${error instanceof Error ? error.message : String(error)}`))));
  }
  const result = parityMetrics({ routes, crawler, docs: { prod, staging }, probes, sourceErrors, previous, at: start, ...(budget ? { prodCostUsd: budget.spent } : {}) });
  await writeFile(output, JSON.stringify(result.output, null, 2) + "\n");
  if (stateFile && (probes.prod.length || probes.staging.length)) await writeFile(stateFile, JSON.stringify(result.state) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
