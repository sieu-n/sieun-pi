import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Vent chat's "Vent gateway" precheck (`node --import tsx scripts/duties/vent-gateway.ts`). No model call, no browser, names only for keys.
 * - through_vent_pct, the headline: the share of in-scope outside call sites and inbound webhooks that go through Vent in prod. Call sites come
 *   from vent-share.py beside this file, run in the auto-sns-agent checkout at origin/main, which is what prod runs: a site counts when its
 *   code there goes through Vent and, when it runs in prod, prod Vent logged a successful vent.call for it in
 *   the script's last 7 days. Row 63 (GeoNode proxy egress) is the one allowed exception and leaves the count. The 4 Convex inbound webhooks
 *   count when main's convex/http.ts no longer routes the provider's own path and convex/webhooks/vent.ts takes the source.
 * - vent_success_24h_pct: successful prod vent.call rows over the last 24 h, without the caller's own 4xx (429 stays in) and calls the caller
 *   cancelled, from otel_logs in the obs ClickHouse through Grafana's grafana_clickhouse datasource.
 * - provider_keys_outside_vent: (location, key name) pairs where a provider key still sits in a deployment other than Vent, read with the
 *   cutover's env-name listers (sessions/2026/10/18/1610-vent-cutover-all-callers/data) plus Convex env lists and the tier files at origin/main.
 * - vent_hosts_down: how many of vent.virev.ai and vent-staging.virev.ai do not answer 200 on /healthz.
 * A source it cannot read gives 999999 for a count and -1 for a share, a source_errors count and a flagged slice, never a good-looking value.
 * Targets in vent-gateway.duty.json and their sources: through_vent_pct 100 and vent_hosts_down 0 are the owner's "all external API/webhook
 * should pass here", provider_keys_outside_vent 0 is his "completely remove all legacy sdk, API keys from old deployments", and
 * vent_success_24h_pct 99 is the Vent chat's duty brief of 2026-10-18.
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
const SESSIONS = "apps/llm-wiki/content/sessions/2026/10/18";
export const VENT_SHARE = join(dirname(fileURLToPath(import.meta.url)), "vent-share.py");
const LISTERS = `${SESSIONS}/1610-vent-cutover-all-callers/data`;
export const REF = "origin/main";
const GRAFANA = "https://obs.virev.ai/api/ds/query";
export const HOSTS = ["https://vent.virev.ai", "https://vent-staging.virev.ai"] as const;
/** Convex deployments, from the cutover inventory's env-names-before.json (2026-10-18). */
export const CONVEX = { staging: "tremendous-eel-825", production: "befitting-sparrow-356" } as const;
const BOX = "us-metal01";
export const UNMEASURED = 999999;
export const UNMEASURED_PCT = -1;

/**
 * In-scope rows that run in no prod deployment, so their code verdict at main decides them without prod traffic: staging only (12, 13, 61),
 * unconfigured or off (33, 62), laptop and operator scripts (38, 60, 77, 78, 81), and the alarm paths that call Vent first and keep a direct
 * Slack fallback (69, 70, 71), which fire too rarely for a 7 day window. From the "Runs in" cells of the inventory at 8bc0fa3615.
 */
export const CODE_ONLY_ROWS = new Set([12, 13, 33, 38, 60, 61, 62, 69, 70, 71, 77, 78, 81]);

/** The 4 provider webhooks Convex takes today, and the path each provider posts to directly (convex/http.ts at main, 2026-10-18). */
export const WEBHOOKS = [
  { source: "stripe", path: "/stripe-webhook" }, { source: "clerk", path: "/clerk-webhook" },
  { source: "resend", path: "/resend-webhook" }, { source: "zernio", path: "/zernio-webhook" },
] as const;

/**
 * Provider secrets that belong only in Vent once every caller moved: the cutover key inventory (inventory-keys.md) minus URLs, ids,
 * browser-side publishable keys, telemetry (Langfuse, Sentry), Vent's own caller keys and the GeoNode proxy URL, the one allowed exception.
 * Dead keys with no reader stay in, since the owner asked to "completely remove all legacy sdk, API keys from old deployments".
 */
export const PROVIDER_KEYS = new Set([
  "CLIPROXY_API_KEY", "CLIPROXY_SLACK_BOT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "AIMLAPI_KEY", "ELEVENLABS_API_KEY",
  "PEXELS_API_KEY", "HEYGEN_API_KEY", "INSTAGRAM_ACCESS_TOKEN", "INSTAGRAM_APP_SECRET", "TYPESAFE_API_KEY", "ZEROBOUNCE_API_KEY", "RESEND_API_KEY",
  "SLACK_BOT_TOKEN_SALES", "SLACK_BOT_TOKEN_DEV", "STRIPE_SECRET_KEY", "ZERNIO_API_KEY", "GOOGLE_GMAIL_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET",
  "GOOGLE_DRIVE_SYNC_CLIENT_SECRET", "CLERK_SECRET_KEY", "CLERK_DEV_SECRET_KEY", "LITELLM_API_KEY", "QDRANT_API_KEY", "YOUTUBE_API_KEY",
  "POSTHOG_KEY", "POSTHOG_API_KEY", "ANYTHING_BUILDER_AUTH_TOKEN", "STRIPE_WEBHOOK_SECRET", "CLERK_WEBHOOK_SIGNING_SECRET",
  "RESEND_WEBHOOK_SECRET", "ZERNIO_WEBHOOK_SECRET",
]);

/**
 * Where SLACK_BOT_TOKEN_DEV may stay: the alarm paths of rows 69 (metal watch dead-man), 70 (Grafana contact points) and 71 (ci_watch), which
 * keep a direct Slack fallback for when Vent is down, and the files they read it from.
 */
export const ALARM_FALLBACK = /^(tier apps\/infra\/\.env|tier apps\/infra\/metal\/watch\/\.env\.watch|box \/srv\/obs\/secrets\/obs\.env|box \/srv\/[^/]+\/current\/apps\/infra\/metal\/watch\/\.env\.watch|container virev-obs-grafana|railway auto-sns-crawler\/[^/]+\/metal-watch)$/;

/** Vent's own homes: its Railway service, its tier files, its secrets on the box and its containers. */
export const VENT_OWN = /^(railway .*\/vent|tier apps\/vent\/.*|box .*\/vent[^/]*|container .*-vent(-.*)?)$/;

/**
 * Whether a lister location is a deployment of this system other than Vent: Convex, the auto-sns-crawler Railway project, the auto-sns-*
 * Vercel projects, the repo's GitHub stores, tracked tier files and us-metal01. Other projects on the same accounts (slack.green, tokscale,
 * hello2026) and the CLIProxy gateway, which sits upstream of Vent, are outside it.
 */
export function inScope(location: string): boolean {
  if (VENT_OWN.test(location)) return false;
  return /^(convex |railway auto-sns-crawler\/|vercel auto-sns-|github (secrets|variables) (repo|env )|tier |box |container )/.test(location);
}

export interface ShareSite { row: number; app: string; provider: string; runs_in: string; status: string; direct?: string[]; exception?: string | null }
export interface ShareResult { refs: Record<string, { sha: string; sites: ShareSite[]; new_direct?: Record<string, string[]> }>; traffic?: { production?: { sites_with_vent_traffic: number[] } } }
export interface WebhookVerdict { source: string; direct: boolean; vent: boolean }
export interface CallRow { outcome: string; status: string; calls: number }
export interface KeyListing { locations: Record<string, string[]>; unreadable: Record<string, string> }
export interface VentReads { share: ShareResult | { error: string }; webhooks: WebhookVerdict[] | { error: string }; calls: CallRow[] | { error: string }; keys: KeyListing; health: { url: string; status: number; error?: string }[] }

const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places;
const failed = <T extends object>(value: T | { error: string }): value is { error: string } => "error" in value && typeof (value as { error: unknown }).error === "string";

/** Whether main's convex/http.ts still routes the source's own path, and whether convex/webhooks/vent.ts takes the source. */
export function webhookVerdicts(http: string, ventRoute: string | null): WebhookVerdict[] {
  return WEBHOOKS.map(({ source, path }) => ({
    source,
    direct: new RegExp(`path:\\s*['"]${path.replace(/[/-]/g, "\\$&")}['"]`).test(http),
    vent: ventRoute !== null && new RegExp(`\\[\\s*['"]${source}['"]\\s*,`).test(ventRoute) && /webhooks\/vent/.test(ventRoute + http),
  }));
}

/** A caller's own 4xx (429 is capacity, so it stays) or a call the caller cancelled, which the success rate leaves out. */
export const callersOwn = (row: CallRow): boolean => row.outcome === "cancelled" || (/^4\d\d$/.test(row.status) && row.status !== "429");

/** dotenv names of a tier file, without dotenvx's DOTENV_* keys and without `# NAME=` placeholder rows. */
export const envNames = (text: string): string[] =>
  [...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map(match => match[1]!).filter(name => !name.startsWith("DOTENV_"));

export function ventMetrics(reads: VentReads, at: number): PrecheckOutput {
  const flagged: FlaggedSlice[] = [];
  const metrics: Record<string, number> = {};
  let sourceErrors = 0;
  const sourceError = (excerpt: string) => { sourceErrors++; flagged.push({ at, kind: "source_error", excerpt: excerpt.slice(0, 300) }); };

  if (failed(reads.share) || failed(reads.webhooks)) {
    if (failed(reads.share)) sourceError(`vent share script gave no result: ${reads.share.error}`);
    if (failed(reads.webhooks)) sourceError(`convex/http.ts at ${REF} could not be read: ${reads.webhooks.error}`);
    metrics.through_vent_pct = UNMEASURED_PCT;
  } else {
    const main = reads.share.refs[REF];
    const live = new Set(reads.share.traffic?.production?.sites_with_vent_traffic ?? []);
    if (!main || !reads.share.traffic?.production) sourceError(`vent share script result has no ${main ? "prod traffic" : REF} section`);
    const sites = (main?.sites ?? []).filter(site => !site.exception);
    let through = 0;
    for (const site of sites) {
      const codeOnly = CODE_ONLY_ROWS.has(site.row);
      if (site.status === "vent" && (codeOnly || live.has(site.row))) { through++; continue; }
      const why = site.status !== "vent" ? `code at main is ${site.status}${site.direct?.[0] ? `: ${site.direct[0]}` : ""}` : "code at main goes through Vent, but prod Vent logged no successful vent.call for it in 7 days";
      flagged.push({ at, kind: site.status === "vent" ? "no_prod_traffic" : "site_direct", item: `row ${site.row}`, excerpt: `#${site.row} ${site.app} ${site.provider}: ${why}`.slice(0, 300) });
    }
    for (const hook of reads.webhooks) {
      if (!hook.direct && hook.vent) { through++; continue; }
      flagged.push({ at, kind: "webhook_direct", item: `webhook ${hook.source}`, excerpt: `${hook.source} webhook: ${hook.direct ? `convex/http.ts at main still routes the provider's own path` : "no direct route"}${hook.vent ? "" : ", and convex/webhooks/vent.ts at main does not take it"}` });
    }
    const total = sites.length + reads.webhooks.length;
    metrics.through_vent_pct = main && reads.share.traffic?.production && total ? round(100 * through / total) : UNMEASURED_PCT;
    metrics.through_vent_count = through;
    metrics.in_scope_count = total;
    metrics.unlisted_direct_files = Object.keys(main?.new_direct ?? {}).length;
    for (const [path, lines] of Object.entries(main?.new_direct ?? {})) flagged.push({ at, kind: "unlisted_direct", item: path, excerpt: `${path} at main, outside the 70 sites, still reads a provider key or host: ${lines[0]}`.slice(0, 300) });
  }

  if (failed(reads.calls)) {
    sourceError(`prod vent.call rows could not be read from ClickHouse: ${reads.calls.error}`);
    metrics.vent_success_24h_pct = UNMEASURED_PCT;
  } else {
    const counted = reads.calls.filter(row => !callersOwn(row));
    const total = counted.reduce((sum, row) => sum + row.calls, 0);
    const ok = counted.filter(row => row.outcome === "success").reduce((sum, row) => sum + row.calls, 0);
    metrics.vent_calls_24h = reads.calls.reduce((sum, row) => sum + row.calls, 0);
    metrics.vent_success_24h_pct = total ? round(100 * ok / total, 2) : UNMEASURED_PCT;
    if (!total) flagged.push({ at, kind: "no_calls", excerpt: `prod Vent logged ${metrics.vent_calls_24h} vent.call rows in 24 h and none outside the caller's own 4xx, so there is no success rate to read` });
    for (const row of counted) if (row.outcome !== "success") flagged.push({ at, kind: "call_failed", excerpt: `${row.calls} prod vent.call rows in 24 h ended ${row.outcome} with HTTP ${row.status}` });
  }

  for (const [location, error] of Object.entries(reads.keys.unreadable)) sourceError(`${location} could not be listed: ${error}`);
  const leaks: string[] = [];
  for (const [location, names] of Object.entries(reads.keys.locations)) {
    if (!inScope(location)) continue;
    const here = names.filter(name => PROVIDER_KEYS.has(name) && !(name === "SLACK_BOT_TOKEN_DEV" && ALARM_FALLBACK.test(location)));
    for (const name of here) leaks.push(`${location} ${name}`);
    if (here.length) flagged.push({ at, kind: "key_outside_vent", item: location, excerpt: `${location} still holds ${here.join(", ")}`.slice(0, 300) });
  }
  const keysUnread = Object.keys(reads.keys.unreadable).length > 0;
  metrics.provider_keys_outside_vent = keysUnread ? UNMEASURED : leaks.length;
  metrics.provider_keys_seen = leaks.length;
  metrics.key_locations_with_leaks = new Set(leaks.map(leak => leak.slice(0, leak.lastIndexOf(" ")))).size;

  metrics.vent_hosts_down = reads.health.filter(host => host.status !== 200).length;
  for (const host of reads.health) if (host.status !== 200) flagged.push({ at, kind: "host_down", item: host.url, excerpt: `${host.url}/healthz gave ${host.error ?? `HTTP ${host.status}`}`.slice(0, 300) });
  metrics.source_errors = sourceErrors;
  return { metrics, flagged };
}

const run = (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) => new Promise<string>((resolve, reject) => {
  const child = execFile(file, args, { cwd: options.cwd ?? REPO, env: options.env ?? process.env, encoding: "utf8", maxBuffer: 64 << 20 },
    (error, stdout, stderr) => error ? reject(new Error(`${file} ${args.slice(0, 2).join(" ")}: ${String(stderr).trim().split("\n").slice(-2).join(" ").slice(-200) || error.message}`)) : resolve(stdout));
  if (options.input !== undefined) child.stdin?.end(options.input);
});
const errorText = (error: unknown) => {
  if (!(error instanceof Error)) return String(error);
  const code = (error.cause as { code?: string } | undefined)?.code;
  return code ? `${error.message} (${code})` : error.message;
};

async function grafanaToken(): Promise<string> {
  if (process.env.GRAFANA_AGENT_TOKEN) return process.env.GRAFANA_AGENT_TOKEN;
  const token = (await run("npx", ["--no-install", "dotenvx", "get", "GRAFANA_AGENT_TOKEN", "-f", ".env"], { cwd: join(REPO, "apps/infra") })).trim();
  if (!token) throw new Error("GRAFANA_AGENT_TOKEN missing in apps/infra/.env");
  return token;
}

/** Prod vent.call rows of the last 24 h by outcome and HTTP status. */
async function callRows(token: string): Promise<CallRow[]> {
  const sql = "SELECT LogAttributes['vent.outcome'] AS outcome, LogAttributes['http.response.status_code'] AS status, count() AS calls FROM otel_logs " +
    "WHERE ServiceName = 'vent' AND Body = 'vent.call' AND ResourceAttributes['deployment.environment.name'] = 'production' " +
    "AND Timestamp > now() - INTERVAL 24 HOUR GROUP BY outcome, status";
  const response = await fetch(GRAFANA, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ queries: [{ refId: "A", datasource: { uid: "grafana_clickhouse", type: "grafana-clickhouse-datasource" }, rawSql: sql, format: 1, queryType: "sql" }], from: "now-24h", to: "now" }),
  });
  const body = await response.json().catch(() => null) as { results?: { A?: { frames?: { schema: { fields: { name: string }[] }; data: { values: unknown[][] } }[]; error?: string } } } | null;
  const result = body?.results?.A;
  if (!response.ok || !result || result.error) throw new Error(`HTTP ${response.status}: ${String(result?.error ?? "no result").slice(0, 160)}`);
  const frame = result.frames?.[0];
  if (!frame) return [];
  const names = frame.schema.fields.map(field => field.name);
  const column = (name: string) => frame.data.values[names.indexOf(name)] ?? [];
  return column("calls").map((calls, index) => ({ outcome: String(column("outcome")[index] ?? ""), status: String(column("status")[index] ?? ""), calls: Number(calls) }));
}

async function share(token: string | undefined, dir: string): Promise<ShareResult> {
  const out = join(dir, "vent-share.json");
  await run("python3", [VENT_SHARE, "--ref", REF, "--traffic", "--json", out], { env: { ...process.env, ...(token ? { GRAFANA_AGENT_TOKEN: token } : {}) } });
  return JSON.parse(await readFile(out, "utf8")) as ShareResult;
}

async function webhooks(): Promise<WebhookVerdict[]> {
  const http = await run("git", ["show", `${REF}:convex/http.ts`]);
  const ventRoute = await run("git", ["show", `${REF}:convex/webhooks/vent.ts`]).catch(() => null);
  return webhookVerdicts(http, ventRoute);
}

/** Every location's env names: the cutover listers, both Convex deployments, the tier files at main and us-metal01. Values never leave this function. */
async function keyListing(): Promise<KeyListing> {
  const locations: Record<string, string[]> = {};
  const unreadable: Record<string, string> = {};
  const tasks: Promise<void>[] = [];
  tasks.push(run("node", [`${LISTERS}/list-store-names.mjs`]).then(stdout => {
    const listed = JSON.parse(stdout) as { out: Record<string, string[]>; unreadable: Record<string, string> };
    Object.assign(locations, listed.out);
    // sieu-n is a user account, so the org secrets call answers 404 and there is no org store to read.
    for (const [location, error] of Object.entries(listed.unreadable)) if (!(location === "github secrets org" && /HTTP 404/.test(error))) unreadable[location] = error;
  }, (error: unknown) => { unreadable["railway, vercel and github"] = errorText(error); }));
  for (const [tier, name] of Object.entries(CONVEX)) {
    tasks.push(run("npx", ["convex", "env", "list", "--deployment-name", name, "--env-file", "/dev/null"]).then(stdout => {
      locations[`convex ${tier} ${name}`] = [...stdout.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map(match => match[1]!);
    }, (error: unknown) => { unreadable[`convex ${tier} ${name}`] = errorText(error); }));
  }
  tasks.push((async () => {
    const files = (await run("git", ["ls-tree", "-r", "--name-only", REF])).split("\n")
      .filter(path => /(^|\/)\.env(\.[\w-]+)?$/.test(path) && !/\.env\.(example|local|keys)$/.test(path) && !path.startsWith("apps/llm-wiki/content/"));
    for (const path of files) locations[`tier ${path}`] = envNames(await run("git", ["show", `${REF}:${path}`]));
  })().catch((error: unknown) => { unreadable[`tier files at ${REF}`] = errorText(error); }));
  for (const [script, prefix] of [["box-secret-names.py", "box"], ["box-container-env-names.py", "container"]] as const) {
    tasks.push(readFile(join(REPO, LISTERS, script), "utf8").then(source => run("ssh", ["-o", "BatchMode=yes", BOX, "python3", "-"], { input: source })).then(stdout => {
      for (const [location, names] of Object.entries(JSON.parse(stdout) as Record<string, string[]>)) locations[`${prefix} ${location.replace(/\/$/, "")}`] = names;
    }, (error: unknown) => { unreadable[`${BOX} ${prefix}`] = errorText(error); }));
  }
  await Promise.all(tasks);
  return { locations, unreadable };
}

async function health(url: string): Promise<{ url: string; status: number; error?: string }> {
  try {
    const response = await fetch(`${url}/healthz`);
    await response.arrayBuffer();
    return { url, status: response.status };
  } catch (error) { return { url, status: 0, error: errorText(error) }; }
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("vent-gateway: OUTPUT_FILE is not set\n"); process.exit(2); }
  const at = Date.now();
  const dir = await mkdtemp(join(tmpdir(), "vent-gateway-"));
  try {
    const fetched = await run("git", ["fetch", "--quiet", "origin", "main"]).then(() => null, (error: unknown) => errorText(error));
    const token = await grafanaToken().catch((error: unknown) => ({ error: errorText(error) }));
    const tokenText = typeof token === "string" ? token : undefined;
    const [shareResult, hooks, calls, keys, hosts] = await Promise.all([
      share(tokenText, dir).catch((error: unknown) => ({ error: errorText(error) })),
      webhooks().catch((error: unknown) => ({ error: errorText(error) })),
      typeof token === "string" ? callRows(token).catch((error: unknown) => ({ error: errorText(error) })) : Promise.resolve(token),
      keyListing(),
      Promise.all(HOSTS.map(health)),
    ]);
    const result = ventMetrics({ share: shareResult, webhooks: hooks, calls, keys, health: hosts }, at);
    if (fetched) result.flagged!.push({ at, kind: "stale_ref", excerpt: `git fetch origin main failed, so ${REF} may be old: ${fetched}`.slice(0, 300) });
    await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
