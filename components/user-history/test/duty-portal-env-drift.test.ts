// Guards d1's env_keys_staging_only. On 2026-10-18 auto-sns-agent main's apps/api-portal/.env.staging had BATCH_WORKER_SECRET and its .env did
// not, so prod's batch routes ran without the secret staging used (board p9), and no duty metric counted it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { uptimeMetrics } from "../scripts/duties/portal-uptime.ts";

const UP = [{ labels: { target: "crawler_health" }, value: 1 }, { labels: { target: "crawler_schema" }, value: 1 }, { labels: { target: "portal_openapi" }, value: 1 }];
const ANSWERS = { up: UP, uptime: UP, age: UP.map(series => ({ ...series, value: 60 })), p90: [{ labels: { target: "portal_openapi" }, value: 400 }] };
const DIRECT = { status: 200, ms: 150 };
const PROD = "DOTENV_PUBLIC_KEY=\"x\"\nCRAWLER_API_KEY=encrypted:a\nCRAWLER_API_URL=encrypted:b\n";
const STAGING = "DOTENV_PUBLIC_KEY_STAGING=\"y\"\nCRAWLER_API_KEY=encrypted:c\nCRAWLER_API_URL=encrypted:d\nBATCH_WORKER_SECRET=encrypted:e\n";

test("a key staging has and prod lacks on main counts once and names the key, and dotenvx's own keys never count", () => {
  const output = uptimeMetrics(ANSWERS, DIRECT, 0, { main: { prod: PROD, staging: STAGING }, "sieun/dev": { prod: `${PROD}BATCH_WORKER_SECRET=encrypted:f\n`, staging: STAGING } });
  assert.equal(output.metrics.env_keys_staging_only, 1);
  assert.match(output.flagged!.find(flag => flag.kind === "env_staging_only")!.excerpt, /at main has BATCH_WORKER_SECRET/);
});

test("an env file GitHub did not give reads as unmeasured, never as 0", () => {
  const output = uptimeMetrics(ANSWERS, DIRECT, 0, { main: { error: "HTTP 404" } });
  assert.equal(output.metrics.env_keys_staging_only, 999999);
});
