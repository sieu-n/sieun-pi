import { realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { clickhouse } from "./vent-integrations.ts";

/**
 * The Vent chat's "Vent gateway" precheck (`node --import tsx scripts/duties/vent-gateway.ts`). No model call, no browser, names only for keys.
 * - through_vent_pct, the headline: the share of in-scope outside call sites and inbound webhooks that go through Vent in prod. The list of
 *   call sites comes from the code at the dev/sieun tip through vent-share.py beside this file: the inventory rows whose call is still there
 *   (a row whose files are deleted or no longer name the provider leaves, as a site_removed row) plus each direct provider call its call
 *   scan finds that no row covers (new_direct_site, never through Vent). A row counts as through when its code at origin/main, which prod
 *   runs, goes through Vent with no direct call (owner rule c67: the code path, never demand). Row 63
 *   (GeoNode proxy egress) is the one allowed exception and leaves the count. The 4 Convex inbound webhooks count when main's
 *   convex/http.ts no longer routes the provider's own path and convex/webhooks/vent.ts takes the source.
 * - provider_keys_outside_vent: (location, key name) pairs where a provider key, or a copy of one under another name (providerKey), still
 *   sits in a deployment other than Vent, read with the cutover's env-name listers (sessions/2026/10/18/1610-vent-cutover-all-callers/data)
 *   plus Convex env lists, the tier files at origin/main and the dev/sieun tip, and us-metal01's env files, containers and units.
 * - no_prod_traffic_sites, shown with no target: of the through sites that run in prod (not CODE_ONLY_ROWS), how many prod Vent logged no
 *   successful vent.call for in the share script's last 7 days. It proves use, so it swings with demand (c67); the duty JSON lists no metric
 *   for it, so it never misses (10-22: it read 3 for Notion, Telegram and the Slack incoming webhook, which no customer had connected yet).
 * - code_vent_sites and tip_code_vent_sites: of the code_rows call sites at the tip, how many go through Vent by code alone at main and at
 *   the tip, so the cutover's code progress reads before prod runs it; new_direct_sites and tip_removed_sites count the sites the tip added
 *   and dropped.
 * - removed_provider_refs: (provider, file) pairs at the tip that name a provider goal p22 removed (REMOVED_PROVIDERS) outside the guards
 *   that keep it out (KEPT_GUARDS), plus each removed integration tables.py lists again, so removed code or a removed Vent row that comes back misses.
 * - test_calls_real_24h: test sends off production that reached a real provider in 24 h (TEST_SENDS_SQL, goal p85), one test_send_real row
 *   per integration, caller and method.
 * A source it cannot read gives a source_error flagged slice with its reason, counted in source_errors, and leaves each metric it feeds out of
 * the output (the 999999 placeholder for a count to drive down), so the duty runner reads that metric as not measured, never as a value. Until
 * 10-24 a failed read wrote -1, which the runner judged as a measured miss: at 04:28Z prod ClickHouse waited 86 s on disk for the share
 * script's traffic query, the script exited non-zero and the verify run read through_vent_pct -1 while the code path stood at 100.
 * Targets in vent-gateway.duty.json and their sources: through_vent_pct 100 is the owner's "all external API/webhook should pass here", and
 * provider_keys_outside_vent 0 is his "completely remove all legacy sdk, API keys from old deployments". Call success and host health moved
 * to the Vent integrations duty's own precheck (vent-integrations.ts) on 2026-10-19.
 */

const REPO = process.env.LLM_WIKI_REPO || join(homedir(), "Documents/Github/auto-sns-agent");
const SESSIONS = "apps/llm-wiki/content/sessions/2026/10/18";
export const VENT_SHARE = join(dirname(fileURLToPath(import.meta.url)), "vent-share.py");
const LISTERS = `${SESSIONS}/1610-vent-cutover-all-callers/data`;
export const REF = "origin/main";
/** us-metal02's dev branch dev/sieun (c119), where the cutover lands first: its by-code count shows the code ahead of the next prod promote. */
export const TIP_BRANCH = "dev/sieun";
export const TIP = `origin/${TIP_BRANCH}`;
/** Convex deployments, from the cutover inventory's env-names-before.json (2026-10-18). */
export const CONVEX = { staging: "tremendous-eel-825", production: "befitting-sparrow-356" } as const;
const BOX = "us-metal01";
export const UNMEASURED = 999999;

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
 * B2 and PostHog keys are not here: apps call both directly with their own keys (owner rule c181, 2026-10-27).
 */
export const PROVIDER_KEYS = new Set([
  "CLIPROXY_API_KEY", "CLIPROXY_SLACK_BOT_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "AIMLAPI_KEY", "ELEVENLABS_API_KEY",
  "PEXELS_API_KEY", "HEYGEN_API_KEY", "INSTAGRAM_ACCESS_TOKEN", "INSTAGRAM_APP_SECRET", "TYPESAFE_API_KEY", "ZEROBOUNCE_API_KEY", "RESEND_API_KEY",
  "SLACK_BOT_TOKEN_SALES", "SLACK_BOT_TOKEN_DEV", "STRIPE_SECRET_KEY", "ZERNIO_API_KEY", "GOOGLE_GMAIL_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET",
  "GOOGLE_DRIVE_SYNC_CLIENT_SECRET", "CLERK_SECRET_KEY", "CLERK_DEV_SECRET_KEY", "LITELLM_API_KEY", "QDRANT_API_KEY", "YOUTUBE_API_KEY",
  "ANYTHING_BUILDER_AUTH_TOKEN", "STRIPE_WEBHOOK_SECRET", "CLERK_WEBHOOK_SIGNING_SECRET",
  "RESEND_WEBHOOK_SECRET", "ZERNIO_WEBHOOK_SECRET",
  // Found by the p61 env key audit (10-22): the CLIProxy management key.
  "CLIPROXY_MANAGEMENT_KEY",
  // Vent's openrouter integration secret (apps/vent/src/vent/tables.py).
  "OPENROUTER_API_KEY",
]);

/**
 * A provider key copied under another name: a KEY, TOKEN or SECRET name whose first word is the vendor of a PROVIDER_KEYS name, such as
 * STRIPE_USAGE_KEY. On 10-30 e1e4a1114b put copies of the prod Clerk, Resend, Stripe, Zernio and OpenRouter keys under *_USAGE_KEY names
 * in the infra tier and /srv/obs/secrets/vendor-usage.env on us-metal01, and d1 read provider_keys_outside_vent 0. Vent caller keys,
 * browser-public keys, the Clerk JWT public key and our own OAuth state secrets are not provider keys.
 */
const PROVIDER_VENDORS = new Set([...PROVIDER_KEYS].map(name => name.split("_")[0]!));
const NOT_PROVIDER = /_VENT_KEY$|_PUBLISHABLE_KEY$|^CLERK_JWT_KEY$|_OAUTH_STATE_SECRET$|^GOOGLE_PICKER_API_KEY$/;
export const providerKey = (name: string): boolean =>
  PROVIDER_KEYS.has(name) || (PROVIDER_VENDORS.has(name.split("_")[0]!) && /_(KEY|TOKEN|SECRET)$/.test(name) && !NOT_PROVIDER.test(name));

/** Vercel and Railway tokens count on the box, where the host services exporter (virev-services) calls those APIs at runtime: until 10-24
 *  from /srv/obs/secrets/services.env, since 1b0fa0fd17 from the prod infra tier copy /usr/local/lib/virev-services/infra.env, which the key
 *  scan's BOX_READER reads. In tier files and GitHub, Vercel or Railway stores they are deploy credentials. */
export const BOX_PLATFORM = /^(VERCEL|RAILWAY)_([A-Z0-9]+_)*TOKEN$/;
const onBox = (location: string) => /^(box|container|unit) /.test(location);

/**
 * Where SLACK_BOT_TOKEN_DEV may stay: the alarm paths of rows 69 (metal watch dead-man), 70 (Grafana contact points) and 71 (ci_watch), which
 * keep a direct Slack fallback for when Vent is down, and the files they read it from.
 */
/** The repo secret CLERK_SECRET_KEY reaches only the CI job-local Vent: auto-sns-agent scripts/ci/tasks/search-e2e.sh unsets it
 *  and passes it to `vent-mock up` alone (26a36a614f; search / e2e green in verify run 39284928208), as vent-key-scan.mjs exempts it
 *  (2d058da12). Only that name, only as a repo secret. CLERK_CI_SECRET_KEY, the key of the CI-only Clerk instance, takes the same path
 *  from apps/ci-e2e/.env.staging, which vent-key-scan.mjs exempts too. */
export const CI_VENT_INPUT = (location: string, name: string) =>
  (location === "github secrets repo" && name === "CLERK_SECRET_KEY")
  || (name === "CLERK_CI_SECRET_KEY" && (location === "github secrets repo" || location === "tier apps/ci-e2e/.env.staging"));
export const ALARM_FALLBACK = /^(unit (opensearch|pgbackrest|redis|clickhouse)[a-z0-9-]*@[a-z]+\.service|tier apps\/infra\/\.env|unit virev-services\.service|box \/usr\/local\/lib\/virev-services\/infra\.env|tier apps\/infra\/metal\/watch\/\.env\.watch|box \/srv\/obs\/secrets\/obs\.env|box \/srv\/[^/]+\/current\/apps\/infra\/metal\/watch\/\.env\.watch|container virev-obs-grafana|railway auto-sns-crawler\/[^/]+\/metal-watch)$/;

/** Vent's own homes: its Railway service, its tier files, its secrets on the box and its containers. */
export const VENT_OWN = /^(railway .*\/vent|tier apps\/vent\/.*|box .*\/vent[^/]*|container .*-vent(-.*)?)$/;

/** The CLIProxy gateway's own tier files. Its CLIPROXY_API_KEY is the key callers present to the gateway, which sits upstream of Vent, so it is no provider key. */
export const CLIPROXY_OWN = /^tier apps\/infra\/cliproxy\//;

/**
 * Whether a lister location is a deployment of this system other than Vent: Convex, the auto-sns-crawler Railway project, the auto-sns-*
 * Vercel projects, the repo's GitHub stores, tracked tier files and us-metal01. Other projects on the same accounts (slack.green, tokscale,
 * hello2026) and the CLIProxy gateway, which sits upstream of Vent, are outside it.
 */
export function inScope(location: string): boolean {
  if (VENT_OWN.test(location) || CLIPROXY_OWN.test(location)) return false;
  return /^(convex |railway auto-sns-crawler\/|vercel auto-sns-|github (secrets|variables) (repo|env )|tier |box |container |unit )/.test(location);
}

export interface ShareSite { row: number; app: string; provider: string; runs_in: string; status: string; direct?: string[]; exception?: string | null }
/** A direct provider call the share script's call scan found in deployed code that no live inventory row covers. */
export interface NewSite { path: string; app: string; provider: string; direct: string[] }
/** traffic.error is set when the share script could not read prod Vent's vent.call rows; its code verdicts still stand. */
export interface ShareResult { refs: Record<string, { sha: string; sites: ShareSite[]; new_sites?: NewSite[] }>; traffic?: { error?: string; production?: { sites_with_vent_traffic: number[] } } }
/** Share script statuses for a row whose call is no longer in the code: every file deleted, or the files no longer name the provider. */
export const GONE = new Set(["removed", "gone"]);
export interface WebhookVerdict { source: string; direct: boolean; vent: boolean }
export interface KeyListing { locations: Record<string, string[]>; unreadable: Record<string, string> }
/** The tip's text lines that name a removed provider (`git grep -z -n` output) and apps/vent/src/vent/tables.py at the tip. */
export interface RemovedReads { grep: string; tables: string }
/** One group of test sends that reached a real provider in 24 h (TEST_SENDS_SQL). */
export interface TestSendRow { integration: string; caller: string; method: string; calls: number; last: number }
export interface VentReads {
  share: ShareResult | { error: string }; webhooks: WebhookVerdict[] | { error: string }; keys: KeyListing; removed: RemovedReads | { error: string };
  testSends?: TestSendRow[] | { error: string };
}

/**
 * test_calls_real_24h (goal p85, owner rule c174: "these shouldn't be actually being sent"): the calls Vent sent a real provider in the last
 * 24 h on any tier but production, which has no real customers, on the sends that carry test traffic: Resend and Gmail sends, Langfuse trace
 * export and Slack sales pings. Each of those is test traffic Vent should have answered from its fake, except a send whose every recipient
 * domain (vent.recipient_domains, a82dcd731) is one of SINK_DOMAINS, the mail checks' own real targets, which prove real delivery on purpose.
 * Stripe stays out: its staging calls run in test mode, which never charges, and its browser elements need the objects at Stripe, so the
 * specs billing and card checks keep them real by decision. Before Vent wrote vent.recipient_domains, a mail check's send counts here too.
 * Last week this read about 470 a day (Resend 405, Langfuse 61, Slack sales 5), from the test traffic audit of 10-27.
 */
export const SINK_DOMAINS = ["mailsink.virev.ai", "nomail.virev.ai"] as const;
export const TEST_SENDS_SQL = `SELECT \`vent.integration\` AS integration, \`vent.caller\` AS caller, \`vent.method\` AS method,
  sum(greatest(toUInt64OrZero(\`vent.count\`), 1)) AS calls, toUnixTimestamp64Milli(max(Timestamp)) AS last
FROM otel.vent_calls
WHERE Timestamp > now() - INTERVAL 24 HOUR AND ServiceName = 'vent' AND Body = 'vent.call'
  AND ResourceAttributes['deployment.environment.name'] != 'production'
  AND \`vent.route\` != 'webhook' AND \`vent.outcome\` != 'refused' AND \`vent.mock\` != 'true'
  AND ((\`vent.integration\` = 'resend' AND \`vent.method\` IN ('POST /emails', 'POST /emails/batch'))
    OR (\`vent.integration\` = 'gmail' AND \`vent.method\` = 'POST /gmail/v1/users/me/messages/send')
    OR (\`vent.integration\` = 'langfuse' AND \`vent.method\` LIKE 'POST /api/public/otel%')
    OR \`vent.integration\` = 'slack-sales')
  AND NOT (LogAttributes['vent.recipient_domains'] != ''
    AND arrayAll(d -> d IN (${SINK_DOMAINS.map(domain => `'${domain}'`).join(", ")}), splitByChar(',', LogAttributes['vent.recipient_domains'])))
GROUP BY integration, caller, method
ORDER BY calls DESC`;

/**
 * The providers goal p22 removed to the root on 2026-10-19 to 10-21 (the owner: "not just from vent but 뿌리째 쭉쭉 지워. 원천 코드, 관련된
 * 서비스, 테스트 전부 다"): the old konti.bot media stack and its research app, our own Meta Graph app, and ZeroBounce with the Vent
 * integrations no live code called. `grep` is the coarse ERE git grep reads the tip with, `code` the exact match on each line, and
 * `integrations` the tables.py INTEGRATIONS rows that left Vent with it (37305513d4, 4c48f09ef1, 038400632a).
 */
export interface RemovedProvider { name: string; grep: string; code: RegExp; integrations: readonly string[] }
export const REMOVED_PROVIDERS: readonly RemovedProvider[] = [
  { name: "OmniHuman", grep: "omnihuman", code: /omnihuman/i, integrations: [] },
  { name: "AIMLAPI", grep: "aimlapi", code: /aimlapi/i, integrations: ["aimlapi"] },
  { name: "ElevenLabs", grep: "eleven_?labs", code: /eleven_?labs/i, integrations: ["elevenlabs"] },
  { name: "HeyGen", grep: "heygen", code: /heygen/i, integrations: [] },
  { name: "Pexels", grep: "pexels", code: /pexels/i, integrations: ["pexels"] },
  { name: "Sora", grep: "sora|/v1/videos", code: /\bsora[- ]?2\b|\b(generate|download|check)_sora|\bsora_(video|status|general)|\/v1\/videos\b/i, integrations: ["openai"] },
  { name: "konti.bot research app", grep: "[a-z0-9-]\\.konti\\.bot|research[-_]app", code: /\b[\w-]+\.konti\.bot\b|\bresearch[-_]app\b/i, integrations: [] },
  {
    name: "Meta Graph",
    grep: "graph\\.(instagram|facebook)\\.com|api\\.instagram\\.com|rupload\\.facebook\\.com|instagram_(access_token|app_secret)|instagram[-_](graph|oauth|token)|ig_exchange_token",
    // Meta's Ad Library API (graph.facebook.com/ads_archive) is crawler research, not our removed Meta app; INSTAGRAM_GRAPHQL is the crawler's scrape.
    code: /graph\.instagram\.com|graph\.facebook\.com(?!\/(v[\w.]+\/)?ads_archive)|api\.instagram\.com|rupload\.facebook\.com|INSTAGRAM_(ACCESS_TOKEN|APP_SECRET)\b|instagram[-_](graph(?!ql)|oauth|token[-_]exchange)|ig_exchange_token/i,
    integrations: ["instagram-graph", "instagram-graph-user", "instagram-oauth", "instagram-token-exchange"],
  },
  { name: "ZeroBounce", grep: "zerobounce", code: /zerobounce/i, integrations: ["zerobounce"] },
];

/** Tip paths that may name a removed provider: the guards that keep it out, and frozen copies that never run. A path ending in / covers its folder. */
export const KEPT_GUARDS: readonly { path: string; reason: string }[] = [
  { path: "scripts/ci/providers.mjs", reason: "the provider table the key scan's VENDOR_WORDS and the Vent egress lint's banned hosts read, so a removed provider's key or host still fails" },
  { path: "scripts/ci/vent-key-scan.mjs", reason: "the key scan's ban list (the meta-removed and llm-media families)" },
  { path: "scripts/ci/vent-key-scan.test.mjs", reason: "the key scan's test" },
  { path: "scripts/ci/lint.mjs", reason: "the Vent egress lint's banned hosts of our old Meta app" },
  { path: "scripts/ci/lint.test.mjs", reason: "the Vent egress lint's test" },
  { path: "apps/crawler-v3/alembic/versions/0164_drop_email_vendor_verdicts.py", reason: "the ZeroBounce drop migration" },
  { path: "apps/crawler-v3/tests/unit/test_email_vendor_verdicts_drop.py", reason: "the drop migration's test" },
  { path: "apps/infra/metal/gates/ci-durable-schema-tests.sh", reason: "the schema gate that checks 0164 dropped the ZeroBounce storage" },
  { path: "apps/vent/tests/unit/test_integration_route.py", reason: "checks Vent refuses a ZeroBounce call with vent_unknown_integration" },
  { path: "convex/removed-tables.txt", reason: "the dropped konti.bot research tables the convex-schema land check refuses to see re-added" },
  { path: "apps/infra/ci-server/controller/tests/data/", reason: "frozen copies of a past checks.yml the ci-server patcher tests against, pinned in SHA256SUMS" },
  { path: "apps/llm-wiki/tests/fixtures/prose-lint/", reason: "copies of old wiki pages the prose lint tests on" },
  { path: "ops/health/requests.yaml", reason: "the log of past health requests" },
];
const kept = (path: string) => KEPT_GUARDS.some(guard => guard.path.endsWith("/") ? path.startsWith(guard.path) : path === guard.path);

/** The row names of the INTEGRATIONS block in tables.py, or null when the block is missing. */
export function integrationNames(tablesPy: string): string[] | null {
  const start = tablesPy.indexOf("INTEGRATIONS: dict[str, Integration] = {");
  const end = tablesPy.indexOf("\n}\n", start);
  if (start < 0 || end < 0) return null;
  return [...tablesPy.slice(start, end).matchAll(/^\s*"([a-z0-9_-]+)"\s*:\s*Integration\(/gm)].map(match => match[1]!);
}

/** Lines at the tip that name a removed provider outside KEPT_GUARDS, one ref per (provider, file), plus each removed integration tables.py lists again. */
export function removedProviderRefs({ grep, tables }: RemovedReads, at: number): { refs: number; flagged: FlaggedSlice[] } | { error: string } {
  const names = integrationNames(tables);
  if (!names) return { error: `apps/vent/src/vent/tables.py at ${TIP} has no INTEGRATIONS block` };
  const found = new Map<string, FlaggedSlice>();
  for (const line of grep.split("\n")) {
    const [ref, num, text] = line.split("\0");
    if (text === undefined) continue;
    const path = ref!.slice(ref!.indexOf(":") + 1);
    if (kept(path)) continue;
    for (const provider of REMOVED_PROVIDERS) {
      const key = `${provider.name}\0${path}`;
      if (found.has(key) || !provider.code.test(text)) continue;
      found.set(key, { at, kind: "removed_provider_ref", item: path, excerpt: `${provider.name} named at ${TIP} ${path}:${num}: ${text.trim()}`.slice(0, 300) });
    }
  }
  for (const provider of REMOVED_PROVIDERS) {
    for (const integration of provider.integrations.filter(name => names.includes(name))) {
      found.set(`${provider.name}\0integration ${integration}`, { at, kind: "removed_provider_ref", item: `integration ${integration}`, excerpt: `${provider.name}: apps/vent/src/vent/tables.py at ${TIP} lists the removed integration ${integration} again` });
    }
  }
  return { refs: found.size, flagged: [...found.values()] };
}

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
  } else {
    const main = reads.share.refs[REF];
    const tip = reads.share.refs[TIP];
    const traffic = reads.share.traffic?.production;
    const live = new Set(traffic?.sites_with_vent_traffic ?? []);
    if (!tip) sourceError(`vent share script result has no ${TIP} section, so the call-site list is unknown`);
    if (!main) sourceError(`vent share script result has no ${REF} section`);
    if (!traffic) sourceError(`prod vent.call traffic was not read${reads.share.traffic?.error ? `: ${reads.share.traffic.error}` : ", the share result has no prod traffic section"}`);
    const atMain = new Map((main?.sites ?? []).map(site => [site.row, site]));
    const sites = (tip?.sites ?? []).filter(site => !site.exception && !GONE.has(site.status));
    const newSites = tip?.new_sites ?? [];
    let through = 0;
    let quiet = 0;
    for (const site of sites) {
      const prod = atMain.get(site.row);
      if (prod?.status === "vent") {
        // Owner rule c67: the headline measures the code path, not demand. A site whose code at main reaches Vent with no direct
        // call counts; a prod site with no successful vent.call in 7 days is a supporting number only.
        through++;
        if (traffic && !CODE_ONLY_ROWS.has(site.row) && !live.has(site.row)) {
          quiet++;
          flagged.push({ at, kind: "no_prod_traffic", item: `row ${site.row}`, excerpt: `#${site.row} ${site.app} ${site.provider}: code at main goes through Vent; prod Vent logged no successful vent.call for it in 7 days`.slice(0, 300) });
        }
        continue;
      }
      const why = `code at main is ${prod?.status ?? "missing"}${prod?.direct?.[0] ? `: ${prod.direct[0]}` : ""}`;
      flagged.push({ at, kind: "site_direct", item: `row ${site.row}`, excerpt: `#${site.row} ${site.app} ${site.provider}: ${why}`.slice(0, 300) });
    }
    for (const site of newSites) flagged.push({ at, kind: "new_direct_site", item: site.path, excerpt: `${site.app} ${site.provider} at ${TIP}, a direct call no inventory row covers: ${site.direct[0]}`.slice(0, 300) });
    for (const hook of reads.webhooks) {
      if (!hook.direct && hook.vent) { through++; continue; }
      flagged.push({ at, kind: "webhook_direct", item: `webhook ${hook.source}`, excerpt: `${hook.source} webhook: ${hook.direct ? `convex/http.ts at main still routes the provider's own path` : "no direct route"}${hook.vent ? "" : ", and convex/webhooks/vent.ts at main does not take it"}` });
    }
    const total = sites.length + newSites.length + reads.webhooks.length;
    if (main && tip && total) metrics.through_vent_pct = round(100 * through / total);
    else if (main && tip) sourceError(`vent share script found no in-scope call site or webhook at ${TIP}, so there is no share to read`);
    metrics.through_vent_count = through;
    if (main && tip && traffic) metrics.no_prod_traffic_sites = quiet;
    metrics.in_scope_count = total;
    const removed = (tip?.sites ?? []).filter(site => GONE.has(site.status));
    if (tip) {
      metrics.code_rows = sites.length + newSites.length;
      metrics.tip_code_vent_sites = sites.filter(site => site.status === "vent").length;
      metrics.new_direct_sites = newSites.length;
      metrics.tip_removed_sites = removed.length;
      if (main) metrics.code_vent_sites = sites.filter(site => atMain.get(site.row)?.status === "vent").length;
    }
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
    const here = names.filter(name => (providerKey(name) || (BOX_PLATFORM.test(name) && onBox(location))) && !(name === "SLACK_BOT_TOKEN_DEV" && ALARM_FALLBACK.test(location)) && !CI_VENT_INPUT(location, name));
    for (const name of here) leaks.push(`${location} ${name}`);
    if (here.length) flagged.push({ at, kind: "key_outside_vent", item: location, excerpt: `${location} still holds ${here.join(", ")}`.slice(0, 300) });
  }
  const keysUnread = Object.keys(reads.keys.unreadable).length > 0;
  metrics.provider_keys_outside_vent = keysUnread ? UNMEASURED : leaks.length;
  metrics.provider_keys_seen = leaks.length;
  metrics.key_locations_with_leaks = new Set(leaks.map(leak => leak.slice(0, leak.lastIndexOf(" ")))).size;

  const removed = failed(reads.removed) ? reads.removed : removedProviderRefs(reads.removed, at);
  if (failed(removed)) sourceError(`removed provider refs at ${TIP} could not be read: ${removed.error}`);
  else flagged.push(...removed.flagged);
  metrics.removed_provider_refs = failed(removed) ? UNMEASURED : removed.refs;

  if (reads.testSends !== undefined) {
    if (failed(reads.testSends)) {
      sourceError(`otel.vent_calls test sends could not be read: ${reads.testSends.error}`);
      metrics.test_calls_real_24h = UNMEASURED;
    } else {
      metrics.test_calls_real_24h = reads.testSends.reduce((sum, row) => sum + row.calls, 0);
      for (const row of reads.testSends) {
        flagged.push({ at, kind: "test_send_real", item: `${row.integration} ${row.method}`, excerpt: `${row.calls} ${row.integration} ${row.method} calls from caller ${row.caller} off production reached the real provider in 24 h, the last at ${new Date(row.last).toISOString()}`.slice(0, 300) });
      }
    }
  }

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

/** The test sends of TEST_SENDS_SQL, read from prod ClickHouse through the obs Grafana. */
async function testSends(token: string): Promise<TestSendRow[]> {
  const { rows, column } = await clickhouse(token, TEST_SENDS_SQL);
  const [integration, caller, method, calls, last] = ["integration", "caller", "method", "calls", "last"].map(column);
  return Array.from({ length: rows }, (_, i) => ({
    integration: String(integration![i]), caller: String(caller![i]), method: String(method![i]), calls: Number(calls![i]), last: Number(last![i]),
  }));
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

/** What BOX_READER of auto-sns-agent scripts/ci/vent-key-scan.mjs prints: env files, containers (stopped ones too) and host systemd units, names only. */
export interface BoxReaderOut {
  files: Record<string, string[]>; docker: Record<string, string[]>; units?: Record<string, string[]>; errors?: string[];
}

/** Adds the box reader's places to `locations` as `box <file>`, `container <name>` and `unit <unit>`. */
export function boxLocations(out: BoxReaderOut, locations: Record<string, string[]>): void {
  for (const [file, names] of Object.entries(out.files)) locations[`box ${file}`] = names;
  for (const [name, names] of Object.entries(out.docker)) locations[`container ${name}`] = names;
  for (const [unit, names] of Object.entries(out.units ?? {})) locations[`unit ${unit}`] = names;
}

/** Every location's env names: the cutover listers, both Convex deployments, the tier files at main and the tip and us-metal01 through the key scan's BOX_READER. Values never leave this function. */
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
  // A tier file's names at main, which prod runs, and at the tip, where a new copy lands first (the *_USAGE_KEY copies of 10-30).
  for (const ref of [REF, TIP]) tasks.push((async () => {
    const files = (await run("git", ["ls-tree", "-r", "--name-only", ref])).split("\n")
      .filter(path => /(^|\/)\.env(\.[\w-]+)?$/.test(path) && !/\.env\.(example|local|keys)$/.test(path) && !path.startsWith("apps/llm-wiki/content/"));
    for (const path of files) {
      const names = envNames(await run("git", ["show", `${ref}:${path}`]));
      locations[`tier ${path}`] = [...new Set([...(locations[`tier ${path}`] ?? []), ...names])];
    }
  })().catch((error: unknown) => { unreadable[`tier files at ${ref}`] = errorText(error); }));
  tasks.push(run("node", ["--input-type=module", "-e", `import(${JSON.stringify(join(REPO, "scripts/ci/vent-key-scan.mjs"))}).then(m => process.stdout.write(m.BOX_READER))`])
    .then(reader => run("ssh", ["-o", "BatchMode=yes", BOX, "python3", "-"], { input: reader }))
    .then(stdout => { boxLocations(JSON.parse(stdout.trim().split("\n").pop()!) as BoxReaderOut, locations); },
      (error: unknown) => { unreadable[`${BOX} box reader`] = errorText(error); }));
  await Promise.all(tasks);
  return { locations, unreadable };
}

/** The tip's lines that name a removed provider, read with git grep (wiki content and binaries skipped), and tables.py at the tip. Exit 1 is no match. */
async function removedReads(): Promise<RemovedReads> {
  const pattern = REMOVED_PROVIDERS.map(provider => provider.grep).join("|");
  const grep = await new Promise<string>((resolve, reject) => {
    execFile("git", ["grep", "-I", "-n", "-z", "-i", "-E", "-e", pattern, TIP, "--", ".", ":!apps/llm-wiki/content"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 },
      (error, stdout, stderr) => error && !(error.code === 1 && !stderr) ? reject(new Error(`git grep: ${String(stderr).trim().slice(-200) || error.message}`)) : resolve(stdout));
  });
  return { grep, tables: await run("git", ["show", `${TIP}:apps/vent/src/vent/tables.py`]) };
}

async function main(): Promise<void> {
  const output = process.env.OUTPUT_FILE;
  if (!output) { process.stderr.write("vent-gateway: OUTPUT_FILE is not set\n"); process.exit(2); }
  const at = Date.now();
  const dir = await mkdtemp(join(tmpdir(), "vent-gateway-"));
  try {
    const fetched = await run("git", ["fetch", "--quiet", "origin", "main", TIP_BRANCH]).then(() => null, (error: unknown) => errorText(error));
    const token = await grafanaToken().catch((error: unknown) => ({ error: errorText(error) }));
    const tokenText = typeof token === "string" ? token : undefined;
    const [shareResult, hooks, keys, removed, sends] = await Promise.all([
      share(tokenText, dir).catch((error: unknown) => ({ error: errorText(error) })),
      webhooks().catch((error: unknown) => ({ error: errorText(error) })),
      keyListing(),
      removedReads().catch((error: unknown) => ({ error: errorText(error) })),
      tokenText ? testSends(tokenText).catch((error: unknown) => ({ error: errorText(error) })) : Promise.resolve({ error: `no Grafana token: ${(token as { error: string }).error}` }),
    ]);
    const result = ventMetrics({ share: shareResult, webhooks: hooks, keys, removed, testSends: sends }, at);
    if (fetched) result.flagged!.push({ at, kind: "stale_ref", excerpt: `git fetch origin main ${TIP_BRANCH} failed, so ${REF} and ${TIP} may be old: ${fetched}`.slice(0, 300) });
    await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
