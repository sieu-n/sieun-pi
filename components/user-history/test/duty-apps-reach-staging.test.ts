import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { judge, parseDutyInput } from "../src/shared/chat-duties.ts";
import { type Board, branchRuns, type CiCache, demoSteps, type Exec, LINE_FILE, lintJob, measureStaging, openReviews, openSteps, picks, reviewWait, type StagingDeps, type StagingLine, tabStatus } from "../scripts/duties/apps-reach-staging.ts";

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
const lintJobs = (id: number, conclusion: string) => [{ id, name: "checks / monorepo / lint", steps: [{ name: "js / lint + typecheck + unit", conclusion }] }];
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
type FakeRun = { id: number; status: string; jobs?: ReturnType<typeof lintJobs>; log?: string; branch?: string; path?: string };
const RATE_LIMIT = new Error("gh: API rate limit exceeded for user ID 48239275. (HTTP 403)");
/** A CI cache with these runs, the first newest, each lint job id 10 times its run id. */
const cacheOf = (runs: readonly FakeRun[]): CiCache => ({ fetchedAt: iso(0), runs: Object.fromEntries(runs.map((run, index) => [String(run.id), {
  run: { id: run.id, path: run.path ?? ".github/workflows/verify-dev.yml", head_branch: run.branch ?? "sieun/dev", status: run.status, created_at: iso(index + 1) },
  ...run.jobs ? { jobs: run.jobs } : {} }])) });

function deps(options: { line?: StagingLine | Error; board?: Board | Error; runs?: FakeRun[] | Error; logs?: Error }): StagingDeps & { calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (options.logs) throw options.logs;
    const runs = options.runs instanceof Error ? [] : options.runs ?? [];
    return runs.find(run => args[1] === `repos/{owner}/{repo}/actions/jobs/${run.id * 10}/logs`)!.log!;
  };
  const read = async (path: string) => {
    const value = path.endsWith(LINE_FILE) ? options.line : path === "/cache/ci-runs.json" ? (options.runs instanceof Error ? options.runs : cacheOf(options.runs ?? [])) : options.board;
    if (value === undefined || value instanceof Error) throw value ?? new Error(`ENOENT: ${path}`);
    return JSON.stringify(value);
  };
  return { exec, now: () => NOW, read, repo: "/repo", board: "/boards/chat.json", ciCache: "/cache/ci-runs.json", calls };
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
  assert.equal(lintJob(lintJobs(10, "success")), 10);
  assert.equal(lintJob(lintJobs(10, "failure")), 10);
  assert.equal(lintJob(lintJobs(10, "skipped")), null);
  assert.equal(lintJob([{ id: 11, name: "checks / monorepo / lint / macOS", steps: [{ name: "js / lint + typecheck + unit", conclusion: "success" }] }]), null);
  assert.equal(demoSteps(LEFT_OUT), null);
  assert.equal(demoSteps(EXECUTED.split("\n").slice(0, 2).join("\n")), null, "one receipt alone is skipped");
  assert.deepEqual(demoSteps(EXECUTED + "\r\n"), {
    "virev-demo#check": { ok: true, receipt: "executed in this run, hash 67ca29013867254c, exit 0" },
    "virev-demo#test:unit": { ok: true, receipt: "executed in this run, hash 28a619bb0661a8e4, exit 0" },
  });
  assert.deepEqual(Object.values(demoSteps(CACHED)!).map(task => task.ok), [true, true], "a cache hit is a green");
  assert.deepEqual(Object.values(demoSteps(FAILED)!).map(task => task.ok), [false, false], "a failed exit and a task not run are red");
});

test("apps reach staging: open reviews are agent todos naming an app or asking to review or pick, oldest first", () => {
  const todos = [...BOARD.todos!,
    { id: "t25", text: "Review Email with the 6-item checklist.", done: false, from: "agent", at: iso(30), step: "p129" },
    { id: "t27", text: "Say yes or no to the List app's top-10 changes (http://x/1731-list-app-review/review.html).", done: false, from: "agent", at: iso(2), step: "p120" },
    { id: "t28", text: "Renew the GeoNode plan?", done: false, from: "agent", at: iso(90) },
    { id: "t29", text: "Pick the Home chart", done: false, from: "owner", at: iso(80) }];
  assert.deepEqual(openReviews(todos, NOW).map(({ todo, hours, held }) => [todo.id, hours, held]), [["t25", 30, false], ["t27", 2, false]]);
});

test("apps reach staging: a review with tap answers and no reply waits on the owner, so it leaves open_review_max_h for owner_held_review_max_h", async () => {
  // The frontend chat's For you on 10-18 00:45Z: t25 had its choices added in place by the refresh step p194 and read 92.3 h, t28 had none.
  const now = Date.parse("2026-10-18T00:45:10.861Z");
  const todos = [
    { id: "t25", text: "Three yes or no questions on Email. 1. When you open Email, do you land on your templates first with nothing to set up?", done: false, step: "p129",
      links: [{ label: "Email on Staging", target: "http://localhost:5180/configure?scenario=kbeauty-brand&line=staging&to=/app/analytics/email" }],
      from: "agent", at: "2026-10-14T04:29:50.206Z", choices: ["Yes to all 3", "No to some, I'll say which"] },
    { id: "t28", text: "Look at three screens and say good or what to change. Connections, one answer per part: 1. multiple accounts per channel.", done: false,
      step: "p115", from: "agent", at: "2026-10-17T21:44:56.405Z" },
    { id: "t29", text: "Is the new tighter sidebar on Staging right?", done: false, choices: ["Yes, good", "Change something"], step: "p189", from: "agent",
      at: "2026-10-18T00:37:40.414Z" },
  ];
  const output = await measureStaging({ ...deps({ line: LINE, board: { plan: [], todos } }), now: () => now });
  assert.equal(output.metrics.open_review_max_h, 3);
  assert.equal(output.metrics.owner_held_review_max_h, 92.3);
  assert.deepEqual(output.flagged?.filter(item => item.kind.endsWith("review")).map(item => [item.kind, item.item]),
    [["owner_held_review", "p129"], ["open_review", "p115"]]);
  assert.match(output.flagged!.find(item => item.kind === "owner_held_review")!.excerpt, /^t25 open 92\.3 h, waits on the owner's tap \(since/);
  const answered = todos.map(todo => todo.id === "t25" ? { ...todo, reply: "Yes to all 3", answeredBy: "owner" } : todo);
  const after = await measureStaging({ ...deps({ line: LINE, board: { plan: [], todos: answered } }), now: () => now });
  assert.equal(after.metrics.open_review_max_h, 92.3, "an answered review left open is the chat's to check off");
  assert.equal(after.metrics.owner_held_review_max_h, 0);
});

test("apps reach staging: a tab's status counts its Staging pick as one step, and dropped steps leave", () => {
  const plan = [{ id: "p1", text: "Creators lists", status: "done" }, { id: "p2", text: "Creators CRM", status: "doing" },
    { id: "p3", text: "Creators swipe", status: "dropped" }, { id: "p4", text: "Home", status: "done", children: [{ id: "p5", text: "Creators deck", status: "blocked" }] }];
  assert.deepEqual(tabStatus(plan, { key: "creators", word: "Creators", picked: true }),
    { key: "creators", word: "Creators", pct: 50, picked: true, done: ["p1"], open: ["p2", "p5"] });
  assert.equal(tabStatus(plan, { key: "creators", word: "Creators", picked: false }).pct, 25);
  assert.equal(tabStatus(plan, { key: "home", word: "Home", picked: true }).pct, 100);
  assert.equal(tabStatus([], { key: "email", word: "Email", picked: false }).pct, 0);
});

test("apps reach staging: measures picks, the oldest open review, each tab and the last demo CI result", async () => {
  const board: Board = { ...BOARD, todos: [...BOARD.todos!, { id: "t16", text: "Review the Creators set.", done: false, from: "agent", at: iso(20) }] };
  const run = deps({ line: LINE, board, runs: [{ id: 4, status: "in_progress" }, { id: 5, status: "completed", branch: "ci/x", jobs: lintJobs(50, "success") },
    { id: 6, status: "completed", path: ".github/workflows/land.yml", jobs: lintJobs(60, "success") }, { id: 3, status: "completed", jobs: lintJobs(30, "skipped") },
    { id: 2, status: "completed", jobs: lintJobs(20, "success"), log: LEFT_OUT }, { id: 1, status: "completed", jobs: lintJobs(10, "success"), log: CACHED }] });
  const output = await measureStaging(run);
  assert.deepEqual(output.metrics, { apps_picked: 4, open_review_max_h: 20, owner_held_review_max_h: 0, demo_ci_ok: 1, source_errors: 0 });
  assert.deepEqual(run.calls.map(call => call.join(" ")), ["gh api repos/{owner}/{repo}/actions/jobs/20/logs", "gh api repos/{owner}/{repo}/actions/jobs/10/logs"],
    "the runs and jobs come from the CI cache, and only the lint job logs are read from GitHub");
  assert.deepEqual(output.flagged?.filter(item => item.kind !== "tab_status").map(item => item.kind).sort(),
    ["demo_ci", "no_pick", "no_pick", "open_review", "picked", "picked", "picked", "picked"]);
  assert.deepEqual(output.tabs.map(tab => [tab.key, tab.pct]), [["home", 100], ["inbox", 100], ["watchlist", 100], ["email", 100], ["creators", 0], ["connections", 0]]);
  assert.ok(output.flagged?.some(item => item.kind === "tab_status" && item.excerpt === "Creators 0%: no pick on Staging, 0 of 1 board steps done; open: p97"));
  const failed = await measureStaging(deps({ line: LINE, board: BOARD, runs: [{ id: 1, status: "completed", jobs: lintJobs(10, "failure"), log: FAILED }] }));
  assert.equal(failed.metrics.demo_ci_ok, 0);
  assert.equal(failed.metrics.source_errors, 0);
  assert.ok(failed.flagged?.some(item => item.kind === "demo_ci_failed" && item.excerpt?.includes("failed with exit 2")));
});

test("apps reach staging: an unread Staging line or board fails the run, and a failed CI read leaves demo_ci_ok not measured with a source flag", async () => {
  await assert.rejects(measureStaging(deps({ line: new Error("ENOENT"), board: BOARD })), /Staging line .*ENOENT/);
  await assert.rejects(measureStaging(deps({ line: LINE, board: new Error("bad json") })), /board .*bad json/);
  const duty = parseDutyInput(JSON.parse(await readFile(join(import.meta.dirname, "..", "scripts", "duties", "apps-reach-staging.duty.json"), "utf8")), "d", NOW);
  const green = [{ id: 1, status: "completed", jobs: lintJobs(10, "success"), log: EXECUTED }];
  for (const options of [{ runs: new Error("ENOENT: ci-runs.json") }, { runs: green, logs: RATE_LIMIT },
    { runs: [{ id: 1, status: "completed", jobs: lintJobs(10, "success"), log: LEFT_OUT }] }]) {
    const output = await measureStaging(deps({ line: LINE, board: BOARD, ...options }));
    assert.ok(!("demo_ci_ok" in output.metrics), "a failed read is not a miss");
    assert.equal(output.metrics.source_errors, 1);
    assert.ok(output.flagged?.some(item => item.kind === "source" && item.excerpt.endsWith("demo_ci_ok is not measured")));
    const judged = judge(duty.metrics, output);
    assert.deepEqual(Object.keys(judged.metrics).sort(), ["apps_picked", "open_review_max_h"], "the runner still judges the other metrics");
    assert.match(judged.summary, /not measured: the precheck gave no value for demo_ci_ok$/);
  }
  const limited = await measureStaging(deps({ line: LINE, board: BOARD, runs: green, logs: RATE_LIMIT }));
  assert.ok(limited.flagged?.some(item => item.kind === "source" && item.excerpt.includes("HTTP 403")));
});

test("apps reach staging: the cache's completed verify-dev runs on sieun/dev, newest first", () => {
  const cache = cacheOf([{ id: 3, status: "completed" }, { id: 2, status: "in_progress" }, { id: 1, status: "completed", branch: "main" }, { id: 0, status: "completed" }]);
  assert.deepEqual(branchRuns(cache).map(entry => entry.run?.id), [3, 0]);
  assert.deepEqual(branchRuns({}), []);
});

test("apps reach staging duty file parses with one headline and at most 3 more, each a key the precheck writes", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile(join(import.meta.dirname, "..", "scripts", "duties", "apps-reach-staging.duty.json"), "utf8")), "d", NOW);
  assert.deepEqual(duty.schedule, { kind: "daily", at: "09:30" });
  assert.equal(duty.precheck.cwd, "../..");
  assert.deepEqual(duty.metrics.filter(metric => metric.headline).map(metric => metric.key), ["apps_picked"]);
  assert.ok(duty.metrics.length <= 4);
  const output = await measureStaging(deps({ line: LINE, board: BOARD, runs: [{ id: 1, status: "completed", jobs: lintJobs(10, "success"), log: EXECUTED }] }));
  for (const metric of duty.metrics) assert.ok(metric.key in output.metrics, metric.key);
  assert.ok(!duty.metrics.some(metric => metric.key === "source_errors"), "source_errors is run detail");
});
