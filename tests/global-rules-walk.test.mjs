import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The wiki walk guard (packages/sieun-rules/src/walk.ts), global AGENTS.md rule 6. On 11-04 two wiki jobs walked the whole wiki content
// root, about 100 GB with sessions/, for 56 and 24 min in one tool call each. HOME is a small fake tree; these commands are only fed to
// the handlers, and nothing here runs them.
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-walk-")));
const saved = { log: process.env.GLOBAL_RULES_LOG, home: process.env.HOME };
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
process.env.HOME = root;
for (const dir of [".pi/wiki/content/apps", ".pi/wiki/content/sessions", "src/sieun-pi/skills", ".config"]) mkdirSync(join(root, dir), { recursive: true });
const guard = await import("../packages/sieun-rules/src/guard.ts");
const kernelGuard = await import("../packages/sieun-rules/src/kernel-guard.ts");
const sendCheck = await import("../packages/sieun-rules/src/send-check.ts");
test.after(() => {
  for (const [key, name] of [["log", "GLOBAL_RULES_LOG"], ["home", "HOME"]]) {
    if (saved[key] === undefined) delete process.env[name];
    else process.env[name] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

const repo = join(root, "src", "sieun-pi");
const event = (toolName, text) => ({ type: "tool_call", toolCallId: "t", toolName, input: toolName === "bash" ? { command: text } : { code: text } });
const call = (toolName, text, cwd = repo) => guard.onToolCall(event(toolName, text), { cwd });
const cell = (command) => `r = await bash(${JSON.stringify(command)})\nprint(r.output)`;

const WHOLE = [
  "rg -l mermaid ~/.pi/wiki/content",
  "rg -l mermaid ~/.pi/wiki/content/",
  "rg -c mermaid ~/.pi/wiki/content/*",
  "rg --files ~/.pi/wiki",
  "rg -l -e mermaid -g '*.html' /home/x/../../" + root.slice(1) + "/.pi/wiki/content",
  "find ~/.pi/wiki/content -name '*.html' | xargs grep -l mermaid",
  "find ~/.pi/wiki/content -maxdepth 9 -name '*.html'",
  "grep -rl mermaid ~/.pi/wiki/content",
  "grep -R --include='*.html' mermaid $HOME/.pi/wiki/content",
  "C=~/.pi/wiki/content; rg -l mermaid \"$C\"",
  "find ~ -name auth.json -path '*codex*'",
  "find / -name auth.json",
  "rg -l codex ~",
  "bash -lc 'find ~ -name auth.json'",
  "timeout 600 rg -l x ~/.pi/wiki/content",
  "echo $(rg -l mermaid ~/.pi/wiki/content | wc -l)",
];

const SCOPED = [
  "rg -l mermaid ~/.pi/wiki/content/apps ~/.pi/wiki/content/domains ~/.pi/wiki/content/projects ~/.pi/wiki/content/experiments",
  "find ~/.pi/wiki/content/apps -name '*.html'",
  "grep -rl mermaid ~/.pi/wiki/content/sessions/2026/11/04",
  "find ~ -maxdepth 3 -name auth.json",
  "rg --max-depth 2 -l x ~",
  "find ~/.config -name auth.json",
  "rg -l x ~/src/sieun-pi",
  "rg -n 'find ~ -name' skills",
  "grep -rn TODO packages",
  "grep mermaid ~/.pi/wiki/content/index.html",
  "ls ~ | grep pi",
  "ls ~/.pi/wiki/content",
  "git grep -n mermaid",
  "echo 'never run find ~ -name x'",
];

test("today's walks of the wiki content root and other whole walks of it or of home are refused in bash and in an ipython cell", () => {
  for (const text of [...WHOLE.map((t) => ["bash", t]), ...WHOLE.map((t) => ["ipython", cell(t)])]) {
    const result = call(...text);
    assert.equal(result?.block, true, text.join(": "));
    assert.match(result.reason, /wiki walk guard/);
    assert.match(result.reason, /\/wiki\/api\/agent\/find/);
    assert.match(result.reason, /rg -l mermaid ~\/\.pi\/wiki\/content\/apps/);
  }
});

test("a find, rg or grep -r with no path walks the cwd, so it is refused in home and passes in a repo", () => {
  for (const text of ["rg -l codex", "find . -name auth.json", "grep -r codex", "find -name x"]) {
    assert.equal(call("bash", text, root)?.block, true, text);
    assert.equal(call("bash", text, join(root, ".pi", "wiki", "content"))?.block, true, text);
    assert.equal(call("bash", text, repo), undefined, text);
  }
  assert.equal(call("bash", "cat list.txt | rg codex", root), undefined);
});

test("a walk of one named subfolder, a shallow listing and other commands pass", () => {
  for (const text of SCOPED) {
    assert.equal(call("bash", text), undefined, text);
    assert.equal(call("ipython", cell(text)), undefined, text);
  }
});

test("the kernel's run-time shell check refuses a whole walk and passes a scoped one", async () => {
  const content = join(root, ".pi", "wiki", "content");
  const refused = await sendCheck.judgeKernelCheck({ kind: "shell", text: `rg -l mermaid ${content}`, cwd: repo });
  assert.equal(refused.block, true);
  assert.match(refused.reason, /wiki walk guard/);
  const passed = await sendCheck.judgeKernelCheck({ kind: "shell", text: `rg -l mermaid ${content}/apps`, cwd: repo });
  assert.equal(passed.block, false);
});

test("the kernel prelude loads kernel-walk.py", () => {
  assert.match(kernelGuard.PRELUDE_SOURCE, /kernel-walk\.py/);
  assert.match(kernelGuard.PRELUDE_SOURCE, /global_rules_kernel_walk/);
});
