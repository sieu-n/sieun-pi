import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findProject, projectsFile } from "../components/virev/repo-hooks/project.mjs";
import { onToolCall } from "../components/virev/ext-impl/virev/git-guard.mjs";
import { judge } from "../components/virev/policies/auto-sns-agent/agent-guards.mjs";

const temp = mkdtempSync(join(tmpdir(), "virev-scope-"));
const first = join(temp, "first");
const second = join(temp, "second");
const unrelated = join(temp, "unrelated");
const nested = join(first, "vendor/nested");
const worktree = join(first, "vendor/worktree");
const subdir = join(first, "apps/search");
const configPath = join(temp, "virev-projects.json");
for (const path of [first, second, unrelated, nested]) mkdirSync(join(path, ".git"), { recursive: true });
mkdirSync(worktree);
writeFileSync(join(worktree, ".git"), "gitdir: /not-read-by-this-test\n");
mkdirSync(subdir, { recursive: true });
const saved = { projects: process.env.VIREV_PROJECTS_FILE, home: process.env.HOME };
process.env.VIREV_PROJECTS_FILE = configPath;
const entry = (root) => ({ root, policy: "auto-sns-agent" });
const configure = (projects) => writeFileSync(configPath, JSON.stringify({ projects }));
const event = (command) => ({ type: "tool_call", toolCallId: "scope", toolName: "bash", input: { command } });
const call = (cwd, command = "git reset --hard") => onToolCall(event(command), { cwd });

test.beforeEach(() => configure([entry(first)]));
test.after(() => {
  if (saved.projects === undefined) delete process.env.VIREV_PROJECTS_FILE;
  else process.env.VIREV_PROJECTS_FILE = saved.projects;
  if (saved.home === undefined) delete process.env.HOME;
  else process.env.HOME = saved.home;
  rmSync(temp, { recursive: true, force: true });
});

test("the default configuration is global and the explicit override wins", async () => {
  const home = join(temp, "home");
  const globalFile = join(home, ".prime/agent/virev-projects.json");
  mkdirSync(join(home, ".prime/agent"), { recursive: true });
  writeFileSync(globalFile, JSON.stringify({ projects: [entry(second)] }));
  process.env.HOME = home;
  delete process.env.VIREV_PROJECTS_FILE;
  try {
    assert.equal(projectsFile(), globalFile);
    assert.equal((await call(second))?.block, true);
    assert.equal(await call(first), undefined);
    process.env.VIREV_PROJECTS_FILE = configPath;
    assert.equal(projectsFile(), configPath);
    assert.equal((await call(first))?.block, true);
    assert.equal(await call(second), undefined);
  } finally {
    process.env.VIREV_PROJECTS_FILE = configPath;
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
  }
});

test("project-local legacy markers never opt in", async () => {
  configure([]);
  const legacy = join(first, ".prime/agent");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "virev-project.json"), '{"project":"auto-sns-agent"}');
  assert.equal(await call(first), undefined);
  rmSync(configPath);
  assert.equal(await call(first), undefined);
});

test("multiple roots opt in independently and config edits apply on the next call", async () => {
  configure([entry(first), entry(second)]);
  assert.equal((await call(first))?.block, true);
  assert.equal((await call(second))?.block, true);
  assert.equal(await call(unrelated), undefined);
  configure([entry(second)]);
  assert.equal(await call(first), undefined);
  assert.equal((await call(second))?.block, true);
  assert.deepEqual(findProject(second), { repoRoot: realpathSync(second), cwd: realpathSync(second), policy: "auto-sns-agent" });
});

for (const invalid of [null, [], {}, { root: first }, { root: first, policy: null },
  { root: first, policy: "" }, { root: first, policy: "unknown" }, entry("first"),
  entry(join(temp, "missing")), entry(configPath), { root: 42, policy: "auto-sns-agent" }]) {
  test(`invalid or unsupported entry does not opt in: ${JSON.stringify(invalid)}`, async () => {
    configure([invalid]);
    assert.equal(await call(first), undefined);
  });
}

test("invalid entries do not disable separate valid entries", async () => {
  configure([null, entry("relative"), entry(first)]);
  assert.equal((await call(first))?.block, true);
});

test("directory prefixes and independent Git boundaries do not inherit policy", async () => {
  const prefix = join(temp, "first-other");
  mkdirSync(prefix);
  for (const cwd of [prefix, nested, worktree, join(nested, "missing/subdir")]) {
    assert.equal(findProject(cwd), null);
    assert.equal(await call(cwd), undefined);
    for (const command of ["git add -A", "npx convex dev --once", "pnpm test"]) {
      assert.equal(await call(first, `cd '${cwd}' && ${command}`), undefined);
    }
    assert.equal(await call(first, `git -C '${cwd}' reset --hard`), undefined);
    assert.equal(await call(first, `git --git-dir='${cwd}/.git' reset --hard`), undefined);
    assert.equal(await call(first, `git --work-tree='${cwd}' reset --hard`), undefined);
  }
  assert.equal((await call(subdir))?.block, true);
});

test("an independent nested checkout requires its own explicit opt-in", async () => {
  assert.equal(await call(nested), undefined);
  configure([entry(first), entry(nested)]);
  assert.equal((await call(nested))?.block, true);
  assert.equal(findProject(nested).repoRoot, realpathSync(nested));
});

test("symlinked roots resolve to the same checkout and escapes stay outside", async () => {
  const alias = join(temp, "alias");
  const escape = join(first, "escape");
  symlinkSync(first, alias, "dir");
  symlinkSync(unrelated, escape, "dir");
  configure([entry(alias)]);
  assert.equal((await call(first))?.block, true);
  assert.equal((await call(join(alias, "apps/search")))?.block, true);
  for (const cwd of [escape, join(escape, "not-yet-created")]) {
    assert.equal(await call(cwd), undefined);
    assert.equal(await call(first, `cd '${cwd}' && npx convex dev --once`), undefined);
    assert.equal(await call(first, `git -C '${cwd}' reset --hard`), undefined);
  }
});

test("unrelated repositories get no company Git, Convex, or local-check rules", async () => {
  for (const command of ["git reset --hard", "git push origin main", "npx convex dev --once",
    "CONVEX_DEPLOYMENT=prod:example npx convex dev --once", "pnpm test", "uv run pytest"]) {
    assert.equal((await call(first, command))?.block, true);
    assert.equal(await call(unrelated, command), undefined);
  }
});

test("Convex duplicate-watcher checks remain policy-scoped", () => {
  const options = { repoRoot: first, cwd: first, convexWatchers: 1 };
  assert.match(judge("npx convex dev", options).deny, /ALREADY running/);
  assert.equal(judge("npx convex dev", { ...options, cwd: unrelated }), null);
  assert.equal(judge(`cd '${nested}' && npx convex dev`, options), null);
  assert.equal(judge("npx convex dev", { ...options, convexWatchers: 0 }), null);
});
