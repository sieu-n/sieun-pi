// Guards owner rule c119: the Mac works on one dev branch, dev/sieun-mac. The handled check reads the Mac checkout's own branch, so it follows
// the Mac's move from dev/sieun-mac-a to dev/sieun-mac with no edit.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { devBranch } from "../scripts/duties/staging-design-rules.ts";

test("the handled check reads the Mac checkout's agent.branch, else its current branch", async () => {
  const repo = mkdtempSync(join(tmpdir(), "d6-branch-"));
  try {
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "dev/sieun-mac"]);
    assert.equal(await devBranch(repo), "dev/sieun-mac");
    execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "scratch"]);
    assert.equal(await devBranch(repo), "scratch");
    execFileSync("git", ["-C", repo, "config", "agent.branch", "dev/sieun-mac"]);
    assert.equal(await devBranch(repo), "dev/sieun-mac");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
