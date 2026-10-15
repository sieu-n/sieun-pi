import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import { type Board, demoSteps, type Exec, LINE_FILE, lintJob, measureStaging, openSteps, picks, reviewWait, type StagingDeps, type StagingLine } from "../scripts/duties/apps-reach-staging.ts";

const NOW = Date.parse("2026-10-13T00:30:00Z");
const HOUR = 3_600_000;
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

const LINE: StagingLine = {
  apps: { home: { variant: "picked", at: "2026-10-12" }, email: { variant: "combined" }, watchlist: { variant: "picked" }, inbox: { variant: "picked" },
    creators: { variant: "shipped" } },
  log: [{ at: iso(60) }, { at: iso(10) }],
};
const BOARD: Board = {
  plan: [{ id: "p14", text: "Each Prospect app reaches Staging", status: "doing", children: [
    { id: "p97", text: "Creators demos like a real product", status: "doing", job: "creators product demos" },
    { id: "p84", text: "Creators from shipped", status: "dropped", job: "waiting browser checks" },
  ] }],
  todos: [
    { id: "t11", text: "Connections has 4 new versions on 5180.", done: true, from: "agent", at: iso(20), step: "p17" },
    { id: "t14", text: "Pick a Creators version for Staging.", done: true, from: "agent", at: iso(5), step: "p84" },
    { id: "t15", text: "Creators is next, from the owner", done: false, from: "owner", at: iso(1) },
  ],
};
const lintJobs = (id: number, conclusion: string) => ({ jobs: [{ databaseId: id, name: "checks / monorepo / lint", steps: [{ name: "js / lint + typecheck + unit", conclusion }] }] });
const receipts = (check: string, unit: string) => [
  `2026-10-15T00:01:28.2111850Z turbo task virev-demo#check: ${check}`,
  "2026-10-15T00:01:28.2112360Z turbo task virev-demo#i18n:compile: executed in this run, hash 0565f4203776366e, exit 0",
  `2026-10-15T00:01:28.2112890Z turbo task virev-demo#test:unit: ${unit}`,
].join("\n");
const EXECUTED = receipts("executed in this run, hash 67ca29013867254c, exit 0", "executed in this run, hash 28a619bb0661a8e4, exit 0");
const CACHED = receipts("not executed in this run, cache hit replayed hash fd0216e587b288fa from run https://github.com/sieu-n/auto-sns-agent/actions/runs/38643067488/attempts/1 on 706fdb3b at 2026-10-14T22:11:16.493Z",
  "executed in this run, hash bb9a8545a569f436, exit 0");
const FAILED = receipts("executed in this run, hash 67ca29013867254c, failed with exit 2", "not run, hash 28a619bb0661a8e4");
const LEFT_OUT = "2026-10-15T00:01:28.2111850Z turbo task llm-wiki#check: executed in this run, hash 1, exit 0";
type FakeRun = { id: number; status: string; jobs: unknown; log?: string };

function deps(options: { line?: StagingLine | Error; board?: Board | Error; runs?: FakeRun[] | Error }): StagingDeps & { calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (options.runs instanceof Error || !options.runs) throw options.runs ?? new Error("gh: not logged in");
    if (args[1] === "list") return JSON.stringify(options.runs.map(run => ({ databaseId: run.id, status: run.status, conclusion: "", createdAt: iso(3) })));
    if (args[0] === "api") return options.runs.find(run => args[1] === `repos/{owner}/{repo}/actions/jobs/${run.id * 10}/logs`)!.log!;
    return JSON.stringify(options.runs.find(run => String(run.id) === args[2])!.jobs);
  };
  const read = async (path: string) => {
    const value = path.endsWith(LINE_FILE) ? options.line : options.board;
    if (value === undefined || value instanceof Error) throw value ?? new Error(`ENOENT: ${path}`);
    return JSON.stringify(value);
  };
  return { exec, now: () => NOW, read, repo: "/repo", board: "/boards/chat.json", calls };
}

test("apps reach staging: any variant but shipped is a pick, and an app missing from the line counts as shipped", () => {
  const apps = picks(LINE);
  assert.deepEqual(apps.filter(app => app.picked).map(app => app.key).sort(), ["email", "home", "inbox", "watchlist"]);
  assert.deepEqual(apps.filter(app => !app.picked).map(app => app.key).sort(), ["connections", "creators"]);
});

test("apps reach staging: the review wait is 0 with an open agent todo, else hours since the newest agent todo, else since the line started", () => {
  assert.equal(reviewWait(BOARD.todos!, "Creators", NOW, NOW - 60 * HOUR).hours, 5, "an owner todo does not count");
  assert.equal(reviewWait(BOARD.todos!, "Connections", NOW, NOW - 60 * HOUR).hours, 20);
  assert.equal(reviewWait(BOARD.todos!, "Email", NOW, NOW - 60 * HOUR).hours, 60);
  const open = [...BOARD.todos!, { id: "t16", text: "Creators has 3 new versions.", done: false, from: "agent", at: iso(70) }];
  assert.equal(reviewWait(open, "Creators", NOW, NOW).hours, 0);
  assert.deepEqual(openSteps(BOARD.plan!, "Creators"), ["p97 (job creators product demos)"]);
});

test("apps reach staging: the CI check reads the virev-demo receipts of the lint job and skips a run that left virev-demo out", () => {
  assert.equal(lintJob(lintJobs(10, "success").jobs), 10);
  assert.equal(lintJob(lintJobs(10, "failure").jobs), 10);
  assert.equal(lintJob(lintJobs(10, "skipped").jobs), null);
  assert.equal(lintJob([{ databaseId: 11, name: "checks / monorepo / lint / macOS", steps: [{ name: "js / lint + typecheck + unit", conclusion: "success" }] }]), null);
  assert.equal(demoSteps(LEFT_OUT), null);
  assert.equal(demoSteps(EXECUTED.split("\n").slice(0, 2).join("\n")), null, "one receipt alone is skipped");
  assert.deepEqual(demoSteps(EXECUTED + "\r\n"), {
    "virev-demo#check": { ok: true, receipt: "executed in this run, hash 67ca29013867254c, exit 0" },
    "virev-demo#test:unit": { ok: true, receipt: "executed in this run, hash 28a619bb0661a8e4, exit 0" },
  });
  assert.deepEqual(Object.values(demoSteps(CACHED)!).map(task => task.ok), [true, true], "a cache hit is a green");
  assert.deepEqual(Object.values(demoSteps(FAILED)!).map(task => task.ok), [false, false], "a failed exit and a task not run are red");
});

test("apps reach staging: measures picks, the longest wait and the last demo CI result", async () => {
  const run = deps({ line: LINE, board: BOARD, runs: [{ id: 4, status: "in_progress", jobs: {} }, { id: 3, status: "completed", jobs: lintJobs(30, "skipped") },
    { id: 2, status: "completed", jobs: lintJobs(20, "success"), log: LEFT_OUT }, { id: 1, status: "completed", jobs: lintJobs(10, "success"), log: CACHED }] });
  const output = await measureStaging(run);
  assert.deepEqual(output.metrics, { apps_picked: 4, review_wait_max_h: 20, demo_ci_ok: 1, source_errors: 0 });
  assert.deepEqual(run.calls.filter(call => call[2] === "view").map(call => call[3]), ["3", "2", "1"]);
  assert.deepEqual(run.calls.filter(call => call[1] === "api").map(call => call[2]), ["repos/{owner}/{repo}/actions/jobs/20/logs", "repos/{owner}/{repo}/actions/jobs/10/logs"]);
  assert.deepEqual(output.flagged?.map(item => item.kind).sort(), ["demo_ci", "no_pick", "no_pick", "picked", "picked", "picked", "picked"]);
  const failed = await measureStaging(deps({ line: LINE, board: BOARD, runs: [{ id: 1, status: "completed", jobs: lintJobs(10, "failure"), log: FAILED }] }));
  assert.equal(failed.metrics.demo_ci_ok, 0);
  assert.equal(failed.metrics.source_errors, 0);
  assert.ok(failed.flagged?.some(item => item.kind === "demo_ci_failed" && item.excerpt?.includes("failed with exit 2")));
});

test("apps reach staging: unread sources still give every metric and count as source errors", async () => {
  const output = await measureStaging(deps({ line: new Error("ENOENT"), board: new Error("bad json"), runs: new Error("gh: not logged in") }));
  assert.deepEqual(output.metrics, { apps_picked: 0, review_wait_max_h: 0, demo_ci_ok: 0, source_errors: 3 });
  const failed = await measureStaging(deps({ line: LINE, board: BOARD, runs: [{ id: 1, status: "completed", jobs: lintJobs(10, "success"), log: LEFT_OUT }] }));
  assert.equal(failed.metrics.source_errors, 1);
});

test("apps reach staging duty file parses, and every metric is a key the precheck writes", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile(join(import.meta.dirname, "..", "scripts", "duties", "apps-reach-staging.duty.json"), "utf8")), "d", NOW);
  assert.deepEqual(duty.schedule, { kind: "daily", at: "09:30" });
  assert.equal(duty.precheck.cwd, "../..");
  const output = await measureStaging(deps({}));
  assert.deepEqual(duty.metrics.map(metric => metric.key).sort(), Object.keys(output.metrics).sort());
});
