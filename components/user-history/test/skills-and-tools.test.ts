import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHECKS, type Deps, type ExecResult, runChecks, toOutput } from "../scripts/duties/skills-and-tools.ts";
import type { DutyStore } from "../src/chat-duty-store.ts";
import { dailyRun } from "../src/chat-tools.ts";
import type { Duty, DutyRunRecord } from "../src/shared/chat-duties.ts";

const asideTabs = CHECKS.find(check => check.id === "aside_tabs")!;
const deps = (platform?: NodeJS.Platform): Deps => ({
  exec: async () => ({ code: 0, stdout: "", stderr: "", ms: 0 }),
  mcp: async () => ({ tools: [], error: "connection closed" }),
  readFile: async () => JSON.stringify({ mcpServers: { aside: { command: "/home/sieun/.local/bin/aside", args: ["mcp"] } } }),
  writeFile: async () => {},
  rm: async () => {},
  exists: async () => true,
  realpath: async path => path,
  list: async () => [],
  loadResolver: async () => async () => undefined,
  home: "/home/sieun",
  repo: "/repo",
  scratchDir: "/tmp",
  now: () => 0,
  ...(platform ? { platform } : {}),
});

test("aside_tabs on the linux box points the fix at the Mac over ssh", async () => {
  const outcome = await asideTabs.run(deps("linux"));
  assert.equal(outcome.status, "fail");
  assert.ok(outcome.status === "fail" && outcome.fix.includes("aside-remote"), JSON.stringify(outcome));
});

test("aside_tabs on macOS keeps the local open -a Aside fix", async () => {
  const outcome = await asideTabs.run(deps());
  assert.ok(outcome.status === "fail" && outcome.fix.startsWith("open Aside with `open -a Aside`"), JSON.stringify(outcome));
});

const railwayAuth = CHECKS.find(check => check.id === "railway_auth")!;
const railwayDeps = (token: string | undefined): Deps => ({
  ...deps("linux"),
  env: token === undefined ? {} : { RAILWAY_API_TOKEN: token },
  exec: async (_file, _args, options) => options.env?.RAILWAY_API_TOKEN && options.env.HOME !== "/home/sieun"
    ? { code: 1, stdout: "", stderr: "Unauthorized. Please check that your RAILWAY_API_TOKEN is valid", ms: 0 }
    : { code: 0, stdout: "Logged in as Sieun Park (sieunpark77@gmail.com)", stderr: "", ms: 0 },
});

test("railway_auth fails a broken RAILWAY_API_TOKEN that the OAuth login would hide", async () => {
  const outcome = await railwayAuth.run(railwayDeps("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
  assert.ok(outcome.status === "fail" && outcome.fix.includes("railway.com/account/tokens"), JSON.stringify(outcome));
});

test("railway_auth names the inline comment when RAILWAY_API_TOKEN carries one", async () => {
  const outcome = await railwayAuth.run(railwayDeps('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"  # PERSONAL account token'));
  assert.ok(outcome.status === "fail" && outcome.fix.includes("inline comment"), JSON.stringify(outcome));
});

test("railway_auth without RAILWAY_API_TOKEN keeps the OAuth whoami", async () => {
  const outcome = await railwayAuth.run(railwayDeps(undefined));
  assert.equal(outcome.status, "pass", JSON.stringify(outcome));
});

const websearchQuery = CHECKS.find(check => check.id === "websearch_query")!;
const GOOGLE = { code: 0, stdout: "Results for query \"Prime Intellect\":\n\nResult 1: Prime Intellect - The Open Superintelligence Stack\n", stderr: "", ms: 0 };
const FALLBACK = { code: 0, stdout: "NOTE: google is unavailable on the Virev search backend right now (HTTP 502: Upstream error; no charge was taken). These are DuckDuckGo results instead:\n\nResult 1: Prime Intellect\n", stderr: "", ms: 0 };
const BAD_GATEWAY = { code: 0, stdout: "Results for query \"Prime Intellect\": Virev search error (502): Upstream error", stderr: "", ms: 0 };
const searchDeps = (answers: { code: number; stdout: string; stderr: string; ms: number }[], calls: { n: number }): Deps => ({
  ...deps("linux"),
  exec: async () => answers[Math.min(calls.n++, answers.length - 1)]!,
});

test("websearch_query passes when Google answers on the retry after the DuckDuckGo fallback", async () => {
  const calls = { n: 0 };
  const outcome = await websearchQuery.run(searchDeps([FALLBACK, GOOGLE], calls));
  assert.equal(outcome.status, "pass", JSON.stringify(outcome));
  assert.equal(calls.n, 2);
});

test("websearch_query passes when Google answers on the retry after a Virev 502", async () => {
  const calls = { n: 0 };
  const outcome = await websearchQuery.run(searchDeps([BAD_GATEWAY, GOOGLE], calls));
  assert.equal(outcome.status, "pass", JSON.stringify(outcome));
  assert.equal(calls.n, 2);
});

test("websearch_query fails when the retry gets the DuckDuckGo fallback too", async () => {
  const calls = { n: 0 };
  const outcome = await websearchQuery.run(searchDeps([FALLBACK, FALLBACK], calls));
  assert.ok(outcome.status === "fail" && outcome.detail.includes("DuckDuckGo fallback"), JSON.stringify(outcome));
  assert.equal(calls.n, 2);
});

test("websearch_query searches once when Google answers the first time", async () => {
  const calls = { n: 0 };
  const outcome = await websearchQuery.run(searchDeps([GOOGLE], calls));
  assert.equal(outcome.status, "pass", JSON.stringify(outcome));
  assert.equal(calls.n, 1);
});

const skillMap = CHECKS.find(check => check.id === "skill_map")!;
const skillPaths = CHECKS.find(check => check.id === "skill_paths")!;
const LS_TREE = [".agents/skills/apps/web/SKILL.md", ".agents/skills/apps/web/inner/SKILL.md", ".agents/skills/repo/.hidden/x/SKILL.md", ".claude/skills-native/gh/SKILL.md"].join("\n");
const gitDeps = (map: string): Deps => ({
  ...deps("linux"),
  list: async () => [{ name: "SKILL.md", kind: "file" }],
  readFile: async () => "| `apps/uncommitted` |",
  exec: async (file, args) => file === "git" && args[0] === "ls-tree" ? { code: 0, stdout: LS_TREE, stderr: "", ms: 0 }
    : file === "git" && args[0] === "show" ? { code: 0, stdout: map, stderr: "", ms: 0 } : { code: 1, stdout: "", stderr: "unexpected", ms: 0 },
});

test("skill_map compares HEAD's skill folders with HEAD's map, so an uncommitted folder in the shared tree does not count", async () => {
  assert.equal((await skillMap.run(gitDeps("| `apps/web` | x |\n| `gh` | y |\n"))).status, "pass");
  const outcome = await skillMap.run(gitDeps("| `apps/web` | x |\n"));
  assert.ok(outcome.status === "fail" && outcome.detail === "map lacks gh", JSON.stringify(outcome));
});

const HEAD_FILES: Record<string, string> = {
  "scripts/ci/check-skill-paths.mjs": "import { readFileSync } from 'node:fs';\nimport { annotate } from './gh-annotate.mjs';\n",
  "scripts/ci/gh-annotate.mjs": "import { join } from 'node:path';\nexport { root } from \"../lib/paths.mjs\";\nimport { annotate } from './gh-annotate.mjs';\n",
};

test("skill_paths runs check-skill-paths.mjs with the modules it imports at HEAD over a git archive with GIT_DIR on the repo, and cleans up", async () => {
  const calls: { file: string; args: readonly string[]; cwd: string | undefined; env: Record<string, string> | undefined }[] = [];
  const run = (stdout: string): Deps => ({
    ...deps("linux"),
    exec: async (file, args, options) => {
      calls.push({ file, args, cwd: options.cwd, env: options.env });
      return { code: 0, stdout: file === "git" && args[0] === "rev-parse" ? "/repo/.git\n" : file === "git" && args[0] === "show" ? HEAD_FILES[args[1]!.slice(5)] ?? "" : file === "node" ? stdout : "", stderr: "", ms: 0 };
    },
  });
  assert.equal((await skillPaths.run(run("[]"))).status, "pass");
  const node = calls.find(call => call.file === "node")!;
  const archive = calls.find(call => call.file === "git" && call.args[0] === "archive")!;
  assert.ok(archive.args.includes("HEAD") && archive.cwd === "/repo");
  for (const file of ["scripts/ci/check-skill-paths.mjs", "scripts/ci/gh-annotate.mjs", "scripts/lib/paths.mjs"]) assert.ok(archive.args.includes(file), `archive lacks ${file}`);
  assert.ok(!archive.args.includes("node:fs"));
  assert.deepEqual(node.env, { GIT_DIR: "/repo/.git", GIT_WORK_TREE: node.cwd });
  assert.ok(node.cwd!.startsWith("/tmp/skill-paths-head-"));
  assert.deepEqual(calls.at(-1)!.args, ["-rf", node.cwd, `${node.cwd}.tar`]);
  const dead = await skillPaths.run(run('[{"file":"a/SKILL.md","line":1,"ref":"apps/x.ts"}]'));
  assert.ok(dead.status === "fail" && dead.detail.includes("apps/x.ts"), JSON.stringify(dead));
});

const macChecks = CHECKS.filter(check => ["aside_tabs", "aside_account"].includes(check.id));
const tailscale = (online: boolean) => JSON.stringify({ Peer: { "nodekey:1": { DNSName: "main-dev-sieuns-macbook-pro-m2max.tail0c093d.ts.net.", TailscaleIPs: ["100.66.173.18"], Online: online, LastSeen: "2026-10-18T11:10:00Z" } } });
const macDeps = (online: boolean, account: ExecResult, calls: string[]): Deps => ({
  ...deps("linux"),
  now: () => Date.parse("2026-10-18T13:24:00Z"),
  readFile: async () => JSON.stringify({ mcpServers: { aside: { command: "aside", args: ["mcp"] }} }),
  mcp: async command => { calls.push(`mcp ${command}`); return { tools: [], error: "the server exited with code 255 before answering" }; },
  exec: async (file, args) => {
    calls.push(`${file} ${args.join(" ")}`);
    if (file === "ssh" && args[0] === "-G") return { code: 0, stdout: "user sieunpark\nhostname 100.66.173.18\nport 22\n", stderr: "", ms: 0 };
    if (file === "tailscale") return { code: 0, stdout: tailscale(online), stderr: "", ms: 0 };
    return account;
  },
});
const TIMED_OUT = { code: 124, stdout: "", stderr: "", ms: 10_002 };

test("an offline Mac turns aside_tabs and aside_account off, with no owner fix and one Tailscale probe", async () => {
  const calls: string[] = [];
  const results = await runChecks(macDeps(false, TIMED_OUT, calls), macChecks);
  for (const { check, outcome } of results) {
    assert.equal(outcome.status, "off", `${check.id} ${JSON.stringify(outcome)}`);
    assert.ok(outcome.detail.includes("MacBook Pro is offline (Tailscale last seen 2h ago)"), outcome.detail);
  }
  assert.deepEqual(toOutput(results, 0).metrics, { checks_failed: 0, owner_fixes: 0, cua_failed: 0, websearch_failed: 0, checks_run: 2 });
  assert.deepEqual(calls, ["ssh -G mac", "tailscale status --json"]);
});

test("aside_account on an online Mac keeps a signed-out reply as the owner's fix", async () => {
  const signedOut = { code: 0, stdout: "  u0 sieunpark77@gmail.com signed out\n", stderr: "", ms: 0 };
  const outcome = await CHECKS.find(check => check.id === "aside_account")!.run(macDeps(true, signedOut, []));
  assert.ok(outcome.status === "fail" && outcome.fixer === "owner" && outcome.fix.includes("sign in"), JSON.stringify(outcome));
});

test("aside_account on an online Mac calls a timeout a reach problem, not a sign-in", async () => {
  const outcome = await CHECKS.find(check => check.id === "aside_account")!.run(macDeps(true, TIMED_OUT, []));
  assert.ok(outcome.status === "fail" && outcome.fixer === "agent" && outcome.fix.includes("check ssh to that Mac") && !outcome.fix.includes("sign in"), JSON.stringify(outcome));
});

test("dailyRun drops a flagged check that CHECKS no longer has", async () => {
  const dir = await mkdtemp(join(tmpdir(), "daily-run-"));
  const detail = join(dir, "out.json");
  await writeFile(detail, JSON.stringify({ flagged: [{ kind: "off", item: "aside_tabs", excerpt: "Mac asleep" }, { kind: "off", item: "paper_mcp", excerpt: "Paper closed" }] }));
  const duty = { id: "d5", name: "Skills and tools", precheck: { command: ["node", "scripts/duties/skills-and-tools.ts"] } } as unknown as Duty;
  const record = { duty: "d5", at: 1, detail, verdict: "met", metrics: {}, summary: "" } as unknown as DutyRunRecord;
  const store = { dir, chats: async () => ["c1"], list: async () => [duty], runs: async () => [record] } as unknown as DutyStore;
  const run = await dailyRun(store);
  assert.deepEqual(run?.problems.map(problem => problem.id), ["aside_tabs"]);
  await rm(dir, { recursive: true, force: true });
});
