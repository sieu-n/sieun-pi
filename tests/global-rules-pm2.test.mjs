import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The pm2 home guard (packages/sieun-rules/src/pm2.ts). These strings are only fed to the handler; nothing here runs them.
const root = mkdtempSync(join(tmpdir(), "global-rules-pm2-"));
const saved = process.env.GLOBAL_RULES_LOG;
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
const guard = await import("../packages/sieun-rules/src/guard.ts");
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

// On 11-03 a bare `npx pm2 jlist` in a kernel on us-metal02 started an empty God Daemon in ~/.pm2 that stayed up until a hand kill.
test("the extension sets an unset PM2_HOME to auto-sns-agent's dev home, so a bare pm2 command in a kernel reads the real apps", async () => {
  const { defaultPm2Home } = await import("../packages/sieun-rules/src/pm2.ts");
  const { mkdirSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const checkout = join(root, "auto-sns-agent");
  assert.equal(defaultPm2Home({}, checkout), undefined, "no dev home on this box, no default");
  mkdirSync(join(checkout, ".cache", "pm2-dev"), { recursive: true });
  assert.equal(defaultPm2Home({}, checkout), join(checkout, ".cache", "pm2-dev"));
  assert.equal(defaultPm2Home({ PM2_HOME: "/srv/other/.pm2" }, checkout), undefined, "a PM2_HOME the session set stays");
  const index = new URL("../packages/sieun-rules/src/index.ts", import.meta.url).href;
  const script = `const pi = { on() {}, registerMcpServer: undefined }; await (await import(${JSON.stringify(index)})).default(pi);
const { execFileSync } = await import("node:child_process");
process.stdout.write(execFileSync("python3", ["-c", "import os; print(os.environ.get('PM2_HOME'))"], { env: { ...process.env }, encoding: "utf8" }));`;
  const env = { ...process.env, GLOBAL_RULES_AUTO_SNS_AGENT: checkout, GLOBAL_RULES_LOG: join(root, "index.log") };
  delete env.PM2_HOME;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env, cwd: root });
  assert.equal(out.trim(), join(checkout, ".cache", "pm2-dev"));
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
