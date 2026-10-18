import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hooks = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/git-hooks");
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

function repo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "sieun-pi-stale-index-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (args, env = {}) => spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...cleanEnv, ...env } });
  const git = (args, env) => {
    const result = run(args, env);
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  const privateCommit = (message, stage) => {
    const env = { GIT_INDEX_FILE: path.join(dir, ".git/index-private") };
    git(["read-tree", "HEAD"], env);
    stage((args) => git(args, env));
    git(["commit", "-q", "-m", message], env);
    rmSync(env.GIT_INDEX_FILE);
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "core.hooksPath", hooks]);
  write("components/chats.ts", "fallback on\n");
  write("components/pool.ts", "one account\n");
  write("components/virev/index.mjs", "virev\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);
  return { dir, run, git, write, privateCommit, show: (spec) => git(["show", spec]) };
}

test("a shared-index commit cannot revert a file another session committed through a private index (8df54b1 over 48d3adf)", (t) => {
  const r = repo(t);
  r.write("components/chats.ts", "fallback removed\n");
  r.privateCommit("chat fallback removal", (git) => git(["add", "components/chats.ts"]));
  const fallbackRemoval = r.git(["rev-parse", "HEAD"]);
  r.write("components/pool.ts", "two accounts\n");
  r.git(["add", "components/pool.ts"]);
  const refused = r.run(["commit", "-q", "-m", "pool job"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /M components\/chats\.ts {2}\(the working tree matches HEAD\)/);
  assert.equal(r.git(["rev-parse", "HEAD"]), fallbackRemoval);
  const fix = refused.stderr.split("\n").find((line) => line.includes("--cacheinfo")).trim();
  assert.match(fix, /^git update-index --add --cacheinfo 100644,[0-9a-f]{40},"components\/chats\.ts"$/);
  r.git(["update-index", "--add", "--cacheinfo", fix.split(" ")[4].replaceAll('"', "")]);
  r.git(["commit", "-q", "-m", "pool job"]);
  assert.equal(r.show("HEAD:components/chats.ts"), "fallback removed");
  assert.equal(r.show("HEAD:components/pool.ts"), "two accounts");
});

test("a shared-index commit cannot undo a move another session committed (baac96c over 7f51876)", (t) => {
  const r = repo(t);
  mkdirSync(path.join(r.dir, "components/global-rules"));
  renameSync(path.join(r.dir, "components/virev/index.mjs"), path.join(r.dir, "components/global-rules/index.mjs"));
  r.privateCommit("replace virev with global-rules", (git) => {
    git(["rm", "-q", "--cached", "components/virev/index.mjs"]);
    git(["add", "components/global-rules/index.mjs"]);
  });
  const move = r.git(["rev-parse", "HEAD"]);
  r.write("components/chats.ts", "plan card fix\n");
  r.git(["add", "components/chats.ts"]);
  const refused = r.run(["commit", "-q", "-m", "user-history"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /D components\/global-rules\/index\.mjs {2}\(the working tree matches HEAD\)/);
  assert.match(refused.stderr, /A components\/virev\/index\.mjs {2}\(the working tree matches HEAD\)/);
  assert.match(refused.stderr, /git update-index --force-remove -- "components\/virev\/index\.mjs"/);
  assert.equal(r.git(["rev-parse", "HEAD"]), move);
  r.git(["commit", "-q", "-m", "user-history", "--", "components/chats.ts"]);
  assert.equal(r.git(["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").sort().join(","),
    "components/chats.ts,components/global-rules/index.mjs,components/pool.ts");
});

test("a stale entry is refused even when the working tree has moved on since", (t) => {
  const r = repo(t);
  r.write("components/chats.ts", "fallback removed\n");
  r.privateCommit("chat fallback removal", (git) => git(["add", "components/chats.ts"]));
  r.write("components/chats.ts", "fallback removed, still editing\n");
  r.write("components/pool.ts", "two accounts\n");
  r.git(["add", "components/pool.ts"]);
  const refused = r.run(["commit", "-q", "-m", "pool job"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /M components\/chats\.ts {2}\(the staged blob is an older committed version\)/);
});

test("ordinary commits, partial staging and real deletions pass", (t) => {
  const r = repo(t);
  r.write("components/chats.ts", "fallback removed\nand more\n");
  r.git(["rm", "-q", "components/virev/index.mjs"]);
  r.write("components/pool.ts", "two accounts\n");
  r.git(["add", "components/pool.ts"]);
  const partial = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: r.dir, input: "fallback removed\n", encoding: "utf8", env: cleanEnv }).stdout.trim();
  r.git(["update-index", "--cacheinfo", `100644,${partial},components/chats.ts`]);
  r.git(["commit", "-q", "-m", "work"]);
  assert.equal(r.show("HEAD:components/chats.ts"), "fallback removed");
  assert.equal(readFileSync(path.join(r.dir, "components/chats.ts"), "utf8"), "fallback removed\nand more\n");
  assert.equal(r.run(["cat-file", "-e", "HEAD:components/virev/index.mjs"]).status === 0, false);
});
