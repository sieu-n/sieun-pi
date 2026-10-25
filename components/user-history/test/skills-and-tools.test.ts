import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CALL_TIMEOUT_MS, CHECKS, type Deps, type ExecResult, runChecks, toOutput, withHarness } from "../scripts/duties/skills-and-tools.ts";
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

// 10-22 11:56 KST: the box parity run failed aside_tabs on the box alone after the owner closed his last Aside window at 01:08Z.
test("aside_tabs is off, with no fix, when the owner's Aside has no open window", async () => {
  const closed = "Aside Browser profile for account u0 (\"Profile 0\") is not connected to the daemon. Make sure that profile is running";
  for (const platform of ["linux", "darwin"] as const) {
    const outcome = await asideTabs.run({ ...deps(platform), exec: async () => ({ code: 0, stdout: "", stderr: "", ms: 0 }),
      mcp: async () => ({ tools: [], result: { isError: true, content: [{ text: closed }] } }) });
    assert.ok(outcome.status === "off" && outcome.detail.startsWith("the owner's Aside has no open window"), JSON.stringify(outcome));
  }
});

const modelPolicy = CHECKS.find(check => check.id === "model_policy")!;
const MODEL_LIST = "provider      model                       context  max-out  thinking  images\nanthropic     claude-fable-5              500K     128K     yes       yes\n";
const policyDeps = (answer: ExecResult, calls: { args: readonly string[]; timeoutMs: number }[]): Deps => ({
  ...deps("linux"),
  readFile: async () => JSON.stringify({ roles: { builder: { model: "anthropic/claude-fable-5" } }, policy: { allowed: ["inherit-parent"] } }),
  exec: async (_file, args, options) => { calls.push({ args, timeoutMs: options.timeoutMs }); return answer; },
});

test("model_policy lists models without loading extensions, which no provider comes from, and waits CALL_TIMEOUT_MS", async () => {
  const calls: { args: readonly string[]; timeoutMs: number }[] = [];
  const outcome = await modelPolicy.run(policyDeps({ code: 0, stdout: MODEL_LIST, stderr: "", ms: 0 }, calls));
  assert.equal(outcome.status, "pass", JSON.stringify(outcome));
  assert.deepEqual(calls, [{ args: ["--offline", "--no-extensions", "model", "list"], timeoutMs: CALL_TIMEOUT_MS }]);
});

test("a model list that hangs past CALL_TIMEOUT_MS still fails model_policy", async () => {
  const outcome = await modelPolicy.run(policyDeps({ code: 124, stdout: "", stderr: "", ms: CALL_TIMEOUT_MS }, []));
  assert.ok(outcome.status === "fail" && outcome.detail === `model list timed out after ${CALL_TIMEOUT_MS} ms`, JSON.stringify(outcome));
});

test("claude_skill_links waits CALL_TIMEOUT_MS for sync-claude-skills.sh and fails a run that hangs past it", async () => {
  const check = CHECKS.find(item => item.id === "claude_skill_links")!;
  const calls: { args: readonly string[]; timeoutMs: number }[] = [];
  const outcome = await check.run(policyDeps({ code: 124, stdout: "", stderr: "", ms: CALL_TIMEOUT_MS }, calls));
  assert.deepEqual(calls, [{ args: ["scripts/skills/sync-claude-skills.sh", "--check"], timeoutMs: CALL_TIMEOUT_MS }]);
  assert.ok(outcome.status === "fail" && outcome.detail.includes(`timed out after ${CALL_TIMEOUT_MS} ms`), JSON.stringify(outcome));
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

const STATUS_PAGE = (incidents: string) => `<script>$_TSR.router=($R=>$R[0]={entries:$R[1]=[],activeIncidents:$R[2]=[${incidents}],recentIncidents:$R[9]=[],maintenances:$R[10]=[]})</script>`;
const API_OUTAGE = '$R[3]={id:"9bc9a3c0",slug:"QH8L8B3E",title:"Dashboard and API unavailable, builds paused",status:"IDENTIFIED",createdAt:"2026-10-21T07:24:24.727677+00:00",resolvedAt:null,components:$R[4]=[$R[5]={id:"69b4",name:"Builds",groupName:"US West (California, USA)",impact:"MAJOR_OUTAGE"},$R[6]={id:"2f6f",name:"API \u2014 backboard.railway.com",groupName:"Railway",impact:"PARTIAL_OUTAGE"}],updates:$R[7]=[$R[8]={id:"0c86",status:"IDENTIFIED",message:"Builds remain paused and some API features are still unavailable.",createdAt:"2026-10-21T13:40:38.705388+00:00"}]}';

test("railway_auth reads a refused token as off while status.railway.com shows an open incident that names the API", async () => {
  const urls: string[] = [];
  const outcome = await railwayAuth.run({ ...railwayDeps("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), fetchText: async url => { urls.push(url); return STATUS_PAGE(API_OUTAGE); } });
  assert.deepEqual(urls, ["https://status.railway.com"]);
  assert.ok(outcome.status === "off" && outcome.detail.includes('"Dashboard and API unavailable, builds paused" (since 2026-10-21 07:24Z'), JSON.stringify(outcome));
});

test("railway_auth keeps the fail and its Fix line when status.railway.com shows no open incident", async () => {
  for (const page of [STATUS_PAGE(""), STATUS_PAGE(API_OUTAGE.replace("resolvedAt:null", 'resolvedAt:"2026-10-21T16:00:00+00:00"')), ""]) {
    const outcome = await railwayAuth.run({ ...railwayDeps("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), fetchText: async () => page });
    assert.ok(outcome.status === "fail" && outcome.fix.includes("railway.com/account/tokens"), JSON.stringify(outcome));
  }
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

test("skill_paths archives only the skill roots HEAD holds, so an emptied .claude/skills-native does not fail git archive", async () => {
  const archives: (readonly string[])[] = [];
  const outcome = await skillPaths.run({
    ...deps("linux"),
    exec: async (file, args) => {
      if (file === "git" && args[0] === "archive") archives.push(args);
      const stdout = file === "git" && args[0] === "rev-parse" ? "/repo/.git\n" : file === "git" && args[0] === "ls-tree" ? ".agents/skills\n.claude/rules\n" : file === "node" ? "[]" : "";
      return { code: 0, stdout, stderr: "", ms: 0 };
    },
  });
  assert.equal(outcome.status, "pass", JSON.stringify(outcome));
  assert.ok(archives[0]!.includes(".agents/skills") && archives[0]!.includes(".claude/rules"));
  assert.ok(!archives[0]!.includes(".claude/skills-native"));
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

const poolCodex = CHECKS.find(check => check.id === "pool_codex")!;
const poolDeps = (rows: object[]): Deps => ({ ...deps("linux"), exec: async () => ({ code: 0, stdout: JSON.stringify({ rows }), stderr: "", ms: 0 }) });

// 10-23: fhnyq29tw5's Codex sign-in went to Apple's password page, which no agent can pass.
test("pool_codex makes a Sign in with Apple account's new sign-in the owner's fix", async () => {
  const outcome = await poolCodex.run(poolDeps([{ email: "fhnyq29tw5@privaterelay.appleid.com", reason: "needs-reauth" }, { email: "a@gmail.com", usable: true }]));
  assert.ok(outcome.status === "fail" && outcome.fixer === "owner", JSON.stringify(outcome));
});

test("pool_codex keeps an email-code account's new sign-in the agent's fix", async () => {
  const outcome = await poolCodex.run(poolDeps([{ email: "fhnyq29tw5@privaterelay.appleid.com", reason: "needs-reauth" }, { email: "b@gmail.com", reason: "needs-reauth" }]));
  assert.ok(outcome.status === "fail" && outcome.fixer === "agent", JSON.stringify(outcome));
});

// 10-24 to 10-26: sieunpark77's Claude sign-in, which needs the owner's Aside and no password or 2FA from him, counted in owner_fixes for 28
// runs while his Mac was offline, so no todo could hold it and the dead account fell out of skills_or_tools_to_fix.
const poolClaude = CHECKS.find(check => check.id === "pool_claude")!;
const reauthRows = JSON.stringify({ rows: [{ email: "sieunpark77@gmail.com", reason: "needs-reauth" }, { email: "a@gmail.com", usable: true }] });
const poolMacDeps = (online: boolean): Deps => {
  const mac = macDeps(online, TIMED_OUT, []);
  return { ...mac, exec: async (file, args, options) => file === "pi-pool" ? { code: 0, stdout: reauthRows, stderr: "", ms: 0 } : mac.exec(file, args, options) };
};

test("pool_claude keeps a new sign-in the agent's fix while the Mac is offline, so owner_fixes leaves it out", async () => {
  const away = await poolClaude.run(poolMacDeps(false));
  assert.ok(away.status === "fail" && away.fixer === "agent" && away.detail.includes("MacBook Pro is offline") && away.fix.includes("pi-pool login"), JSON.stringify(away));
  const metrics = withHarness(toOutput([{ check: poolClaude, outcome: away, ms: 0 }], 0), { metrics: { skills_to_prune: 0 }, flagged: [] }).metrics;
  assert.equal(metrics.owner_fixes, 0);
  assert.equal(metrics.skills_or_tools_to_fix, 1);
  const back = await poolClaude.run(poolMacDeps(true));
  assert.ok(back.status === "fail" && back.fixer === "agent" && !back.detail.includes("offline") && back.fix.includes("Aside"), JSON.stringify(back));
});

// 10-24 05:13Z: sieunpark77's Claude refresh grant reached its fixed end, and nothing flagged it before it did.
test("pool_claude flags a live account whose refresh grant ends within GRANT_WARN_MS, and skips a disabled one", async () => {
  const now = Date.parse("2026-10-24T00:00:00Z");
  const ends: Record<string, number> = { a1: now + 10 * 3_600_000, a2: now + 5 * 86_400_000, a3: now + 3_600_000 };
  const rows = [{ id: "a1", email: "sieunpark77@gmail.com", usable: true }, { id: "a2", email: "claude4@slack.green", usable: true }, { id: "a3", email: "krenerd77@naver.com", disabled: true }];
  const mac = macDeps(true, TIMED_OUT, []);
  const outcome = await poolClaude.run({ ...mac, now: () => now,
    exec: async (file, args, options) => file === "pi-pool" ? { code: 0, stdout: JSON.stringify({ rows }), stderr: "", ms: 0 } : mac.exec(file, args, options),
    readFile: async path => {
      const id = path.match(/pi-pool\/accounts\/secrets\/pi-pool\.anthropic\.(\w+)$/)?.[1];
      if (!id) throw new Error(`unexpected read ${path}`);
      return JSON.stringify({ accessToken: "x", refreshTokenExpiresAt: ends[id] });
    } });
  assert.ok(outcome.status === "fail" && outcome.fixer === "agent" && outcome.detail.startsWith("sieunpark77@gmail.com (grant ends 10-24 10:00Z) need")
    && !outcome.detail.includes("claude4") && !outcome.detail.includes("krenerd77") && outcome.fix.includes("pi-pool login"), JSON.stringify(outcome));
});

// 10-24 00:13 KST: pool_codex waited on the owner's Apple sign-in, and the headline missed for 10 runs that no agent could move.
test("skills_or_tools_to_fix leaves out a fail only the owner can fix, which owner_fixes counts", () => {
  const check = (id: string) => CHECKS.find(entry => entry.id === id)!;
  const tools = toOutput([
    { check: check("pool_codex"), outcome: { status: "fail", fixer: "owner", detail: "needs Sign in with Apple", fix: "sign in" }, ms: 0 },
    { check: check("gh_auth"), outcome: { status: "pass", detail: "ok" }, ms: 0 },
  ], 0);
  const harness = { metrics: { skills_to_prune: 0 }, flagged: [] };
  assert.equal(withHarness(tools, harness).metrics.skills_or_tools_to_fix, 0);
  assert.equal(withHarness(tools, harness).metrics.owner_fixes, 1);
  assert.equal(withHarness(tools, new Error("boom")).metrics.skills_or_tools_to_fix, 1);
  const agent = toOutput([{ check: check("gh_auth"), outcome: { status: "fail", fixer: "agent", detail: "signed out", fix: "gh auth login" }, ms: 0 }], 0);
  assert.equal(withHarness(agent, { metrics: { skills_to_prune: 2 }, flagged: [] }).metrics.skills_or_tools_to_fix, 3);
});
