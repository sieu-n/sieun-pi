// Guards slack green guy's p223 (10-30): slack.green prod answered HTTP 200 for hours while every page threw "Missing Supabase environment
// variables" in the browser, because the us-metal02 prebuilt build had no NEXT_PUBLIC_SUPABASE_* values, and no duty saw it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEPLOY_MINUTES, type DeployDeps, measureDeploys } from "../scripts/duties/slack-green-deploys.ts";
import { type PageRead, PAGES, pageFailure, readConnectCheck, readWorker, servicesOutput, type WorkerRead } from "../scripts/duties/slack-green-services.ts";

const NOW = Date.parse("2026-10-30T12:10:00Z");
const WORKER: WorkerRead = { status: "running", running: true, startedAt: NOW - 3_600_000, restarts: 0, lastActiveAt: NOW - 30_000, activeLines: 200 };
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
    worker: WORKER,
    deploys: { metrics: { commits_not_live: 3, main_checks_failed_24h: 0, worker_not_live: 0, vercel_not_live: 3, source_errors: 0 }, flagged: [] } }, NOW);
  assert.equal(output.metrics.new_user_checks_failing, PAGES.length);
  assert.equal(output.metrics.deploy_problems, 0);
  assert.equal(output.metrics.owner_slack_green, 1);
});

test("failed main runs alone make deploy_problems a day's window that ages out, and a live problem does not", () => {
  const base = { pages: PAGES.map(spec => page(spec.key)), routes: [], errors: [], presence: { presence: "active", online: true, connectionCount: 1 },
    worker: WORKER };
  const failedAt = NOW - 2 * 3_600_000;
  const checks = servicesOutput({ ...base, deploys: { metrics: { commits_not_live: 0, main_checks_failed_24h: 4, worker_not_live: 0, vercel_not_live: 0, source_errors: 0 },
    flagged: [], lastEventAt: { main_checks_failed_24h: failedAt } } }, NOW);
  assert.equal(checks.metrics.deploy_problems, 4);
  assert.deepEqual(checks.lastEventAt, { deploy_problems: failedAt });
  assert.deepEqual(checks.windowMs, { deploy_problems: 24 * 3_600_000 });
  const late = servicesOutput({ ...base, deploys: { metrics: { commits_not_live: 1, main_checks_failed_24h: 4, worker_not_live: 1, vercel_not_live: 0, source_errors: 0 },
    flagged: [], lastEventAt: { main_checks_failed_24h: failedAt } } }, NOW);
  assert.equal(late.metrics.deploy_problems, 5);
  assert.equal(late.windowMs, undefined);
});

const komodo = (container: unknown, stdout: string) => ({ komodo: async () => ({ key: "k", secret: "s" }),
  fetch: (async (url: string | URL | Request) => new Response(JSON.stringify(String(url).endsWith("/read/GetStackLog") ? { stdout, stderr: "", success: true } : container))) as typeof fetch });

// 11-25: the worker left Railway for Komodo Stack slack-green, whose log lines carry the compose service prefix and a UTC logging time.
test("the worker read takes the container state and revision from Komodo and the newest presence check from its Stack log", async () => {
  const stdout = "slack-green-worker  | 2026-10-30 12:09:20,100 - app.lib.slack.session - INFO - [ppwc] 🟢 active\n" +
    "slack-green-worker  | 2026-10-30 12:09:30,406 - app.lib.slack.session - INFO - [closer] 🟢 active\nslack-green-worker  | Running in PRODUCTION mode\n";
  const container = { RestartCount: 2, Config: { Labels: { "org.opencontainers.image.revision": "618867bad0e8475e208d6e958e13ede93578097a" } },
    State: { Status: "running", Running: true, Restarting: false, StartedAt: "2026-10-30T11:10:00Z" } };
  const worker = await readWorker(komodo(container, stdout));
  assert.deepEqual(worker, { status: "running", running: true, startedAt: NOW - 3_600_000, restarts: 2, revision: "618867bad0e8475e208d6e958e13ede93578097a",
    activeLines: 2, lastActiveAt: NOW - 29_594 });
  const restarting = await readWorker(komodo({ State: { Status: "restarting", Running: true, Restarting: true, StartedAt: "2026-10-30T12:09:00Z" } }, ""));
  const output = servicesOutput({ pages: PAGES.map(spec => page(spec.key)), routes: [], errors: [], connectCheck: { issues: [] }, worker: restarting,
    deploys: { metrics: { worker_not_live: 0, main_checks_failed_24h: 0, source_errors: 0 }, flagged: [] } }, NOW);
  assert.equal(output.metrics.deploy_problems, 2);
});

// 11-25: the box ran 618867b while CI had published d418d8b (#635) and moved :main to it 7 h before.
test("a main commit with a published worker image that the worker does not run counts after DEPLOY_MINUTES, and a commit with no image does not", async () => {
  const LIVE = "618867bad0e8475e208d6e958e13ede93578097a";
  const IMAGED = "d418d8bead2790410bcda00592a8c20262c30b94";
  const FRONTEND = "53127052aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const at = NOW - (DEPLOY_MINUTES + 5) * 60_000;
  const worker = komodo({ Config: { Labels: { "org.opencontainers.image.revision": LIVE } } }, "");
  const deps: DeployDeps = { komodo: worker.komodo, now: () => NOW, vercelToken: async () => "t",
    fetch: (async (url: string | URL | Request) => String(url).includes("vercel.com")
      ? new Response(JSON.stringify({ targets: { production: { meta: { githubCommitSha: LIVE } } }, deployments: [] })) : worker.fetch(url)) as typeof fetch,
    exec: async (_file: string, args: readonly string[]) => String(args[1]).includes(`/compare/${LIVE}...main`)
      ? JSON.stringify([{ sha: IMAGED, at: new Date(at).toISOString() }, { sha: FRONTEND, at: new Date(at).toISOString() }])
      : String(args[1]).includes("/packages/container/") ? JSON.stringify([{ at: new Date(at + 600_000).toISOString(), tags: [IMAGED, "main"] }]) : "[]" };
  const output = await measureDeploys(deps);
  assert.equal(output.metrics.worker_not_live, 1);
  assert.match((output.flagged ?? []).find(slice => slice.kind === "worker_not_live")?.excerpt ?? "",
    /the Komodo worker \(Stack slack-green\) runs 618867b, which lacks d418d8b \(25 min after its push, worker image published\)/);
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
