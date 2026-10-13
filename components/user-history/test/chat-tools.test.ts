import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { DutyStore } from "../src/chat-duty-store.ts";
import { dailyRun, toolChecks, TOOLS_CACHE_MS } from "../src/chat-tools.ts";
import { RECHECKS_FILE, type Deps, type ExecResult, type McpResult, type Recheck } from "../scripts/duties/skills-and-tools.ts";

const HOME = "/h";
const ok = (stdout: string, code = 0, stderr = ""): ExecResult => ({ code, stdout, stderr, ms: 5 });
const SETTINGS = { mcpServers: { aside: { command: "/h/.local/bin/aside", args: ["mcp"] }, "cua-driver": { command: "/h/.local/bin/cua-driver", args: ["mcp"] } } };

/** Answers by program and first arg, every one passing unless `answers` replaces it. Counts calls per program, so a test sees how often the search ran. */
function fakeDeps(answers: Record<string, ExecResult> = {}, mcp?: () => Promise<McpResult>): Deps & { calls: string[] } {
  const calls: string[] = [];
  const passing: Record<string, ExecResult> = {
    "cua-driver permissions": ok(JSON.stringify({ accessibility: true, screen_recording: true })),
    "python -c import websearch": ok(`${HOME}/.prime/agent/skills/websearch/src/websearch/__init__.py\n`),
    "python -c import asyncio": ok("Result 1: Prime Intellect\nURL: https://www.primeintellect.ai/\n"),
    "aside account": ok("* u0  owner@example.com  signed in  profiles: Profile 0\n"),
  };
  return {
    calls,
    exec: async (file, args) => {
      const argv = `${basename(file)} ${args.join(" ")}`;
      const key = Object.keys(passing).find(prefix => argv.startsWith(prefix)) ?? argv;
      calls.push(key);
      await new Promise(resolve => setTimeout(resolve, 5));
      return answers[key] ?? passing[key] ?? ok("", 127, `no fake for ${argv}`);
    },
    mcp: mcp ?? (async command => command.endsWith("aside")
      ? { tools: ["repl"], result: { content: [{ text: JSON.stringify({ count: 4 }) }] } }
      : { tools: ["health_report", "click"], result: { structuredContent: { overall: "ok", checks: [] } } }),
    readFile: async path => { if (path === `${HOME}/.prime/agent/settings.json`) return JSON.stringify(SETTINGS); throw new Error(`ENOENT ${path}`); },
    writeFile: async () => {},
    rm: async () => {},
    exists: async () => false,
    realpath: async path => path,
    list: async () => [],
    loadResolver: async () => async () => undefined,
    home: HOME,
    repo: "/repo",
    scratchDir: "/tmp",
    now: Date.now,
  };
}
const searches = (deps: { calls: string[] }) => deps.calls.filter(call => call === "python -c import asyncio").length;

test("every tool check passes in CHECKS order with its kind and tool, and the view has no daily run without a store", async () => {
  const view = await toolChecks({ deps: fakeDeps() }).view(false);
  assert.deepEqual(view.checks.map(check => [check.id, check.kind, check.status]), [
    ["cua_permissions", "computer use", "pass"], ["cua_mcp", "computer use", "pass"], ["websearch_kernel", "web search", "pass"],
    ["websearch_query", "web search", "pass"], ["aside_tabs", "browser", "pass"], ["aside_account", "browser", "pass"]]);
  assert.equal(view.checks.find(check => check.id === "aside_tabs")?.detail, "4 tabs");
  assert.ok(view.checks.every(check => check.fix === undefined && check.ms >= 0));
  assert.equal(view.daily, null);
});

test("a failing check gives its error text and its fix; a check that throws is a failed check", async () => {
  const deps = fakeDeps({ "aside account": ok("", 1, "not signed in") }, async () => { throw new Error("socket closed"); });
  const checks = (await toolChecks({ deps }).view(true)).checks;
  const account = checks.find(check => check.id === "aside_account")!;
  assert.equal(account.status, "fail");
  assert.equal(account.detail, "aside account status: exit 1: not signed in");
  assert.equal(account.fix, "sign in to the Aside account in the Aside app");
  for (const id of ["aside_tabs", "cua_mcp"]) assert.deepEqual(checks.filter(check => check.id === id).map(check => [check.status, check.detail]), [["fail", "socket closed"]]);
});

test("view(false) reuses a result younger than five minutes, view(true) and an older result run again", async () => {
  let clock = 1_000_000;
  const deps = fakeDeps();
  const tools = toolChecks({ deps, now: () => clock });
  const first = await tools.view(false);
  assert.equal(first.checkedAt, clock);
  clock += TOOLS_CACHE_MS - 1;
  assert.equal((await tools.view(false)).checkedAt, first.checkedAt);
  assert.equal(searches(deps), 1);
  assert.equal(deps.calls.length, 4);
  await tools.view(true);
  assert.equal(searches(deps), 2);
  clock += TOOLS_CACHE_MS;
  await tools.view(false);
  assert.equal(searches(deps), 3);
});

test("views that arrive during a run share it", async () => {
  const deps = fakeDeps();
  const tools = toolChecks({ deps });
  const views = await Promise.all([tools.view(false), tools.view(true), tools.view(false)]);
  assert.equal(searches(deps), 1);
  assert.equal(new Set(views.map(view => view.checkedAt)).size, 1);
  await tools.view(true);
  assert.equal(searches(deps), 2);
});

const CHAT = "01a1164b-4a2d-742d-b27a-82f086ed0200";
const OTHER = "01a1164b-4a2d-742d-b27a-82f086ed0201";
const duty = (id: string, script: string) => ({ id, name: script === "skills-and-tools.ts" ? "Skills and tools" : "Chat system", ownerWords: "x", goal: "x",
  metrics: [{ key: "checks_failed", label: "Checks failed", op: "<=", target: 0 }], schedule: { kind: "daily", at: "04:30" },
  precheck: { command: ["node", "--import", "tsx", `scripts/duties/${script}`], cwd: "/x", timeoutMs: 120000 }, onMiss: "x", status: "active", createdAt: 1, updatedAt: 1, runCount: 1 });
const record = (dutyId: string, at: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ duty: dutyId, at, trigger: "schedule", ms: 9000, verdict: "missed", metrics: { checks_run: { value: 30, target: 25, op: ">=", met: true } }, summary: `run at ${at}`, ...extra });

test("the daily run is the newest run of a skills-and-tools duty across chats, with its failing and off checks", async () => {
  const data = await mkdtemp(join(tmpdir(), "chat-tools-"));
  try {
    const dir = join(data, "duties");
    await mkdir(join(dir, CHAT), { recursive: true });
    const detail = join(dir, CHAT, "d5-run.json");
    await writeFile(detail, JSON.stringify({ metrics: { checks_failed: 2, checks_run: 31 }, flagged: [
      { kind: "off", item: "paper_mcp", excerpt: "paper_mcp (Paper MCP): Paper Desktop is closed" },
      { kind: "fail_agent", item: "railway_auth", excerpt: "railway_auth (railway): railway whoami: exit 1" },
      { kind: "fail_owner", item: "cua_permissions", excerpt: "cua_permissions (cua-driver): accessibility false" },
      { kind: "passed", excerpt: "aside_tabs 30ms" }] }));
    await writeFile(join(dir, `${CHAT}.json`), JSON.stringify({ version: 1, duties: [duty("d1", "chat-health.ts"), duty("d5", "skills-and-tools.ts")] }));
    await writeFile(join(dir, `${CHAT}.runs.jsonl`), [record("d5", 100), record("d5", 300, { detail }), record("d1", 400)].join("\n") + "\n");
    await writeFile(join(dir, `${OTHER}.json`), JSON.stringify({ version: 1, duties: [duty("d2", "skills-and-tools.ts")] }));
    await writeFile(join(dir, `${OTHER}.runs.jsonl`), record("d2", 200) + "\n");
    const store = new DutyStore(data);

    const daily = await dailyRun(store);
    assert.deepEqual(daily, { chatId: CHAT, dutyId: "d5", name: "Skills and tools", at: 300, verdict: "missed", summary: "run at 300", checksRun: 31, problems: [
      { id: "paper_mcp", status: "off", text: "paper_mcp (Paper MCP): Paper Desktop is closed" },
      { id: "railway_auth", status: "fail", text: "railway_auth (railway): railway whoami: exit 1" },
      { id: "cua_permissions", status: "fail", text: "cua_permissions (cua-driver): accessibility false" }] });
    assert.deepEqual((await toolChecks({ dutyStore: store, deps: fakeDeps() }).view(false)).daily, daily);

    await writeFile(join(dir, `${OTHER}.runs.jsonl`), record("d2", 500, { detail: join(dir, CHAT, "gone.json") }) + "\n");
    assert.deepEqual(await dailyRun(store), { chatId: OTHER, dutyId: "d2", name: "Skills and tools", at: 500, verdict: "missed", summary: "run at 500", checksRun: 30, problems: [] });

    await writeFile(join(dir, CHAT, "bad.json"), "{ not json");
    await writeFile(join(dir, `${OTHER}.runs.jsonl`), record("d2", 600, { detail: join(dir, CHAT, "bad.json") }) + "\n");
    assert.deepEqual((await dailyRun(store))?.problems, []);

    await writeFile(join(dir, `${CHAT}.json`), JSON.stringify({ version: 1, duties: [duty("d1", "chat-health.ts")] }));
    await rm(join(dir, `${OTHER}.json`));
    assert.equal(await dailyRun(store), null);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("a daily failure carries the newest re-check after the run, and the --only run of the script records one", async () => {
  const data = await mkdtemp(join(tmpdir(), "chat-tools-"));
  try {
    const dir = join(data, "duties");
    await mkdir(join(dir, CHAT), { recursive: true });
    const detail = join(dir, CHAT, "d5-run.json");
    await writeFile(detail, JSON.stringify({ metrics: { checks_run: 30 }, flagged: [
      { kind: "fail_agent", item: "railway_auth", excerpt: "railway_auth: exit 1" },
      { kind: "fail_agent", item: "skill_paths", excerpt: "skill_paths: dead paths" },
      { kind: "fail_agent", item: "gh_auth", excerpt: "gh_auth: not logged in" }] }));
    await writeFile(join(dir, `${CHAT}.json`), JSON.stringify({ version: 1, duties: [duty("d5", "skills-and-tools.ts")] }));
    await writeFile(join(dir, `${CHAT}.runs.jsonl`), record("d5", 300, { detail }) + "\n");
    await writeFile(join(dir, RECHECKS_FILE), [
      { at: 200, results: [{ id: "gh_auth", status: "pass", detail: "before the run" }] },
      { at: 400, results: [{ id: "railway_auth", status: "fail", detail: "still exit 1" }, { id: "skill_paths", status: "pass", detail: "no dead paths" }] },
      { at: 500, results: [{ id: "railway_auth", status: "pass", detail: "signed in" }] },
    ].map(line => JSON.stringify(line)).join("\n") + "\nnot json\n");

    const problems = (await dailyRun(new DutyStore(data)))?.problems;
    assert.deepEqual(problems, [
      { id: "railway_auth", status: "fail", text: "railway_auth: exit 1", recheck: { at: 500, status: "pass", detail: "signed in" } },
      { id: "skill_paths", status: "fail", text: "skill_paths: dead paths", recheck: { at: 400, status: "pass", detail: "no dead paths" } },
      { id: "gh_auth", status: "fail", text: "gh_auth: not logged in" }]);

    const file = join(data, "rechecks.jsonl");
    const script = join(import.meta.dirname, "../scripts/duties/skills-and-tools.ts");
    await new Promise<void>((resolve, reject) => execFile(process.execPath, ["--import", "tsx", script, "--only", "no_such_check"], { env: { ...process.env, RECHECKS_FILE: file } },
      error => error ? resolve() : reject(new Error("an unknown id must exit non-zero"))));
    await assert.rejects(readFile(file, "utf8"));
    await new Promise<void>((resolve, reject) => execFile(process.execPath, ["--import", "tsx", script, "--only", "skill_files"], { env: { ...process.env, RECHECKS_FILE: file }, timeout: 60_000 },
      error => error ? reject(error) : resolve()));
    const [line, ...rest] = (await readFile(file, "utf8")).trim().split("\n");
    assert.equal(rest.length, 0);
    const recorded = JSON.parse(line!) as Recheck;
    assert.equal(typeof recorded.at, "number");
    assert.deepEqual(recorded.results.map(result => result.id), ["skill_files"]);
    assert.ok(["pass", "fail", "off"].includes(recorded.results[0]!.status));
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});
