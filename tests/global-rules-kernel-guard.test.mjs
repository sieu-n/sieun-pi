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

test("send-check.ts --serve-socket judges for many processes in each one's environment, a second judge on the path exits, and it leaves after its idle time", async () => {
  const { spawn } = await import("node:child_process");
  const { createConnection } = await import("node:net");
  const { existsSync, readFileSync } = await import("node:fs");
  const check = join(import.meta.dirname, "..", "components", "global-rules", "send-check.ts");
  const path = join(root, "judge.sock");
  const start = () => spawn(process.execPath, [check, "--serve-socket", path, "1500"], { stdio: "ignore", env: process.env });
  const judge = start();
  const exited = new Promise((resolve) => judge.on("exit", (code) => resolve(code)));
  for (let i = 0; i < 200 && !existsSync(path); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  const second = start();
  assert.equal(await new Promise((resolve) => second.on("exit", resolve)), 0, "a second judge on a path that answers exits at once");
  const ask = (session, text) => new Promise((resolve, reject) => {
    const env = { ...process.env, GLOBAL_RULES_SEND_LOG: join(root, `sends-${session}.jsonl`), RLM_SESSION_DIR: join(root, "artifacts", session) };
    const socket = createConnection(path, () => socket.write(`${JSON.stringify({ id: 1, cwd: root, env, check: { kind: "shell", text, cwd: root, approval: "" } })}\n`));
    let out = "";
    socket.on("data", (chunk) => { out += chunk; if (out.includes("\n")) { socket.end(); resolve(JSON.parse(out)); } });
    socket.on("error", reject);
  });
  const a = "01a10000-0000-7000-8000-00000000000a";
  const b = "01a10000-0000-7000-8000-00000000000b";
  const [refused, passed] = await Promise.all([ask(a, "curl -X POST https://api.resend.com/emails -d x"), ask(b, "git ls-files deploy.sh")]);
  const oneShot = (text) => JSON.parse(execFileSync(process.execPath, [check], { input: JSON.stringify({ kind: "shell", text, cwd: root, approval: "" }),
    env: { ...process.env, GLOBAL_RULES_SEND_LOG: join(root, "sends-one-shot.jsonl") } }).toString());
  assert.deepEqual({ block: refused.block, reason: refused.reason }, oneShot("curl -X POST https://api.resend.com/emails -d x"));
  assert.deepEqual({ block: passed.block }, oneShot("git ls-files deploy.sh"));
  const logged = readFileSync(join(root, `sends-${a}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(logged.map((line) => [line.decision, line.layer]), [["refused", "kernel"]]);
  assert.match(JSON.stringify(logged[0]), new RegExp(a));
  assert.equal(existsSync(join(root, `sends-${b}.jsonl`)), false, "the other process's check wrote nothing to this log");
  assert.equal(await exited, 0);
  assert.equal(existsSync(path), false, "the judge removes its socket when it leaves");
});
