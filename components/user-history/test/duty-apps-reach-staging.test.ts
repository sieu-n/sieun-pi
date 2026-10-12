import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import { type Board, demoSteps, type Exec, LINE_FILE, measureStaging, openSteps, picks, reviewWait, type StagingDeps, type StagingLine } from "../scripts/duties/apps-reach-staging.ts";

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
const PASSED = { jobs: [{ name: "light / m1-air", steps: [{ name: "virev-demo / test / unit", conclusion: "success" }, { name: "virev-demo / typecheck", conclusion: "success" }] }] };
const SKIPPED = { jobs: [{ name: "light / m1-air", steps: [{ name: "virev-demo / test / unit", conclusion: "skipped" }, { name: "virev-demo / typecheck", conclusion: "skipped" }] }] };

function deps(options: { line?: StagingLine | Error; board?: Board | Error; runs?: { id: number; status: string; jobs: unknown }[] | Error }): StagingDeps & { calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (options.runs instanceof Error || !options.runs) throw options.runs ?? new Error("gh: not logged in");
    if (args[1] === "list") return JSON.stringify(options.runs.map(run => ({ databaseId: run.id, status: run.status, conclusion: "", createdAt: iso(3) })));
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

test("apps reach staging: the CI check skips runs that did not run both virev-demo steps", () => {
  assert.equal(demoSteps(SKIPPED.jobs), null);
  assert.deepEqual(demoSteps(PASSED.jobs), { "virev-demo / test / unit": "success", "virev-demo / typecheck": "success" });
});

test("apps reach staging: measures picks, the longest wait and the last demo CI result", async () => {
  const run = deps({ line: LINE, board: BOARD, runs: [{ id: 3, status: "in_progress", jobs: {} }, { id: 2, status: "completed", jobs: SKIPPED }, { id: 1, status: "completed", jobs: PASSED }] });
  const output = await measureStaging(run);
  assert.deepEqual(output.metrics, { apps_picked: 4, review_wait_max_h: 20, demo_ci_ok: 1, source_errors: 0 });
  assert.deepEqual(run.calls.filter(call => call[2] === "view").map(call => call[3]), ["2", "1"]);
  assert.deepEqual(output.flagged?.map(item => item.kind).sort(), ["demo_ci", "no_pick", "no_pick", "picked", "picked", "picked", "picked"]);
});

test("apps reach staging: unread sources still give every metric and count as source errors", async () => {
  const output = await measureStaging(deps({ line: new Error("ENOENT"), board: new Error("bad json"), runs: new Error("gh: not logged in") }));
  assert.deepEqual(output.metrics, { apps_picked: 0, review_wait_max_h: 0, demo_ci_ok: 0, source_errors: 3 });
  const failed = await measureStaging(deps({ line: LINE, board: BOARD, runs: [{ id: 1, status: "completed", jobs: SKIPPED }] }));
  assert.equal(failed.metrics.source_errors, 1);
});

test("apps reach staging duty file parses, and every metric is a key the precheck writes", async () => {
  const duty = parseDutyInput(JSON.parse(await readFile(join(import.meta.dirname, "..", "scripts", "duties", "apps-reach-staging.duty.json"), "utf8")), "d", NOW);
  assert.deepEqual(duty.schedule, { kind: "daily", at: "09:30" });
  assert.equal(duty.precheck.cwd, "../..");
  const output = await measureStaging(deps({}));
  assert.deepEqual(duty.metrics.map(metric => metric.key).sort(), Object.keys(output.metrics).sort());
});
