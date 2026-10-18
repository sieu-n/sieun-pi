#!/usr/bin/env node
// Refuses a commit or a push that deletes many tracked files, unless its message says so on purpose.
// On 10-18 at 05:34Z, 5557c587a deleted all 712 files of main: its author committed from a private index built from an empty tree.
// Every box's prime-sync moved its checkout there within a minute, and every agent's skill links pointed into it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MAX_FILES = 20;
export const MAX_SHARE = 0.05;
const DECLARED = /^Deletes: (\d+) files? on purpose\.?\s*$/gm;
const ZERO = /^0+$/;

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

const lines = (text) => text.split("\0").filter(Boolean);

export function declaredDeletes(message) {
  return Math.max(0, ...[...message.matchAll(DECLARED)].map((match) => Number(match[1])));
}

/** Null when the commit may land, else the reason it may not. */
export function verdict({ deleted, total, message }) {
  if (deleted <= MAX_FILES && deleted <= total * MAX_SHARE) return null;
  if (declaredDeletes(message) >= deleted) return null;
  const share = total ? Math.round((deleted / total) * 100) : 100;
  return `it deletes ${deleted} of ${total} tracked files (${share}%), over the limit of ${MAX_FILES} files or ${MAX_SHARE * 100}% of the tree`;
}

function refusal(where, subject, reason, deleted) {
  return [
    `${where}: refused ${subject}, because ${reason}.`,
    "A commit built from an empty or partial private index deletes every file it left out, as 5557c587a did on 10-18.",
    "If you did not mean to delete these files, rebuild the index from HEAD (git read-tree HEAD) and stage only your files.",
    `If the deletes are a real cleanup, add this line to the commit message: Deletes: ${deleted} files on purpose`,
    "",
  ].join("\n");
}

/** commit-msg: compares the index the commit is about to record with HEAD. */
export function checkStagedCommit(cwd, message) {
  if (spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd }).status !== 0) return null;
  const deleted = lines(git(["diff-index", "--cached", "-z", "--no-renames", "--diff-filter=D", "--name-only", "HEAD"], cwd)).length;
  if (deleted === 0) return null;
  const total = lines(git(["ls-tree", "-r", "-z", "--name-only", "HEAD"], cwd)).length;
  const reason = verdict({ deleted, total, message });
  return reason && refusal("commit-msg", "this commit", reason, deleted);
}

/** One commit against its parents. A merge counts only paths it drops from every parent. */
export function checkCommit(cwd, commit) {
  const [, ...parents] = git(["rev-list", "--parents", "-n", "1", commit], cwd).trim().split(" ");
  if (parents.length === 0) return null;
  const counts = parents.map((parent) => lines(git(["diff-tree", "-r", "-z", "--no-renames", "--diff-filter=D", "--name-only", parent, commit], cwd)).length);
  const deleted = Math.min(...counts);
  if (deleted === 0) return null;
  const total = lines(git(["ls-tree", "-r", "-z", "--name-only", parents[0]], cwd)).length;
  const reason = verdict({ deleted, total, message: git(["log", "-1", "--format=%B", commit], cwd) });
  return reason && refusal("pre-push", `commit ${commit.slice(0, 9)}`, reason, deleted);
}

/** pre-push: every commit the push sends that the remote lacks. Input lines are `<local ref> <local sha> <remote ref> <remote sha>`. */
export function checkPush(cwd, remote, input) {
  const problems = [];
  for (const line of input.split("\n").filter(Boolean)) {
    const [, local, , remoteSha] = line.split(" ");
    if (ZERO.test(local)) continue;
    const known = !ZERO.test(remoteSha) && spawnSync("git", ["cat-file", "-e", `${remoteSha}^{commit}`], { cwd }).status === 0;
    const range = known ? [local, `^${remoteSha}`] : [local, "--not", `--remotes=${remote}`];
    for (const commit of git(["rev-list", ...range], cwd).split("\n").filter(Boolean)) {
      const problem = checkCommit(cwd, commit);
      if (problem) problems.push(problem);
    }
  }
  return problems;
}

function main([mode, arg]) {
  const cwd = process.cwd();
  if (mode === "commit-msg") return [checkStagedCommit(cwd, readFileSync(arg, "utf8"))].filter(Boolean);
  if (mode === "pre-push") return checkPush(cwd, arg, readFileSync(0, "utf8"));
  throw new Error(`unknown mode ${mode}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const problems = main(process.argv.slice(2));
    if (problems.length > 0) {
      process.stderr.write(problems.join("\n"));
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`mass-delete check failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
