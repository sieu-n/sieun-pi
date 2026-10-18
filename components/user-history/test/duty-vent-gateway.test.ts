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
    share: { refs: { "origin/main": { sha: "a", sites: [site(0, "vent"), site(1, "vent"), site(63, "direct", { exception: "GeoNode" })] } }, traffic: { production: { sites_with_vent_traffic: [0, 1] } } },
    webhooks: webhookVerdicts("", VENT_ROUTE),
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
  const output = ventMetrics(reads({ webhooks: webhookVerdicts(HTTP_DIRECT, VENT_ROUTE) }), 0);
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
