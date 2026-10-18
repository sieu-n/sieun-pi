import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The kernel send guard (c37): every ipython cell gets the prelude that installs kernel-guard.py once per kernel.
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-kernel-guard-")));
const saved = { GLOBAL_RULES_LOG: process.env.GLOBAL_RULES_LOG, GLOBAL_RULES_GUARD: process.env.GLOBAL_RULES_GUARD };
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
const kernel = await import("../components/global-rules/kernel-guard.ts");
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const cell = (code) => {
  const event = { type: "tool_call", toolCallId: "t", toolName: "ipython", input: { code } };
  kernel.onToolCall(event);
  return event.input.code;
};

test("every ipython cell gets the one-line prelude once, and bash calls and GLOBAL_RULES_GUARD=off are left alone", () => {
  const code = cell("x = 1");
  assert.equal(code, `${kernel.PRELUDE}x = 1`);
  assert.equal(kernel.PRELUDE.split("\n").length, 2);
  assert.equal(cell(code), code);
  const bash = { type: "tool_call", toolCallId: "t", toolName: "bash", input: { command: "ls" } };
  kernel.onToolCall(bash);
  assert.equal(bash.input.command, "ls");
  process.env.GLOBAL_RULES_GUARD = "off";
  try {
    assert.equal(cell("x = 1"), "x = 1");
  } finally {
    delete process.env.GLOBAL_RULES_GUARD;
  }
});

test("the prelude installs the guard in a fresh Python once and puts python-child on PYTHONPATH", () => {
  const code = cell("import os, sys\nprint(sys.global_rules_send_guard, 'python-child' in os.environ['PYTHONPATH'])") + "\n" + cell("print('again')").slice(kernel.PRELUDE.length);
  const env = { ...process.env };
  delete env.PYTHONPATH;
  const out = execFileSync("python3", ["-c", code], { encoding: "utf8", env });
  assert.equal(out, "True True\nagain\n");
});

test("send-check.ts --serve answers each line in order with its id and exits after its idle time with no check", async () => {
  const { spawn } = await import("node:child_process");
  const check = join(import.meta.dirname, "..", "components", "global-rules", "send-check.ts");
  const judge = spawn(process.execPath, [check, "--serve", "1500"], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, GLOBAL_RULES_SEND_LOG: join(root, "sends.jsonl") } });
  let out = "";
  judge.stdout.on("data", (chunk) => { out += chunk; });
  const exited = new Promise((resolve) => judge.on("exit", (code) => resolve(code)));
  const ask = (id, text) => judge.stdin.write(`${JSON.stringify({ id, cwd: root, check: { kind: "shell", text, cwd: root, approval: "" } })}\n`);
  ask(1, "curl -X POST https://api.resend.com/emails -d x");
  ask(2, "git ls-files deploy.sh");
  ask(3, "not json");
  judge.stdin.write("{broken\n");
  const started = Date.now();
  assert.equal(await exited, 0);
  assert.ok(Date.now() - started >= 1000, "it waited for its idle time");
  const lines = out.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.id), [1, 2, 3, null]);
  assert.equal(lines[0].block, true);
  assert.match(lines[0].reason, /send guard: refused/);
  assert.deepEqual(lines[1], { id: 2, block: false });
  assert.equal(lines[3].error !== undefined, true);
});
