import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { headModules } from "./auto-sns-agent-head-modules.mjs";

// auto-sns-agent's repo guard loads from global-rules for every Prime session, whatever its cwd. The fixture checkout holds a copy of
// the live checkout's scripts/repo/agent/guards, so the rules under test are the ones agents get, and nothing here runs a command.
const SOURCE = join(homedir(), "Documents/Github/auto-sns-agent/scripts/repo/agent/guards");
// The guards also load these from HEAD (agent-branch.mjs headModule), so the fixture commits them too.
const HEAD_MODULES = existsSync(SOURCE) ? headModules(SOURCE) : [];
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-auto-sns-agent-")));
const checkout = join(root, "auto-sns-agent");
const broken = join(root, "broken", "auto-sns-agent");
const HOME_CWD = "/Users/sieunpark";
const OWNER = "01a10810-34b5-710f-88fe-3d369f89a8c9";
const REAL_PUSH = "git push origin 7ac665783133be3e74975a5a117d213ff26d54dc:refs/heads/dev/sieun 2>&1 | tail -3; git ls-remote origin refs/heads/dev/sieun";

// The guard loads from the checkout's HEAD, so a fixture commits its guard files.
const GIT_ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function commitGuards(dir, message = "guards") {
  const env = { PATH: process.env.PATH ?? "", HOME: root, ...GIT_ID };
  execFileSync("/usr/bin/git", ["-C", dir, "add", "-A", "scripts/repo/agent/guards", ...HEAD_MODULES], { env });
  execFileSync("/usr/bin/git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", message], { env });
}

function fixture(dir) {
  mkdirSync(join(dir, "scripts/repo/agent"), { recursive: true });
  cpSync(SOURCE, join(dir, "scripts/repo/agent/guards"), { recursive: true, filter: (src) => !src.endsWith(".test.mjs") });
  for (const rel of HEAD_MODULES) cpSync(join(SOURCE, "../../../..", rel), join(dir, rel));
  execFileSync("/usr/bin/git", ["init", "-q", "-b", "dev/sieun", dir]);
  execFileSync("/usr/bin/git", ["-C", dir, "remote", "add", "origin", "https://github.com/sieu-n/auto-sns-agent"]);
  commitGuards(dir);
}

const skip = !existsSync(SOURCE) && "no auto-sns-agent checkout on this machine";
const saved = { ...process.env };
let handlers = [];
if (!skip) {
  fixture(checkout);
  fixture(broken);
  writeFileSync(join(broken, "scripts/repo/agent/guards/prime.mjs"), "throw new Error('fixture: prime.mjs is broken');\n");
  commitGuards(broken, "a broken guard");
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
async function call(tool, text, context, from = handlers) {
  const event = { type: "tool_call", toolCallId: "t", toolName: tool, input: tool === "bash" ? { command: text } : { code: text } };
  for (const [name, handler] of from) {
    if (name !== "tool_call") continue;
    const result = await handler(event, context);
    if (result?.block) return result.reason;
  }
  return null;
}

test("the repo guard registers for a session started in /Users/sieunpark and logs its session_start", { skip }, async () => {
  const start = handlers.find(([name]) => name === "session_start");
  assert.ok(start);
  await start[1]({ type: "session_start", reason: "startup" }, ctx(HOME_CWD, "01a13a10-9994-7636-ae01-bbf5d7d4f9ee"));
  const line = JSON.parse(readFileSync(process.env.REPO_GUARD_LOG, "utf8").trim().split("\n").at(-1));
  assert.deepEqual([line.rule, line.verdict, line.cwd], ["session_start", "loaded", HOME_CWD]);
});

test("the 10-14 14:40Z push is refused from a /Users/sieunpark session through cd, git -C and the repo URL", { skip }, async () => {
  for (const text of [`cd ${checkout} && ${REAL_PUSH}`, `git -C ${checkout} push origin 7ac6657831:refs/heads/dev/sieun`,
    "git push https://github.com/sieu-n/auto-sns-agent 7ac6657831:refs/heads/dev/sieun"]) {
    assert.match(await call("bash", text, ctx(HOME_CWD, "01a13a10-9994-7636-ae01-bbf5d7d4f9ee")) ?? "", /^repo guard \(git-push-dev-branch\)/, text);
  }
  assert.match(await call("ipython", `r = await bash("cd ${checkout} && ${REAL_PUSH.replaceAll('"', '\\"')}")`, ctx(HOME_CWD, "x")) ?? "", /git-push-dev-branch/);
});

test("the release owner's push passes from any cwd, and a ci/ push is refused from any cwd", { skip }, async () => {
  assert.equal(await call("bash", `cd ${checkout} && ${REAL_PUSH}`, ctx(HOME_CWD, OWNER)), null);
  assert.equal(await call("bash", `git -C ${checkout} push -q origin HEAD:refs/heads/dev/sieun`, ctx(checkout, OWNER)), null);
  assert.match(await call("bash", `cd ${checkout} && git push origin HEAD:refs/heads/ci/guard-everywhere`, ctx(HOME_CWD, "x")) ?? "", /^repo guard \(git-push-ci\)/);
});

test("an ipython cell is judged where it runs after os.chdir, into the checkout or out of it", { skip }, async () => {
  assert.equal(await call("ipython", "bash('git stash')", ctx(HOME_CWD, "x")), null);
  assert.match(await call("ipython", `import os\nos.chdir(${JSON.stringify(checkout)})\nbash('git stash')`, ctx(HOME_CWD, "x")) ?? "", /git-hazard/);
  assert.match(await call("ipython", "bash('git stash')", ctx(checkout, "x")) ?? "", /git-hazard/);
  assert.equal(await call("ipython", `import os\nos.chdir(${JSON.stringify(root)})\nbash('git stash')`, ctx(checkout, "x")), null);
  assert.equal(await call("ipython", `bash(f"cd {T} && git stash")`, ctx(checkout, "x")), null);
});

test("a session outside the checkout keeps its other git and its env reads", { skip }, async () => {
  for (const text of ["git push origin HEAD:refs/heads/dev/sieun", "git reset --hard", "printenv OPENAI_API_KEY", "env | grep PATH"]) {
    assert.equal(await call("bash", text, ctx(root, "x")), null, text);
  }
  assert.match(await call("bash", `git -C ${checkout} stash`, ctx(HOME_CWD, "x")) ?? "", /git-hazard/);
});

test("rules that fail to load refuse nothing, and the failure is logged", { skip }, async () => {
  const script = `
    const handlers = [];
    await (await import(${JSON.stringify(join(process.cwd(), "components/global-rules/index.ts"))})).default({ on: (n, h) => handlers.push([n, h]) });
    const ctx = (cwd) => ({ cwd, sessionManager: { getSessionId: () => "x", getSessionFile: () => undefined, getHeader: () => ({}) } });
    const call = async (text, c) => (await Promise.all(handlers.filter(([n]) => n === "tool_call").map(([, h]) => h({ toolName: "bash", input: { command: text } }, c)))).find((r) => r?.block)?.reason ?? null;
    console.log(JSON.stringify([await call("git push origin dev/sieun", ctx(${JSON.stringify(broken)})), await call("git -C ~/Documents/Github/auto-sns-agent push", ctx("/tmp")), await call("git push", ctx("/tmp"))]));`;
  const log = join(root, "broken.log");
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", env: { ...process.env, GLOBAL_RULES_AUTO_SNS_AGENT: broken, GLOBAL_RULES_LOG: log },
  });
  assert.deepEqual(JSON.parse(out.trim().split("\n").at(-1)), [null, null, null]);
  assert.match(readFileSync(log, "utf8"), /\[load\] auto-sns-agent\.ts failed: fixture: prime\.mjs is broken/);
});

// The guard before b9a88ff4d7 (08:21Z on 10-18) and c84c6c646e (08:46Z): it refused every local pytest, ruff and ty run, and a push to
// main from an ipython cell. A worker that imported it kept it, so sessions loaded before 83b915939 were refused with these texts
// until they reloaded, such as Vent's 'vent duty' pushing sieun-pi main at 11:19Z and 'vent local mock mode' at 11:20Z.
const STALE = /Python rung is the same|runs in GitHub Actions, not on this machine/;
const OLD_GUARDS = "b9a88ff4d7^";
const skipOld = skip || !(() => {
  try { execFileSync("/usr/bin/git", ["-C", join(SOURCE, "../../../.."), "cat-file", "-e", `${OLD_GUARDS}:scripts/repo/agent/guards/commands.mjs`]); return true; } catch { return false; }
})() && "no commit c84c6c646e in the auto-sns-agent checkout";

function appWithTests(dir) {
  const app = join(dir, "apps/crawler-v3");
  mkdirSync(join(app, "tests/unit"), { recursive: true });
  writeFileSync(join(app, "tests/unit/test_census.py"), "def test_a(): pass\n");
  return app;
}
const CELL_PUSH = 'r = await bash("git push -q origin HEAD:main")';
const NAMED_PYTEST = ".venv/bin/python -m pytest -q -p no:cacheprovider tests/unit/test_census.py";

test("a fresh box session runs pytest, ruff and ty on a named file", { skip }, async () => {
  const app = appWithTests(checkout);
  for (const text of [NAMED_PYTEST, "uv run ruff check tests/unit/test_census.py", ".venv/bin/ty check tests/unit/test_census.py"]) {
    const reason = await call("bash", text, ctx(app, "x"));
    assert.doesNotMatch(reason ?? "", STALE, text);
    if (process.platform !== "darwin") assert.equal(reason, null, text);
  }
  assert.match(await call("bash", "uv run pytest tests", ctx(app, "x")) ?? "", /names the directory tests/);
});

test("a live session follows a guard edit at its next tool call, with no worker restart", { skip: skipOld }, async () => {
  const live = join(root, "live", "auto-sns-agent");
  fixture(live);
  const guards = join(live, "scripts/repo/agent/guards");
  const old = execFileSync("/usr/bin/git", ["-C", join(SOURCE, "../../../.."), "archive", OLD_GUARDS, "scripts/repo/agent/guards"]);
  execFileSync("tar", ["-x", "-C", live], { input: old });
  commitGuards(live, "the guard before b9a88ff4d7");
  const app = appWithTests(live);
  const script = `
    const handlers = [];
    await (await import(${JSON.stringify(join(process.cwd(), "components/global-rules/index.ts"))})).default({ on: (n, h) => handlers.push([n, h]) });
    const ctx = { cwd: ${JSON.stringify(app)}, sessionManager: { getSessionId: () => "x", getSessionFile: () => undefined, getHeader: () => ({}) } };
    const call = async (text) => {
      for (const [n, h] of handlers) if (n === "tool_call") { const r = await h({ toolName: "bash", input: { command: text } }, ctx); if (r?.block) return r.reason; }
      return null;
    };
    const cell = async (code) => {
      for (const [n, h] of handlers) if (n === "tool_call") { const r = await h({ toolName: "ipython", input: { code } }, ctx); if (r?.block) return r.reason; }
      return null;
    };
    const before = await call(${JSON.stringify(NAMED_PYTEST)});
    const pushBefore = await cell(${JSON.stringify(CELL_PUSH)});
    process.stdin.once("data", async () => {
      const after = await call(${JSON.stringify(NAMED_PYTEST)});
      const dir = await call("uv run pytest tests");
      const pushAfter = await cell(${JSON.stringify(CELL_PUSH)});
      console.log(JSON.stringify({ before, after, dir, pushBefore, pushAfter }));
      process.exit(0);
    });
    console.log("ready");`;
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, GLOBAL_RULES_AUTO_SNS_AGENT: live }, stdio: ["pipe", "pipe", "inherit"],
  });
  let out = "";
  let swapped = false;
  child.stdout.on("data", (chunk) => {
    out += chunk;
    if (out.includes("ready\n") && !swapped) {
      swapped = true;
      cpSync(SOURCE, guards, { recursive: true, filter: (src) => !src.endsWith(".test.mjs") });
      commitGuards(live, "the current guard");
      child.stdin.write("go\n");
    }
  });
  await new Promise((resolve) => child.on("exit", resolve));
  const result = JSON.parse(out.trim().split("\n").at(-1));
  assert.match(result.before ?? "", STALE);
  if (process.platform !== "darwin") assert.equal(result.after, null);
  assert.doesNotMatch(result.after ?? "", STALE);
  assert.match(result.dir ?? "", /names the directory tests/);
  assert.match(result.pushBefore ?? "", /git-push-main/);
  assert.equal(result.pushAfter, null);
});

test("a scratch copy of the repo, with its own old guard files, is judged by the checkout's current guard", { skip: skipOld }, async () => {
  // On 10-18 Vent's job ran its checks from a copy under apps/llm-wiki/content/sessions/<folder>/data/vent-src.
  const copy = join(checkout, "apps/llm-wiki/content/sessions/2026/10/18/1612-vent-mock-mode/data/vent-src");
  const old = execFileSync("/usr/bin/git", ["-C", join(SOURCE, "../../../.."), "archive", OLD_GUARDS, "scripts/repo/agent/guards"]);
  mkdirSync(copy, { recursive: true });
  execFileSync("tar", ["-x", "-C", copy], { input: old });
  const app = join(copy, "apps/vent");
  mkdirSync(join(app, "tests/unit"), { recursive: true });
  writeFileSync(join(app, "tests/unit/test_mock_engine.py"), "def test_a(): pass\n");
  // The 10-18 cell ran it under nice -n 10, which the cap guard has refused since c107, so the copy here runs it plain.
  const text = `cd ${app} && uv run pytest -q tests/unit/test_mock_engine.py`;
  for (const cwd of [checkout, app, HOME_CWD]) {
    const reason = await call("bash", text, ctx(cwd, "x"));
    assert.doesNotMatch(reason ?? "", STALE, cwd);
    if (process.platform !== "darwin") assert.equal(reason, null, cwd);
  }
  assert.equal(await call("ipython", `r = await bash(${JSON.stringify(text)})`, ctx(checkout, "x")), null);
  assert.match(await call("bash", `cd ${app} && uv run pytest tests`, ctx(checkout, "x")) ?? "", /names the directory tests/);
});

test("a landed guard that fails to load keeps the last guard that loaded", { skip }, async () => {
  const live = join(root, "keep", "auto-sns-agent");
  fixture(live);
  const loaded = [];
  process.env.GLOBAL_RULES_AUTO_SNS_AGENT = live;
  try {
    const module = await import(`../components/global-rules/auto-sns-agent.ts?keep`);
    await module.register({ on: (name, handler) => loaded.push([name, handler]) });
    const push = `git -C ${live} push origin HEAD:refs/heads/dev/sieun`;
    assert.match(await call("bash", push, ctx(HOME_CWD, "x"), loaded) ?? "", /git-push-dev-branch/);
    writeFileSync(join(live, "scripts/repo/agent/guards/prime.mjs"), "throw new Error('fixture: a broken edit');\n");
    commitGuards(live, "a broken guard");
    assert.match(await call("bash", push, ctx(HOME_CWD, "x"), loaded) ?? "", /git-push-dev-branch/);
  } finally {
    process.env.GLOBAL_RULES_AUTO_SNS_AGENT = checkout;
  }
});

test("an uncommitted edit to the checkout's guard files does not change the live guard", { skip }, async () => {
  // 10-18 11:48Z: a session's unsaved edit to the shared tree's guards/git.mjs dropped the hooks-off push check for every session.
  const live = join(root, "dirty", "auto-sns-agent");
  fixture(live);
  const loaded = [];
  process.env.GLOBAL_RULES_AUTO_SNS_AGENT = live;
  try {
    const module = await import(`../components/global-rules/auto-sns-agent.ts?dirty`);
    await module.register({ on: (name, handler) => loaded.push([name, handler]) });
    const push = `git -C ${live} push origin HEAD:refs/heads/dev/sieun`;
    assert.match(await call("bash", push, ctx(HOME_CWD, "x"), loaded) ?? "", /git-push-dev-branch/);
    writeFileSync(join(live, "scripts/repo/agent/guards/prime.mjs"), "export const registerRepoGuard = () => {};\nexport const onToolCall = () => undefined;\n");
    assert.match(await call("bash", push, ctx(HOME_CWD, "x"), loaded) ?? "", /git-push-dev-branch/);
    const fresh = [];
    const again = await import(`../components/global-rules/auto-sns-agent.ts?dirty-fresh`);
    await again.register({ on: (name, handler) => fresh.push([name, handler]) });
    assert.match(await call("bash", push, ctx(HOME_CWD, "x"), fresh) ?? "", /git-push-dev-branch/);
  } finally {
    process.env.GLOBAL_RULES_AUTO_SNS_AGENT = checkout;
  }
});
