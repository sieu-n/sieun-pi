import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The repo copy guard (packages/sieun-rules/src/repo-copy.ts), owner rule c193. On 10-29 slack green guy's jobs ran tsc and next dev in
// per-job `git worktree` copies on the owner's Mac at about 1 GB each in red minutes. These commands are only fed to the handlers.
const root = realpathSync(mkdtempSync(join(tmpdir(), "global-rules-copy-")));
const saved = process.env.GLOBAL_RULES_LOG;
const savedHome = process.env.HOME;
process.env.GLOBAL_RULES_LOG = join(root, "global-rules.log");
process.env.HOME = root;
const guard = await import("../packages/sieun-rules/src/guard.ts");
const sendCheck = await import("../packages/sieun-rules/src/send-check.ts");
test.after(() => {
  if (saved === undefined) delete process.env.GLOBAL_RULES_LOG;
  else process.env.GLOBAL_RULES_LOG = saved;
  process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

const event = (toolName, text) => ({ type: "tool_call", toolCallId: "t", toolName, input: toolName === "bash" ? { command: text } : { code: text } });
const call = (toolName, text) => guard.onToolCall(event(toolName, text), { cwd: root });
const cell = (command) => `r = await bash(${JSON.stringify(command)})\nprint(r.output)`;

const COPIES = [
  "cd ~/Documents/Github/slack-green && git worktree add -b sg-fix ~/scratch/01a18790/sg-copy origin/main",
  "git -C ~/Documents/Github/slack-green worktree add ../sg-2 HEAD",
  "git clone ~/Documents/Github/auto-sns-agent /tmp/asa",
  "git clone --depth 1 /home/sieun/src/sieun-pi ./sp",
  "git clone file:///Users/sieunpark/Documents/Github/slack-green x",
  "git clone -- ../slack-green copy",
  "git archive HEAD | tar -x -C /tmp/tree",
  "git archive --format=tar -o /tmp/t.tar HEAD",
  "bash -lc 'git worktree add /tmp/w main'",
  "ssh sieunpark@100.66.173.18 'cd ~/Documents/Github/slack-green && git worktree add /tmp/w'",
  "timeout 60 git clone ./repo ../repo-copy",
  "echo start; (cd repo && git worktree add ../w2)",
];

const FINE = [
  "git worktree list",
  "git worktree remove ~/scratch/01a18790/sg-copy",
  "git worktree prune",
  "git clone https://github.com/sieu-n/prime-shared-state.git",
  "git clone git@github.com:sieu-n/slack-green.git /tmp/sg",
  "git clone us-metal02:src/sieun-pi sp",
  "git archive HEAD > /tmp/tree.tar",
  "git status",
  "rg -n 'git worktree add' skills",
  "git commit -m 'docs: never git worktree add' -- README.md",
  "echo 'never git clone a local checkout'",
];

for (const platform of ["darwin", "linux"]) {
  test(`on ${platform}, a worktree add, a local clone or an archive into a folder is refused in bash and in an ipython cell`, () => {
    process.env.GLOBAL_RULES_PLATFORM = platform;
    for (const text of [...COPIES.map((t) => ["bash", t]), ...COPIES.map((t) => ["ipython", cell(t)])]) {
      const result = call(...text);
      assert.equal(result?.block, true, text.join(": "));
      assert.match(result.reason, /repo copy guard/);
      assert.match(result.reason, /c193/);
      assert.match(result.reason, /existing checkout/);
    }
    const argv = call("ipython", 'import subprocess\nsubprocess.run(["git", "worktree", "add", "/tmp/w", "main"])');
    assert.equal(argv?.block, true);
  });

  test(`on ${platform}, reading, removing and pruning worktrees and remote clones pass`, () => {
    process.env.GLOBAL_RULES_PLATFORM = platform;
    for (const text of FINE) {
      assert.equal(call("bash", text), undefined, text);
      assert.equal(call("ipython", cell(text)), undefined, text);
    }
  });
}

test("the kernel half refuses a worktree add whose command the cell builds at run time", () => {
  const result = sendCheck.judgeCheck({ kind: "shell", text: "git worktree add /tmp/w main", cwd: root });
  assert.equal(result.block, true);
  assert.match(result.reason, /repo copy guard/);
  assert.deepEqual(sendCheck.judgeCheck({ kind: "shell", text: "git worktree list", cwd: root }), { block: false });
});

// At 12:04Z on 10-30 a slack green guy job that the guard refused a new worktree ran `pnpm install` in an old one, and its tree held 6.6 GB.
test("an install, build, dev server, type check or test inside an existing worktree or renamed clone is refused", () => {
  const repo = join(root, "Github", "slack-green");
  const wt = join(root, "Github", "slack-green-trial-banner-checkout");
  const renamed = join(root, "Github", "slack-green-p2");
  const boxRun = join(root, "box-run", "mac", "repo");
  for (const dir of [repo, renamed, boxRun]) {
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/sieu-n/slack-green.git\n');
  }
  mkdirSync(join(wt, "packages", "frontend"), { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${repo}/.git/worktrees/x\n`);
  const at = (cwd, toolName, text) => guard.onToolCall(event(toolName, text), { cwd });
  for (const [cwd, text] of [
    [wt, 'pnpm install --frozen-lockfile --filter "@slack-green/frontend..."'],
    [join(wt, "packages", "frontend"), "npx tsc --noEmit -p ."],
    [root, `cd ${wt} && pnpm -C packages/frontend dev`],
    [root, `pnpm -C ${wt} install`],
    [renamed, "pnpm test"],
    [renamed, "node node_modules/.bin/next dev"],
    [root, `bash -lc 'cd ${renamed} && yarn build'`],
  ]) {
    const result = at(cwd, "bash", text);
    assert.equal(result?.block, true, text);
    assert.match(result.reason, /runs in a copy of the repo/);
  }
  const cellResult = at(root, "ipython", `import os\nos.chdir(${JSON.stringify(wt)})\nh = bash('pnpm install --frozen-lockfile')`);
  assert.equal(cellResult?.block, true, "a cell that chdirs into the worktree");
  for (const [cwd, text] of [[repo, "pnpm install"], [repo, "npx tsc --noEmit -p ."], [boxRun, "pnpm install"], [wt, "git status"],
    [wt, "ls node_modules"], [wt, "cat package.json"], [root, `cd ${repo} && pnpm build`], [wt, "git worktree list"]]) {
    assert.equal(at(cwd, "bash", text), undefined, `${cwd}: ${text}`);
  }
});

// On 10-30 the guard refused Prime's only checkout on us-metal02, /home/sieun/work/prime-agent-fix-p8/repo, as "a copy of all.bundle",
// because it was cloned from a bundle file and so was not named after its origin.
test("the one main checkout passes wherever its origin points, and a second clone or a worktree of it is refused", () => {
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { stdio: "pipe" });
  const seed = join(root, "seed", "prime");
  mkdirSync(seed, { recursive: true });
  git("-C", seed, "init", "-q");
  writeFileSync(join(seed, "a.txt"), "a\n");
  git("-C", seed, "add", "a.txt");
  git("-C", seed, "commit", "-qm", "a");
  const p8 = join(root, "work", "prime-agent-fix-p8");
  mkdirSync(p8, { recursive: true });
  git("-C", seed, "bundle", "create", join(p8, "all.bundle"), "--all");
  mkdirSync(join(root, "elsewhere"));
  git("-C", seed, "bundle", "create", join(root, "elsewhere", "other.bundle"), "--all");
  const main = join(p8, "repo");
  git("clone", "-q", join(p8, "all.bundle"), main);
  const second = join(root, "scratch", "x", "repo");
  git("clone", "-q", main, second);
  const sameBundle = join(p8, "repo-2");
  git("clone", "-q", join(p8, "all.bundle"), sameBundle);
  const sameRoot = join(p8, "repo-3");
  git("clone", "-q", join(root, "elsewhere", "other.bundle"), sameRoot);
  const wt = join(p8, "wt-pr");
  git("-C", main, "worktree", "add", "-q", wt);
  const lone = join(root, "Github", "sg-renamed");
  mkdirSync(join(lone, ".git"), { recursive: true });
  writeFileSync(join(lone, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:sieu-n/lone-repo.git\n');
  const at = (cwd, text) => guard.onToolCall(event("bash", text), { cwd });
  for (const cwd of [main, lone]) assert.equal(at(cwd, "npx vitest --run test/a.test.ts"), undefined, cwd);
  assert.equal(at(root, `cd ${main} && npx tsgo --noEmit`), undefined);
  for (const [cwd, why] of [[second, /is a clone of the checkout/], [sameBundle, /the main checkout of that repo/],
    [sameRoot, /the main checkout of that repo/], [wt, /is a git worktree/]]) {
    const result = at(cwd, "npx vitest --run test/a.test.ts");
    assert.equal(result?.block, true, cwd);
    assert.match(result.reason, why, cwd);
  }
});
