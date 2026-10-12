import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The owner's sieun-pi checkout, rebuilt in a temp HOME: two commits on a fake origin, two local ones.
const root = mkdtempSync(join(tmpdir(), "global-rules-sieun-pi-"));
const home = join(root, "home");
const project = join(root, "auto-sns-agent");
const remote = join(root, "remote/sieu-n/sieun-pi.git");
const checkout = join(home, "Documents/Github/sieun-pi");
const copy = join(root, "elsewhere/pi-copy");
const atOrigin = join(root, "elsewhere/at-origin");
const other = join(root, "other-repo");
mkdirSync(join(project, ".git"), { recursive: true });
const gitConfig = join(root, "gitconfig");
writeFileSync(gitConfig, "[user]\n\tname = test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");

const saved = Object.fromEntries(["HOME", "GLOBAL_RULES_LOG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"].map((k) => [k, process.env[k]]));
Object.assign(process.env, { HOME: home, GLOBAL_RULES_LOG: join(root, "global-rules.log"), GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" });
const guard = await import("../components/global-rules/guard.ts");
test.after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function commit(dir, name) {
  writeFileSync(join(dir, name), name);
  git(dir, "add", name);
  git(dir, "commit", "-q", "-m", name);
}
mkdirSync(remote, { recursive: true });
git(remote, "init", "-q", "--bare");
mkdirSync(checkout, { recursive: true });
git(checkout, "init", "-q");
git(checkout, "remote", "add", "origin", remote);
commit(checkout, "c1");
commit(checkout, "c2");
git(checkout, "push", "-q", "-u", "origin", "main");
commit(checkout, "c3");
commit(checkout, "c4");
for (const dir of [copy, atOrigin]) execFileSync("git", ["clone", "-q", remote, dir]);
commit(copy, "c3");
mkdirSync(other, { recursive: true });
git(other, "init", "-q");
git(other, "remote", "add", "origin", join(root, "remote/someone/else.git"));
commit(other, "o1");
commit(other, "o2");
git(other, "update-ref", "refs/remotes/origin/main", "HEAD");

async function verdict(command, toolName = "bash", cwd = project) {
  const input = toolName === "bash" ? { command } : { code: `handle = bash(${JSON.stringify(command)})` };
  return guard.onToolCall({ type: "tool_call", toolCallId: "sieun-pi", toolName, input }, { cwd });
}

const allowed = [
  "cd ~/Documents/Github/sieun-pi && git rebase -i origin/main",
  "cd $HOME/Documents/Github/sieun-pi && git rebase origin/main",
  "git -C ~/Documents/Github/sieun-pi rebase -i HEAD~2",
  `cd '${checkout}' && git rebase`,
  `git -C '${checkout}' rebase --onto origin/main HEAD~1`,
  `git -C '${checkout}' -c core.editor=true rebase -i --exec 'echo ok' origin/main main`,
  `git -C '${checkout}' commit --amend --no-edit`,
  `git -C '${checkout}' push origin feature`,
  `git -C '${checkout}' reset --soft HEAD~1`,
  `git -C '${copy}' rebase -i origin/main`,
  `git -C '${copy}' commit --amend -m c3`,
  `git -C '${other}' rebase -i --root`,
  `git -C '${other}' push --force origin feature`,
  "cd ~ && git status",
];
for (const command of allowed) {
  for (const toolName of ["bash", "ipython"]) {
    test(`${toolName} allows ${command}`, async () => {
      assert.equal(await verdict(command, toolName), undefined);
    });
  }
}

const blocked = [
  ["cd ~/Documents/Github/sieun-pi && git rebase -i HEAD~3", /commits already on a remote branch/],
  ["cd ~/Documents/Github/sieun-pi && git rebase -i origin/main~1", /commits already on a remote branch/],
  [`git -C '${checkout}' rebase --root`, /commits already on a remote branch/],
  [`git -C '${checkout}' rebase --onto HEAD~3 HEAD~3`, /commits already on a remote branch/],
  [`git -C '${checkout}' rebase no-such-ref`, /could not prove/],
  [`git -C '${atOrigin}' commit --amend --no-edit`, /HEAD is already on a remote branch/],
  [`git -C '${copy}' rebase HEAD~2`, /commits already on a remote branch/],
  ["cd ~/Documents/Github/sieun-pi && git push --force origin main", /force/],
  [`git -C '${checkout}' push -f origin main`, /force/],
  [`git -C '${checkout}' push --force-with-lease origin main`, /force/],
  [`git -C '${checkout}' push origin +main`, /force/],
  [`git -C '${copy}' push --force-with-lease=main origin main`, /force/],
  ["cd ~/Documents/Github/sieun-pi && git reset --hard origin/main", /reset --hard/],
  [`bash -lc "cd '${checkout}' && git rebase -i HEAD~3"`, /commits already on a remote branch/],
];
for (const [command, reason] of blocked) {
  for (const toolName of ["bash", "ipython"]) {
    test(`${toolName} blocks ${command}`, async () => {
      const result = await verdict(command, toolName);
      assert.equal(result?.block, true);
      assert.match(result.reason, reason);
      assert.match(result.reason, /^global-rules sieun-pi guard: /);
      assert.match(result.reason, /local checkout is ground truth/);
    });
  }
}

test("rebase steps are allowed while a rebase is in progress", async () => {
  const step = join(root, "elsewhere/step");
  execFileSync("git", ["clone", "-q", remote, step]);
  commit(step, "s1");
  commit(step, "s2");
  assert.throws(() => git(step, "rebase", "-q", "--exec", "false", "origin/main"));
  for (const action of ["--continue", "--skip", "--abort", "--edit-todo", "--show-current-patch"]) {
    assert.equal(await verdict(`cd '${step}' && git rebase ${action}`), undefined, action);
  }
  git(step, "rebase", "--abort");
});

test("the rule follows the target checkout, not the session cwd", async () => {
  for (const cwd of [project, other, root]) {
    assert.equal((await verdict(`git -C '${checkout}' reset --hard`, "bash", cwd))?.block, true, cwd);
  }
  assert.equal((await verdict("git reset --hard", "bash", checkout))?.block, true);
  assert.equal((await verdict("git rebase -i HEAD~3", "bash", checkout))?.block, true);
});

// A push to main is the merge guard's rule (c49), so these force pushes name a feature branch.
test("other repos get no verdict from this rule", async () => {
  for (const command of ["git rebase -i origin/main", "git reset --hard", "git push --force origin feature", "git stash"]) {
    assert.equal(await verdict(command, "bash", other), undefined, command);
  }
});
