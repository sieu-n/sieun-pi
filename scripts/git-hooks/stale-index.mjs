#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstatSync, readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ZERO = /^0+$/;

function git(args, cwd, input) {
  const result = spawnSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function stagedEntries(cwd) {
  const fields = git(["diff-index", "--cached", "-z", "--no-renames", "HEAD"], cwd).split("\0");
  const entries = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [headMode, indexMode, headSha, indexSha, status] = fields[i].slice(1).split(" ");
    entries.push({
      path: fields[i + 1],
      status,
      headMode,
      head: ZERO.test(headSha) ? null : headSha,
      index: ZERO.test(indexSha) ? null : indexSha,
      gitlink: headMode === "160000" || indexMode === "160000",
    });
  }
  return entries;
}

function worktreeBlob(cwd, path) {
  const full = `${cwd}/${path}`;
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return git(["hash-object", "--stdin"], cwd, readlinkSync(full)).trim();
  if (stat.isFile()) return git(["hash-object", "--", path], cwd).trim();
  return null;
}

function earlierVersions(cwd, path) {
  const raw = git(["log", "--format=", "--raw", "--no-abbrev", "-n", "200", "HEAD", "--", path], cwd);
  return new Set(raw.split("\n").flatMap((line) => line.split("\t")[0].split(" ").slice(2, 4)));
}

export function findStaleEntries(cwd) {
  if (spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd }).status !== 0) return [];
  const entries = stagedEntries(cwd).filter((entry) => !entry.gitlink);
  const stale = [];
  for (const entry of entries) {
    const work = worktreeBlob(cwd, entry.path);
    if (entry.index === work) continue;
    if (work === entry.head) stale.push({ ...entry, reason: "the working tree matches HEAD" });
    else if (entry.index && earlierVersions(cwd, entry.path).has(entry.index)) {
      stale.push({ ...entry, reason: "the staged blob is an older committed version" });
    }
  }
  return stale;
}

function fixCommand(entry) {
  const path = JSON.stringify(entry.path);
  if (!entry.head) return `git update-index --force-remove -- ${path}`;
  return `git update-index --add --cacheinfo ${entry.headMode},${entry.head},${path}`;
}

export function staleReport(stale) {
  const rows = stale.map((entry) => `  ${entry.status} ${entry.path}  (${entry.reason})`);
  const fixes = stale.map((entry) => `  ${fixCommand(entry)}`);
  return [
    "pre-commit: refused. These staged paths are stale index entries, not your changes.",
    "Committing them would revert work that another session committed through a private index.",
    ...rows,
    "",
    "Reset each entry to HEAD (this leaves the working tree alone):",
    ...fixes,
    "",
    "Or commit only your files: git commit -m \"...\" -- <your files>. It leaves these entries alone.",
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const stale = findStaleEntries(process.cwd());
    if (stale.length > 0) {
      process.stderr.write(staleReport(stale));
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`pre-commit: stale-index check failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
