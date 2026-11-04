import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The Mac heavy check note (packages/sieun-rules/src/heavy-check.ts), global rule 6. On 11-04 at 16:20:55 KST the job 'onboarding paywall
// back' ran `pnpm check` in auto-sns-agent apps/search through its kernel's bash() on the owner's Mac, and its tsgo tree grew from 0.1 to
// 7.52 GB in a minute while swap went from 11.5 to 13.3 GB. These commands are only fed to the handlers; nothing here runs them.
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-heavy-")));
const saved = { log: process.env.GLOBAL_RULES_LOG, platform: process.env.GLOBAL_RULES_PLATFORM };
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
const guard = await import("../packages/sieun-rules/src/guard.ts");
const sendCheck = await import("../packages/sieun-rules/src/send-check.ts");
test.after(() => {
  for (const [key, name] of [["log", "GLOBAL_RULES_LOG"], ["platform", "GLOBAL_RULES_PLATFORM"]]) {
    if (saved[key] === undefined) delete process.env[name];
    else process.env[name] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

// A checkout shaped like auto-sns-agent: its commit.mjs, the kit-check.mjs every app's check runs, and apps/search's check and test scripts.
const asa = join(root, "auto-sns-agent");
const search = join(asa, "apps", "search");
for (const dir of [join(asa, ".git"), join(asa, "scripts/repo/agent"), join(asa, "packages/config"), search]) mkdirSync(dir, { recursive: true });
writeFileSync(join(asa, "scripts/repo/agent/commit.mjs"), "");
writeFileSync(join(asa, "packages/config/kit-check.mjs"), "import { spawnSync } from 'node:child_process';\nspawnSync('svelte-check', process.argv.slice(2));\n");
writeFileSync(join(search, "package.json"), JSON.stringify({ scripts: {
  check: "pnpm i18n:compile && NODE_OPTIONS=--max-old-space-size=8192 node ../../packages/config/kit-check.mjs --tsconfig ./tsconfig.json --tsgo --incremental",
  "i18n:compile": "paraglide-js compile",
  test: "pnpm i18n:compile && vitest run",
} }));
// A checkout shaped like sieun-pi.
const pi = join(root, "sieun-pi");
for (const dir of [join(pi, ".git"), join(pi, "packages/sieun-rules"), join(pi, "apps/chat")]) mkdirSync(dir, { recursive: true });

const event = (toolName, text, id = "t") => ({ type: "tool_call", toolCallId: id, toolName, input: toolName === "bash" ? { command: text } : { code: text } });
const kernel = (text, cwd) => sendCheck.judgeKernelCheck({ kind: "shell", text, cwd });

test("on the Mac, the 11-04 `pnpm check` in apps/search runs from the kernel with a note that names its cost and the CI path", async () => {
  process.env.GLOBAL_RULES_PLATFORM = "darwin";
  const result = await kernel("pnpm check", search);
  assert.equal(result.block, false);
  assert.match(result.warning, /Mac heavy check: `pnpm check` runs here on the owner's Mac/);
  assert.match(result.warning, /kit-check\.mjs runs a whole-app type check/);
  assert.match(result.warning, /7\.52 GB/);
  assert.match(result.warning, /commit\.mjs --probe <files>/);
  for (const [text, cwd] of [
    [`cd ${search} && pnpm check`, root],
    ["pnpm -C apps/search check", asa],
    ["pnpm --filter search check", asa],
    ["pnpm test", search],
    ["npx vitest run", search],
    ["npx svelte-check --tsconfig ./tsconfig.json", search],
    ["npx tsc --noEmit -p convex/tsconfig.tests.json", asa],
    ["pnpm exec tsgo --noEmit", search],
    ["npx turbo run check --filter=search", asa],
    ["bash -lc 'cd apps/search && pnpm check'", asa],
  ]) {
    const r = await kernel(text, cwd);
    assert.equal(r.block, false, text);
    assert.match(r.warning ?? "", /Mac heavy check/, text);
  }
});

test("on the Mac, checks of named files and version reads run with no note", async () => {
  process.env.GLOBAL_RULES_PLATFORM = "darwin";
  for (const [text, cwd] of [
    ["node_modules/.bin/vitest run tests/unit/a.test.ts", search],
    ["npx tsc --noEmit src/a.ts", asa],
    ["npx tsc --version", asa],
    ["pnpm i18n:compile", search],
    ["git status", asa],
  ]) assert.deepEqual(await kernel(text, cwd), { block: false }, text);
});

test("a bash tool call runs and its result carries the note; an ipython cell is left to the kernel half", () => {
  process.env.GLOBAL_RULES_PLATFORM = "darwin";
  assert.equal(guard.onToolCall(event("bash", `cd ${search} && pnpm check`, "c1"), { cwd: root }), undefined);
  const out = guard.onToolResult({ toolCallId: "c1", content: [{ type: "text", text: "svelte-check found 0 errors" }] });
  assert.equal(out.content[0].text, "svelte-check found 0 errors");
  assert.match(out.content[1].text, /Mac heavy check/);
  assert.equal(guard.onToolResult({ toolCallId: "c1", content: [] }), undefined);
  assert.equal(guard.onToolCall(event("ipython", `r = await bash("cd ${search} && pnpm check")`, "c2"), { cwd: root }), undefined);
  assert.equal(guard.onToolResult({ toolCallId: "c2", content: [] }), undefined);
});

test("in sieun-pi the note names the box command in us-metal02's checkout", async () => {
  process.env.GLOBAL_RULES_PLATFORM = "darwin";
  const r = await kernel("npx svelte-check", join(pi, "apps/chat"));
  assert.match(r.warning, /ssh us-metal02 'cd ~\/src\/sieun-pi\/apps\/chat && git log -1 --format=%h && heavy 8G -- npx svelte-check'/);
});

test("on us-metal02 and in CI the same commands run with no note", async () => {
  process.env.GLOBAL_RULES_PLATFORM = "linux";
  assert.deepEqual(await kernel("pnpm check", search), { block: false });
  assert.equal(guard.onToolCall(event("bash", `cd ${search} && pnpm check`, "c3"), { cwd: root }), undefined);
  assert.equal(guard.onToolResult({ toolCallId: "c3", content: [] }), undefined);
});
