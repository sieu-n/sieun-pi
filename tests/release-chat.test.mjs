import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/release-chat.mjs");
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const TYPECHECK = `node -e "if (process.env.TYPECHECK_FAIL) process.exit(1); setTimeout(() => {}, Number(process.env.TYPECHECK_MS || 0))"`;
const TEST = `node -e "if (process.env.TEST_FAIL) process.exit(1)"`;

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "sieun-pi-release-chat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  const home = path.join(dir, "chat");
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: cleanEnv });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  };
  const commit = (name) => {
    write("components/user-history/src/version.txt", `${name}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", name);
    return git("rev-parse", "HEAD");
  };
  mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  write(".gitignore", "node_modules/\n");
  write("components/user-history/src/chat-assets-prebuild.mjs", "");
  write("components/user-history/package.json", JSON.stringify({ name: "fixture", private: true, scripts: { typecheck: TYPECHECK, test: TEST } }));
  mkdirSync(path.join(repo, "node_modules"));
  mkdirSync(path.join(repo, "components/user-history/node_modules"));
  const kicks = path.join(dir, "kicks.log");
  const launchctl = path.join(dir, "launchctl");
  writeFileSync(launchctl, `#!/bin/sh\necho "$@" >> "${kicks}"\n`, { mode: 0o755 });
  const c1 = commit("one");
  const c2 = commit("two");
  const c3 = commit("three");
  git("checkout", "-q", "-b", "side", c1);
  const side = commit("side");
  git("checkout", "-q", "main");
  const env = (extra = {}) => ({ ...cleanEnv, SIEUN_PI_CHAT_HOME: home, SIEUN_PI_CHAT_LAUNCHCTL: launchctl, SIEUN_PI_CHAT_SYSTEMCTL: launchctl, SIEUN_PI_CHAT_SERVICE_MANAGER: "launchd", ...extra });
  const release = (args, extra) => spawnSync(process.execPath, [script, ...args, "--repo", repo], { encoding: "utf8", env: env(extra) });
  const releaseAsync = (args, extra) => new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args, "--repo", repo], { env: env(extra) });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
  const current = () => readlinkSync(path.join(home, "current"));
  const kicked = () => (existsSync(kicks) ? readFileSync(kicks, "utf8").trim().split("\n") : []);
  return { repo, home, c1, c2, c3, side, release, releaseAsync, current, kicked };
}

const id = (sha) => `release-${sha.slice(0, 7)}`;

test("a release builds the folder, flips current and kickstarts the chat", (t) => {
  const f = fixture(t);
  const result = f.release([f.c1]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), id(f.c1));
  assert.equal(f.current(), id(f.c1));
  const dir = path.join(f.home, id(f.c1));
  assert.equal(JSON.parse(readFileSync(path.join(dir, "release.json"), "utf8")).sha, f.c1);
  assert.equal(readFileSync(path.join(dir, "components/user-history/src/version.txt"), "utf8"), "one\n");
  assert.equal(readlinkSync(path.join(dir, "node_modules")), path.join(f.repo, "node_modules"));
  assert.equal(readlinkSync(path.join(dir, "components/user-history/node_modules")), path.join(f.repo, "components/user-history/node_modules"));
  assert.deepEqual(f.kicked(), [`kickstart -k gui/${userInfo().uid}/com.sieun.agent-chat`]);
  const next = f.release([f.c3, "--no-kickstart"]);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(f.current(), id(f.c3));
  assert.equal(f.kicked().length, 1);
  assert.equal(existsSync(path.join(f.home, "release.lock")), false);
});

test("on a Linux host the release restarts the systemd user unit instead", (t) => {
  const f = fixture(t);
  const result = f.release([f.c1], { SIEUN_PI_CHAT_SERVICE_MANAGER: "systemd" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.current(), id(f.c1));
  assert.deepEqual(f.kicked(), ["--user restart sieun-pi-chat.service"]);
});

test("an older release behind the lock of a newer one that holds it exits 0 at once and leaves current alone", async (t) => {
  // 10-18 11:25Z: three jobs queued da7e7e0c3 behind the release of 8957c594a, which held it already.
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const newer = f.releaseAsync([f.c3], { TYPECHECK_MS: "1500" });
  while (!existsSync(path.join(f.home, "release.lock"))) await new Promise((done) => setTimeout(done, 20));
  for (const sha of [f.c2, f.c3]) {
    const older = await f.releaseAsync([sha]);
    assert.equal(older.status, 0, older.stderr);
    assert.match(older.stderr, new RegExp(`${sha.slice(0, 7)} is already in the release of ${f.c3.slice(0, 7)} that pid \\d+ runs now`));
    assert.doesNotMatch(older.stderr, /waiting for the release of/);
  }
  const won = await newer;
  assert.equal(won.status, 0, won.stderr);
  assert.doesNotMatch(won.stderr, /restart left to/);
  assert.equal(f.current(), id(f.c3));
  assert.equal(existsSync(path.join(f.home, id(f.c2))), false);
  assert.equal(f.kicked().length, 1);
});

test("a commit the live release already holds exits 0 with nothing built, flipped or restarted", (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c3]).status, 0);
  for (const sha of [f.c3, f.c2]) {
    const again = f.release([sha]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stderr, new RegExp(`${sha.slice(0, 7)} already live in ${id(f.c3)}; nothing to do`));
    assert.equal(again.stdout.trim(), id(f.c3));
  }
  assert.equal(f.current(), id(f.c3));
  assert.equal(existsSync(path.join(f.home, id(f.c2))), false);
  assert.equal(f.kicked().length, 1);
  assert.equal(existsSync(path.join(f.home, "release.lock")), false);
});

test("two releases started together end on the newer one", async (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const [older, newer] = await Promise.all([f.releaseAsync([f.c2], { TYPECHECK_MS: "300" }), f.releaseAsync([f.c3], { TYPECHECK_MS: "300" })]);
  assert.equal(newer.status, 0, newer.stderr);
  assert.ok([0, 3].includes(older.status), older.stderr);
  assert.equal(f.current(), id(f.c3));
});

test("going back to an older or unrelated commit needs --rollback, and an older one without it changes nothing", (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  assert.equal(f.release([f.c3, "--no-kickstart"]).status, 0);
  const kept = f.release([f.c1]);
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stderr, /already live in/);
  assert.equal(f.current(), id(f.c3));
  const refused = f.release([f.side, "--no-kickstart"]);
  assert.equal(refused.status, 3);
  assert.match(refused.stderr, /Pass --rollback/);
  const back = f.release([id(f.c1), "--rollback"]);
  assert.equal(back.status, 0, back.stderr);
  assert.match(back.stderr, /built already/);
  assert.equal(back.stdout.trim(), id(f.c1));
  assert.equal(f.current(), id(f.c1));
  assert.equal(f.kicked().length, 1);
});

test("a failed typecheck or test leaves current and the folders as they were", (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  for (const fail of ["TYPECHECK_FAIL", "TEST_FAIL"]) {
    const failed = f.release([f.c2], { [fail]: "1" });
    assert.equal(failed.status, 1, fail);
    assert.equal(f.current(), id(f.c1));
    assert.equal(existsSync(path.join(f.home, id(f.c2))), false);
    assert.equal(existsSync(path.join(f.home, "release.lock")), false);
  }
});

test("a lock left by a dead process is taken over", (t) => {
  const f = fixture(t);
  mkdirSync(f.home, { recursive: true });
  writeFileSync(path.join(f.home, "release.lock"), JSON.stringify({ pid: 999999, sha: f.c2, startedAt: "2026-10-15T00:00:00Z" }));
  const result = f.release([f.c1, "--no-kickstart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /took over a stale lock/);
  assert.equal(f.current(), id(f.c1));
});

test("a release that ends while a newer one waits leaves the restart to it, so the two restart once", async (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const first = f.releaseAsync([f.c2], { TYPECHECK_MS: "1500" });
  while (!existsSync(path.join(f.home, "release.lock"))) await new Promise((done) => setTimeout(done, 20));
  const second = f.releaseAsync([f.c3]);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.match(a.stderr, /restart left to the waiting release of/);
  assert.equal(f.current(), id(f.c3));
  assert.equal(f.kicked().length, 1);
  assert.equal(existsSync(path.join(f.home, "restart.owed")), false);
});

test("a waiting release whose build fails still restarts for the one it was left", async (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const first = f.releaseAsync([f.c2], { TYPECHECK_MS: "1500" });
  while (!existsSync(path.join(f.home, "release.lock"))) await new Promise((done) => setTimeout(done, 20));
  const second = f.releaseAsync([f.c3], { TEST_FAIL: "1" });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 1, b.stderr);
  assert.equal(f.current(), id(f.c2));
  assert.equal(f.kicked().length, 1);
  assert.equal(existsSync(path.join(f.home, "restart.owed")), false);
});
