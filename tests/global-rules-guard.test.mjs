import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The send rule is the trigger here; these tests cover how commands are found in bash and ipython calls.
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-guard-")));
const home = join(root, "home");
mkdirSync(join(home, ".prime/agent"), { recursive: true });
const saved = { HOME: process.env.HOME, GLOBAL_RULES_LOG: process.env.GLOBAL_RULES_LOG };
process.env.HOME = home;
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
const guard = await import("../packages/sieun-rules/src/guard.ts");
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const BAD = "curl -sS -X POST https://acme.zendesk.com/api/v2/tickets/1.json -d x";
const REPO = fileURLToPath(new URL("..", import.meta.url));
const event = (toolName, text) => ({ type: "tool_call", toolCallId: "t", toolName, input: toolName === "bash" ? { command: text } : { code: text } });
const call = (toolName, text, ctx = { cwd: root }) => guard.onToolCall(event(toolName, text), ctx);

test("extracts current Prime bash calls", () => {
  assert.deepEqual(guard.extractShellCandidates(`handle = bash("${BAD}")`).map((item) => item.text), [BAD]);
});

test("Python invocation forms are guarded", async () => {
  for (const code of [
    `%%bash\n${BAD}`,
    `!${BAD}`,
    `subprocess.run(["curl", "-sS", "-X", "POST", "https://acme.zendesk.com/api/v2/tickets/1.json", "-d", "x"])`,
    `subprocess.run("${BAD}", shell=True)`,
    `os.system("${BAD}")`,
    `await bash(command="${BAD}")`,
    `handle = bash("""${BAD}\ngit status""")`,
    `handle = bash('echo ")" && ${BAD}')`,
  ]) {
    assert.equal((await call("ipython", code))?.block, true, code);
  }
});

test("Python comments and quoted examples are not calls", async () => {
  for (const code of [
    `# bash("${BAD}")`,
    `example = 'bash("${BAD}")'`,
    `print("${BAD}")`,
    "handle = bash(command)",
    `subprocess.run(argv, cwd="${BAD}")`,
  ]) {
    assert.equal(await call("ipython", code), undefined, code);
  }
});

test("other tools and non-string input pass through", async () => {
  assert.equal(await guard.onToolCall({ type: "tool_call", toolCallId: "t", toolName: "read", input: { path: BAD } }, { cwd: root }), undefined);
  assert.equal(await guard.onToolCall({ type: "tool_call", toolCallId: "t", toolName: "bash", input: {} }, { cwd: root }), undefined);
});

test("missing context cwd uses the process cwd", async () => {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    assert.equal((await call("bash", "git reset --hard", {}))?.block, undefined);
    process.chdir(REPO);
    assert.equal((await call("bash", "git reset --hard", {}))?.block, true);
  } finally {
    process.chdir(cwd);
  }
});

test("a handler error fails open and is logged", async () => {
  const stale = { get cwd() { throw new Error("This extension ctx is stale after session replacement or reload"); } };
  assert.equal(await call("bash", BAD, stale), undefined);
  assert.match(readFileSync(process.env.GLOBAL_RULES_LOG, "utf8"), /\[guard\] handler error, failing open cwd=\? :: Error: This extension ctx is stale/);
});
