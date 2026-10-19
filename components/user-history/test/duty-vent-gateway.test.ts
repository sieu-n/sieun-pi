// Guards the Vent gateway duty (vent-gateway.ts). On 2026-10-18 Vent carried 0 of the 70 in-scope prod call sites, both Vent hosts failed
// the TLS handshake and 112 provider keys still sat outside Vent, and the duty has to read those as misses, never as a pass.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inScope, UNMEASURED, UNMEASURED_PCT, ventMetrics, webhookVerdicts, type VentReads } from "../scripts/duties/vent-gateway.ts";

const site = (row: number, status: string, extra: object = {}) => ({ row, app: "convex", provider: "Stripe", runs_in: "Convex staging, prod", status, ...extra });
const HTTP_DIRECT = "http.route({\n\tpath: '/stripe-webhook',\n})\nhttp.route({ path: '/clerk-webhook' })\nhttp.route({ path: '/resend-webhook' })\nhttp.route({ path: '/zernio-webhook' })\n";
const VENT_ROUTE = "export const VENT_WEBHOOK_PREFIX = '/webhooks/vent/';\nnew Map([\n\t['stripe', a],\n\t['clerk', b],\n\t['resend', c],\n\t['zernio', d],\n]);\n";

function reads(overrides: Partial<VentReads> = {}): VentReads {
  return {
    share: { refs: { "origin/main": { sha: "a", sites: [site(0, "vent"), site(1, "vent"), site(63, "direct", { exception: "GeoNode" })] }, "origin/sieun/dev": { sha: "b", sites: [site(0, "vent"), site(1, "vent"), site(63, "direct", { exception: "GeoNode" })] } }, traffic: { production: { sites_with_vent_traffic: [0, 1] } } },
    webhooks: webhookVerdicts({ http: "", ventRoute: VENT_ROUTE }),
    keys: { locations: { "convex production befitting-sparrow-356": ["VENT_KEY", "PUBLIC_CLERK_PUBLISHABLE_KEY"] }, unreadable: {} },
    ...overrides,
  };
}

test("all sites and webhooks on Vent with prod traffic read 100%, and the GeoNode exception leaves the count", () => {
  const { metrics } = ventMetrics(reads(), 0);
  assert.equal(metrics.through_vent_pct, 100);
  assert.equal(metrics.in_scope_count, 6);
  assert.equal(metrics.provider_keys_outside_vent, 0);
});

test("a site whose code is on Vent but has no prod vent.call does not count, unless it runs in no prod deployment", () => {
  const sites = [site(0, "vent"), site(38, "vent")];
  const share = { refs: { "origin/main": { sha: "a", sites }, "origin/sieun/dev": { sha: "b", sites } }, traffic: { production: { sites_with_vent_traffic: [] } } };
  const output = ventMetrics(reads({ share, webhooks: [] }), 0);
  assert.equal(output.metrics.through_vent_pct, 50);
  assert.equal(output.flagged!.find(flag => flag.kind === "no_prod_traffic")!.item, "row 0");
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

test("a failed share script gives a -1 share and a source error", () => {
  const output = ventMetrics(reads({ share: { error: "exit 1" } }), 0);
  assert.equal(output.metrics.through_vent_pct, UNMEASURED_PCT);
  assert.equal(output.metrics.source_errors, 1);
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
  assert.deepEqual([output.metrics.code_rows, output.metrics.code_vent_sites, output.metrics.tip_code_vent_sites], [2, 1, 1]);
  assert.deepEqual(output.flagged!.filter(flag => flag.kind === "tip_site_direct").map(flag => flag.item), ["row 1"]);
  const noTip = ventMetrics(reads({ share: { refs: { "origin/main": share.refs["origin/main"] }, traffic: share.traffic } }), 0);
  assert.deepEqual([noTip.metrics.tip_code_vent_sites, noTip.metrics.through_vent_pct], [UNMEASURED_PCT, UNMEASURED_PCT]);
  assert.equal(noTip.metrics.source_errors, 1);
});

// On 2026-10-19 the konti, Meta and ZeroBounce removals deleted 10 call sites from sieun/dev 53b1ed6201 (OmniHuman, ElevenLabs, Pexels, Sora,
// the Instagram Graph routes, ZeroBounce and more), and the duty still counted each one as a direct site from its frozen 70 rows, so
// through_vent_pct could never reach 100%. The list of sites now comes from the tip: removed rows leave, and a new direct call counts.
test("a site whose call is gone at the tip leaves the count, and a new direct call at the tip counts against the share", () => {
  const share = { refs: {
    "origin/main": { sha: "a", sites: [site(0, "vent"), site(54, "direct"), site(62, "direct")] },
    "origin/sieun/dev": { sha: "b", sites: [site(0, "vent"), site(54, "removed"), site(62, "gone")],
      new_sites: [{ path: "convex/search/newThing.ts", app: "convex", provider: "stripe", direct: ["convex/search/newThing.ts:3: await fetch('https://api.stripe.com/v1/charges')"] }] },
  }, traffic: { production: { sites_with_vent_traffic: [0] } } };
  const output = ventMetrics(reads({ share }), 0);
  assert.deepEqual([output.metrics.in_scope_count, output.metrics.through_vent_count, output.metrics.through_vent_pct], [6, 5, round(100 * 5 / 6)]);
  assert.deepEqual([output.metrics.tip_removed_sites, output.metrics.new_direct_sites, output.metrics.code_rows], [2, 1, 2]);
  assert.deepEqual(output.flagged!.filter(flag => flag.kind === "site_removed").map(flag => flag.item), ["row 54", "row 62"]);
  assert.deepEqual(output.flagged!.filter(flag => flag.kind === "new_direct_site").map(flag => flag.item), ["convex/search/newThing.ts"]);
  assert.equal(output.flagged!.some(flag => flag.kind === "site_direct"), false);
});

test("vent-share.py reads a row whose files no longer name the provider as gone, and its call scan finds a new direct call but no covered one", async () => {
  const { execFileSync } = await import("node:child_process");
  const { VENT_SHARE } = await import("../scripts/duties/vent-gateway.ts");
  const files: Record<string, string> = {
    "apps/crawler-v3/src/contacts/email_verify.py": "def verify(email):\n    return mx_lookup(email)\n",
    "convex/lib/stripeClient.ts": "import Stripe from 'stripe';\nimport { ventKey } from './vent';\nreturn new Stripe(ventKey(), {});\n",
    "convex/search/newThing.ts": "const res = await fetch('https://api.stripe.com/v1/charges', { headers });\n",
    "convex/search/hint.ts": "throw badRequest('That does not look like a Slack incoming-webhook URL (https://hooks.slack.com/services/…)');\n",
    "apps/search/svelte.config.js": "export default {};\n",
    "apps/search/src/lib/analytics/config.ts": "export const HOST = 'https://us.i.posthog.com';\n",
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
