import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The pm2 home guard (components/global-rules/pm2.ts). These strings are only fed to the handler; nothing here runs them.
const root = mkdtempSync(join(tmpdir(), "global-rules-pm2-"));
const saved = process.env.GLOBAL_RULES_LOG;
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
const guard = await import("../components/global-rules/guard.ts");
test.after(() => {
  if (saved === undefined) delete process.env.GLOBAL_RULES_LOG;
  else process.env.GLOBAL_RULES_LOG = saved;
  rmSync(root, { recursive: true, force: true });
});

const event = (toolName, text) => ({ type: "tool_call", toolCallId: "t", toolName, input: toolName === "bash" ? { command: text } : { code: text } });
const call = (toolName, text) => guard.onToolCall(event(toolName, text), { cwd: root });

function refused(toolName, texts) {
  for (const text of texts) {
    const result = call(toolName, text);
    assert.equal(result?.block, true, `${toolName}: ${text}`);
    assert.match(result.reason, /pm2 guard/, `${toolName}: ${text}`);
    assert.match(result.reason, /relative PM2_HOME/);
    assert.match(result.reason, /\/Users\/sieunpark\/Documents\/Github\/auto-sns-agent\/\.cache\/pm2-dev/);
  }
}

function allowed(toolName, texts) {
  for (const text of texts) assert.equal(call(toolName, text), undefined, `${toolName}: ${text}`);
}

test("a pm2 command with a relative PM2_HOME is refused, the 10-22 and 10-26 forms included", () => {
  refused("bash", [
    "cd apps/virev-demo && PM2_HOME=.cache/pm2-dev node_modules/.bin/pm2 restart virev-demo",
    "PM2_HOME=.cache/pm2-dev pm2 jlist",
    "export PM2_HOME=.cache/pm2-dev; npx pm2 ls",
    "env PM2_HOME=.cache/pm2-dev pnpm exec pm2 logs search --lines 50",
    "ssh -o BatchMode=yes sieunpark@100.66.173.18 'cd ~/Documents/Github/auto-sns-agent/apps/virev-demo; PM2_HOME=.cache/pm2-dev ../../node_modules/.bin/pm2 restart virev-demo'",
    "bash -lc 'PM2_HOME=.cache/pm2-dev pm2 describe virev-demo'",
  ]);
  refused("ipython", [
    `r = await bash("for d in ~/.pm2 .cache/pm2-dev; do echo $d; PM2_HOME=$d npx -y pm2 jlist 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' ; done")`,
  ]);
});

test("an absolute, home-relative or computed PM2_HOME passes, and so does text that only names one", () => {
  allowed("bash", [
    "PM2_HOME=/Users/sieunpark/Documents/Github/auto-sns-agent/.cache/pm2-dev node_modules/.bin/pm2 restart virev-demo",
    "PM2_HOME=~/.pm2 pm2 kill",
    'PM2_HOME="$PWD/.cache/pm2-dev" pm2 jlist',
    'PM2_HOME="$(git rev-parse --show-toplevel)/.cache/pm2-dev" pm2 jlist',
    "pm2 jlist",
    "pnpm dev:status",
    "rg -n 'PM2_HOME=.cache/pm2-dev' .agents/skills",
    "git commit -m 'docs: PM2_HOME=.cache/pm2-dev is relative' -- README.md",
    "PM2_HOME=.cache/pm2-dev ls .cache/pm2-dev/logs",
  ]);
});
