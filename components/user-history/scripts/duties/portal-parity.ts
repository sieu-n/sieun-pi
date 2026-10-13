import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The api portal vp chat's "Portal matches crawler" precheck (`node --import tsx scripts/duties/portal-parity.ts`). No model call.
 * It turns the 2026-10-12 parity audit into a daily measure:
 * 1. It reads three public openapi.json files: crawler.virev.ai (the crawler routes), api.virev.ai (what customers can call) and
 *    staging-api.virev.ai (what it probes, through the Vercel automation bypass).
 * 2. It calls every documented /v1 operation once on staging only, with the operation's own docs example, under throwaway test orgs that it
 *    seeds through the staging Convex /api/test/seed route and deletes again through /api/test/cleanup. DM operations are never called.
 * 3. It sorts each answer: 2xx works, an `upstream_*` error code is a crawler cause (the portal passes crawler errors on that way), anything
 *    else is a portal cause, and a call it could not make or judge is unprobed. A page-1 answer with a cursor gets one page-2 call.
 * 4. It counts crawler routes with no /v1 route on api.virev.ai from portal-parity.routes.json.
 * A source it cannot read gives 999999 for the metrics that need it, a source_errors count and a flagged slice.
 *
 * Sources for the targets in portal-parity.duty.json (the JSON cannot hold comments):
 * - routes_working_pct >= 100, routes_missing_v1 <= 0, routes_broken_portal <= 0, routes_broken_crawler <= 0: board goal p1 "Every crawler
 *   API endpoint works through the api portal", which asks for every route.
 * - routes_unprobed <= 0 and source_errors <= 0: a route or source the run could not measure is a gap in the measure itself.
 * The note's routes_differ <= 0 is left out: judging a body against the crawler needs a matched crawler call per route with the portal's
 * parameter renames, which this precheck does not rebuild. Board item p11 owns the 5 differing routes.
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
/** Response keys that carry the next page, and the query parameter that takes it back. */
const CURSOR_KEYS = ["next_cursor", "cursor", "continuationToken", "continuation_token", "next_page_id"] as const;

interface Param { name: string; in: string; required?: boolean; example?: unknown; schema?: { example?: unknown }; examples?: Record<string, { value?: unknown }> }
export interface Operation { parameters?: Param[]; requestBody?: { content?: Record<string, { example?: unknown; examples?: Record<string, { value?: unknown }>; schema?: { example?: unknown } }> }; "x-example-query"?: Record<string, unknown> }
export type OpenApi = { paths?: Record<string, Record<string, Operation>> };
export interface Route { crawler: string; group: string; portal: string[]; byDesign?: string }
export interface ProbeRequest { method: string; path: string; query: Record<string, string>; body?: unknown }
export type Verdict = "ok" | "crawler" | "portal" | "unprobed";
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
  if (status === 0 || status === 429 || status === 402) return { verdict: "unprobed", code };
  if (code?.startsWith("upstream_")) return { verdict: "crawler", code };
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

/** The duty's metrics from the three openapi documents (null when unread), the probe results and the route map. */
export function parityMetrics(input: {
  routes: readonly Route[]; crawler: OpenApi | null; prod: OpenApi | null; staging: OpenApi | null; probes: readonly ProbeResult[];
  sourceErrors: readonly string[]; previous?: ParityState | undefined; at: number;
}): { output: PrecheckOutput; state: ParityState } {
  const { routes, probes, at } = input;
  const flagged: FlaggedSlice[] = input.sourceErrors.map(excerpt => ({ at, kind: "source_error", excerpt: excerpt.slice(0, 300) }));
  const crawlerOps = input.crawler && operations(input.crawler);
  const prodOps = input.prod && operations(input.prod);
  const byOp = new Map(probes.map(probe => [probe.op, probe]));
  const live = routes.filter(route => !crawlerOps || crawlerOps.has(route.crawler));
  for (const route of routes) if (crawlerOps && !crawlerOps.has(route.crawler)) flagged.push({ at, kind: "crawler_route_gone", excerpt: `${route.crawler} is no longer in the crawler openapi; drop it from portal-parity.routes.json if that is meant` });
  const scored = live.filter(route => !route.byDesign);
  const hasV1 = (route: Route) => !!prodOps && route.portal.some(op => prodOps.has(baseOp(op)));

  let missing = UNMEASURED;
  if (crawlerOps && prodOps) {
    const gaps = scored.filter(route => !hasV1(route));
    missing = gaps.length;
    const byGroup = new Map<string, string[]>();
    for (const route of gaps) byGroup.set(route.group, [...(byGroup.get(route.group) ?? []), route.crawler]);
    for (const [group, list] of byGroup) flagged.push({ at, kind: "missing_v1", item: group, excerpt: `${group}: ${list.length} crawler routes with no /v1 route on api.virev.ai: ${list.join(", ")}`.slice(0, 600) });
    const staged = input.staging ? operations(input.staging) : undefined;
    for (const route of gaps) {
      const waiting = route.portal.filter(op => staged?.has(baseOp(op)));
      if (waiting.length) flagged.push({ at, kind: "staging_only", excerpt: `${route.crawler}: ${waiting.join(", ")} is on staging and not yet on api.virev.ai` });
    }
  }
  for (const route of live) if (route.byDesign) flagged.push({ at, kind: "by_design", excerpt: `${route.crawler}: ${route.byDesign}` });

  const probed = probes.length > 0;
  const count = (verdict: Verdict) => probes.filter(probe => probe.verdict === verdict).length;
  const working = scored.filter(route => route.portal.some(op => byOp.get(op)?.verdict === "ok")).length;
  for (const probe of probes) {
    if (probe.verdict === "ok") continue;
    flagged.push({ at, kind: probe.verdict === "unprobed" ? "unprobed" : `broken_${probe.verdict}`, excerpt: `${probe.op} on staging: ${probe.status || "no answer"}${probe.code ? ` ${probe.code}` : ""} after ${probe.ms} ms, ${probe.note}`.slice(0, 400) });
    const before = input.previous?.verdicts[probe.op];
    if (before === "ok" && probe.verdict !== "unprobed") flagged.push({ at, kind: "regression", excerpt: `${probe.op} worked on staging at the last run and now fails (${probe.status} ${probe.code ?? ""})`.trim() });
  }
  const metrics: Record<string, number> = {
    routes_working_pct: probed && crawlerOps && prodOps && scored.length ? Math.round(1000 * working / scored.length) / 10 : UNMEASURED,
    routes_missing_v1: missing,
    routes_broken_portal: probed ? count("portal") : UNMEASURED,
    routes_broken_crawler: probed ? count("crawler") : UNMEASURED,
    routes_unprobed: probed ? count("unprobed") : UNMEASURED,
    source_errors: input.sourceErrors.length,
    routes_working: working,
    routes_scored: scored.length,
    v1_ops_probed: probes.length,
  };
  const verdicts = Object.fromEntries(probes.map(probe => [probe.op, probe.verdict]));
  return { output: { metrics, flagged }, state: { verdicts: { ...input.previous?.verdicts, ...verdicts } } };
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

async function probe(base: string, bypass: string, org: Org, op: string, request: ProbeRequest, deadline: number, note: string): Promise<ProbeResult & { body: unknown }> {
  const url = new URL(base + request.path);
  for (const [key, value] of Object.entries(request.query)) url.searchParams.set(key, value);
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: request.method,
      headers: { authorization: `Bearer ${org.key}`, "x-vercel-protection-bypass": bypass, ...(request.body === undefined ? {} : { "content-type": "application/json" }) },
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
  const env = await attempt("auto-sns-agent apps/llm-wiki/specs/envs/staging.json", async () =>
    JSON.parse(await readFile(join(REPO, "apps/llm-wiki/specs/envs/staging.json"), "utf8")) as { urls: Record<string, string>; keySources: Record<string, { cmd: string }> });
  const [crawler, prod, bypass, secret] = await Promise.all([
    attempt(CRAWLER_OPENAPI, () => getJson(CRAWLER_OPENAPI)),
    attempt(PROD_OPENAPI, () => getJson(PROD_OPENAPI)),
    env ? attempt("VERCEL_AUTOMATION_BYPASS_SECRET key source", () => sh(env.keySources.VERCEL_AUTOMATION_BYPASS_SECRET!.cmd, REPO)) : null,
    env ? attempt("CONVEX_WEBHOOK_SECRET key source", () => sh(env.keySources.CONVEX_WEBHOOK_SECRET!.cmd, REPO)) : null,
  ]);
  const base = env?.urls.apiPortal ?? "";
  const staging = bypass ? await attempt(`${base}/openapi.json`, () => getJson(`${base}/openapi.json`, { "x-vercel-protection-bypass": bypass })) : null;
  const probes: ProbeResult[] = [];
  const orgs: Org[] = [];
  if (env && staging && bypass && secret) {
    const seeded = await attempt("staging test org seed", () => Promise.all(Array.from({ length: ORGS }, (_, index) => seedOrg(env.urls.convex!, secret, index, start))));
    if (seeded) orgs.push(...seeded);
    try {
      if (orgs.length) {
        const ops = [...operations(staging)].filter(([op]) => !isDm(op));
        const later: [string, Operation][] = [];
        const first = ops.filter(([op, operation]) => { if (CHAINED.test(op)) { later.push([op, operation]); return false; } return true; });
        const phase1 = await Promise.all(first.map(async ([op, operation], index) => {
          const request = buildRequest(op, operation);
          if ("missing" in request) return { op, verdict: "unprobed" as const, status: 0, ms: 0, note: request.missing, body: null };
          return probe(base, bypass, orgs[index % orgs.length]!, op, request, start + PHASE1_MS, "docs example");
        }));
        const jobOps = [...new Set(routes.flatMap(route => route.portal).filter(op => op.endsWith(JOB)))];
        const jobs = await Promise.all(jobOps.map(async (op, index) => {
          const operation = operations(staging).get(baseOp(op));
          const request = operation && buildRequest(baseOp(op), operation);
          if (!request || "missing" in request) return { op, verdict: "unprobed" as const, status: 0, ms: 0, note: request ? request.missing : "not in the staging openapi", body: null };
          return probe(base, bypass, orgs[index % orgs.length]!, op, jobRequest(request), start + PHASE1_MS, "docs example in job mode");
        }));
        const sources = [...jobs.map((result, index) => ({ result, org: index % orgs.length })), ...phase1.map((result, index) => ({ result, org: index % orgs.length }))];
        const chained = chainIds(sources.map(source => source.result.body));
        const ids = Object.fromEntries(Object.entries(chained).map(([name, id]) => [name, id.value]));
        const phase2 = await Promise.all([
          ...later.map(async ([op, operation]) => {
            const request = buildRequest(op, operation, ids);
            if ("missing" in request) return { op, verdict: "unprobed" as const, status: 0, ms: 0, note: request.missing, body: null };
            const name = CHAINED.exec(op)![1]!;
            return probe(base, bypass, orgs[sources[chained[name]!.from]!.org]!, op, request, start + PHASE2_MS, "id from this run, same test org");
          }),
          ...phase1.flatMap((result, index) => {
            const operation = first[index]![1];
            const next = result.verdict === "ok" ? nextPage(operation, result.body) : null;
            const request = next && buildRequest(result.op, operation);
            if (!next || !request || "missing" in request) return [];
            return [probe(base, bypass, orgs[index % orgs.length]!, `${result.op} page 2`, { ...request, query: { ...request.query, [next.param]: next.value } }, start + PHASE2_MS, `page 2 with its own ${next.param}`)];
          }),
        ]);
        // A page-2 failure counts against the operation: a customer cannot get past page 1.
        const pageTwo = new Map(phase2.filter(result => result.op.endsWith(" page 2")).map(result => [result.op.slice(0, -" page 2".length), result]));
        for (const result of [...phase1, ...jobs, ...phase2.filter(result => !result.op.endsWith(" page 2"))]) {
          const second = pageTwo.get(result.op);
          const { body: _body, ...plain } = second && second.verdict !== "ok" ? { ...second, op: result.op, note: `page 1 worked, ${second.note}` } : result;
          probes.push(plain);
        }
      }
    } finally {
      await Promise.all(orgs.map(org => cleanupOrg(env.urls.convex!, secret, org).catch((error: unknown) =>
        sourceErrors.push(`cleanup of test org ${org.id} failed: ${error instanceof Error ? error.message : String(error)}`))));
    }
  }
  const result = parityMetrics({ routes, crawler, prod, staging, probes, sourceErrors, previous, at: start });
  await writeFile(output, JSON.stringify(result.output, null, 2) + "\n");
  if (stateFile && probes.length) await writeFile(stateFile, JSON.stringify(result.state) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
