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
