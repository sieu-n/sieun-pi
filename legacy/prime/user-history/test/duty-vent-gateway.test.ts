// Guards the Vent gateway duty (vent-gateway.ts). On 2026-10-18 Vent carried 0 of the 70 in-scope prod call sites, both Vent hosts failed
// the TLS handshake and 112 provider keys still sat outside Vent, and the duty has to read those as misses, never as a pass.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { dutyShapeProblem, type DutyMetric } from "../src/shared/chat-duties.ts";
import { boxLocations, inScope, removedProviderRefs, TEST_SENDS_SQL, TIP, UNMEASURED, VENT_SHARE, ventMetrics, webhookVerdicts, type ShareResult, type VentReads } from "../scripts/duties/vent-gateway.ts";

const site = (row: number, status: string, extra: object = {}) => ({ row, app: "convex", provider: "Stripe", runs_in: "Convex staging, prod", status, ...extra });
const TABLES = 'INTEGRATIONS: dict[str, Integration] = {\n    "zernio": Integration(ZERNIO, "ZERNIO_API_KEY"),\n    "cliproxy-openai": Integration(OPENAI, "CLIPROXY_API_KEY"),\n}\n';
const HTTP_DIRECT = "http.route({\n\tpath: '/stripe-webhook',\n})\nhttp.route({ path: '/clerk-webhook' })\nhttp.route({ path: '/resend-webhook' })\nhttp.route({ path: '/zernio-webhook' })\n";
const VENT_ROUTE = "export const VENT_WEBHOOK_PREFIX = '/webhooks/vent/';\nnew Map([\n\t['stripe', a],\n\t['clerk', b],\n\t['resend', c],\n\t['zernio', d],\n]);\n";

function reads(overrides: Partial<VentReads> = {}): VentReads {
  return {
    share: { refs: { "origin/main": { sha: "a", sites: [site(0, "vent"), site(1, "vent"), site(63, "direct", { exception: "GeoNode" })] }, "origin/dev/sieun": { sha: "b", sites: [site(0, "vent"), site(1, "vent"), site(63, "direct", { exception: "GeoNode" })] } }, traffic: { production: { sites_with_vent_traffic: [0, 1] } } },
    webhooks: webhookVerdicts({ http: "", ventRoute: VENT_ROUTE }),
    keys: { locations: { "convex production befitting-sparrow-356": ["VENT_KEY", "PUBLIC_CLERK_PUBLISHABLE_KEY"] }, unreadable: {} },
    removed: { grep: "", tables: TABLES },
    ...overrides,
  };
}

test("all sites and webhooks on Vent with prod traffic read 100%, and the GeoNode exception leaves the count", () => {
  const { metrics } = ventMetrics(reads(), 0);
  assert.equal(metrics.through_vent_pct, 100);
  assert.equal(metrics.in_scope_count, 6);
  assert.equal(metrics.provider_keys_outside_vent, 0);
});

test("a site whose code at main is on Vent counts with or without prod traffic (c67); no traffic is a supporting number", () => {
  const sites = [site(0, "vent"), site(38, "vent"), site(1, "direct")];
  const share = { refs: { "origin/main": { sha: "a", sites }, "origin/dev/sieun": { sha: "b", sites } }, traffic: { production: { sites_with_vent_traffic: [] } } };
  const output = ventMetrics(reads({ share, webhooks: [] }), 0);
  assert.equal(output.metrics.through_vent_pct, round(100 * 2 / 3));
  assert.equal(output.metrics.no_prod_traffic_sites, 1);
  assert.equal(output.flagged!.find(flag => flag.kind === "no_prod_traffic")!.item, "row 0");
  assert.equal(output.flagged!.find(flag => flag.kind === "site_direct")!.item, "row 1");
});

test("direct webhook routes on main count as direct even when the Vent route exists", () => {
  const output = ventMetrics(reads({ webhooks: webhookVerdicts({ http: HTTP_DIRECT, ventRoute: VENT_ROUTE }) }), 0);
  assert.equal(output.metrics.through_vent_pct, round(100 * 2 / 6));
  assert.equal(output.flagged!.filter(flag => flag.kind === "webhook_direct").length, 4);
});

test("provider keys count per location outside Vent, the alarm fallback Slack token is allowed, and an unread store reads unmeasured", () => {
  const keys = { locations: {
    "convex production befitting-sparrow-356": ["STRIPE_SECRET_KEY", "RESEND_API_KEY", "PUBLIC_POSTHOG_KEY"],
    "railway auto-sns-crawler/production/vent": ["STRIPE_SECRET_KEY"],
    "tier apps/vent/.env": ["STRIPE_SECRET_KEY"],
    "vercel slack.green-fe-real production": ["STRIPE_SECRET_KEY"],
    "container virev-obs-grafana": ["SLACK_BOT_TOKEN_DEV"],
    "container virev-obs-digest": ["SLACK_BOT_TOKEN_DEV"],
    "box /srv/obs/secrets/obs.env.bak-20261013": ["SLACK_BOT_TOKEN_DEV"],
    "github secrets repo": ["CLERK_SECRET_KEY", "STRIPE_SECRET_KEY"],
  }, unreadable: {} };
  // The CI-only CLERK_SECRET_KEY repo secret is a Vent input; any other repo secret still counts.
  assert.equal(ventMetrics(reads({ keys }), 0).metrics.provider_keys_outside_vent, 5);
  assert.equal(ventMetrics(reads({ keys: { ...keys, unreadable: { "convex staging tremendous-eel-825": "401" } } }), 0).metrics.provider_keys_outside_vent, UNMEASURED);
  assert.equal(inScope("container virev-prod-vent"), false);
  assert.equal(inScope("box /srv/prod/secrets/vent.env"), false);
  assert.equal(inScope("container virev-prod-crawler-api"), true);
});

// On 10-25 d1 read provider_keys_outside_vent 2 from CLIPROXY_API_KEY in apps/infra/cliproxy/.env and .env.staging, the gateway's own inbound key.
test("the CLIProxy gateway's tier files are out of scope, and other tiers still count", () => {
  const keys = { locations: {
    "tier apps/infra/cliproxy/.env": ["CLIPROXY_API_KEY"],
    "tier apps/infra/cliproxy/.env.staging": ["CLIPROXY_API_KEY"],
    "tier apps/search/.env": ["CLIPROXY_API_KEY"],
  }, unreadable: {} };
  assert.equal(ventMetrics(reads({ keys }), 0).metrics.provider_keys_outside_vent, 1);
  assert.equal(inScope("tier apps/infra/cliproxy/.env"), false);
  assert.equal(inScope("tier apps/infra/.env"), true);
});

test("the box reader's stopped containers, host units and services.env tokens count (p61 audit, 10-22)", () => {
  const locations: Record<string, string[]> = {};
  boxLocations({
    files: { "/srv/obs/secrets/services.env": ["RAILWAY_API_TOKEN", "VERCEL_TOKEN"], "/srv/prod/secrets/vent.env": ["STRIPE_SECRET_KEY"] },
    docker: { "virev-prod-copy-oneoff": ["OPENAI_API_KEY"] },
    units: { "opensearch-b2@prod.service": ["SLACK_BOT_TOKEN_DEV", "PATH"], "virev-digest.service": ["SLACK_BOT_TOKEN_DEV"] },
  }, locations);
  locations["github secrets repo"] = ["VERCEL_TOKEN", "RAILWAY_TOKEN"];
  const output = ventMetrics(reads({ keys: { locations, unreadable: {} } }), 0);
  // services.env 2, the stopped oneoff's key 1, a non-backup unit's Slack token 1. Vent's own file, GitHub deploy tokens
  // and the backup unit, which runs dotenvx over the infra tier that holds the alarm fallback token, do not count.
  assert.equal(output.metrics.provider_keys_outside_vent, 4);
  assert.equal(inScope("unit opensearch-b2@prod.service"), true);
});

// Owner rule c181 (10-27): apps call B2 and PostHog directly, so their keys sit in app tiers and on the box and never count.
test("B2 and PostHog keys outside Vent do not count (c181)", () => {
  const keys = { locations: {
    "tier apps/crawler-v3/.env": ["B2_KEY_ID", "B2_APP_KEY", "RAW_ARCHIVE_URL", "BACKBLAZE_APPLICATION_KEY"],
    "tier apps/search/.env": ["POSTHOG_KEY", "POSTHOG_API_KEY", "POSTHOG_PERSONAL_API_KEY"],
    "box /home/x/.config/b2-viewer/env": ["B2_VIEWER_PROD_KEY"],
    "tier apps/api-portal/.env": ["STRIPE_SECRET_KEY"],
  }, unreadable: {} };
  assert.equal(ventMetrics(reads({ keys }), 0).metrics.provider_keys_outside_vent, 1);
});

// On 10-24 1b0fa0fd17 moved virev-services' RAILWAY_API_TOKEN and VERCEL_TOKEN from /srv/obs/secrets/services.env into the prod infra tier,
// which host.yml copies to /usr/local/lib/virev-services/infra.env, and d1 read provider_keys_outside_vent 0 while the exporter still called
// Railway and Vercel directly. The copy a host unit loads counts its two tokens; the tier file and GitHub keep them as deploy credentials.
test("the infra tier copy virev-services loads counts its Vercel and Railway tokens, and its alarm Slack token stays exempt", () => {
  const locations: Record<string, string[]> = {};
  const tier = ["RAILWAY_API_TOKEN", "VERCEL_TOKEN", "SLACK_BOT_TOKEN_DEV", "GRAFANA_URL"];
  boxLocations({ files: { "/usr/local/lib/virev-services/infra.env": tier }, docker: {}, units: { "virev-services.service": tier } }, locations);
  locations["tier apps/infra/.env"] = tier;
  locations["github secrets repo"] = ["VERCEL_TOKEN"];
  const output = ventMetrics(reads({ keys: { locations, unreadable: {} } }), 0);
  assert.deepEqual(output.flagged!.filter(flag => flag.kind === "key_outside_vent").map(flag => flag.excerpt), [
    "box /usr/local/lib/virev-services/infra.env still holds RAILWAY_API_TOKEN, VERCEL_TOKEN",
    "unit virev-services.service still holds RAILWAY_API_TOKEN, VERCEL_TOKEN",
  ]);
  assert.equal(output.metrics.key_locations_with_leaks, 2);
});

// On 10-24 at 04:28Z the share script exited non-zero on a ClickHouse TIMEOUT_EXCEEDED, the precheck wrote through_vent_pct -1 and the
// runner judged that a measured miss of the 100 target. A failed read leaves the metric out, so the runner reads it as not measured.
test("a failed share script leaves through_vent_pct unmeasured with a source error, never -1", async () => {
  const { judge } = await import("../src/shared/chat-duties.ts");
  const duty = JSON.parse(await readFile(new URL("../scripts/duties/vent-gateway.duty.json", import.meta.url), "utf8"));
  const output = ventMetrics(reads({ share: { error: "exit 1" }, testSends: [] }), 0);
  assert.equal("through_vent_pct" in output.metrics, false);
  assert.ok(Object.values(output.metrics).every(value => value !== -1));
  assert.equal(output.metrics.source_errors, 1);
  const verdict = judge(duty.metrics, output);
  assert.equal(verdict.metrics.through_vent_pct, undefined);
  assert.match(verdict.summary, /not measured: the precheck gave no value for through_vent_pct \(vent share script gave no result: exit 1\)/);
});

test("a failed traffic read keeps the code-path share and leaves only no_prod_traffic_sites unmeasured", () => {
  const share = { refs: (reads().share as ShareResult).refs, traffic: { error: "Grafana answered 400 for vent.call day 0: Code: 159. DB::Exception: Timeout exceeded" } };
  const output = ventMetrics(reads({ share } as Partial<VentReads>), 0);
  assert.equal(output.metrics.through_vent_pct, 100);
  assert.equal("no_prod_traffic_sites" in output.metrics, false);
  assert.equal(output.flagged!.filter(flag => flag.kind === "no_prod_traffic").length, 0);
  assert.equal(output.metrics.source_errors, 1);
  assert.match(output.flagged!.find(flag => flag.kind === "source_error")!.excerpt, /^prod vent\.call traffic was not read: Grafana answered 400 .*Timeout exceeded/);
});

test("vent-share.py reads the datasource error out of a Grafana answer that leads with the executed query", async () => {
  const { execFileSync } = await import("node:child_process");
  const { VENT_SHARE } = await import("../scripts/duties/vent-gateway.ts");
  const body = JSON.stringify({ results: { A: { error: "Code: 159. DB::Exception: Timeout exceeded: elapsed 85871 ms, maximum: 64000 ms", status: 400,
    frames: [{ schema: { meta: { executedQueryString: `SELECT ${"x, ".repeat(200)}1` } } }] } } });
  const code = "import importlib.util, sys\nspec = importlib.util.spec_from_file_location('vs', sys.argv[1]); vs = importlib.util.module_from_spec(spec)\n" +
    "sys.modules['vs'] = vs; spec.loader.exec_module(vs)\nprint(vs.grafana_error(sys.argv[2]))";
  assert.equal(execFileSync("python3", ["-c", code, VENT_SHARE, body], { encoding: "utf8" }).trim(), "Code: 159. DB::Exception: Timeout exceeded: elapsed 85871 ms, maximum: 64000 ms");
});

test("vent-share.py takes each provider's Vent integrations from tables.py, by name or by secret, and never gives gmail to Google OAuth", async () => {
  const { execFileSync } = await import("node:child_process");
  const { VENT_SHARE } = await import("../scripts/duties/vent-gateway.ts");
  const tables = 'INTEGRATIONS: dict[str, Integration] = {\n  "slack-dev": Integration(SLACK, "SLACK_BOT_TOKEN_DEV"),\n  "openai": Integration(OPENAI, "OPENAI_API_KEY"),\n' +
    '  "gmail": Integration(GMAIL, "GOOGLE_GMAIL_CLIENT_SECRET"),\n  "google-oauth": Integration(GOOGLE_OAUTH, secret_env="GOOGLE_GMAIL_CLIENT_SECRET"),\n}\n';
  const code = "import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location('vs', sys.argv[1]); vs = importlib.util.module_from_spec(spec)\n" +
    "sys.modules['vs'] = vs; spec.loader.exec_module(vs)\nints = vs.vent_integrations(sys.argv[2])\n" +
    "print(json.dumps({p: sorted(vs.integrations_for(p, ints)) for p in ['slack', 'openai-paid', 'google-oauth', 'gmail', 'notion']}))";
  const got = JSON.parse(execFileSync("python3", ["-c", code, VENT_SHARE, tables], { encoding: "utf8" }));
  assert.deepEqual(got, { slack: ["slack-dev"], "openai-paid": ["openai"], "google-oauth": ["google-oauth"], gmail: ["gmail"], notion: [] });
});

const round = (value: number) => Math.round(value * 10) / 10;

// On sieun/dev since 2026-10-18 http.ts names no webhook path: registry.ts lists the sources, each sources/<name>.ts declares its path,
// receive.ts routes source.path and vent.ts takes any listed source. Read with http.ts alone, all 4 hooks would have read "no direct route".
const VENT_BY_SOURCES = "export const VENT_WEBHOOK_PREFIX = '/webhooks/vent/';\nconst source = SOURCES.find((entry) => entry.name === name);\nhttp.route({ pathPrefix: VENT_WEBHOOK_PREFIX, method: 'POST', handler: receiveFromVent });\n";
const SOURCE_PATHS = { stripe: "/stripe-webhook", clerk: "/clerk-webhook", resend: "/resend-webhook", zernio: "/zernio-webhook" };

test("registry webhook sources whose path receive.ts still routes read as direct, and as Vent once their path leaves", () => {
  const names = ["stripe", "clerk", "resend", "zernio"];
  const live = webhookVerdicts({ http: "registerWebhookRoutes(http);", ventRoute: VENT_BY_SOURCES, registry: { names, paths: SOURCE_PATHS, routed: true } });
  assert.deepEqual(live.map(hook => [hook.direct, hook.vent]), [[true, true], [true, true], [true, true], [true, true]]);
  const moved = webhookVerdicts({ http: "registerWebhookRoutes(http);", ventRoute: VENT_BY_SOURCES, registry: { names, paths: SOURCE_PATHS, routed: false } });
  assert.equal(ventMetrics(reads({ webhooks: moved }), 0).metrics.through_vent_pct, 100);
  const unlisted = webhookVerdicts({ http: "", ventRoute: VENT_BY_SOURCES, registry: { names: ["stripe"], paths: {}, routed: true } });
  assert.deepEqual(unlisted.map(hook => hook.vent), [true, false, false, false]);
});

// On 2026-10-19 the Vent cutover train checked the 7 rows the old rules read as direct or partial at sieun/dev 36d3466814 (#2, #13, #19, #35,
// #36, #71, #77): each one goes through Vent, and the session's vent_share.py read 69 of 70 there. Each fixture holds the lines of the real file.
// #36 (PostHog) left the count with c181 on 10-27, so 6 stay here.
const DETECTOR_CASES: Record<string, { row: number; provider: string; files: Record<string, string>; deps?: Record<string, string> }> = {
  "#2 Resend component with an empty key": { row: 2, provider: "resend", files: {
    "convex/search/senders/resendClient.ts": "import { components } from '../../_generated/api';\nimport { Resend } from '@convex-dev/resend';\n\nexport const resend = new Resend(components.resend, {\n\tapiKey: '',\n\ttestMode: false,\n});\n",
    "convex/search/campaigns/scheduler.ts": "import { sendGmailEmail } from '../senders/gmailActions';\nimport { DEPLOYMENT_TAG, deploymentTagValue, resend } from '../senders/resendClient';\n" }, deps: {
    "convex/search/senders/gmailActions.ts": "import { ventAuth, ventFetch, ventUrl } from '../../lib/vent';\n" } },
  "#13 Drive OAuth scope string": { row: 13, provider: "google-drive", files: {
    "convex/search/integrations/driveSyncActions.ts": "import { VENT_PROVIDER_TOKEN_HEADER, ventAuth, ventFetch, ventUrl } from '../../lib/vent';\nexport const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';\n\treturn await ventFetch(ventUrl('google-drive', `/drive/v3${path}`), {\n\t\theaders: { ...ventAuth(), [VENT_PROVIDER_TOKEN_HEADER]: token },\n" } },
  "#19 customer Slack webhook secret in x-vent-provider-token": { row: 19, provider: "slack-webhook", files: {
    "convex/search/workflows/stepActions.ts": "import { VENT_PROVIDER_TOKEN_HEADER, ventAuth, ventFetch, ventUrl } from '../../lib/vent';\n\tconst webhookUrl = await integrationSecret(ctx, orgId, String(config.connectionId ?? ''), 'slack_webhook');\n\tif (!isSlackWebhookUrl(webhookUrl)) throw badRequest('stored Slack webhook URL is invalid');\n\tconst res = await ventFetch(ventUrl('slack-webhook-user', ''), {\n\t\theaders: { ...ventAuth(), [VENT_PROVIDER_TOKEN_HEADER]: slackWebhookSecret(webhookUrl) },\n" } },
  "#35 svelte-clerk handler with the Backend API through clerk-vent": { row: 35, provider: "clerk", files: {
    "apps/search/src/hooks.server.ts": "import { env } from '$env/dynamic/private';\nimport { withClerkHandler } from 'svelte-clerk/server';\nimport { clerkVentOptions, withVentTokens } from '$lib/server/clerk-vent';\n" } },
  "#71 ci_watch posts through _vent_post and keeps slack_api as the Vent-down fallback": { row: 71, provider: "slack", files: {
    "apps/infra/ci-server/alert/ci_watch.py": "def _vent_post(cfg, payload):\n    try:\n        return _chat_post(cfg[\"vent_api\"], credential(cfg[\"vent_credential\"]), payload)\n    except urllib.error.HTTPError as e:\n        code = e.headers.get(\"x-vent-error\") or vent_error_code(e.read())\n\ndef slack_post(cfg, text) -> bool:\n    if credential(cfg.get(\"vent_credential\", \"\")):\n        body = _vent_post(cfg, payload)\n    if body is None:\n        body = _chat_post(cfg[\"slack_api\"], token, payload)\n",
    "apps/infra/ci-server/alert/config.json.j2": "{\n  \"vent_api\": {{ ci.watch.vent_api | default('https://vent.virev.ai/slack-dev') | to_json }},\n  \"slack_api\": \"https://slack.com/api\",\n}\n" } },
  "#77 IndexNow key-file config with the POSTs through vent.call": { row: 77, provider: "seo", files: {
    "scripts/seo/virev_seo/indexnow.py": "from virev_seo import vent\nfrom virev_seo.config import INDEXNOW_KEY_DIR, INDEXNOW_ROOT_KEY_DIR, METRICS_DIR\nINDEXNOW_PATH = \"/indexnow/indexnow\"\nSENT_FILE = METRICS_DIR / \"indexnow-sent.json\"\nclass IndexNowError(RuntimeError):\n    pass\n    status, body = vent.call(\"indexnow\", INDEXNOW_PATH, payload)\n" } },
};

// A bypass the narrowed rules must still catch: a Stripe client built on the secret key with no Vent sign in the file.
const BYPASS = { row: 5, provider: "stripe", files: {
  "convex/lib/stripeClient.ts": "import Stripe from 'stripe';\nimport { env } from './env';\nreturn new Stripe(env.STRIPE_SECRET_KEY, {});\n" } };

test("vent-share.py reads the 6 rows the cutover train checked as Vent, and still reads a direct Stripe client as direct", async () => {
  const { execFileSync } = await import("node:child_process");
  const { VENT_SHARE } = await import("../scripts/duties/vent-gateway.ts");
  const code = "import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location('vs', sys.argv[1]); vs = importlib.util.module_from_spec(spec)\n" +
    "sys.modules['vs'] = vs; spec.loader.exec_module(vs)\nclass T:\n  def __init__(s, files): s.files, s.ref = files, 'fixture'\n  def read(s, p): return s.files.get(p)\n" +
    "out = {}\nfor name, c in json.loads(sys.argv[2]).items():\n  site = vs.Site(c['row'], 'app', '', name, '', c['provider'], list(c['files']))\n" +
    "  v = vs.judge(site, T({**c['files'], **c.get('deps', {})}))\n  out[name] = [v.status, v.direct]\nprint(json.dumps(out))";
  const got = JSON.parse(execFileSync("python3", ["-c", code, VENT_SHARE, JSON.stringify({ ...DETECTOR_CASES, bypass: BYPASS })], { encoding: "utf8" })) as Record<string, [string, string[]]>;
  for (const name of Object.keys(DETECTOR_CASES)) assert.deepEqual(got[name], ["vent", name.startsWith("#71") ? got[name]![1] : []], name);
  assert.equal(got.bypass![0], "direct");
  assert.match(got.bypass![1].join("\n"), /STRIPE_SECRET_KEY|new Stripe/);
});

test("the by-code counts read at main and at the dev/sieun tip, and a direct row at the tip is flagged for the cutover train", () => {
  const share = { refs: {
    "origin/main": { sha: "a", sites: [site(0, "direct"), site(1, "vent"), site(63, "direct", { exception: "GeoNode" })] },
    "origin/dev/sieun": { sha: "b", sites: [site(0, "vent"), site(1, "partial", { direct: ["x.ts:1: fetch('https://api.stripe.com')"] }), site(63, "direct", { exception: "GeoNode" })] },
  }, traffic: { production: { sites_with_vent_traffic: [1] } } };
  const output = ventMetrics(reads({ share }), 0);
  assert.deepEqual([output.metrics.code_rows, output.metrics.code_vent_sites, output.metrics.tip_code_vent_sites], [2, 1, 1]);
  assert.deepEqual(output.flagged!.filter(flag => flag.kind === "tip_site_direct").map(flag => flag.item), ["row 1"]);
  const noTip = ventMetrics(reads({ share: { refs: { "origin/main": share.refs["origin/main"] }, traffic: share.traffic } }), 0);
  assert.deepEqual(["tip_code_vent_sites" in noTip.metrics, "through_vent_pct" in noTip.metrics], [false, false]);
  assert.equal(noTip.metrics.source_errors, 1);
});

// On 2026-10-19 the konti, Meta and ZeroBounce removals deleted 10 call sites from sieun/dev 53b1ed6201 (OmniHuman, ElevenLabs, Pexels, Sora,
// the Instagram Graph routes, ZeroBounce and more), and the duty still counted each one as a direct site from its frozen 70 rows, so
// through_vent_pct could never reach 100%. The list of sites now comes from the tip: removed rows leave, and a new direct call counts.
test("a site whose call is gone at the tip leaves the count, and a new direct call at the tip counts against the share", () => {
  const share = { refs: {
    "origin/main": { sha: "a", sites: [site(0, "vent"), site(54, "direct"), site(62, "direct")] },
    "origin/dev/sieun": { sha: "b", sites: [site(0, "vent"), site(54, "removed"), site(62, "gone")],
      new_sites: [{ path: "convex/search/newThing.ts", app: "convex", provider: "stripe", direct: ["convex/search/newThing.ts:3: await fetch('https://api.stripe.com/v1/charges')"] }] },
  }, traffic: { production: { sites_with_vent_traffic: [0] } } };
  const output = ventMetrics(reads({ share }), 0);
  assert.deepEqual([output.metrics.in_scope_count, output.metrics.through_vent_count, output.metrics.through_vent_pct], [6, 5, round(100 * 5 / 6)]);
  assert.deepEqual([output.metrics.tip_removed_sites, output.metrics.new_direct_sites, output.metrics.code_rows], [2, 1, 2]);
  assert.deepEqual(output.flagged!.filter(flag => flag.kind === "site_removed").map(flag => flag.item), ["row 54", "row 62"]);
  assert.deepEqual(output.flagged!.filter(flag => flag.kind === "new_direct_site").map(flag => flag.item), ["convex/search/newThing.ts"]);
  assert.equal(output.flagged!.some(flag => flag.kind === "site_direct"), false);
});

test("vent-share.py reads a row whose files no longer name the provider as gone, and its call scan finds a new direct call but no covered or c181 PostHog one", async () => {
  const { execFileSync } = await import("node:child_process");
  const { VENT_SHARE } = await import("../scripts/duties/vent-gateway.ts");
  const files: Record<string, string> = {
    "apps/crawler-v3/src/contacts/email_verify.py": "def verify(email):\n    return mx_lookup(email)\n",
    "convex/lib/stripeClient.ts": "import Stripe from 'stripe';\nimport { ventKey } from './vent';\nreturn new Stripe(ventKey(), {});\n",
    "convex/search/newThing.ts": "const res = await fetch('https://api.stripe.com/v1/charges', { headers });\n",
    "convex/search/hint.ts": "throw badRequest('That does not look like a Slack incoming-webhook URL (https://hooks.slack.com/services/…)');\n",
    "apps/search/svelte.config.js": "export default {};\n",
    "apps/search/src/lib/analytics/config.ts": "export const HOST = 'https://us.i.posthog.com';\n",
    "apps/search/src/lib/server/posthog.ts": "import { PostHog } from 'posthog-node';\nexport const ph = new PostHog(env.POSTHOG_KEY, { host: 'https://us.i.posthog.com' });\n",
    "apps/crawler-v3/src/settings.py": "    cliproxy_base_url: str = \"\"\n",
  };
  const code = "import importlib.util, json, re, sys\nspec = importlib.util.spec_from_file_location('vs', sys.argv[1]); vs = importlib.util.module_from_spec(spec)\n" +
    "sys.modules['vs'] = vs; spec.loader.exec_module(vs)\nclass T:\n  def __init__(s, files): s.files, s.ref, s.text = set(files), 'fixture', files\n" +
    "  def read(s, p): return s.text.get(p)\n  def grep(s, pattern, roots):\n" +
    "    return [(p, str(n), l) for p, t in s.text.items() for n, l in enumerate(t.split('\\n'), 1) if re.search(pattern, l)]\n" +
    "tree = T(json.loads(sys.argv[2]))\nsites = [vs.Site(62, 'crawler-v3', '', 'ZeroBounce', '', 'zerobounce', ['apps/crawler-v3/src/contacts/email_verify.py']),\n" +
    "  vs.Site(5, 'convex', '', 'Stripe', '', 'stripe', ['convex/lib/stripeClient.ts'])]\nverdicts = {s.row: vs.judge(s, tree) for s in sites}\n" +
    "print(json.dumps({'status': {r: v.status for r, v in verdicts.items()}, 'new': [[x['path'], x['provider']] for x in vs.call_scan(tree, sites, verdicts)]}))";
  const got = JSON.parse(execFileSync("python3", ["-c", code, VENT_SHARE, JSON.stringify(files)], { encoding: "utf8" }));
  assert.deepEqual(got, { status: { "62": "gone", "5": "vent" }, new: [["convex/search/newThing.ts", "stripe"]] });
});

test("vent-share.py follows an import only into a helper that names the provider, so a form whose helper only posts to Slack through Vent reads as gone for Resend", async () => {
  const { execFileSync } = await import("node:child_process");
  const { VENT_SHARE } = await import("../scripts/duties/vent-gateway.ts");
  const files: Record<string, string> = {
    "apps/search/src/routes/api/contact/+server.ts": "import { submitForm } from '$lib/server/form-submissions';\nexport const POST = submitForm;\n",
    "apps/search/src/lib/server/form-submissions.ts": "import { readVent } from './vent';\nconst vent = readVent(env);\nawait postSalesSlackMessage(vent, msg);\n",
    "apps/search/src/routes/api/google/callback/+server.ts": "import { exchange } from '$lib/server/google-token';\nexport const GET = exchange;\n",
    "apps/search/src/lib/server/google-token.ts": "import { readVent } from './vent';\n// Google OAuth token exchange\nawait ventFetch(vent, 'google-oauth', '/token');\n",
  };
  const code = "import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location('vs', sys.argv[1]); vs = importlib.util.module_from_spec(spec)\n" +
    "sys.modules['vs'] = vs; spec.loader.exec_module(vs)\nclass T:\n  def __init__(s, files): s.files, s.ref, s.text = set(files), 'fixture', files\n" +
    "  def read(s, p): return s.text.get(p)\n" +
    "tree = T(json.loads(sys.argv[2]))\nsites = [vs.Site(25, 'search', '', 'Resend', '', 'resend', ['apps/search/src/routes/api/contact/+server.ts']),\n" +
    "  vs.Site(29, 'search', '', 'Google OAuth', '', 'google-oauth', ['apps/search/src/routes/api/google/callback/+server.ts'])]\n" +
    "print(json.dumps({s.row: vs.judge(s, tree).status for s in sites}))";
  const got = JSON.parse(execFileSync("python3", ["-c", code, VENT_SHARE, JSON.stringify(files)], { encoding: "utf8" }));
  assert.deepEqual(got, { "25": "gone", "29": "vent" });
});

test("removed_provider_refs counts a removed provider named outside the kept guards once per file, and a removed Vent integration listed again", () => {
  const line = (path: string, text: string) => `origin/dev/sieun:${path}\0${1}\0${text}`;
  const grep = [
    line("apps/research-agent-be/src/media.py", "client = HeyGen(); pexels = Pexels()"),
    line("apps/research-agent-be/src/media.py", "HEYGEN_URL = 'https://api.heygen.com'"),
    line("scripts/ci/vent-key-scan.mjs", "'HEYGEN', 'ZEROBOUNCE',"),
    line("apps/infra/ci-server/controller/tests/data/patched/.github/workflows/checks.yml", "- name: research-app / lint"),
    line("apps/crawler-v3/src/platforms/instagram/transport.py", "INSTAGRAM_GRAPHQL_POST,"),
    line("apps/crawler-v3/docs/multi-platform-search.md", "The official `graph.facebook.com/ads_archive` API is political-ads-only"),
    line("apps/blog/content/kr-beauty-collabs-2026/data/kr-beauty-collabs.csv", "@sora_lab,ingredients,76000,6"),
    line("convex/search/upload.ts", "fetch('https://graph.instagram.com/v25.0/me')"),
    // The owner wants konti.bot gone but its redirect, so any konti.bot host counts, such as mail-check.mjs's old GreenMail host (10-22),
    // while a Clerk test address @konti.bot names no host.
    line("scripts/staging/mail-check.mjs", "\thost: 'mailcheck-smtp.konti.bot',"),
    line("scripts/staging/mail-check.mjs", "const MEMBER_EMAIL = 'mail-review+clerk_test@konti.bot';"),
    line("apps/web/src/research.ts", "const RESEARCH = 'https://p.konti.bot/api'"),
  ].join("\n");
  const tables = TABLES.replace('    "zernio"', '    "zerobounce": Integration(ZEROBOUNCE, "ZEROBOUNCE_API_KEY"),\n    "zernio"');
  const result = removedProviderRefs({ grep, tables }, 0);
  assert.ok(!("error" in result));
  assert.deepEqual(result.flagged.map(flag => flag.item).sort(), ["apps/research-agent-be/src/media.py", "apps/research-agent-be/src/media.py", "apps/web/src/research.ts", "convex/search/upload.ts", "integration zerobounce", "scripts/staging/mail-check.mjs"]);
  assert.equal(ventMetrics(reads({ removed: { grep, tables } }), 0).metrics.removed_provider_refs, 6);
  assert.equal(ventMetrics(reads(), 0).metrics.removed_provider_refs, 0);
  assert.equal(ventMetrics(reads({ removed: { grep: "", tables: "" } }), 0).metrics.removed_provider_refs, UNMEASURED);
});

test("vent-share.py reads prod traffic one day per query and merges the days, because one 7-day query hit Grafana's 60 s deadline on 10-22", async () => {
  const { execFileSync } = await import("node:child_process");
  const { VENT_SHARE } = await import("../scripts/duties/vent-gateway.ts");
  const code = "import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location('vs', sys.argv[1]); vs = importlib.util.module_from_spec(spec)\n" +
    "sys.modules['vs'] = vs; spec.loader.exec_module(vs)\nrow = lambda c, n, t: dict(env='production', caller=c, integration='notion', operation='read', outcome='success', calls=n, last=t)\n" +
    "print(json.dumps({'day0': vs.traffic_sql(0), 'day3': vs.traffic_sql(3), 'merged': vs.merge_traffic([[row('virev', 2, 100)], [row('virev', 3, 50), row('search', 1, 70)]])}))";
  const got = JSON.parse(execFileSync("python3", ["-c", code, VENT_SHARE], { encoding: "utf8" })) as { day0: string; day3: string; merged: { caller: string; calls: number; last: number }[] };
  assert.match(got.day0, /Timestamp > now\(\) - INTERVAL 1 DAY GROUP BY/);
  assert.match(got.day3, /Timestamp > now\(\) - INTERVAL 4 DAY AND Timestamp <= now\(\) - INTERVAL 3 DAY/);
  assert.deepEqual(got.merged.map(r => [r.caller, r.calls, r.last]), [["virev", 5, 100], ["search", 1, 70]]);
});

// Owner rule c119: us-metal02 moved from sieun/dev to dev/sieun on 2026-10-27 08:17Z, and origin/sieun/dev stopped moving.
test("the gateway and vent-share.py read the tip at origin/dev/sieun", () => {
  assert.equal(TIP, "origin/dev/sieun");
  const help = execFileSync("python3", [VENT_SHARE, "--help"], { encoding: "utf8" });
  assert.match(help, /default origin\/dev\/sieun/);
});

test("test sends that reached a provider off production sum into test_calls_real_24h, one row each, and a failed read is unmeasured (p85, c174)", () => {
  const testSends = [
    { integration: "resend", caller: "convex", method: "POST /emails", calls: 26, last: 0 },
    { integration: "langfuse", caller: "research-agent-be", method: "POST /api/public/otel/v1/traces", calls: 30, last: 0 },
  ];
  const output = ventMetrics(reads({ testSends }), 0);
  assert.equal(output.metrics.test_calls_real_24h, 56);
  assert.deepEqual(output.flagged!.filter(flag => flag.kind === "test_send_real").map(flag => flag.item), ["resend POST /emails", "langfuse POST /api/public/otel/v1/traces"]);
  assert.equal(ventMetrics(reads({ testSends: [] }), 0).metrics.test_calls_real_24h, 0);
  const unread = ventMetrics(reads({ testSends: { error: "HTTP 502" } }), 0);
  assert.equal(unread.metrics.test_calls_real_24h, UNMEASURED);
  assert.equal(unread.metrics.source_errors, 1);
});

test("the test send query leaves out production, faked calls and sends whose every recipient is a mail check sink, and never counts Stripe", () => {
  assert.match(TEST_SENDS_SQL, /deployment\.environment\.name'\] != 'production'/);
  assert.match(TEST_SENDS_SQL, /`vent\.mock` != 'true'/);
  assert.match(TEST_SENDS_SQL, /arrayAll\(d -> d IN \('mailsink\.virev\.ai', 'nomail\.virev\.ai'\)/);
  assert.doesNotMatch(TEST_SENDS_SQL, /stripe/);
});

// On 10-28 the chat system duty's quiet-spot audit found goal p85 linked to d1/test_calls_real_24h while d1 kept it as a reading with no target,
// so a test send that reached a real provider never read as a miss (owner rule c174, "these shouldn't be actually being sent").
test("the duty keeps one headline and at most 3 metrics, and test_calls_real_24h is one of them with a target of 0", () => {
  return readFile(new URL("../scripts/duties/vent-gateway.duty.json", import.meta.url), "utf8").then(text => {
    const duty = JSON.parse(text) as { metrics: DutyMetric[]; readings?: unknown };
    assert.equal(dutyShapeProblem(duty.metrics), null);
    assert.deepEqual(duty.metrics.map(metric => metric.key), ["through_vent_pct", "provider_keys_outside_vent", "removed_provider_refs", "test_calls_real_24h"]);
    assert.deepEqual(duty.metrics.find(metric => metric.key === "test_calls_real_24h")!.target, 0);
    assert.equal(duty.readings, undefined);
  });
});
