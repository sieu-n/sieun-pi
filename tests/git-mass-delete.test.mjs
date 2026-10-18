import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { declaredDeletes, verdict } from "../scripts/git-hooks/mass-delete.mjs";

// 5557c587a on 10-18 05:34Z: a commit from a private index built from an empty tree kept its one file and deleted the other 712.
const hooks = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/git-hooks");
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

function repo(t, files = 500) {
  const dir = mkdtempSync(path.join(tmpdir(), "sieun-pi-mass-delete-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const work = path.join(dir, "work");
  const run = (args, env = {}, input) => spawnSync("git", args, { cwd: work, input, encoding: "utf8", env: { ...cleanEnv, ...env } });
  const git = (args, env, input) => {
    const result = run(args, env, input);
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    writeFileSync(path.join(work, file), text);
  };
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", path.join(dir, "origin.git")]);
  mkdirSync(work);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "core.hooksPath", hooks]);
  git(["remote", "add", "origin", path.join(dir, "origin.git")]);
  for (let i = 0; i < files; i++) write(`skills/s${i % 25}/f${i}.md`, `${i}\n`);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);
  git(["push", "-q", "origin", "main"]);
  const remoteHead = () => spawnSync("git", ["rev-parse", "main"], { cwd: path.join(dir, "origin.git"), encoding: "utf8", env: cleanEnv }).stdout.trim();
  return { work, run, git, write, remoteHead };
}

function emptyIndexTree({ work, git, write }) {
  rmSync(path.join(work, "skills"), { recursive: true });
  const env = { GIT_INDEX_FILE: path.join(work, ".git/index-private") };
  git(["read-tree", "--empty"], env);
  write("components/user-history/src/duty.ts", "duty\n");
  git(["add", "components/user-history/src/duty.ts"], env);
  return env;
}

test("the commit-msg hook refuses the 5557c587a commit from an empty private index", (t) => {
  const r = repo(t);
  const head = r.git(["rev-parse", "HEAD"]);
  const env = emptyIndexTree(r);
  const result = r.run(["commit", "-q", "-m", "fix(user-history): a CI wait moves a step only while a wake watches its run"], env);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /deletes 500 of 500 tracked files \(100%\)/);
  assert.match(result.stderr, /Deletes: 500 files on purpose/);
  assert.equal(r.git(["rev-parse", "HEAD"]), head);
});

test("the pre-push hook refuses the same commit made with commit-tree, which runs no commit hook", (t) => {
  const r = repo(t);
  const before = r.remoteHead();
  const tree = r.git(["write-tree"], emptyIndexTree(r));
  const commit = r.git(["commit-tree", tree, "-p", "HEAD", "-m", "fix(user-history): a duty"]);
  r.git(["update-ref", "refs/heads/main", commit]);
  const result = r.run(["push", "-q", "origin", "main"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`pre-push: refused commit ${commit.slice(0, 9)}, because it deletes 500 of 500`));
  assert.equal(r.remoteHead(), before);
});

test("a commit that deletes 20 files lands, and one that deletes 21 needs its Deletes line", (t) => {
  const r = repo(t);
  r.git(["rm", "-q", "-r", "--", ...Array.from({ length: 20 }, (_, i) => `skills/s${i % 25}/f${i}.md`)]);
  r.git(["commit", "-q", "-m", "chore: drop 20 notes"]);
  r.git(["rm", "-q", "-r", "--", ...Array.from({ length: 21 }, (_, i) => `skills/s${(i + 20) % 25}/f${i + 20}.md`)]);
  const refused = r.run(["commit", "-q", "-m", "chore: drop 21 notes"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /deletes 21 of 480/);
  r.git(["commit", "-q", "-m", "chore: drop 21 notes\n\nDeletes: 21 files on purpose"]);
  r.git(["push", "-q", "origin", "main"]);
  assert.equal(r.remoteHead(), r.git(["rev-parse", "HEAD"]));
});

test("in a small tree the 5% share binds before the 20 files", (t) => {
  const r = repo(t, 40);
  r.git(["rm", "-q", "skills/s0/f0.md", "skills/s1/f1.md", "skills/s2/f2.md"]);
  assert.equal(r.run(["commit", "-q", "-m", "chore: drop three"]).status, 1);
  r.git(["commit", "-q", "-m", "chore: drop three\n\nDeletes: 3 files on purpose"]);
});

test("the Deletes line must cover every deleted file", () => {
  assert.equal(declaredDeletes("fix: x\n\nDeletes: 326 files on purpose\n"), 326);
  assert.equal(declaredDeletes("fix: x\n# Deletes: 900 files on purpose\n"), 0);
  assert.equal(verdict({ deleted: 9, total: 712, message: "docs: fold nine skills" }), null);
  assert.match(verdict({ deleted: 326, total: 712, message: "test: cut\n\nDeletes: 300 files on purpose" }), /deletes 326 of 712/);
  assert.equal(verdict({ deleted: 326, total: 712, message: "test: cut\n\nDeletes: 326 files on purpose" }), null);
});
