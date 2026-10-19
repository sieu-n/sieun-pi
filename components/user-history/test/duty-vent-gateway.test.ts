// Guards the Vent gateway duty (vent-gateway.ts). On 2026-10-18 Vent carried 0 of the 70 in-scope prod call sites, both Vent hosts failed
// the TLS handshake and 112 provider keys still sat outside Vent, and the duty has to read those as misses, never as a pass.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inScope, UNMEASURED, UNMEASURED_PCT, ventMetrics, webhookVerdicts, type VentReads } from "../scripts/duties/vent-gateway.ts";

const site = (row: number, status: string, extra: object = {}) => ({ row, app: "convex", provider: "Stripe", runs_in: "Convex staging, prod", status, ...extra });
const HTTP_DIRECT = "http.route({\n\tpath: '/stripe-webhook',\n})\nhttp.route({ path: '/clerk-webhook' })\nhttp.route({ path: '/resend-webhook' })\nhttp.route({ path: '/zernio-webhook' })\n";
const VENT_ROUTE = "export const VENT_WEBHOOK_PREFIX = '/webhooks/vent/';\nnew Map([\n\t['stripe', a],\n\t['clerk', b],\n\t['resend', c],\n\t['zernio', d],\n]);\n";
const UP = [{ url: "https://vent.virev.ai", status: 200 }, { url: "https://vent-staging.virev.ai", status: 200 }];

function reads(overrides: Partial<VentReads> = {}): VentReads {
  return {
    share: { refs: { "origin/main": { sha: "a", sites: [site(0, "vent"), site(1, "vent"), site(63, "direct", { exception: "GeoNode" })] }, "origin/sieun/dev": { sha: "b", sites: [site(0, "vent"), site(1, "vent"), site(63, "direct", { exception: "GeoNode" })] } }, traffic: { production: { sites_with_vent_traffic: [0, 1] } } },
    webhooks: webhookVerdicts({ http: "", ventRoute: VENT_ROUTE }),
    calls: [{ outcome: "success", status: "200", calls: 99 }, { outcome: "upstream_error", status: "502", calls: 1 }, { outcome: "refused", status: "401", calls: 50 }],
    keys: { locations: { "convex production befitting-sparrow-356": ["VENT_KEY", "PUBLIC_CLERK_PUBLISHABLE_KEY"] }, unreadable: {} },
    health: UP,
    ...overrides,
  };
}

test("all sites and webhooks on Vent with prod traffic read 100%, and the GeoNode exception leaves the count", () => {
  const { metrics } = ventMetrics(reads(), 0);
  assert.equal(metrics.through_vent_pct, 100);
  assert.equal(metrics.in_scope_count, 6);
  assert.equal(metrics.vent_success_24h_pct, 99);
  assert.equal(metrics.provider_keys_outside_vent, 0);
  assert.equal(metrics.vent_hosts_down, 0);
});

test("a site whose code is on Vent but has no prod vent.call does not count, unless it runs in no prod deployment", () => {
  const share = { refs: { "origin/main": { sha: "a", sites: [site(0, "vent"), site(38, "vent")] } }, traffic: { production: { sites_with_vent_traffic: [] } } };
  const output = ventMetrics(reads({ share, webhooks: [] }), 0);
  assert.equal(output.metrics.through_vent_pct, 50);
  assert.equal(output.flagged!.find(flag => flag.kind === "no_prod_traffic")!.item, "row 0");
});

test("direct webhook routes on main count as direct even when the Vent route exists", () => {
  const output = ventMetrics(reads({ webhooks: webhookVerdicts({ http: HTTP_DIRECT, ventRoute: VENT_ROUTE }) }), 0);
  assert.equal(output.metrics.through_vent_pct, round(100 * 2 / 6));
  assert.equal(output.flagged!.filter(flag => flag.kind === "webhook_direct").length, 4);
});

test("no prod calls read -1 for the success rate, never 100", () => {
  assert.equal(ventMetrics(reads({ calls: [] }), 0).metrics.vent_success_24h_pct, UNMEASURED_PCT);
  assert.equal(ventMetrics(reads({ calls: [{ outcome: "refused", status: "401", calls: 4 }] }), 0).metrics.vent_success_24h_pct, UNMEASURED_PCT);
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
  }, unreadable: {} };
  assert.equal(ventMetrics(reads({ keys }), 0).metrics.provider_keys_outside_vent, 4);
  assert.equal(ventMetrics(reads({ keys: { ...keys, unreadable: { "convex staging tremendous-eel-825": "401" } } }), 0).metrics.provider_keys_outside_vent, UNMEASURED);
  assert.equal(inScope("container virev-prod-vent"), false);
  assert.equal(inScope("box /srv/prod/secrets/vent.env"), false);
  assert.equal(inScope("container virev-prod-crawler-api"), true);
});

test("a failed share script or ClickHouse read gives -1 shares and a source error, and a down host counts", () => {
  const output = ventMetrics(reads({ share: { error: "exit 1" }, calls: { error: "HTTP 401" }, health: [UP[0]!, { url: "https://vent-staging.virev.ai", status: 0, error: "TLS" }] }), 0);
  assert.equal(output.metrics.through_vent_pct, UNMEASURED_PCT);
  assert.equal(output.metrics.vent_success_24h_pct, UNMEASURED_PCT);
  assert.equal(output.metrics.source_errors, 2);
  assert.equal(output.metrics.vent_hosts_down, 1);
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
  "#36 PostHog posts to ${VENT_URL}/posthog": { row: 36, provider: "posthog", files: {
    "apps/search/src/lib/server/posthog.ts": "import { env as publicEnv } from '$env/dynamic/public';\nimport { readVent } from './vent';\n\treturn [publicEnv.PUBLIC_POSTHOG_KEY].find(isUsable);\n\tconst vent = readVent(privateEnv);\n" } },
  "#71 ci_watch posts through _vent_post and keeps slack_api as the Vent-down fallback": { row: 71, provider: "slack", files: {
    "apps/infra/ci-server/alert/ci_watch.py": "def _vent_post(cfg, payload):\n    try:\n        return _chat_post(cfg[\"vent_api\"], credential(cfg[\"vent_credential\"]), payload)\n    except urllib.error.HTTPError as e:\n        code = e.headers.get(\"x-vent-error\") or vent_error_code(e.read())\n\ndef slack_post(cfg, text) -> bool:\n    if credential(cfg.get(\"vent_credential\", \"\")):\n        body = _vent_post(cfg, payload)\n    if body is None:\n        body = _chat_post(cfg[\"slack_api\"], token, payload)\n",
    "apps/infra/ci-server/alert/config.json.j2": "{\n  \"vent_api\": {{ ci.watch.vent_api | default('https://vent.virev.ai/slack-dev') | to_json }},\n  \"slack_api\": \"https://slack.com/api\",\n}\n" } },
  "#77 IndexNow key-file config with the POSTs through vent.call": { row: 77, provider: "seo", files: {
    "scripts/seo/virev_seo/indexnow.py": "from virev_seo import vent\nfrom virev_seo.config import INDEXNOW_KEY_DIR, INDEXNOW_ROOT_KEY_DIR, METRICS_DIR\nINDEXNOW_PATH = \"/indexnow/indexnow\"\nSENT_FILE = METRICS_DIR / \"indexnow-sent.json\"\nclass IndexNowError(RuntimeError):\n    pass\n    status, body = vent.call(\"indexnow\", INDEXNOW_PATH, payload)\n" } },
};

// A real bypass the narrowed rules must still catch: search's PostHog client at origin/main a8f85b4206 reads the private POSTHOG_KEY and
// posts with posthog-node to us.i.posthog.com, with no Vent sign in the file.
const BYPASS = { row: 36, provider: "posthog", files: {
  "apps/search/src/lib/server/posthog.ts": "import { PostHog } from 'posthog-node';\nimport { env as privateEnv } from '$env/dynamic/private';\n\treturn [privateEnv.POSTHOG_KEY, privateEnv.PUBLIC_POSTHOG_KEY, publicEnv.PUBLIC_POSTHOG_KEY].find(isUsable);\n\t\t'https://us.i.posthog.com'\n" } };

test("vent-share.py reads the 7 rows the cutover train checked as Vent, and still reads a direct PostHog client as direct", async () => {
  const { execFileSync } = await import("node:child_process");
  const { VENT_SHARE } = await import("../scripts/duties/vent-gateway.ts");
  const code = "import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location('vs', sys.argv[1]); vs = importlib.util.module_from_spec(spec)\n" +
    "sys.modules['vs'] = vs; spec.loader.exec_module(vs)\nclass T:\n  def __init__(s, files): s.files, s.ref = files, 'fixture'\n  def read(s, p): return s.files.get(p)\n" +
    "out = {}\nfor name, c in json.loads(sys.argv[2]).items():\n  site = vs.Site(c['row'], 'app', '', name, '', c['provider'], list(c['files']))\n" +
    "  v = vs.judge(site, T({**c['files'], **c.get('deps', {})}))\n  out[name] = [v.status, v.direct]\nprint(json.dumps(out))";
  const got = JSON.parse(execFileSync("python3", ["-c", code, VENT_SHARE, JSON.stringify({ ...DETECTOR_CASES, bypass: BYPASS })], { encoding: "utf8" })) as Record<string, [string, string[]]>;
  for (const name of Object.keys(DETECTOR_CASES)) assert.deepEqual(got[name], ["vent", name.startsWith("#71") ? got[name]![1] : []], name);
  assert.equal(got.bypass![0], "direct");
  assert.match(got.bypass![1].join("\n"), /posthog-node|POSTHOG_KEY|us\.i\.posthog\.com/);
});

test("the by-code counts read at main and at the sieun/dev tip, and a direct row at the tip is flagged for the cutover train", () => {
  const share = { refs: {
    "origin/main": { sha: "a", sites: [site(0, "direct"), site(1, "vent"), site(63, "direct", { exception: "GeoNode" })] },
    "origin/sieun/dev": { sha: "b", sites: [site(0, "vent"), site(1, "partial", { direct: ["x.ts:1: fetch('https://api.stripe.com')"] }), site(63, "direct", { exception: "GeoNode" })] },
  }, traffic: { production: { sites_with_vent_traffic: [1] } } };
  const output = ventMetrics(reads({ share }), 0);
  assert.deepEqual([output.metrics.code_rows, output.metrics.code_vent_sites, output.metrics.tip_code_vent_sites], [3, 1, 1]);
  assert.deepEqual(output.flagged!.filter(flag => flag.kind === "tip_site_direct").map(flag => flag.item), ["row 1"]);
  const noTip = ventMetrics(reads({ share: { refs: { "origin/main": share.refs["origin/main"] }, traffic: share.traffic } }), 0);
  assert.equal(noTip.metrics.tip_code_vent_sites, UNMEASURED_PCT);
  assert.equal(noTip.metrics.source_errors, 1);
});
