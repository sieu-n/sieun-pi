import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as guard from "../components/virev/ext-impl/virev/git-guard.mjs";

const root = mkdtempSync(join(tmpdir(), "virev-guard-"));
const project = join(root, "auto-sns-agent");
mkdirSync(join(project, ".prime/agent"), { recursive: true });
mkdirSync(join(project, ".git"));
const configPath = join(root, "virev-projects.json");
const config = JSON.stringify({ projects: [{ root: project, policy: "auto-sns-agent" }] });
writeFileSync(configPath, config);
const previousProjectsFile = process.env.VIREV_PROJECTS_FILE;
process.env.VIREV_PROJECTS_FILE = configPath;
test.after(() => {
  if (previousProjectsFile === undefined) delete process.env.VIREV_PROJECTS_FILE;
  else process.env.VIREV_PROJECTS_FILE = previousProjectsFile;
  rmSync(root, { recursive: true, force: true });
});

for (const command of ["git reset --hard", "git stash", "git add -A", "git push --force"]) {
  test(`native bash blocks ${command}`, async () => {
    const result = await guard.onToolCall({ type: "tool_call", toolCallId: "native", toolName: "bash", input: { command } }, { cwd: project });
    assert.equal(result?.block, true);
    assert.ok(result.reason.length > 20);
  });
}

test("extracts current Prime bash calls", () => {
  assert.deepEqual(guard.extractShellCandidates('handle = bash("git reset --hard")').map((item) => item.text), ["git reset --hard"]);
});

const unrelated = join(root, "other-repo");
const nested = join(project, "vendor", "other-repo");
for (const directory of [unrelated, nested]) {
  mkdirSync(join(directory, ".git"), { recursive: true });
}
const subdir = join(project, "apps", "search");
mkdirSync(subdir, { recursive: true });

function toolEvent(toolName, text) {
  return { type: "tool_call", toolCallId: "test", toolName, input: toolName === "bash" ? { command: text } : { code: text } };
}

const blockedCommands = [
  "git reset --hard HEAD",
  "git push --force-with-lease origin sieun/dev",
  "git push --force-with-lease=refs/heads/sieun/dev origin sieun/dev",
  "git push -uf origin sieun/dev",
  "git push origin +HEAD:sieun/dev",
  "git push origin HEAD:refs/heads/main",
  "git checkout -b new-branch --force",
  "git switch -c new-branch --discard-changes",
  "git stash pop",
  "git checkout -- important.txt",
  "git switch old-branch",
  "git checkout -B old-branch",
  "git switch -C old-branch",
  "git clean -fd",
  "git add .",
  "git add :/",
  "git commit -am oops",
  "git branch -D old-branch",
  "git worktree add /tmp/another-tree",
  "git merge topic",
  "git rebase main",
  "git pull",
  "git push origin main",
  'bash -lc "git reset --hard"',
  'echo "$(git stash pop)"',
  "npx convex dev --once",
  "pnpm exec tsc --noEmit",
  "pnpm test",
  "uv run pytest",
];

for (const command of blockedCommands) {
  for (const toolName of ["bash", "ipython"]) {
    test(`${toolName} denies ${command}`, async () => {
      const input = toolName === "bash" ? command : `handle = bash(${JSON.stringify(command)})`;
      const result = await guard.onToolCall(toolEvent(toolName, input), { cwd: subdir });
      assert.equal(result?.block, true, input);
      assert.ok(result.reason.length > 20);
    });
  }
}

const allowedCommands = [
  "git status --short",
  "git diff --stat",
  "git log -3 --oneline",
  "git fetch origin",
  "git stash list",
  "git stash show",
  "git worktree list",
  "git clean --dry-run",
  "git add my-file.ts",
  'git commit -m "fix: one file"',
  "git push origin sieun/dev",
  "git checkout -b new-branch",
  "git switch -c new-branch",
  "pnpm dev",
  "pnpm exec turbo run check --dry=json",
  "uv run ruff format my_file.py",
  'printf "%s" "git reset --hard"',
  "cat <<'EOF'\ngit reset --hard\nEOF",
];

for (const command of allowedCommands) {
  for (const toolName of ["bash", "ipython"]) {
    test(`${toolName} allows ${command.split("\n")[0]}`, async () => {
      const input = toolName === "bash" ? command : `await bash(${JSON.stringify(command)})`;
      assert.equal(await guard.onToolCall(toolEvent(toolName, input), { cwd: project }), undefined);
    });
  }
}

for (const directory of [unrelated, nested]) {
  for (const command of ["git reset --hard", "git add -A", "pnpm test", "npx convex dev --once"]) {
    test(`unrelated boundary ${directory} allows ${command}`, async () => {
      assert.equal(await guard.onToolCall(toolEvent("bash", command), { cwd: directory }), undefined);
      assert.equal(await guard.onToolCall(toolEvent("bash", `cd '${directory}' && ${command}`), { cwd: project }), undefined);
      if (command.startsWith("git ")) {
        assert.equal(await guard.onToolCall(toolEvent("bash", `git -C '${directory}' ${command.slice(4)}`), { cwd: project }), undefined);
      }
    });
  }
}

test("scope is a global opt-in, not the directory name", async () => {
  const unmarked = join(unrelated, "auto-sns-agent");
  mkdirSync(unmarked);
  assert.equal(await guard.onToolCall(toolEvent("bash", "git reset --hard"), { cwd: unmarked }), undefined);
});

test("invalid and unsupported configuration do not opt in", async () => {
  try {
    for (const text of ["not-json", "null", "[]", '{"projects":null}',
      JSON.stringify({ projects: [{ root: project, policy: "other-project" }] })]) {
      writeFileSync(configPath, text);
      assert.equal(await guard.onToolCall(toolEvent("bash", "git reset --hard"), { cwd: project }), undefined);
    }
  } finally {
    writeFileSync(configPath, config);
  }
});

test("explicit project-root overrides the helpers' source location", async () => {
  const git = await import("../components/virev/policies/auto-sns-agent/agent-git-guard.mjs");
  const projectConfig = { repoRoot: project, cwd: subdir };
  assert.match(git.analyze("git reset --hard", projectConfig), /git reset/);
  assert.equal(git.analyze("git status", projectConfig), null);
  assert.equal(git.analyze(`git -C '${unrelated}' reset --hard`, projectConfig), null);
});

test("legacy Python invocation forms remain guarded", async () => {
  for (const code of [
    "%%bash\ngit reset --hard",
    "!git reset --hard",
    'subprocess.run(["git", "reset", "--hard"])',
    'subprocess.run("git reset --hard", shell=True)',
    'os.system("git reset --hard")',
    'await bash(command="git reset --hard")',
    'handle = bash("""git reset --hard\ngit status""")',
    `handle = bash('echo ")" && git reset --hard')`,
  ]) {
    const result = await guard.onToolCall(toolEvent("ipython", code), { cwd: project });
    assert.equal(result?.block, true, code);
  }
});

test("Python comments and quoted examples are not calls", async () => {
  for (const code of [
    '# bash("git reset --hard")',
    `example = 'bash("git reset --hard")'`,
    'print("git reset --hard")',
    'handle = bash(command)',
    'subprocess.run(argv, cwd="git reset --hard")',
  ]) {
    assert.equal(await guard.onToolCall(toolEvent("ipython", code), { cwd: project }), undefined, code);
  }
});

test("off switch keeps the tool unchanged", async () => {
  const previous = process.env.VIREV_GIT_GUARD;
  process.env.VIREV_GIT_GUARD = "off";
  try {
    assert.equal(await guard.onToolCall(toolEvent("bash", "git reset --hard"), { cwd: project }), undefined);
  } finally {
    if (previous === undefined) delete process.env.VIREV_GIT_GUARD;
    else process.env.VIREV_GIT_GUARD = previous;
  }
});


test("symlink targets outside the project stay outside its policy", async () => {
  const linked = join(project, "external-link");
  symlinkSync(unrelated, linked, "dir");
  assert.equal(await guard.onToolCall(toolEvent("bash", "git reset --hard"), { cwd: linked }), undefined);
  assert.equal(await guard.onToolCall(toolEvent("bash", `git -C '${linked}' add -A`), { cwd: project }), undefined);
});

test("missing context cwd uses the runtime process cwd", async () => {
  const cwd = process.cwd();
  process.chdir(project);
  try {
    assert.equal((await guard.onToolCall(toolEvent("bash", "git reset --hard"), {}))?.block, true);
  } finally {
    process.chdir(cwd);
  }
});
