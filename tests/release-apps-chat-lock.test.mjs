// Runs scripts/release-apps-chat.mjs with a temp HOME and a temp repo that has no origin, so it stops at the origin check (exit 4) after it
// takes the lock, before any build, unit or systemctl call.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

const script = resolve(import.meta.dirname, "../scripts/release-apps-chat.mjs");
const root = mkdtempSync(join(tmpdir(), "release-lock-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** A pid no process holds: a child that ran and exited. */
function deadPid() {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

test("taking the lock removes a waiting release's draft whose pid is gone and keeps a live one", () => {
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  execFileSync("git", ["-C", repo, "add", "a.txt"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a"]);
  const home = join(root, "home");
  const dir = join(home, ".local/share/sieun-pi-apps-chat");
  mkdirSync(dir, { recursive: true });
  const dead = deadPid();
  writeFileSync(join(dir, `release.lock.${dead}`), `${JSON.stringify({ pid: dead, sha: "0".repeat(40) })}\n`);
  writeFileSync(join(dir, `release.lock.${process.pid}`), `${JSON.stringify({ pid: process.pid, sha: "1".repeat(40) })}\n`);
  const result = spawnSync(process.execPath, [script, "HEAD", "--repo", repo], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(result.status, 4, result.stderr);
  assert.equal(existsSync(join(dir, `release.lock.${dead}`)), false);
  assert.equal(existsSync(join(dir, `release.lock.${process.pid}`)), true);
  assert.deepEqual(readdirSync(dir).sort(), [`release.lock.${process.pid}`]);
});
