import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The tool_call guard judges an ipython cell where its commands run: the kernel's reported cwd, moved by each os.chdir the cell
// spells out (kernel-cwd.ts). Before, it judged from ctx.cwd, the session's start cwd, so a `git reset --hard` after
// os.chdir into sieun-pi passed, and one after os.chdir out of sieun-pi was refused.
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-kernel-cwd-")));
const pi = join(root, "sieun-pi");
const other = join(root, "other-repo");
const session = join(root, "artifacts/01a10000-0000-7000-8000-000000000000/sub-1234abcd");
mkdirSync(session, { recursive: true });
const gitConfig = join(root, "gitconfig");
writeFileSync(gitConfig, "[user]\n\tname = t\n\temail = t@t\n[init]\n\tdefaultBranch = main\n");
const saved = Object.fromEntries(["GLOBAL_RULES_LOG", "GLOBAL_RULES_SEND_LOG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"].map((k) => [k, process.env[k]]));
Object.assign(process.env, {
  GLOBAL_RULES_LOG: join(root, "global-rules.log"), GLOBAL_RULES_SEND_LOG: join(root, "sends.jsonl"), GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1",
});
const guard = await import("../components/global-rules/guard.ts");
const { UNKNOWN_CWD, cellSteps, kernelCwd, sessionDirOf } = await import("../components/global-rules/kernel-cwd.ts");
const { PRELUDE } = await import("../components/global-rules/kernel-guard.ts");
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
for (const [dir, origin] of [[pi, "https://github.com/sieu-n/sieun-pi.git"], [other, "https://github.com/someone/else.git"]]) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", origin);
}

const cell = (code, ctx) => guard.onToolCall({ type: "tool_call", toolCallId: "t", toolName: "ipython", input: { code } }, ctx)?.reason ?? null;
const ctx = (cwd, sessionFile) => ({ cwd, sessionManager: { getSessionFile: () => sessionFile } });

test("os.chdir moves the cwd for the commands after it, through names, f-strings, Path and +", () => {
  const cwds = (code, start = "/start") => cellSteps(code, start).map((step) => step.cwd);
  assert.deepEqual(cwds(`import os\nos.chdir('${pi}')\nr = await bash('git status')`), ["/start", pi]);
  assert.deepEqual(cwds("R = os.path.expanduser('~/x')\nos.chdir(R); bash('git log')").at(-1), join(process.env.HOME, "x"));
  assert.deepEqual(cwds("W = '/w'\nos.chdir(W + '/a')\nbash('git log')\nos.chdir('..')"), ["/start", "/w/a", "/w"]);
  assert.deepEqual(cwds("T = Path('/s').expanduser() / 'a'\nos.chdir(T)\nos.chdir(f'{T}/b')"), ["/start", "/s/a", "/s/a/b"]);
  // A name an earlier cell set is unknown here, so no cwd rule judges the commands after it, and kernel-guard.py judges their git
  // writes at run time with the real cwd. The next cell starts where the kernel reports it is.
  assert.deepEqual(cwds("os.chdir(REPO)\nbash('git commit')"), [UNKNOWN_CWD]);
  assert.equal(cellSteps("T = '/t'\nbash(f'cd {T} && git -C {T}/a log; git -C {U} stash')", "/s")[0].code,
    `T = '/t'\nbash(f'cd /t && git -C /t/a log; git -C ${UNKNOWN_CWD} stash')`);
  assert.deepEqual(cwds(`s = "os.chdir('/nope')"  # os.chdir('/no')\nbash('git log')`), ["/start"]);
});

test("a sieun-pi rule follows an os.chdir in the cell both ways", () => {
  assert.equal(cell("bash('git reset --hard')", ctx(root)), null);
  assert.match(cell(`import os\nos.chdir('${pi}')\nbash('git reset --hard')`, ctx(root)) ?? "", /sieun-pi guard: `git reset --hard`/);
  assert.match(cell("bash('git reset --hard')", ctx(pi)) ?? "", /sieun-pi guard/);
  assert.equal(cell(`os.chdir('${other}')\nbash('git reset --hard')`, ctx(pi)), null);
  assert.match(cell(`os.chdir('${other}')\nbash('git log')\nos.chdir('${pi}')\nbash('git reset --hard')`, ctx(root)) ?? "", /sieun-pi guard/);
  assert.match(cell(`bash(f"cd ${pi} && git reset --hard")`, ctx(root)) ?? "", /sieun-pi guard/);
  assert.equal(cell("bash(f'cd {T} && git reset --hard')", ctx(pi)), null);
});

test("a cell starts where the kernel reported its cwd, which kernel-cwd.py writes at load and after each os.chdir", async () => {
  assert.equal(sessionDirOf(join(session, "01a1.jsonl")), session);
  assert.equal(sessionDirOf(join(root, "sessions/01a1.jsonl")), join(root, "session-artifacts/01a1"));
  const kernel = spawn("python3", ["-c", `${PRELUDE}import os, sys\nos.chdir(${JSON.stringify(pi)})\nprint("ready", flush=True)\nsys.stdin.read()`], {
    env: { ...process.env, RLM_SESSION_DIR: session }, stdio: ["pipe", "pipe", "inherit"],
  });
  try {
    await new Promise((resolve) => kernel.stdout.once("data", resolve));
    const report = JSON.parse(readFileSync(join(session, "kernel-cwd.json"), "utf8"));
    assert.deepEqual(report, { pid: kernel.pid, host: hostname(), cwd: pi });
    assert.equal(kernelCwd(join(session, "x.jsonl")), pi);
    assert.match(cell("bash('git reset --hard')", ctx(root, join(session, "x.jsonl"))) ?? "", /sieun-pi guard/);
  } finally {
    kernel.stdin.end();
    await new Promise((resolve) => kernel.once("exit", resolve));
  }
  // A report from a kernel that is gone is not read.
  assert.equal(kernelCwd(join(session, "x.jsonl")), null);
  assert.equal(cell("bash('git reset --hard')", ctx(root, join(session, "x.jsonl"))), null);
});
