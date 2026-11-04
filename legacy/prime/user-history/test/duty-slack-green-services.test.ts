// Guards slack green guy's p223 (10-30): slack.green prod answered HTTP 200 for hours while every page threw "Missing Supabase environment
// variables" in the browser, because the us-metal02 prebuilt build had no NEXT_PUBLIC_SUPABASE_* values, and no duty saw it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type PageRead, PAGES, pageFailure, parseWorker, servicesOutput, type WorkerRead } from "../scripts/duties/slack-green-services.ts";

const NOW = Date.parse("2026-10-30T12:10:00Z");
const WORKER: WorkerRead = { running: true, restarts: 0, startedAt: NOW - 3_600_000, image: `ghcr.io/sieu-n/slack-green/worker:${"a".repeat(40)}`, sha: "a".repeat(40),
  lastActiveAt: NOW - 30_000, activeLines: 200 };
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
    worker: WORKER, deploys: { metrics: { main_checks_failed_24h: 0, worker_not_live: 0, vercel_not_live: 3, source_errors: 0 }, flagged: [] } }, NOW);
  assert.equal(output.metrics.pages_failing, PAGES.length);
  assert.equal(output.metrics.deploy_problems, 0);
  assert.equal(output.metrics.owner_slack_green, 1);
});

test("failed main runs alone make deploy_problems a day's window that ages out, and a live problem does not", () => {
  const base = { pages: PAGES.map(spec => page(spec.key)), routes: [], errors: [], presence: { presence: "active", online: true, connectionCount: 1 },
    worker: WORKER };
  const failedAt = NOW - 2 * 3_600_000;
  const checks = servicesOutput({ ...base, deploys: { metrics: { main_checks_failed_24h: 4, worker_not_live: 0, vercel_not_live: 0, source_errors: 0 },
    flagged: [], lastEventAt: { main_checks_failed_24h: failedAt } } }, NOW);
  assert.equal(checks.metrics.deploy_problems, 4);
  assert.deepEqual(checks.lastEventAt, { deploy_problems: failedAt });
  assert.deepEqual(checks.windowMs, { deploy_problems: 24 * 3_600_000 });
  const late = servicesOutput({ ...base, deploys: { metrics: { main_checks_failed_24h: 4, worker_not_live: 1, vercel_not_live: 0, source_errors: 0 },
    flagged: [], lastEventAt: { main_checks_failed_24h: failedAt } } }, NOW);
  assert.equal(late.metrics.deploy_problems, 5);
  assert.equal(late.windowMs, undefined);
});

// p226 (11-04): the worker runs on us-metal01, read from prod Prometheus (docker state, cAdvisor) and otel.otel_logs through Grafana.
const S = (value: number, labels: Record<string, string> = {}) => ({ labels, value });
const STATE = [S(1, { __name__: "virev_container_running" }), S(0, { __name__: "virev_container_restart_count" }), S((NOW - 3_600_000) / 1000, { __name__: "virev_container_started_seconds" })];
const STAMP = [S((NOW - 20_000) / 1000)];
const SEEN = [S(NOW / 1000, { image: `ghcr.io/sieu-n/slack-green/worker:${"a".repeat(40)}` })];

test("the worker read takes docker's state, the sha of cAdvisor's image tag and the newest presence line", () => {
  assert.deepEqual(parseWorker(STATE, STAMP, SEEN, [{ lines: 200, newest: NOW - 30_000 }], NOW), WORKER);
  const quiet = parseWorker(STATE, STAMP, [S(NOW / 1000, { image: "ghcr.io/sieu-n/slack-green/worker:main" })], [{ lines: 0, newest: 0 }], NOW);
  assert.equal(quiet.sha, undefined);
  assert.equal(quiet.lastActiveAt, undefined);
  assert.throws(() => parseWorker([], STAMP, [], [], NOW), /has no container slack-green-worker/);
  assert.throws(() => parseWorker(STATE, [S((NOW - 20 * 60_000) / 1000)], SEEN, [], NOW), /docker state file was last written 20 min ago/);
});

test("a worker that is stopped, restarted itself in the last 10 min, went silent or runs a tag with no sha is a deploy problem each", () => {
  const output = (worker: WorkerRead) => servicesOutput({ pages: PAGES.map(spec => page(spec.key)), routes: [], errors: [], worker,
    deploys: { metrics: { main_checks_failed_24h: 0, worker_not_live: 0, vercel_not_live: 0, source_errors: 0 }, flagged: [] } }, NOW);
  assert.equal(output(WORKER).metrics.deploy_problems, 0);
  assert.equal(output({ ...WORKER, running: false }).metrics.deploy_problems, 1);
  assert.equal(output({ ...WORKER, restarts: 3, startedAt: NOW - 120_000 }).metrics.deploy_problems, 1);
  assert.equal(output({ ...WORKER, restarts: 3 }).metrics.deploy_problems, 0);
  const { sha: _sha, ...tagOnly } = WORKER;
  const silentTag = output({ ...tagOnly, image: "ghcr.io/sieu-n/slack-green/worker:main", lastActiveAt: NOW - 11 * 60_000 });
  assert.equal(silentTag.metrics.deploy_problems, 2);
  assert.match((silentTag.flagged ?? []).find(item => item.kind === "worker_problem")?.excerpt ?? "", /worker:main, which names no main sha, and its last presence check log line is 11 min old/);
});
