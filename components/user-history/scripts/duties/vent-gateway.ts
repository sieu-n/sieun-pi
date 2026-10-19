import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Vent chat's "Vent gateway" precheck (`node --import tsx scripts/duties/vent-gateway.ts`). No model call, no browser, names only for keys.
 * - through_vent_pct, the headline: the share of in-scope outside call sites and inbound webhooks that go through Vent in prod. The list of
 *   call sites comes from the code at the sieun/dev tip through vent-share.py beside this file: the inventory rows whose call is still there
 *   (a row whose files are deleted or no longer name the provider leaves, as a site_removed row) plus each direct provider call its call
 *   scan finds that no row covers (new_direct_site, never through Vent). A row counts as through when its code at origin/main, which prod
 *   runs, goes through Vent and, when it runs in prod, prod Vent logged a successful vent.call for it in the script's last 7 days. Row 63
 *   (GeoNode proxy egress) is the one allowed exception and leaves the count. The 4 Convex inbound webhooks count when main's
 *   convex/http.ts no longer routes the provider's own path and convex/webhooks/vent.ts takes the source.
 * - provider_keys_outside_vent: (location, key name) pairs where a provider key still sits in a deployment other than Vent, read with the
 *   cutover's env-name listers (sessions/2026/10/18/1610-vent-cutover-all-callers/data) plus Convex env lists and the tier files at origin/main.
 * - code_vent_sites and tip_code_vent_sites: of the code_rows call sites at the tip, how many go through Vent by code alone at main and at
 *   the tip, so the cutover's code progress reads before prod runs it; new_direct_sites and tip_removed_sites count the sites the tip added
 *   and dropped.
 * A source it cannot read gives 999999 for a count to drive down, -1 for a share or a count to drive up, a source_errors count and a flagged slice, never a good-looking value.
 * Targets in vent-gateway.duty.json and their sources: through_vent_pct 100 is the owner's "all external API/webhook should pass here", and
 * provider_keys_outside_vent 0 is his "completely remove all legacy sdk, API keys from old deployments". Call success and host health moved
 * to the Vent integrations duty's own precheck (vent-integrations.ts) on 2026-10-19.
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
const SESSIONS = "apps/llm-wiki/content/sessions/2026/10/18";
export const VENT_SHARE = join(dirname(fileURLToPath(import.meta.url)), "vent-share.py");
const LISTERS = `${SESSIONS}/1610-vent-cutover-all-callers/data`;
export const REF = "origin/main";
/** The release tip, where the cutover lands first: its by-code count shows the code ahead of the next prod promote. */
export const TIP = "origin/sieun/dev";
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
/** The repo secret CLERK_SECRET_KEY reaches only the CI job-local Vent: auto-sns-agent scripts/ci/tasks/search-e2e.sh unsets it
 *  and passes it to `vent-mock up` alone (26a36a614f; search / e2e green in verify run 39284928208), as vent-key-scan.mjs exempts it
 *  (2d058da12). Only that name, only as a repo secret. */
export const CI_VENT_INPUT = (location: string, name: string) => location === "github secrets repo" && name === "CLERK_SECRET_KEY";
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
/** A direct provider call the share script's call scan found in deployed code that no live inventory row covers. */
export interface NewSite { path: string; app: string; provider: string; direct: string[] }
export interface ShareResult { refs: Record<string, { sha: string; sites: ShareSite[]; new_sites?: NewSite[] }>; traffic?: { production?: { sites_with_vent_traffic: number[] } } }
/** Share script statuses for a row whose call is no longer in the code: every file deleted, or the files no longer name the provider. */
export const GONE = new Set(["removed", "gone"]);
export interface WebhookVerdict { source: string; direct: boolean; vent: boolean }
export interface KeyListing { locations: Record<string, string[]>; unreadable: Record<string, string> }
export interface VentReads { share: ShareResult | { error: string }; webhooks: WebhookVerdict[] | { error: string }; keys: KeyListing }

const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places;
const failed = <T extends object>(value: T | { error: string }): value is { error: string } => "error" in value && typeof (value as { error: unknown }).error === "string";

/**
 * The webhook files at a ref: convex/http.ts, convex/webhooks/vent.ts, and since the webhook registry (sieun/dev, 2026-10-18) the source
 * names convex/webhooks/registry.ts lists and the path each convex/webhooks/sources/<name>.ts declares, which receive.ts routes as is.
 */
export interface WebhookFiles { http: string; ventRoute: string | null; registry?: { names: string[]; paths: Record<string, string>; routed: boolean } }

/** Whether the ref still routes the source's own path, and whether convex/webhooks/vent.ts takes the source. */
export function webhookVerdicts({ http, ventRoute, registry }: WebhookFiles): WebhookVerdict[] {
  const quoted = (path: string) => new RegExp(`path:\\s*['"]${path.replace(/[/-]/g, "\\$&")}['"]`);
  const ventBySources = ventRoute !== null && /SOURCES\.find\(/.test(ventRoute) && /pathPrefix:\s*VENT_WEBHOOK_PREFIX/.test(ventRoute);
  return WEBHOOKS.map(({ source, path }) => {
    const listed = registry?.names.includes(source) ?? false;
    return {
      source,
      direct: quoted(path).test(http) || (listed && registry?.routed === true && registry.paths[source] === path),
      vent: ventRoute !== null && /webhooks\/vent/.test(ventRoute + http)
        && (new RegExp(`\\[\\s*['"]${source}['"]\\s*,`).test(ventRoute) || (ventBySources && listed)),
    };
  });
}


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
    const tip = reads.share.refs[TIP];
    const live = new Set(reads.share.traffic?.production?.sites_with_vent_traffic ?? []);
    if (!tip) sourceError(`vent share script result has no ${TIP} section, so the call-site list is unknown`);
    if (!main || !reads.share.traffic?.production) sourceError(`vent share script result has no ${main ? "prod traffic" : REF} section`);
    const atMain = new Map((main?.sites ?? []).map(site => [site.row, site]));
    const sites = (tip?.sites ?? []).filter(site => !site.exception && !GONE.has(site.status));
    const newSites = tip?.new_sites ?? [];
    let through = 0;
    for (const site of sites) {
      const prod = atMain.get(site.row);
      const codeOnly = CODE_ONLY_ROWS.has(site.row);
      if (prod?.status === "vent" && (codeOnly || live.has(site.row))) { through++; continue; }
      const why = prod?.status !== "vent" ? `code at main is ${prod?.status ?? "missing"}${prod?.direct?.[0] ? `: ${prod.direct[0]}` : ""}` : "code at main goes through Vent, but prod Vent logged no successful vent.call for it in 7 days";
      flagged.push({ at, kind: prod?.status === "vent" ? "no_prod_traffic" : "site_direct", item: `row ${site.row}`, excerpt: `#${site.row} ${site.app} ${site.provider}: ${why}`.slice(0, 300) });
    }
    for (const site of newSites) flagged.push({ at, kind: "new_direct_site", item: site.path, excerpt: `${site.app} ${site.provider} at ${TIP}, a direct call no inventory row covers: ${site.direct[0]}`.slice(0, 300) });
    for (const hook of reads.webhooks) {
      if (!hook.direct && hook.vent) { through++; continue; }
      flagged.push({ at, kind: "webhook_direct", item: `webhook ${hook.source}`, excerpt: `${hook.source} webhook: ${hook.direct ? `convex/http.ts at main still routes the provider's own path` : "no direct route"}${hook.vent ? "" : ", and convex/webhooks/vent.ts at main does not take it"}` });
    }
    const total = sites.length + newSites.length + reads.webhooks.length;
    metrics.through_vent_pct = main && tip && reads.share.traffic?.production && total ? round(100 * through / total) : UNMEASURED_PCT;
    metrics.through_vent_count = through;
    metrics.in_scope_count = total;
    metrics.code_rows = tip ? sites.length + newSites.length : UNMEASURED_PCT;
    metrics.code_vent_sites = main && tip ? sites.filter(site => atMain.get(site.row)?.status === "vent").length : UNMEASURED_PCT;
    metrics.tip_code_vent_sites = tip ? sites.filter(site => site.status === "vent").length : UNMEASURED_PCT;
    metrics.new_direct_sites = tip ? newSites.length : UNMEASURED_PCT;
    const removed = (tip?.sites ?? []).filter(site => GONE.has(site.status));
    metrics.tip_removed_sites = tip ? removed.length : UNMEASURED_PCT;
    for (const site of removed) {
      const prod = atMain.get(site.row);
      const still = prod && !GONE.has(prod.status) ? `, and main, which prod runs, still has it (${prod.status}) until the next promote` : "";
      flagged.push({ at, kind: "site_removed", item: `row ${site.row}`, excerpt: `#${site.row} ${site.app} ${site.provider}: its call is ${site.status} at ${TIP}, so it leaves the count${still}`.slice(0, 300) });
    }
    for (const site of sites) {
      if (site.status === "vent") continue;
      flagged.push({ at, kind: "tip_site_direct", item: `row ${site.row}`, excerpt: `#${site.row} ${site.app} ${site.provider}: code at ${TIP} is ${site.status}${site.direct?.[0] ? `: ${site.direct[0]}` : ""}`.slice(0, 300) });
    }
  }

  for (const [location, error] of Object.entries(reads.keys.unreadable)) sourceError(`${location} could not be listed: ${error}`);
  const leaks: string[] = [];
  for (const [location, names] of Object.entries(reads.keys.locations)) {
    if (!inScope(location)) continue;
    const here = names.filter(name => PROVIDER_KEYS.has(name) && !(name === "SLACK_BOT_TOKEN_DEV" && ALARM_FALLBACK.test(location)) && !CI_VENT_INPUT(location, name));
    for (const name of here) leaks.push(`${location} ${name}`);
    if (here.length) flagged.push({ at, kind: "key_outside_vent", item: location, excerpt: `${location} still holds ${here.join(", ")}`.slice(0, 300) });
  }
  const keysUnread = Object.keys(reads.keys.unreadable).length > 0;
  metrics.provider_keys_outside_vent = keysUnread ? UNMEASURED : leaks.length;
  metrics.provider_keys_seen = leaks.length;
  metrics.key_locations_with_leaks = new Set(leaks.map(leak => leak.slice(0, leak.lastIndexOf(" ")))).size;

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

async function share(token: string | undefined, dir: string): Promise<ShareResult> {
  const out = join(dir, "vent-share.json");
  await run("python3", [VENT_SHARE, "--ref", REF, "--ref", TIP, "--traffic", "--json", out], { env: { ...process.env, ...(token ? { GRAFANA_AGENT_TOKEN: token } : {}) } });
  return JSON.parse(await readFile(out, "utf8")) as ShareResult;
}

async function webhooks(): Promise<WebhookVerdict[]> {
  const show = (path: string) => run("git", ["show", `${REF}:${path}`]).catch(() => null);
  const http = await run("git", ["show", `${REF}:convex/http.ts`]);
  const [ventRoute, registryText, receive] = await Promise.all([show("convex/webhooks/vent.ts"), show("convex/webhooks/registry.ts"), show("convex/webhooks/receive.ts")]);
  if (registryText === null) return webhookVerdicts({ http, ventRoute });
  const names = (registryText.match(/SOURCES[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? "").split(",").map(name => name.trim()).filter(Boolean);
  const paths: Record<string, string> = {};
  for (const name of names) {
    const declared = (await show(`convex/webhooks/sources/${name}.ts`))?.match(/path:\s*['"](\/[^'"]+)['"]/)?.[1];
    if (declared) paths[name] = declared;
  }
  return webhookVerdicts({ http, ventRoute, registry: { names, paths, routed: /path:\s*source\.path/.test(receive ?? "") } });
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

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("vent-gateway: OUTPUT_FILE is not set\n"); process.exit(2); }
  const at = Date.now();
  const dir = await mkdtemp(join(tmpdir(), "vent-gateway-"));
  try {
    const fetched = await run("git", ["fetch", "--quiet", "origin", "main", "sieun/dev"]).then(() => null, (error: unknown) => errorText(error));
    const token = await grafanaToken().catch((error: unknown) => ({ error: errorText(error) }));
    const tokenText = typeof token === "string" ? token : undefined;
    const [shareResult, hooks, keys] = await Promise.all([
      share(tokenText, dir).catch((error: unknown) => ({ error: errorText(error) })),
      webhooks().catch((error: unknown) => ({ error: errorText(error) })),
      keyListing(),
    ]);
    const result = ventMetrics({ share: shareResult, webhooks: hooks, keys }, at);
    if (fetched) result.flagged!.push({ at, kind: "stale_ref", excerpt: `git fetch origin main sieun/dev failed, so ${REF} and ${TIP} may be old: ${fetched}`.slice(0, 300) });
    await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
