import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Crawler API and MCP duty's precheck for the Crawler VP chat (`node --import tsx scripts/duties/crawler-api-mcp.ts`). Reads only.
 * The owner merged the Crawler API and Query MCP duties on 10-22 (msg mvj491h5): "merge Crawler API & Query MCP".
 * The headline counts what fails on prod for a customer: the documented crawler API routes that fail for a crawler reason, read by
 * auto-sns-agent scripts/duties/crawler/crawler-api.mjs from the API portal chat's d2 detail file, plus each Query MCP call that fails on
 * prod https://virev.ai/mcp on either tier. The supporting counts, minutes the API and its health snapshots were down in 24 h (prod
 * Prometheus through obs.virev.ai) and the Instagram posts behind the prod OpenSearch alias crawler_v3_posts (0 when the alias is off),
 * come from the same crawler-api.mjs run. The posts count keeps p689, closed on 10-24 at 1,411.8M against 1,007M. The onboarding render
 * count, also from crawler-api.mjs, keeps p1076: 3 shop page renders fired at once at the prod crawler, counted when they answer under
 * onboarding's 60 s render limit.
 * The MCP half calls prod the way a customer's agent does (JSON-RPC over Streamable HTTP, a bearer token): describe, a sql count, a search
 * count and the owner's follower-bucket sql (10-15 23:58Z: "팔로워 구간별로 좋아요 수 비율 분석해줘" as one group-by sql call), per tier.
 * The identity is the prod test user mcp-duty-checker with orgs org_mcp_duty_standard and org_mcp_duty_full (dataApi allow), made on 10-20
 * for this check; each run mints a fresh access token with the search app's MCP_TOKEN_SIGNING_SECRET, so no token is stored. The secret
 * comes from apps/search/.env at the commit prod serves (https://virev.ai/health names it), decrypted with the checkout's
 * apps/search/.env.keys. On 10-22 the incident QH8L8B3E rotation changed the secret on sieun/dev at 10:02Z while prod still served main
 * 6cdb32f, and a token signed with the checkout's secret read invalid_token on all 8 calls.
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
const MCP_URL = "https://virev.ai/mcp";
const HEALTH_URL = "https://virev.ai/health";
const USER = "mcp-duty-checker";
const TIERS = ["standard", "full"] as const;
/** The "could not measure" value, the same one auto-sns-agent scripts/duties/ci/duty-sources.mjs gives a metric it could not read. */
export const UNMEASURED = 999999;
export const HEADLINE = "prod_routes_and_mcp_tools_failing";
/** Token lifetime: one run. The whole MCP check took 26 to 38 s on prod (10-19 17:30Z and 23:22Z), so an hour covers it with room. */
const TOKEN_TTL_S = 3600;
/** One MCP call. The slowest call, the follower-bucket sql on the standard tier, stops at that tier's 10 s max_execution_time. */
const CALL_TIMEOUT_MS = 30_000;
export const FOLLOWER_BUCKET_SQL =
  "SELECT multiIf(followers < 1000, '0-1K', followers < 10000, '1K-10K', followers < 100000, '10K-100K', followers < 1000000, '100K-1M', '1M+') " +
  "AS follower_bucket, count() AS posts, round(avg(likes)) AS avg_likes, round(avg(likes / followers) * 100, 3) AS likes_per_follower_pct " +
  "FROM q.instagram_post_counts WHERE followers > 0 GROUP BY follower_bucket ORDER BY min(followers)";
const CALLS: { name: string; tool: "describe" | "sql" | "search"; args: Record<string, unknown> }[] = [
  { name: "describe", tool: "describe", args: {} },
  { name: "sql", tool: "sql", args: { sql: "SELECT count() AS posts FROM q.instagram_post_counts" } },
  { name: "search", tool: "search", args: { index: "crawler_v3_profiles", op: "_count", body: { query: { match_all: {} } } } },
  { name: "follower_bucket", tool: "sql", args: { sql: FOLLOWER_BUCKET_SQL } },
];

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
export function mintToken(secret: string, tier: string, now: number): string {
  const payload = { userId: USER, clientId: `duty-query-mcp-${tier}`, clientName: `Query MCP duty check, ${tier} tier (keep)`, connectorSurface: "custom",
    resource: MCP_URL, aud: MCP_URL, scope: "openid profile email", orgId: `org_mcp_duty_${tier}`, type: "access", iat: now, exp: now + TOKEN_TTL_S,
    jti: randomBytes(16).toString("hex") };
  const enc = b64u(JSON.stringify(payload));
  return `vrev_mcp_access.${enc}.${b64u(createHmac("sha256", secret).update(enc).digest())}`;
}

/** The JSON-RPC result of one Streamable HTTP POST, answered as JSON or as an SSE stream. */
export function rpcResult(text: string): { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } } {
  const body = text.trimStart().startsWith("{") ? text : text.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5)).join("");
  return JSON.parse(body);
}

export interface CallResult { name: string; ok: boolean; ms: number; note: string }
async function callTool(token: string, call: (typeof CALLS)[number], id: number): Promise<CallResult> {
  const t0 = Date.now();
  const done = (ok: boolean, note: string): CallResult => ({ name: call.name, ok, ms: Date.now() - t0, note });
  try {
    const res = await fetch(MCP_URL, { method: "POST", signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: call.tool, arguments: call.args } }) });
    const text = await res.text();
    if (!res.ok) return done(false, `HTTP ${res.status}: ${text.slice(0, 200)}`);
    const rpc = rpcResult(text);
    const out = (rpc.result?.content ?? []).map(c => c.text ?? "").join("");
    if (rpc.error || rpc.result?.isError) return done(false, (rpc.error?.message ?? out).slice(0, 300));
    let meta: { ms?: number; readRows?: number; readBytes?: number } | undefined;
    try { meta = (JSON.parse(out) as { data?: { meta?: typeof meta } }).data?.meta; } catch { /* a text answer */ }
    return done(true, meta ? [`server ${meta.ms} ms`, meta.readRows !== undefined ? `${meta.readRows} rows` : "", meta.readBytes !== undefined ? `${meta.readBytes} bytes read` : ""].filter(Boolean).join(", ") : "");
  } catch (error) {
    return done(false, error instanceof Error ? error.message : String(error));
  }
}

/** The prod search app's MCP_TOKEN_SIGNING_SECRET: apps/search/.env at the revision https://virev.ai/health reports. */
async function prodSigningSecret(): Promise<string> {
  const run = promisify(execFile);
  const health = (await (await fetch(HEALTH_URL, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })).json()) as { revision?: string | null };
  const rev = health.revision;
  if (!rev || !/^[0-9a-f]{40}$/.test(rev)) throw new Error(`${HEALTH_URL} named no revision (${JSON.stringify(health)})`);
  await run("git", ["cat-file", "-e", `${rev}^{commit}`], { cwd: REPO }).catch(() => run("git", ["fetch", "-q", "origin", rev], { cwd: REPO }));
  const dir = await mkdtemp(join(tmpdir(), "crawler-api-mcp-env-"));
  try {
    const envFile = join(dir, ".env");
    await writeFile(envFile, (await run("git", ["show", `${rev}:apps/search/.env`], { cwd: REPO, maxBuffer: 16 << 20 })).stdout, { mode: 0o600 });
    const { stdout } = await run("npx", ["--no-install", "dotenvx", "get", "MCP_TOKEN_SIGNING_SECRET", "-f", envFile, "-fk", join(REPO, "apps/search/.env.keys")],
      { cwd: join(REPO, "apps/search") });
    const secret = stdout.trim();
    if (!secret || secret.startsWith("encrypted:")) throw new Error(`MCP_TOKEN_SIGNING_SECRET did not decrypt in apps/search/.env at prod revision ${rev.slice(0, 10)}`);
    return secret;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readMcp(): Promise<Record<string, CallResult[]>> {
  const secret = await prodSigningSecret();
  const now = Math.floor(Date.now() / 1000);
  const tiers = await Promise.all(TIERS.map(async tier => {
    const token = mintToken(secret, tier, now);
    const calls: CallResult[] = [];
    for (const [i, call] of CALLS.entries()) calls.push(await callTool(token, call, i + 1));
    return [tier, calls] as const;
  }));
  return Object.fromEntries(tiers);
}

/** crawler-api.mjs's own output for this run: its three counts, its flagged lines and the time of each count's newest down minute. */
async function readCrawlerApi(): Promise<PrecheckOutput> {
  const dir = await mkdtemp(join(tmpdir(), "crawler-api-mcp-"));
  try {
    const file = join(dir, "crawler-api.json");
    await promisify(execFile)("node", ["scripts/duties/crawler/crawler-api.mjs"], { cwd: REPO, env: { ...process.env, OUTPUT_FILE: file }, timeout: 100_000 });
    return JSON.parse(await readFile(file, "utf8")) as PrecheckOutput;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The precheck output from the crawler-api.mjs output (or why it failed) and the MCP calls per tier (or why they failed). A count that
 * crawler-api.mjs could not read already holds UNMEASURED, and the headline holds UNMEASURED when either half could not be read.
 */
export function report(api: PrecheckOutput | Error, mcp: Record<string, CallResult[]> | Error, now: number): PrecheckOutput {
  const flagged: FlaggedSlice[] = [];
  const read = (key: string, missing = UNMEASURED) => (api instanceof Error ? missing : api.metrics[key] ?? missing);
  if (api instanceof Error) flagged.push({ at: now, kind: "source_error", excerpt: `crawler-api.mjs failed: ${api.message}`.slice(0, 299) });
  else for (const slice of api.flagged ?? []) {
    if (slice.kind === "unmeasured") continue;
    flagged.push(slice.kind === "prod_routes_failing_crawler" ? { ...slice, kind: HEADLINE } : slice);
  }
  let mcpFailing = UNMEASURED;
  if (mcp instanceof Error) flagged.push({ at: now, kind: "source_error", excerpt: `Query MCP read failed: ${mcp.message}`.slice(0, 299) });
  else {
    const failed = Object.entries(mcp).flatMap(([tier, calls]) => calls.filter(c => !c.ok).map(c => `${tier} ${c.name} (${c.note})`));
    mcpFailing = failed.length;
    if (failed.length) flagged.push({ at: now, kind: HEADLINE, excerpt: `${failed.length} Query MCP calls fail on prod ${MCP_URL}: ${failed.join("; ")}`.slice(0, 600) });
    for (const [tier, calls] of Object.entries(mcp)) {
      flagged.push({ at: now, kind: "detail", excerpt: `Query MCP ${tier} tier: ` + calls.map(c => `${c.name} ${c.ok ? "ok" : "FAILED"} ${c.ms} ms${c.note ? ` (${c.note})` : ""}`).join("; ") });
    }
  }
  const routes = read("prod_routes_failing_crawler");
  const metrics = {
    [HEADLINE]: routes === UNMEASURED || mcpFailing === UNMEASURED ? UNMEASURED : routes + mcpFailing,
    api_down_minutes_24h: read("api_down_minutes_24h"),
    health_snapshot_down_minutes_24h: read("health_snapshot_down_minutes_24h"),
    ig_posts_searchable: read("ig_posts_searchable", -UNMEASURED),
    onboarding_renders_3x_under_60s: read("onboarding_renders_3x_under_60s", -UNMEASURED),
  };
  const unmeasured = Object.entries(metrics).filter(([, value]) => Math.abs(value) === UNMEASURED).map(([key]) => key);
  if (unmeasured.length) flagged.push({ at: now, kind: "unmeasured", excerpt: `Not measured this run, so the value is ${UNMEASURED} or -${UNMEASURED} and counts as a miss: ${unmeasured.join(", ")}. Fix the source error first.` });
  const lastEventAt = api instanceof Error ? undefined : api.lastEventAt;
  return { metrics, flagged, ...(lastEventAt && Object.keys(lastEventAt).length ? { lastEventAt } : {}) };
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("crawler-api-mcp: OUTPUT_FILE is not set\n"); process.exit(2); }
  const asError = (reason: unknown) => (reason instanceof Error ? reason : new Error(String(reason)));
  const [api, mcp] = await Promise.all([readCrawlerApi().catch(asError), readMcp().catch(asError)]);
  const out = report(api, mcp, Date.now());
  await writeFile(output, JSON.stringify(out, null, 2) + "\n");
  process.stdout.write(`crawler-api-mcp: ${Object.entries(out.metrics).map(([k, v]) => `${k}=${v}`).join(" ")}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
