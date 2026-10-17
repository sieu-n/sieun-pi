import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { parseDutyInput } from "../src/shared/chat-duties.ts";
import { CHECKS, type Deps, type Entry, type ExecResult, frontmatter, type McpResult, realMcp, releaseVersion, runChecks, searchPath, toOutput, withHarness } from "../scripts/duties/skills-and-tools.ts";

const NOW = Date.parse("2026-10-10T05:00:00Z");
const HOME = "/h";
const REPO = "/repo";
const RELEASE = `${HOME}/.local/share/prime-agent/releases/0.9.8-darwin-arm64-abc`;
const ok = (stdout: string, code = 0, stderr = ""): ExecResult => ({ code, stdout, stderr, ms: 5 });
const row = (email: string, extra: Record<string, unknown> = {}) => ({ email, usable: false, reason: "limited 3h", disabled: false, limited_until: NOW / 1000 + 3600, cooldown_until: null, windows: [], ...extra });

/** argv patterns (basename of the program, then its args) and the answer each gives when every check passes. */
const PASSING: [RegExp, ExecResult][] = [
  [/^cua-driver permissions/, ok(JSON.stringify({ accessibility: true, screen_recording: true }))],
  [/^cua-driver check-update/, ok(JSON.stringify({ update_available: false, error: null, current_version: "0.34.1", latest_version: "0.34.1" }))],
  [/^cua-driver status$/, ok("Cua Driver daemon is running\n  pid: 9\n")],
  [/^cua-driver update --apply/, ok("Installed cua-driver 0.34.2.\n")],
  [/^cua-driver stop/, ok("")],
  [/^cua-driver --version/, ok("cua-driver 0.34.2\n")],
  [/^open -n -g -a CuaDriver --args serve/, ok("")],
  [/^python -c import websearch/, ok("/src/websearch/src/websearch/__init__.py\n")],
  [/^python -c import asyncio/, ok("Result 1: Prime Intellect\nURL: https://www.primeintellect.ai/\ncost: 0.003 balance left: 9\n")],
  [/^aside account status/, ok("* u0  owner@example.com  signed in  profiles: Profile 0\n")],
  [/^prime-agent status --json/, ok(JSON.stringify([{ isDefault: true, status: "current", version: "0.9.8", pid: 7 }]))],
  [/^prime-agent --offline model list/, ok("provider  model  context\nanthropic  claude-opus-5-5  1M\nopenai-codex  gpt-6-astra  400K\n")],
  [/^edit --path /, ok("Edited the file\n")],
  [/^python -c from attach_image/, ok("image/png 73 (4, 4)\n")],
  [/^pi-pool ls --json --provider openai-codex/, ok(JSON.stringify({ rows: [row("codex@example.com", { usable: true, reason: null })] }))],
  [/^pi-pool ls --json$/, ok(JSON.stringify({ rows: [row("claude8@example.com", { usable: true, reason: null }), row("claude9@example.com")] }))],
  [/^claude auth status/, ok(JSON.stringify({ loggedIn: true, email: "owner@example.com", subscriptionType: "max" }))],
  [/^uv run --script/, ok("usage: claude-sdk-session.py [-h]\n")],
  [/^codex login status/, ok("", 0, "Logged in using ChatGPT\n")],
  [/^gh auth status/, ok("github.com\n  ✓ Logged in to github.com account owner (keyring)\n")],
  [/^vercel whoami/, ok("owner\n")],
  [/^railway whoami/, ok("Logged in as Owner\n")],
  [/^convex login status/, ok("Status: Logged in\n", 0, "ExperimentalWarning\n")],
  [/^ssh /, ok("")],
  [/^dotenvx get -f/, ok(JSON.stringify({ A: "plain", B: "1" }))],
  [/^node scripts\/skills\/read-skill\.mjs apps\/llm-wiki/, ok("---\nname: llm-wiki\ndescription: x\n---\n")],
  [/^bash scripts\/skills\/sync-claude-skills\.sh --check/, ok("ok: Claude Code native skills are in sync\n")],
  [/^git ls-tree -r/, ok(".agents/skills/apps/llm-wiki/SKILL.md\n.agents/skills/apps/llm-wiki/references/writing.md\n.agents/skills/workflows/common/claude-in-codex/SKILL.md\n.claude/skills-native/codex-in-claude/SKILL.md\n")],
  [/^git ls-tree --name-only HEAD -- \.claude\/skills\//, ok(".claude/skills/README.md\n.claude/skills/apps-llm-wiki\n.claude/skills/codex-in-claude\n")],
  [/^node scripts\/ci\/check-skill-paths\.mjs --json/, ok("[]\n")],
];

const SETTINGS = { mcpServers: {
  aside: { command: "/h/.local/bin/aside", args: ["mcp"] },
  "cua-driver": { command: "/h/.local/bin/cua-driver", args: ["mcp"], disabledTools: ["kill_app"] },
  paper: { command: "/h/.paper/bin/paper", args: ["mcp"] } }, skills: ["-edit", `-${HOME}/.prime/agent/skills/websearch`] };
const SKILL = (name: string) => `---\nname: ${name}\ndescription: >-\n  Use when ${name} is needed.\n---\n# ${name}\n`;
const dir = (...names: string[]): Entry[] => names.map(name => ({ name, kind: "dir" }));
const file = (...names: string[]): Entry[] => names.map(name => ({ name, kind: "file" }));

interface Fake { exec?: [RegExp, ExecResult | Error][]; mcp?: Record<string, McpResult>; files?: Record<string, string>; folders?: Record<string, Entry[]>; resolve?: (id: string) => void }

function fakeDeps(fake: Fake = {}): Deps & { calls: string[] } {
  const calls: string[] = [];
  const files: Record<string, string> = {
    [`${HOME}/.prime/agent/settings.json`]: JSON.stringify(SETTINGS),
    [`${HOME}/.prime/agent/pstack-models.json`]: JSON.stringify({ roles: { feature: [{ model: "anthropic/claude-opus-5-5", thinking: "high" }], judge: "openai-codex/gpt-6-astra" },
      policy: { allowed: ["inherit-parent", "anthropic/claude-opus-5-5"] } }),
    [`${HOME}/.prime/agent/skills/websearch/SKILL.md`]: SKILL("websearch"),
    [`${RELEASE}/skills/edit/SKILL.md`]: SKILL("edit"),
    [`${REPO}/.agents/skills/repo/skill-creation/references/skill-map.md`]: "| Skill | Use |\n| `apps/llm-wiki` | x |\n| `workflows/common/claude-in-codex` | y |\n| `codex-in-claude` | z |\n",
    [`${REPO}/.agents/skills/apps/llm-wiki/SKILL.md`]: SKILL("llm-wiki"),
    [`${REPO}/.claude/skills-native/codex-in-claude/SKILL.md`]: SKILL("codex-in-claude"),
    ...fake.files,
  };
  const folders: Record<string, Entry[]> = {
    [`${HOME}/.prime/agent/skills`]: dir("websearch", "skills"),
    [`${RELEASE}/skills`]: [...dir("edit"), ...file(".gitignore")],
    [REPO]: file(".env", ".env.keys", ".env.example", "package.json"),
    [`${REPO}/apps`]: dir("search"),
    [`${REPO}/apps/search`]: file(".env.local", ".env.local.example"),
    [`${REPO}/.agents/skills`]: dir("apps", "workflows"),
    [`${REPO}/.agents/skills/apps`]: dir("llm-wiki"),
    [`${REPO}/.agents/skills/apps/llm-wiki`]: [...file("SKILL.md"), ...dir("references")],
    [`${REPO}/.agents/skills/apps/llm-wiki/references`]: file("writing.md"),
    [`${REPO}/.agents/skills/workflows`]: dir("common"),
    [`${REPO}/.agents/skills/workflows/common`]: dir("claude-in-codex"),
    [`${REPO}/.agents/skills/workflows/common/claude-in-codex`]: file("SKILL.md"),
    [`${REPO}/.claude/skills-native`]: dir("codex-in-claude"),
    [`${REPO}/.claude/skills`]: [...file("README.md"), ...dir("apps-llm-wiki", "codex-in-claude")],
    ...fake.folders,
  };
  const mcp: Record<string, McpResult> = {
    "cua-driver": { serverName: "cua-driver", tools: ["health_report", "kill_app"], result: { structuredContent: { overall: "ok", checks: [{ name: "tcc_accessibility", status: "pass" }, { name: "screen_capture_capability", status: "skip" }] } } },
    aside: { serverName: "aside", tools: ["repl"], result: { isError: false, content: [{ type: "text", text: "{\"count\":2}" }] } },
    paper: { serverName: "paper-desktop", tools: ["list_resources"], result: { content: [{ type: "text", text: "[]" }] } },
    ...fake.mcp,
  };
  return {
    calls,
    exec: async (program, args) => {
      const key = `${basename(program)} ${args.join(" ")}`;
      calls.push(key);
      const answer = [...(fake.exec ?? []), ...PASSING].find(([pattern]) => pattern.test(key))?.[1];
      if (!answer) throw new Error(`unexpected ${key}`);
      if (answer instanceof Error) throw answer;
      if (basename(program) === "edit") files[args[1]!] = files[args[1]!]!.replace(args[3]!, args[5]!);
      return answer;
    },
    mcp: async command => mcp[basename(command)] ?? { tools: [], error: "spawn ENOENT" },
    readFile: async path => { if (path in files) return files[path]!; throw new Error(`ENOENT ${path}`); },
    writeFile: async (path, text) => { files[path] = typeof text === "string" ? text : "<bytes>"; },
    rm: async path => { delete files[path]; },
    exists: async path => path in files || path in folders || Object.entries(folders).some(([parent, entries]) => entries.some(entry => join(parent, entry.name) === path && entry.kind !== "missing")),
    realpath: async path => path.endsWith("prime-agent/bin/prime-agent") ? `${RELEASE}/prime-agent` : path.endsWith(".prime/agent/skills/websearch") ? "/src/websearch" : path,
    list: async path => folders[path] ?? [],
    loadResolver: async () => async (_repo, id) => { fake.resolve?.(id); },
    home: HOME, repo: REPO, scratchDir: "/scratch", now: () => NOW, sleep: async () => {},
  };
}

async function run(fake: Fake = {}) {
  const deps = fakeDeps(fake);
  const results = await runChecks(deps);
  return { deps, results, output: toOutput(results, NOW), outcome: (id: string) => results.find(result => result.check.id === id)!.outcome };
}
const kindOf = (output: ReturnType<typeof toOutput>, id: string) => output.flagged?.find(item => item.item === id)?.kind;

test("skills and tools: ids are unique, every group is used, and the duty file has one headline and at most 3 more metrics, all written by the precheck", async () => {
  assert.equal(new Set(CHECKS.map(check => check.id)).size, CHECKS.length);
  assert.deepEqual([...new Set(CHECKS.map(check => check.group))].sort(),
    ["accounts", "browser", "computer use", "mcp", "peers", "prime skills", "repo skills", "service clis", "web search"]);
  const duty = parseDutyInput(JSON.parse(await readFile(join(import.meta.dirname, "..", "scripts", "duties", "skills-and-tools.duty.json"), "utf8")), "d", NOW);
  assert.equal(duty.name, "Skills and tools");
  assert.deepEqual(duty.schedule, { kind: "daily", at: "04:30" });
  const { output } = await run();
  assert.deepEqual(duty.metrics.filter(metric => metric.headline).map(metric => metric.key), ["skills_or_tools_to_fix"]);
  assert.ok(duty.metrics.length <= 4);
  assert.deepEqual(duty.precheck.command.slice(-2), ["scripts/duties/skills-and-tools.ts", "--with-harness"]);
  const harness = { metrics: { skills_to_prune: 2, cache_read_ratio_1h: 95, cache_read_ratio_24h: 96 }, flagged: [{ kind: "prune", item: "old-skill", excerpt: "unread 14 days" }] };
  const merged = withHarness(output, harness);
  for (const metric of duty.metrics) assert.ok(metric.key in merged.metrics, metric.key);
  assert.equal(merged.metrics.skills_or_tools_to_fix, 2, "every tool check passes, and the 2 skills to prune count");
  assert.equal(merged.flagged?.at(-1)?.item, "old-skill");
  const broken = withHarness(output, new Error("exit 1: no wiki.db"));
  assert.equal(broken.metrics.skills_or_tools_to_fix, 1, "a harness check that did not run is not green");
});

test("skills and tools: with every tool answering its pass text, all 30 checks pass", async () => {
  const { output, results, deps } = await run();
  assert.deepEqual(results.filter(result => result.outcome.status !== "pass").map(result => [result.check.id, result.outcome]), []);
  assert.deepEqual(output.metrics, { checks_failed: 0, owner_fixes: 0, cua_failed: 0, websearch_failed: 0, checks_run: 30 });
  assert.deepEqual(output.flagged?.map(item => item.kind), ["passed"]);
  assert.match(output.flagged![0]!.excerpt, /^cua_permissions \d+ms, cua_mcp \d+ms/);
  assert.deepEqual(deps.calls.filter(call => call.startsWith("dotenvx")).sort(), ["dotenvx get -f .env", "dotenvx get -f apps/search/.env.local"]);
});

test("skills and tools: websearch_kernel pins the skill source folders before it imports websearch, and a pin it cannot write fails", async () => {
  const order: string[] = [];
  const deps = fakeDeps();
  const exec = deps.exec;
  deps.exec = async (program, args, options) => { if (basename(program) === "python") order.push("import"); return exec(program, args, options); };
  deps.pinSkillPaths = async () => { order.push("pin"); return [{ file: "/site/sieun_pi_skills.pth", written: true, paths: ["/src/websearch/src", "/src/board/src"] }]; };
  const check = CHECKS.find(item => item.id === "websearch_kernel")!;
  const outcome = await check.run(deps);
  assert.deepEqual(order, ["pin", "import"]);
  assert.deepEqual(outcome, { status: "pass", detail: "kernel loads /src/websearch/src/websearch/__init__.py; sieun_pi_skills.pth pins 2 skill source folders (written now)" });
  deps.pinSkillPaths = async () => { throw new Error("EACCES: permission denied"); };
  const failed = await check.run(deps);
  assert.equal(failed.status, "fail");
  assert.match(failed.status === "fail" ? failed.detail : "", /could not write sieun_pi_skills\.pth: EACCES/);
});

const cases: { name: string; fake: Fake; id: string; kind: string; metrics?: Record<string, number>; excerpt?: RegExp }[] = [
  { name: "cua grants false", id: "cua_permissions", kind: "fail_owner", metrics: { cua_failed: 1, owner_fixes: 1 },
    fake: { exec: [[/^cua-driver permissions/, ok(JSON.stringify({ accessibility: false, screen_recording: true }))]] } },
  { name: "cua daemon down", id: "cua_permissions", kind: "fail_agent", metrics: { cua_failed: 1 }, fake: { exec: [[/^cua-driver permissions/, ok("", 1, "daemon not running")]] } },
  { name: "cua tcc check failing over MCP", id: "cua_mcp", kind: "fail_owner", excerpt: /tcc_screen_recording fail/,
    fake: { mcp: { "cua-driver": { tools: ["health_report", "kill_app"], result: { structuredContent: { overall: "fail", checks: [{ name: "tcc_screen_recording", status: "fail", message: "not granted" }] } } } } } },
  { name: "a stale disabledTools name", id: "cua_mcp", kind: "fail_agent", excerpt: /kill_app/,
    fake: { mcp: { "cua-driver": { tools: ["health_report"], result: { structuredContent: { overall: "ok", checks: [] } } } } } },
  { name: "cua update that does not install", id: "cua_version", kind: "fail_agent", metrics: { cua_failed: 1 }, excerpt: /update --apply from 0\.34\.1 to 0\.34\.2: exit 1: curl failed/,
    fake: { exec: [[/^cua-driver check-update/, ok(JSON.stringify({ update_available: true, error: null, current_version: "0.34.1", latest_version: "0.34.2" }))],
      [/^cua-driver update --apply/, ok("", 1, "curl failed")]] } },
  { name: "websearch kernel path under releases", id: "websearch_kernel", kind: "fail_agent", metrics: { websearch_failed: 1 }, excerpt: /prime-agent-skill-websearch/,
    fake: { exec: [[/^python -c import websearch/, ok(`${RELEASE}/skills/websearch/src/websearch/__init__.py\n`)]] } },
  { name: "Virev degraded NOTE", id: "websearch_query", kind: "fail_agent", metrics: { websearch_failed: 1 }, excerpt: /DuckDuckGo fallback/,
    fake: { exec: [[/^python -c import asyncio/, ok("NOTE: google is unavailable on the Virev search backend right now\nResult 1: Prime Intellect\n")]] } },
  { name: "Virev 402", id: "websearch_query", kind: "fail_owner", metrics: { websearch_failed: 1, owner_fixes: 1 },
    fake: { exec: [[/^python -c import asyncio/, ok("Virev API balance is empty (402): top up\n")]] } },
  { name: "Aside CLI missing", id: "aside_tabs", kind: "fail_owner", fake: { mcp: { aside: { tools: [], error: "spawn /h/.local/bin/aside ENOENT" } } } },
  { name: "pi-pool needs-reauth row", id: "pool_claude", kind: "fail_agent", excerpt: /claude1@example\.com need a new sign-in/,
    fake: { exec: [[/^pi-pool ls --json$/, ok(JSON.stringify({ rows: [row("claude1@example.com", { reason: "needs-reauth" }), row("claude8@example.com", { usable: true, reason: null })] }))]] } },
  { name: "no usable codex account and no reset within a day", id: "pool_codex", kind: "fail_agent", excerpt: /none resets within 24 h/,
    fake: { exec: [[/^pi-pool ls --json --provider openai-codex/, ok(JSON.stringify({ rows: [row("c@example.com", { limited_until: NOW / 1000 + 3 * 86_400 })] }))]] } },
  { name: "skill folder whose name mismatches", id: "skill_files", kind: "fail_agent", excerpt: /frontmatter name "web-search" is not the folder name/,
    fake: { files: { [`${HOME}/.prime/agent/skills/websearch/SKILL.md`]: SKILL("web-search") } } },
  { name: "a settings skills entry that loads nothing", id: "skill_files", kind: "fail_agent", excerpt: /load nothing: \+\/h\/gone, ~\/gone-too/,
    fake: { files: { [`${HOME}/.prime/agent/settings.json`]: JSON.stringify({ ...SETTINGS, skills: ["+/h/gone", "~/gone-too", "-/h/gone-off", "!old-*"] }) } } },
  { name: "a model the Mac cannot reach", id: "model_policy", kind: "fail_agent", excerpt: /openai-codex\/gpt-6-astra/,
    fake: { exec: [[/^prime-agent --offline model list/, ok("provider model\nanthropic claude-opus-5-5 1M\n")]] } },
  { name: "ssh key refused", id: "ssh_metal", kind: "fail_owner", fake: { exec: [[/^ssh /, ok("", 255, "root@203.0.113.10: Permission denied (publickey).")]] } },
  { name: "a skill read that fails", id: "skill_reader", kind: "fail_agent", excerpt: /Cannot find module/,
    fake: { exec: [[/^node scripts\/skills\/read-skill/, ok("", 1, "Error: Cannot find module 'yaml'")]] } },
  { name: "an id that does not resolve", id: "skill_ids", kind: "fail_agent", excerpt: /codex-in-claude \(Skill not found\)/,
    fake: { resolve: id => { if (id === "codex-in-claude") throw new Error("Skill not found"); } } },
  { name: "a link missing from HEAD", id: "claude_links_committed", kind: "fail_agent", excerpt: /links missing from HEAD: apps-llm-wiki/,
    fake: { exec: [[/^git ls-tree --name-only HEAD -- \.claude\/skills\//, ok(".claude/skills/codex-in-claude\n")]] } },
  { name: "a skill the map lacks", id: "skill_map", kind: "fail_agent", excerpt: /map lacks workflows\/specs/,
    fake: { folders: { [`${REPO}/.agents/skills/workflows`]: dir("common", "specs"), [`${REPO}/.agents/skills/workflows/specs`]: file("SKILL.md") } } },
  { name: "a dead skill path", id: "skill_paths", kind: "fail_agent", fake: { exec: [[/^node scripts\/ci\/check-skill-paths/, ok(JSON.stringify([{ skill: "x", path: "apps/gone" }]))]] } },
];
for (const { name, fake, id, kind, metrics, excerpt } of cases) test(`skills and tools: ${name} -> ${kind}`, async () => {
  const { output } = await run(fake);
  assert.equal(kindOf(output, id), kind);
  assert.equal(output.metrics.checks_failed, kind.startsWith("fail") ? 1 : 0);
  for (const [key, value] of Object.entries(metrics ?? {})) assert.equal(output.metrics[key], value, key);
  if (excerpt) assert.match(output.flagged!.find(item => item.item === id)!.excerpt, excerpt);
});

test("skills and tools: paper not running is off and not counted", async () => {
  const { output } = await run({ mcp: { paper: { tools: ["list_resources"], result: { isError: true, content: [{ text: "Paper Desktop isn't running. Tell the user to open it." }] } } } });
  assert.equal(kindOf(output, "paper_mcp"), "off");
  assert.equal(output.metrics.checks_failed, 0);
  assert.doesNotMatch(output.flagged!.find(item => item.kind === "passed")!.excerpt, /paper_mcp/);
});

test("skills and tools: a disabled needs-reauth row is off on purpose and passes", async () => {
  const { outcome } = await run({ exec: [[/^pi-pool ls --json$/, ok(JSON.stringify({ rows: [row("old@example.com", { reason: "needs-reauth", disabled: true }), row("claude8@example.com", { usable: true, reason: null })] }))]] });
  assert.equal(outcome("pool_claude").status, "pass");
});

test("skills and tools: a value still encrypted is an owner fix and the value never reaches the output", async () => {
  const secret = "encrypted:BDb7tOpSecretCipherText==";
  const { output } = await run({ exec: [[/^dotenvx get -f apps\/search/, ok(JSON.stringify({ CLERK_SECRET_KEY: secret, PLAIN: "x" }))]] });
  assert.equal(kindOf(output, "dotenvx_keys"), "fail_owner");
  assert.match(output.flagged!.find(item => item.item === "dotenvx_keys")!.excerpt, /apps\/search\/\.env\.local \(1\)/);
  assert.ok(!JSON.stringify(output).includes("BDb7tOpSecretCipherText"));
  assert.ok(!JSON.stringify(output).includes("CLERK_SECRET_KEY"));
});

test("skills and tools: a daemon list with one current entry and no default flag passes (a server env without TMPDIR)", async () => {
  const { outcome } = await run({ exec: [[/^prime-agent status --json/, ok(JSON.stringify([{ isDefault: false, status: "current", version: "0.9.8", pid: 7 }]))]] });
  assert.equal(outcome("prime_daemon").status, "pass");
});

test("skills and tools: a stale daemon passes only when prime-agent list shows it serving live sessions (prime-agent#1222)", async () => {
  const stale = [/^prime-agent status --json/, ok(JSON.stringify([{ isDefault: true, status: "stale", pid: 7 }]))] as [RegExp, ExecResult];
  const serving = await run({ exec: [stale, [/^prime-agent list --json/, ok(JSON.stringify({ sessions: [{ activeSessionId: "a1", isSessionActive: true }, { isSessionActive: false }] }))]] });
  assert.equal(serving.outcome("prime_daemon").status, "pass");
  const idle = await run({ exec: [stale, [/^prime-agent list --json/, ok(JSON.stringify({ sessions: [{ isSessionActive: false }] }))]] });
  assert.equal(idle.outcome("prime_daemon").status, "fail");
});

test("skills and tools: a check whose exec throws or times out fails for the agent and the other checks still run", async () => {
  const { output, outcome } = await run({ exec: [[/^gh auth status/, new Error("boom from exec")], [/^vercel whoami/, { code: 124, stdout: "", stderr: "", ms: 20_000 }]] });
  assert.deepEqual(outcome("gh_auth"), { status: "fail", fixer: "agent", detail: "boom from exec", fix: "find why the check itself broke" });
  assert.equal(kindOf(output, "vercel_auth"), "fail_agent");
  assert.match(output.flagged!.find(item => item.item === "vercel_auth")!.excerpt, /timed out after 20000 ms/);
  assert.equal(output.metrics.checks_failed, 2);
  assert.equal(output.metrics.checks_run, 30);
});

test("releaseVersion keeps a pre-release tag, so a daemon-fix build is not read as a stale daemon", () => {
  assert.equal(releaseVersion("0.9.8-darwin-arm64-078c9abd"), "0.9.8");
  assert.equal(releaseVersion("0.9.8-daemon-fix.1-darwin-arm64-b29bc85b.VQKrC7"), "0.9.8-daemon-fix.1");
  assert.equal(releaseVersion("0.9.8-daemon-fix.1-darwin-arm64-b29bc85b"), "0.9.8-daemon-fix.1");
});

test("frontmatter: plain, quoted and folded values", () => {
  assert.deepEqual(frontmatter('---\nname: a-b\ndescription: "Use it, when: x"\n---\nbody'), { name: "a-b", description: "Use it, when: x" });
  assert.deepEqual(frontmatter("---\nname: c\ndescription: >-\n  line one\n  line two\nmetadata:\n  icon: crown\n---\n"), { name: "c", description: "line one line two", metadata: "icon: crown" });
  assert.deepEqual(frontmatter("# no frontmatter"), {});
});

test("searchPath reaches claude through the tokenmaxxing wrapper before the bare binary", () => {
  const parts = searchPath("/h").split(":");
  assert.ok(parts.indexOf("/h/.config/tokenmaxxing/bin") < parts.indexOf("/h/.local/bin"));
  assert.ok(parts.includes(dirname(process.execPath)));
  assert.ok(!parts.some(part => part.includes("kernel-venv")));
});

const FAKE_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
require("node:fs").writeFileSync(process.argv[2], String(process.pid));
const silent = process.argv[3] === "silent";
rl.on("line", line => {
  const msg = JSON.parse(line);
  if (silent || msg.id === undefined) return;
  const result = msg.method === "initialize" ? { serverInfo: { name: "fake" }, protocolVersion: "2025-06-18", capabilities: {} }
    : msg.method === "tools/list" ? { tools: [{ name: "echo" }, { name: "ping" }] }
    : { isError: false, content: [{ type: "text", text: JSON.stringify(msg.params.arguments) }] };
  process.stderr.write("log line\\n");
  process.stdout.write("not json\\n" + JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});
rl.on("close", () => process.exit(0));
`;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("realMcp: initialize, tools/list and tools/call against a fake stdio server, and a silent server is killed at the timeout", async () => {
  const folder = await mkdtemp(join(tmpdir(), "skills-duty-mcp-"));
  try {
    const script = join(folder, "server.cjs");
    await writeFile(script, FAKE_SERVER);
    const mcp = realMcp(searchPath(process.env.HOME ?? "/"));
    const answer = await mcp(process.execPath, [script, join(folder, "pid1")], { name: "echo", arguments: { hello: "there" } }, 10_000);
    assert.equal(answer.error, undefined);
    assert.equal(answer.serverName, "fake");
    assert.deepEqual(answer.tools, ["echo", "ping"]);
    assert.deepEqual(answer.result, { isError: false, content: [{ type: "text", text: "{\"hello\":\"there\"}" }] });

    const started = Date.now();
    const silent = await mcp(process.execPath, [script, join(folder, "pid2"), "silent"], undefined, 1500);
    assert.match(silent.error ?? "", /no answer within 1500 ms/);
    assert.ok(Date.now() - started < 5000);
    const pid = Number(await readFile(join(folder, "pid2"), "utf8"));
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise(done => setTimeout(done, 100));
    assert.equal(alive(pid), false, "the silent server was killed");

    const missing = await mcp(join(folder, "no-such-server"), [], undefined, 2000);
    assert.match(missing.error ?? "", /ENOENT/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("skills and tools: a newer cua-driver is installed and its daemon restarted before the other computer use checks run", async () => {
  const { outcome, deps, output } = await run({ exec: [
    [/^cua-driver check-update/, ok(JSON.stringify({ update_available: true, error: null, current_version: "0.34.1", latest_version: "0.34.2" }))],
    [/^cua-driver update --apply/, ok("Installed cua-driver 0.34.2.\n")],
    [/^cua-driver status$/, ok("Cua Driver daemon is not running\n")],
    [/^open -n -g/, ok("")],
  ] });
  assert.equal(outcome("cua_version").status, "fail");
  assert.match(outcome("cua_version").detail, /daemon did not start within 15 s/);
  assert.ok(deps.calls.indexOf("cua-driver update --apply") < deps.calls.indexOf("cua-driver stop"));
  assert.equal(output.metrics.cua_failed, 1);

  const ordered = fakeDeps({ exec: [[/^cua-driver check-update/, ok(JSON.stringify({ update_available: true, error: null, current_version: "0.34.1", latest_version: "0.34.2" }))]] });
  const results = await runChecks(ordered);
  assert.deepEqual(results.map(result => result.check.id), CHECKS.map(check => check.id));
  assert.deepEqual(results.find(result => result.check.id === "cua_version")!.outcome, { status: "pass", detail: "updated 0.34.1 to 0.34.2 and restarted the daemon" });
  const last = (call: RegExp) => ordered.calls.findLastIndex(item => call.test(item));
  assert.ok(last(/^cua-driver --version/) < ordered.calls.indexOf("cua-driver permissions status --json"), ordered.calls.join("\n"));
});

test("skills and tools: a stopped cua daemon is started and the grants are read again", async () => {
  const deps = fakeDeps();
  let daemon = false;
  const exec = deps.exec;
  deps.exec = async (program, args, options) => {
    const key = `${basename(program)} ${args.join(" ")}`;
    if (key === "cua-driver permissions status --json") { deps.calls.push(key); return ok(JSON.stringify(daemon ? { accessibility: true, screen_recording: true } : { daemon_running: false, status: "unknown" })); }
    if (key === "cua-driver status") { deps.calls.push(key); return ok(daemon ? "Cua Driver daemon is running\n" : "Cua Driver daemon is not running\n"); }
    if (key.startsWith("open -n -g -a CuaDriver")) daemon = true;
    return exec(program, args, options);
  };
  const [result] = await runChecks(deps, CHECKS.filter(check => check.id === "cua_permissions"));
  assert.deepEqual(result!.outcome, { status: "pass", detail: "accessibility and screen recording granted (started the stopped daemon)" });

  const stuck = fakeDeps({ exec: [[/^cua-driver permissions/, ok(JSON.stringify({ daemon_running: false, status: "unknown" }))], [/^cua-driver status$/, ok("Cua Driver daemon is not running\n")]] });
  const [failed] = await runChecks(stuck, CHECKS.filter(check => check.id === "cua_permissions"));
  assert.equal(failed!.outcome.status, "fail");
  assert.match(failed!.outcome.detail, /did not start within 15 s/);
  assert.equal(stuck.calls.filter(call => call === "cua-driver status").length, 16);
});

test("skills and tools: off-switches for removed skills pass, and a skill read the wiki did not log still passes", async () => {
  const { outcome } = await run({
    files: { [`${HOME}/.prime/agent/settings.json`]: JSON.stringify({ ...SETTINGS, skills: [...SETTINGS.skills, "-/h/.prime/agent/skills/interrogate", "-/h/.prime/agent/skills/principle-gone"] }) },
    exec: [[/^node scripts\/skills\/read-skill/, ok("---\nname: llm-wiki\n", 0, "[read-skill] tracked view recorded offline in wiki.db (connect ECONNREFUSED)")]],
  });
  assert.deepEqual(outcome("skill_files"), { status: "pass", detail: "every skill folder and settings entry is valid (2 off-switches name skills that are gone)" });
  assert.equal(outcome("skill_reader").status, "pass");
  assert.match(outcome("skill_reader").detail, /the view waits in wiki\.db \(tracked view recorded offline/);
});
