import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// auto-sns-agent's repo guard loads from global-rules for every Prime session, whatever its cwd. The fixture checkout holds a copy of
// the live checkout's scripts/repo/agent/guards, so the rules under test are the ones agents get, and nothing here runs a command.
const SOURCE = join(homedir(), "Documents/Github/auto-sns-agent/scripts/repo/agent/guards");
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-auto-sns-agent-")));
const checkout = join(root, "auto-sns-agent");
const broken = join(root, "broken", "auto-sns-agent");
const HOME_CWD = "/Users/sieunpark";
const OWNER = "01a10810-34b5-710f-88fe-3d369f89a8c9";
const REAL_PUSH = "git push origin 7ac665783133be3e74975a5a117d213ff26d54dc:refs/heads/sieun/dev 2>&1 | tail -3; git ls-remote origin refs/heads/sieun/dev";

function fixture(dir) {
  mkdirSync(join(dir, "scripts/repo/agent"), { recursive: true });
  cpSync(SOURCE, join(dir, "scripts/repo/agent/guards"), { recursive: true, filter: (src) => !src.endsWith(".test.mjs") });
  execFileSync("/usr/bin/git", ["init", "-q", "-b", "sieun/dev", dir]);
  execFileSync("/usr/bin/git", ["-C", dir, "remote", "add", "origin", "https://github.com/sieu-n/auto-sns-agent"]);
}

const skip = !existsSync(SOURCE) && "no auto-sns-agent checkout on this machine";
const saved = { ...process.env };
let handlers = [];
if (!skip) {
  fixture(checkout);
  fixture(broken);
  writeFileSync(join(broken, "scripts/repo/agent/guards/prime.mjs"), "throw new Error('fixture: prime.mjs is broken');\n");
  Object.assign(process.env, {
    GLOBAL_RULES_AUTO_SNS_AGENT: checkout,
    GLOBAL_RULES_LOG: join(root, "global-rules.log"),
    GLOBAL_RULES_SEND_LOG: join(root, "sends.jsonl"),
    REPO_GUARD_LOG: join(root, "repo-guard.jsonl"),
  });
  const extension = (await import("../components/global-rules/index.ts")).default;
  await extension({ on: (name, handler) => handlers.push([name, handler]) });
}
test.after(() => {
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});

const ctx = (cwd, id) => ({ cwd, sessionManager: { getSessionId: () => id, getSessionFile: () => undefined, getHeader: () => ({}) } });
function call(tool, text, context) {
  const event = { type: "tool_call", toolCallId: "t", toolName: tool, input: tool === "bash" ? { command: text } : { code: text } };
  for (const [name, handler] of handlers) {
    if (name !== "tool_call") continue;
    const result = handler(event, context);
    if (result?.block) return result.reason;
  }
  return null;
}

test("the repo guard registers for a session started in /Users/sieunpark and logs its session_start", { skip }, () => {
  const start = handlers.find(([name]) => name === "session_start");
  assert.ok(start);
  start[1]({ type: "session_start", reason: "startup" }, ctx(HOME_CWD, "01a13a10-9994-7636-ae01-bbf5d7d4f9ee"));
  const line = JSON.parse(readFileSync(process.env.REPO_GUARD_LOG, "utf8").trim().split("\n").at(-1));
  assert.deepEqual([line.rule, line.verdict, line.cwd], ["session_start", "loaded", HOME_CWD]);
});

test("the 10-14 14:40Z push is refused from a /Users/sieunpark session through cd, git -C and the repo URL", { skip }, () => {
  for (const text of [`cd ${checkout} && ${REAL_PUSH}`, `git -C ${checkout} push origin 7ac6657831:refs/heads/sieun/dev`,
    "git push https://github.com/sieu-n/auto-sns-agent 7ac6657831:refs/heads/sieun/dev"]) {
    assert.match(call("bash", text, ctx(HOME_CWD, "01a13a10-9994-7636-ae01-bbf5d7d4f9ee")) ?? "", /^repo guard \(git-push-sieun-dev\)/, text);
  }
  assert.match(call("ipython", `r = await bash("cd ${checkout} && ${REAL_PUSH.replaceAll('"', '\\"')}")`, ctx(HOME_CWD, "x")) ?? "", /git-push-sieun-dev/);
});

test("the release owner's push and a ci/ push pass from any cwd", { skip }, () => {
  assert.equal(call("bash", `cd ${checkout} && ${REAL_PUSH}`, ctx(HOME_CWD, OWNER)), null);
  assert.equal(call("bash", `git -C ${checkout} push -q origin HEAD:refs/heads/sieun/dev`, ctx(checkout, OWNER)), null);
  assert.equal(call("bash", `cd ${checkout} && git push origin HEAD:refs/heads/ci/guard-everywhere`, ctx(HOME_CWD, "x")), null);
});

test("a session outside the checkout keeps its other git and its env reads", { skip }, () => {
  for (const text of ["git push origin HEAD:refs/heads/sieun/dev", "git reset --hard", "printenv OPENAI_API_KEY", "env | grep PATH"]) {
    assert.equal(call("bash", text, ctx(root, "x")), null, text);
  }
  assert.match(call("bash", `cd ${checkout} && printenv OPENAI_API_KEY`, ctx(root, "x")) ?? "", /secret-print/);
  assert.match(call("bash", `git -C ${checkout} stash`, ctx(HOME_CWD, "x")) ?? "", /git-hazard/);
});

test("rules that fail to load refuse nothing, and the failure is logged", { skip }, () => {
  const script = `
    const handlers = [];
    await (await import(${JSON.stringify(join(process.cwd(), "components/global-rules/index.ts"))})).default({ on: (n, h) => handlers.push([n, h]) });
    const ctx = (cwd) => ({ cwd, sessionManager: { getSessionId: () => "x", getSessionFile: () => undefined, getHeader: () => ({}) } });
    const call = (text, c) => handlers.filter(([n]) => n === "tool_call").map(([, h]) => h({ toolName: "bash", input: { command: text } }, c)).find((r) => r?.block)?.reason ?? null;
    console.log(JSON.stringify([call("git push origin sieun/dev", ctx(${JSON.stringify(broken)})), call("git -C ~/Documents/Github/auto-sns-agent push", ctx("/tmp")), call("git push", ctx("/tmp"))]));`;
  const log = join(root, "broken.log");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", env: { ...process.env, GLOBAL_RULES_AUTO_SNS_AGENT: broken, GLOBAL_RULES_LOG: log },
  });
  assert.deepEqual(JSON.parse(out.trim().split("\n").at(-1)), [null, null, null]);
  assert.match(readFileSync(log, "utf8"), /\[load\] auto-sns-agent\.ts failed: fixture: prime\.mjs is broken/);
});
