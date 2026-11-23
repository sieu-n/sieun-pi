// Guards slack green guy's p223 (10-30): slack.green prod answered HTTP 200 for hours while every page threw "Missing Supabase environment
// variables" in the browser, because the us-metal02 prebuilt build had no NEXT_PUBLIC_SUPABASE_* values, and no duty saw it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type PageRead, PAGES, pageFailure, readConnectCheck, readWorker, servicesOutput } from "../scripts/duties/slack-green-services.ts";

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
  const output = servicesOutput({ pages, routes: [], errors: [], connectCheck: { issues: [] }, presence: { presence: "active", online: true, connectionCount: 1 },
    worker: { status: "SUCCESS", deployAt: NOW - 3_600_000, lastActiveAt: NOW - 30_000, activeLines: 200 },
    deploys: { metrics: { commits_not_live: 3, main_checks_failed_24h: 0, railway_not_live: 0, vercel_not_live: 3, source_errors: 0 }, flagged: [] } }, NOW);
  assert.equal(output.metrics.new_user_checks_failing, PAGES.length);
  assert.equal(output.metrics.deploy_problems, 0);
  assert.equal(output.metrics.owner_slack_green, 1);
});

test("failed main runs alone make deploy_problems a day's window that ages out, and a live problem does not", () => {
  const base = { pages: PAGES.map(spec => page(spec.key)), routes: [], errors: [], presence: { presence: "active", online: true, connectionCount: 1 },
    worker: { status: "SUCCESS", deployAt: NOW - 3_600_000, lastActiveAt: NOW - 30_000, activeLines: 200 } };
  const failedAt = NOW - 2 * 3_600_000;
  const checks = servicesOutput({ ...base, deploys: { metrics: { commits_not_live: 0, main_checks_failed_24h: 4, railway_not_live: 0, vercel_not_live: 0, source_errors: 0 },
    flagged: [], lastEventAt: { main_checks_failed_24h: failedAt } } }, NOW);
  assert.equal(checks.metrics.deploy_problems, 4);
  assert.deepEqual(checks.lastEventAt, { deploy_problems: failedAt });
  assert.deepEqual(checks.windowMs, { deploy_problems: 24 * 3_600_000 });
  const late = servicesOutput({ ...base, deploys: { metrics: { commits_not_live: 1, main_checks_failed_24h: 4, railway_not_live: 1, vercel_not_live: 0, source_errors: 0 },
    flagged: [], lastEventAt: { main_checks_failed_24h: failedAt } } }, NOW);
  assert.equal(late.metrics.deploy_problems, 5);
  assert.equal(late.windowMs, undefined);
});

// 11-04: a Railway build that failed (slack-green #422 deleted the Dockerfile) leaves the deployment before it running.
test("the worker read skips a FAILED deployment and reads the one still running", async () => {
  const exec = async (_file: string, args: readonly string[]): Promise<string> =>
    args[0] === "deployment" ? JSON.stringify([{ status: "FAILED", createdAt: new Date(NOW - 60_000).toISOString() }, { status: "SUCCESS", createdAt: new Date(NOW - 3_600_000).toISOString() }])
      : args[0] === "logs" ? JSON.stringify({ timestamp: new Date(NOW - 30_000).toISOString(), message: "[ppwc] 🟢 active" }) : "";
  const worker = await readWorker(exec);
  assert.equal(worker.status, "SUCCESS");
  assert.equal(worker.lastActiveAt, NOW - 30_000);
});

// 11-05: 20 main commits outside the worker's watch paths left 20 SKIPPED rows above the running deployment.
test("the worker read asks for the CLI's full deployment list, so skipped rows never hide the running one", async () => {
  const seen: string[][] = [];
  const exec = async (_file: string, args: readonly string[]): Promise<string> => {
    seen.push([...args]);
    if (args[0] !== "deployment") return args[0] === "logs" ? JSON.stringify({ timestamp: new Date(NOW - 30_000).toISOString(), message: "🟢 active" }) : "";
    const limit = Number(args[args.indexOf("--limit") + 1]);
    const rows = [...Array.from({ length: 25 }, (_, i) => ({ status: "SKIPPED", createdAt: new Date(NOW - i * 60_000).toISOString() })),
      { status: "SUCCESS", createdAt: new Date(NOW - 7_200_000).toISOString() }];
    return JSON.stringify(rows.slice(0, limit));
  };
  const worker = await readWorker(exec);
  assert.equal(worker.status, "SUCCESS");
  assert.equal(worker.deployAt, NOW - 7_200_000);
  assert.ok(seen.some(args => args[0] === "deployment" && args.includes("1000")));
});

// 11-21: a customer's Slack connect failed on prod after add-on 1.6 shipped; the connect check now runs after every main deploy.
test("the connect check adds 1 to new_user_checks_failing from the newest run that ran, not an hourly run that skipped, or any open connect-check issue", async () => {
  const runs = [
    { databaseId: 3, conclusion: "success", event: "schedule", url: "https://x/3", createdAt: "2026-11-21T13:17:00Z" },
    { databaseId: 2, conclusion: "failure", event: "workflow_run", url: "https://x/2", createdAt: "2026-11-21T12:25:00Z" },
    { databaseId: 1, conclusion: "success", event: "workflow_run", url: "https://x/1", createdAt: "2026-11-21T11:00:00Z" },
  ];
  const issues = [{ number: 599, title: "Connect check failing on slack.green", url: "https://x/599", body: "first", comments: [{ body: "| chrome-bound | first | FAIL |" }] }];
  const exec = async (_file: string, args: readonly string[]): Promise<string> => JSON.stringify(args[0] === "run" ? runs : issues);
  const check = await readConnectCheck(exec);
  assert.equal(check.run?.id, 2);
  assert.equal(check.issues[0]?.latest, "| chrome-bound | first | FAIL |");
  const base = { pages: PAGES.map(spec => page(spec.key)), routes: [], errors: [] };
  assert.equal(servicesOutput({ ...base, connectCheck: check }, NOW).metrics.new_user_checks_failing, 1);
  const green = servicesOutput({ ...base, connectCheck: { run: { ...check.run!, conclusion: "success" }, issues: [] } }, NOW);
  assert.equal(green.metrics.new_user_checks_failing, 0);
  assert.equal(servicesOutput(base, NOW).metrics.new_user_checks_failing, 1);
  const brokenPage = [page("home", { status: 500 }), ...PAGES.slice(1).map(spec => page(spec.key))];
  assert.equal(servicesOutput({ ...base, pages: brokenPage, connectCheck: check }, NOW).metrics.new_user_checks_failing, 2);
});
