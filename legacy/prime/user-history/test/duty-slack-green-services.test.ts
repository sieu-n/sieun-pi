// Guards slack green guy's p223 (10-30): slack.green prod answered HTTP 200 for hours while every page threw "Missing Supabase environment
// variables" in the browser, because the us-metal02 prebuilt build had no NEXT_PUBLIC_SUPABASE_* values, and no duty saw it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type PageRead, PAGES, pageFailure, servicesOutput } from "../scripts/duties/slack-green-services.ts";

const NOW = Date.parse("2026-10-30T12:10:00Z");
const page = (key: string, extra: Partial<PageRead> = {}): PageRead =>
  ({ key, url: `https://slack.green/${key}`, status: 200, pageErrors: [], consoleErrors: [], api5xx: [], ...extra });

test("a page that answers 200 and throws the missing Supabase env error in the browser counts as failing", () => {
  assert.match(pageFailure(page("signup", { pageErrors: ["Missing Supabase environment variables. Please check your .env file."] }))!, /uncaught/);
  assert.match(pageFailure(page("en", { errorScreen: "This page couldn’t load" }))!, /error screen/);
  assert.equal(pageFailure(page("pricing", { consoleErrors: ["Provider's accounts list is empty."] })), null);
});

test("the 10-30 outage reads every page failing while the worker and the owner's Slack read fine", () => {
  const pages = PAGES.map(spec => page(spec.key, { pageErrors: ["Missing Supabase environment variables. Please check your .env file."] }));
  const output = servicesOutput({ pages, routes: [], errors: [], presence: { presence: "active", online: true, connectionCount: 1 },
    worker: { status: "SUCCESS", deployAt: NOW - 3_600_000, lastActiveAt: NOW - 30_000, activeLines: 200 },
    deploys: { metrics: { commits_not_live: 3, main_checks_failed_24h: 0, railway_not_live: 0, vercel_not_live: 3, source_errors: 0 }, flagged: [] } }, NOW);
  assert.equal(output.metrics.pages_failing, PAGES.length);
  assert.equal(output.metrics.deploy_problems, 0);
  assert.equal(output.metrics.owner_slack_green, 1);
});
