import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/release-chat.mjs");
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const BUILD_CONTROLS = ["TYPECHECK_FAIL", "TYPECHECK_MS", "TEST_FAIL", "TEST_HANG"];
const BUILD_STEP = `import { connect } from "node:net";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
const [step, dir] = process.argv.slice(2);
const id = /\\.building-(release-[0-9a-f]+)-/.exec(process.cwd())[1];
const controls = path.join(dir, "controls", id + ".json");
const control = existsSync(controls) ? JSON.parse(readFileSync(controls, "utf8")) : {};
const live = path.join(dir, "live");
writeFileSync(path.join(dir, "seen", id + "-" + step + ".json"), JSON.stringify(process.env));
writeFileSync(path.join(dir, "seen", id + "-" + step + ".kicks"), existsSync(path.join(dir, "kicks.log")) ? readFileSync(path.join(dir, "kicks.log"), "utf8") : "");
for (const [key, value] of Object.entries(process.env)) {
  if (!value.startsWith(live)) continue;
  const stat = statSync(value, { throwIfNoEntry: false });
  if (stat?.isSocket()) await new Promise(done => connect(value).on("connect", function () { this.end(key); done(); }).on("error", done));
  else if (stat?.isDirectory()) writeFileSync(path.join(value, "touched-" + key), step);
}
if (control[step.toUpperCase() + "_FAIL"]) process.exit(1);
if (step === "typecheck") await new Promise(done => setTimeout(done, Number(control.TYPECHECK_MS || 0)));
if (step === "test" && control.TEST_HANG) {
  writeFileSync(path.join(dir, "seen", id + "-test.pid"), String(process.pid));
  setInterval(() => {}, 1000);
}
`;

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "sieun-pi-release-chat-"));
  // Each async release runs in its own process group, and teardown kills every group before it removes the folder: on 10-18 at 13:08Z a failed
  // assertion left a release and its hung npm test running for 61 min after its folder was gone.
  const groups = [];
  t.after(() => {
    for (const pid of groups) try { process.kill(-pid, "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
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
  mkdirSync(path.join(dir, "controls"));
  mkdirSync(path.join(dir, "seen"));
  writeFileSync(path.join(dir, "build-step.mjs"), BUILD_STEP);
  const step = (name) => `node ${JSON.stringify(path.join(dir, "build-step.mjs"))} ${name} ${JSON.stringify(dir)}`;
  write("components/user-history/package.json", JSON.stringify({ name: "fixture", private: true, scripts: { typecheck: step("typecheck"), test: step("test") } }));
  mkdirSync(path.join(repo, "node_modules"));
  mkdirSync(path.join(repo, "components/user-history/node_modules"));
  const kicks = path.join(dir, "kicks.log");
  const launchctl = path.join(dir, "launchctl");
  // A fake launchctl and systemctl in one: is-active and print answer from service.state, every other call is logged and moves that state.
  const state = path.join(dir, "service.state");
  writeFileSync(launchctl, [
    "#!/bin/sh",
    `state=$(cat "${state}" 2>/dev/null)`,
    'case "$*" in',
    '  *is-active*) [ "$state" = running ]; exit $? ;;',
    '  print\\ *) echo "	state = ${state:-not running}"; exit 0 ;;',
    "esac",
    `echo "$@" >> "${kicks}"`,
    `env > "${path.join(dir, "kick.env")}"`,
    'case "$*" in',
    `  *stop*) echo stopped > "${state}" ;;`,
    `  *start*) echo running > "${state}" ;;`,
    "esac",
    "",
  ].join("\n"), { mode: 0o755 });
  const c1 = commit("one");
  const c2 = commit("two");
  const c3 = commit("three");
  const c4 = commit("four");
  git("checkout", "-q", "-b", "side", c1);
  const side = commit("side");
  git("checkout", "-q", "main");
  const origin = path.join(dir, "origin.git");
  assert.equal(spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: cleanEnv }).status, 0);
  git("remote", "add", "origin", origin);
  const publish = (ref = "main") => git("push", "-q", "origin", `${ref}:main`);
  publish();
  const env = (args, extra = {}) => {
    const control = Object.fromEntries(Object.entries(extra).filter(([key]) => BUILD_CONTROLS.includes(key)));
    writeFileSync(path.join(dir, "controls", `${id(args[0])}.json`), JSON.stringify(control));
    const rest = Object.fromEntries(Object.entries(extra).filter(([key]) => !BUILD_CONTROLS.includes(key)));
    return { ...cleanEnv, SIEUN_PI_CHAT_HOME: home, SIEUN_PI_CHAT_LAUNCHCTL: launchctl, SIEUN_PI_CHAT_SYSTEMCTL: launchctl, SIEUN_PI_CHAT_SERVICE_MANAGER: "launchd", ...rest };
  };
  const release = (args, extra) => spawnSync(process.execPath, [script, ...args, "--repo", repo], { encoding: "utf8", env: env(args, extra) });
  const spawnRelease = (args, extra, helper = script) => {
    const child = spawn(process.execPath, [helper, ...args, "--repo", repo], { env: env(args, extra), detached: true });
    groups.push(child.pid);
    return child;
  };
  const releaseAsync = (args, extra, helper) => new Promise((done) => {
    const child = spawnRelease(args, extra, helper);
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
  const current = () => readlinkSync(path.join(home, "current"));
  const kicked = () => (existsSync(kicks) ? readFileSync(kicks, "utf8").trim().split("\n") : []);
  const seen = (sha, step) => JSON.parse(readFileSync(path.join(dir, "seen", `${id(sha)}-${step}.json`), "utf8"));
  const kicksAt = (sha, step) => readFileSync(path.join(dir, "seen", `${id(sha)}-${step}.kicks`), "utf8").trim().split("\n").filter(Boolean);
  const stopService = () => writeFileSync(state, "stopped\n");
  return { dir, repo, home, kicksAt, stopService, spawnRelease, c1, c2, c3, c4, side, git, write, commit, publish, env, release, releaseAsync, current, kicked, seen };
}

const id = (sha) => (sha.startsWith("release-") ? sha : `release-${sha.slice(0, 7)}`);

// A wait that fails its test instead of spinning forever when the script under test never reaches the state, as old code does. The slowest
// test here took 6.3 s end to end on us-metal02 on 10-18, so 60 s only ends a wait that will never finish.
const drafts = (home) => (existsSync(home) ? readdirSync(home).filter((name) => /^release\.lock\.\d+$/.test(name)).length : 0);

// Starts every request while a lock this test holds keeps them queued, then lets go once each has written its draft, so the release that takes
// the lock finds all of them waiting. A request is [args, extra, helper].
async function queued(f, requests) {
  mkdirSync(f.home, { recursive: true });
  const lock = path.join(f.home, "release.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, sha: "held-by-test", startedAt: new Date().toISOString() }));
  const results = requests.map(([args, extra, helper]) => f.releaseAsync(args, extra, helper));
  await waitWhile(() => drafts(f.home) < requests.length);
  rmSync(lock);
  return Promise.all(results);
}

// The helper every box ran before the fold, read from this repository's history.
const BEFORE_FOLD = "4510f7ba62f0d366a03e0c5d34472c8da6c57a36";
function helperBeforeFold(dir) {
  const shown = spawnSync("git", ["-C", path.dirname(script), "show", `${BEFORE_FOLD}:scripts/release-chat.mjs`], { encoding: "utf8", env: cleanEnv });
  assert.equal(shown.status, 0, shown.stderr);
  const file = path.join(dir, "release-chat-before-fold.mjs");
  writeFileSync(file, shown.stdout);
  return file;
}

const built = (f) => readdirSync(path.join(f.dir, "seen")).filter((name) => name.endsWith("-typecheck.json")).map((name) => name.replace(/-typecheck\.json$/, "")).sort();

async function waitWhile(pending) {
  const deadline = Date.now() + 60_000;
  while (pending()) {
    if (Date.now() > deadline) throw new Error(`still waiting after 60 s: ${pending}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

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

test("a release whose commit the in-flight release holds waits for it, then exits 0 with nothing built and one restart", async (t) => {
  // 10-18 11:25Z: three jobs queued da7e7e0c3 behind the release of 8957c594a, which held it already.
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const newer = f.releaseAsync([f.c3], { TYPECHECK_MS: "1500" });
  await waitWhile(() => !existsSync(path.join(f.home, "release.lock")));
  const [older, same] = await Promise.all([f.releaseAsync([f.c2]), f.releaseAsync([f.c3])]);
  const won = await newer;
  assert.equal(won.status, 0, won.stderr);
  for (const [sha, result] of [[f.c2, older], [f.c3, same]]) {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /waiting for the release of/);
    assert.doesNotMatch(result.stderr, /is already in the release of/);
    assert.match(result.stderr, new RegExp(`${sha.slice(0, 7)} (already live|is already) in ${id(f.c3)}`));
    assert.equal(result.stdout.trim(), id(f.c3));
  }
  assert.equal(f.current(), id(f.c3));
  assert.equal(existsSync(path.join(f.home, id(f.c2))), false);
  assert.equal(f.kicked().length, 1);
  assert.equal(existsSync(path.join(f.home, "restart.owed")), false);
});

test("a waiter whose commit the in-flight release holds goes live itself when that release fails", async (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const newer = f.releaseAsync([f.c3], { TYPECHECK_MS: "1500", TEST_FAIL: "1" });
  await waitWhile(() => !existsSync(path.join(f.home, "release.lock")));
  const older = await f.releaseAsync([f.c2]);
  const failed = await newer;
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(older.status, 0, older.stderr);
  assert.equal(older.stdout.trim(), id(f.c2));
  assert.equal(f.current(), id(f.c2));
  assert.ok(existsSync(path.join(f.home, id(f.c2), "release.json")));
  assert.equal(f.kicked().length, 1);
});

test("a commit that --no-kickstart put in current makes the restart when it is released again", (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1]).status, 0);
  assert.equal(f.release([f.c3, "--no-kickstart"]).status, 0);
  assert.equal(f.kicked().length, 1);
  const quiet = f.release([f.c3, "--no-kickstart"]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(f.kicked().length, 1);
  for (const sha of [f.c3, f.c2]) {
    const again = f.release([sha]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout.trim(), id(f.c3));
    assert.equal(f.kicked().length, 2, sha);
  }
  assert.match(f.release([f.c3]).stderr, /already live in/);
  assert.equal(f.kicked().length, 2);
  assert.equal(f.current(), id(f.c3));
  assert.equal(existsSync(path.join(f.home, "release.lock")), false);
});

test("the same commit released again installs the live release's units when the installed ones differ", (t) => {
  const f = fixture(t);
  f.write("deploy/linux/sieun-pi-chat.service", "[Service]\nExecStart=serve\n");
  const c5 = f.commit("five");
  f.publish();
  const units = path.join(f.dir, "units");
  const extra = { SIEUN_PI_CHAT_SERVICE_MANAGER: "systemd", SIEUN_PI_CHAT_UNIT_DIR: units };
  const install = ["--user daemon-reload", "--user stop sieun-pi-chat.service", "--user start sieun-pi-chat.service"];
  assert.equal(f.release([c5], extra).status, 0);
  assert.deepEqual(f.kicked(), install);
  assert.match(f.release([c5], extra).stderr, /already live in/);
  assert.deepEqual(f.kicked(), install);
  writeFileSync(path.join(units, "sieun-pi-chat.service"), "[Service]\nExecStart=edited\n");
  const again = f.release([c5], extra);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readFileSync(path.join(units, "sieun-pi-chat.service"), "utf8"), "[Service]\nExecStart=serve\n");
  assert.deepEqual(f.kicked(), [...install, ...install]);
  assert.equal(f.current(), id(c5));
});

test("a commit missing from origin main is refused with push first, and a built release still rolls back offline", (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const local = f.commit("local");
  for (const sha of [local, f.side]) {
    const refused = f.release([sha]);
    assert.equal(refused.status, 4, refused.stderr);
    assert.match(refused.stderr, new RegExp(`${sha.slice(0, 7)} is not on origin/main; push it to main first`));
    assert.equal(existsSync(path.join(f.home, id(sha))), false);
  }
  assert.equal(f.release([f.c3, "--no-kickstart"]).status, 0);
  f.git("remote", "set-url", "origin", path.join(f.dir, "gone.git"));
  const offline = f.release([f.c4]);
  assert.equal(offline.status, 4, offline.stderr);
  assert.match(offline.stderr, /could not fetch origin main/);
  const unbuilt = f.release([f.c2, "--rollback"]);
  assert.equal(unbuilt.status, 4, unbuilt.stderr);
  assert.equal(f.current(), id(f.c3));
  const back = f.release([id(f.c1), "--rollback"]);
  assert.equal(back.status, 0, back.stderr);
  assert.equal(f.current(), id(f.c1));
  assert.equal(f.kicked().length, 1);
  assert.deepEqual(f.git("for-each-ref", "refs/release-chat"), "");
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
  assert.match(kept.stderr, new RegExp(`${f.c1.slice(0, 7)} is already in ${id(f.c3)}`));
  assert.equal(f.current(), id(f.c3));
  assert.equal(f.kicked().length, 1);
  f.git("merge", "-q", "-s", "ours", "--no-edit", "side");
  f.publish();
  const refused = f.release([f.side, "--no-kickstart"]);
  assert.equal(refused.status, 3);
  assert.match(refused.stderr, /Pass --rollback/);
  const back = f.release([id(f.c1), "--rollback"]);
  assert.equal(back.status, 0, back.stderr);
  assert.match(back.stderr, /built already/);
  assert.equal(back.stdout.trim(), id(f.c1));
  assert.equal(f.current(), id(f.c1));
  assert.equal(f.kicked().length, 2);
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

test("a release that ends while a newer one waits makes its own restart, and the waiter restarts once more after its build", async (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const first = f.releaseAsync([f.c2], { TYPECHECK_MS: "1500" });
  await waitWhile(() => !existsSync(path.join(f.home, "release.lock")));
  const second = f.releaseAsync([f.c3]);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  for (const result of [a, b]) assert.doesNotMatch(result.stderr, /restart left to|restart this release was left/);
  assert.equal(f.kicksAt(f.c3, "typecheck").length, 1);
  assert.equal(f.current(), id(f.c3));
  assert.equal(f.kicked().length, 2);
  assert.equal(JSON.parse(readFileSync(path.join(f.home, "started.json"), "utf8")).id, id(f.c3));
  assert.equal(existsSync(path.join(f.home, "restart.owed")), false);
});

test("a waiting release whose build fails leaves the chat on the release before it, which made its own restart", async (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const first = f.releaseAsync([f.c2], { TYPECHECK_MS: "1500" });
  await waitWhile(() => !existsSync(path.join(f.home, "release.lock")));
  const second = f.releaseAsync([f.c3], { TEST_FAIL: "1" });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 1, b.stderr);
  assert.deepEqual(f.kicksAt(f.c3, "typecheck"), [`kickstart -k gui/${userInfo().uid}/com.sieun.agent-chat`]);
  assert.equal(f.current(), id(f.c2));
  assert.equal(JSON.parse(readFileSync(path.join(f.home, "started.json"), "utf8")).id, id(f.c2));
  assert.equal(f.kicked().length, 1);
  assert.equal(existsSync(path.join(f.home, "restart.owed")), false);
});

test("a waiting release whose tests hang finds the chat already restarted onto the release before it", { timeout: 120000 }, async (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const first = f.releaseAsync([f.c2], { TYPECHECK_MS: "1500" });
  await waitWhile(() => !existsSync(path.join(f.home, "release.lock")));
  const second = f.spawnRelease([f.c3], { TEST_HANG: "1" });
  let stderr = "";
  second.stderr.on("data", (chunk) => { stderr += chunk; });
  const ended = new Promise((done) => second.on("close", done));
  const a = await first;
  assert.equal(a.status, 0, a.stderr);
  assert.doesNotMatch(a.stderr, /restart left to/);
  const pid = path.join(f.dir, "seen", `${id(f.c3)}-test.pid`);
  await waitWhile(() => !existsSync(pid));
  assert.deepEqual(f.kicksAt(f.c3, "typecheck"), [`kickstart -k gui/${userInfo().uid}/com.sieun.agent-chat`]);
  assert.deepEqual(f.kicked(), [`kickstart -k gui/${userInfo().uid}/com.sieun.agent-chat`]);
  assert.equal(JSON.parse(readFileSync(path.join(f.home, "started.json"), "utf8")).id, id(f.c2));
  assert.equal(existsSync(path.join(f.home, "restart.owed")), false);
  second.kill("SIGTERM");
  process.kill(Number(readFileSync(pid, "utf8")), "SIGTERM");
  assert.equal(await ended, 1, stderr);
  assert.match(stderr, /npm run --silent test failed \((SIGTERM|143)\)/);
  assert.equal(f.current(), id(f.c2));
  assert.equal(existsSync(path.join(f.home, id(f.c3))), false);
  assert.deepEqual(f.kicked(), [`kickstart -k gui/${userInfo().uid}/com.sieun.agent-chat`]);
  assert.equal(existsSync(path.join(f.home, "release.lock")), false);
});

test("in a steady queue each release restarts at its own end, so no restart passes on to the next", { timeout: 120000 }, async (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const lockHolder = () => { try { return JSON.parse(readFileSync(path.join(f.home, "release.lock"), "utf8")).sha; } catch { return null; } };
  const first = f.releaseAsync([f.c2], { TYPECHECK_MS: "1500" });
  await waitWhile(() => lockHolder() !== f.c2);
  const second = f.releaseAsync([f.c3], { TYPECHECK_MS: "1500" });
  await waitWhile(() => !readdirSync(f.home).some((name) => /^release\.lock\.\d+$/.test(name)));
  await waitWhile(() => lockHolder() !== f.c3);
  const third = f.releaseAsync([f.c4]);
  const [a, b, c] = await Promise.all([first, second, third]);
  for (const result of [a, b, c]) {
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /restart left to|restart this release was left/);
  }
  assert.equal(f.kicksAt(f.c3, "typecheck").length, 1);
  assert.equal(f.kicksAt(f.c4, "typecheck").length, 2);
  assert.equal(f.current(), id(f.c4));
  assert.equal(f.kicked().length, 3);
  assert.equal(existsSync(path.join(f.home, "restart.owed")), false);
});

test("a stopped service is not applied even when started.json names current, so the same commit starts it again", (t) => {
  const f = fixture(t);
  for (const manager of ["launchd", "systemd"]) {
    const extra = { SIEUN_PI_CHAT_SERVICE_MANAGER: manager };
    const sha = manager === "launchd" ? f.c1 : f.c2;
    const before = f.kicked().length;
    assert.equal(f.release([sha], extra).status, 0);
    assert.match(f.release([sha], extra).stderr, /already live in/);
    assert.equal(f.kicked().length, before + 1);
    f.stopService();
    assert.equal(JSON.parse(readFileSync(path.join(f.home, "started.json"), "utf8")).id, id(sha));
    const again = f.release([sha], extra);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stderr, /which the chat does not run yet/);
    assert.equal(f.kicked().length, before + 2, manager);
    assert.match(f.release([sha], extra).stderr, /already live in/);
    assert.equal(f.kicked().length, before + 2);
  }
});

test("a release that finds its commit live once it takes the lock still makes the restart it owes, with the live release's units", { timeout: 120000 }, async (t) => {
  const f = fixture(t);
  for (const args of [[f.c1, "--no-kickstart"], [f.c3, "--no-kickstart"], [id(f.c1), "--rollback", "--no-kickstart"]]) assert.equal(f.release(args).status, 0);
  const lock = path.join(f.home, "release.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, sha: f.c1, startedAt: new Date().toISOString() }));
  const units = path.join(f.dir, "units");
  const waiter = f.releaseAsync([f.c2], { SIEUN_PI_CHAT_SERVICE_MANAGER: "systemd", SIEUN_PI_CHAT_UNIT_DIR: units });
  await waitWhile(() => !readdirSync(f.home).some((name) => /^release\.lock\.\d+$/.test(name)));
  mkdirSync(path.join(f.home, id(f.c3), "deploy/linux"), { recursive: true });
  writeFileSync(path.join(f.home, id(f.c3), "deploy/linux/sieun-pi-chat.service"), "[Service]\n");
  symlinkSync(id(f.c3), path.join(f.home, ".current-test"));
  renameSync(path.join(f.home, ".current-test"), path.join(f.home, "current"));
  writeFileSync(path.join(f.home, "restart.owed"), JSON.stringify({ sha: f.c3, at: new Date().toISOString() }));
  rmSync(lock);
  const result = await waiter;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`restarting onto ${id(f.c3)} for the restart this release was left \\(restart.owed\\), before its own build`));
  assert.match(result.stderr, new RegExp(`${f.c2.slice(0, 7)} already live in ${id(f.c3)}; nothing to do`));
  assert.equal(result.stdout.trim(), id(f.c3));
  assert.equal(f.current(), id(f.c3));
  assert.equal(readFileSync(path.join(units, "sieun-pi-chat.service"), "utf8"), "[Service]\n");
  assert.deepEqual(f.kicked(), ["--user daemon-reload", "--user stop sieun-pi-chat.service", "--user start sieun-pi-chat.service"]);
  assert.equal(existsSync(path.join(f.home, "restart.owed")), false);
  assert.equal(existsSync(lock), false);
});

test("the typecheck and tests see none of the agent's sockets, dirs, tokens or keys, and the restart keeps them", { timeout: 120000 }, async (t) => {
  const f = fixture(t);
  const live = path.join(f.dir, "live");
  const dirs = Object.fromEntries(["HOME", "TMPDIR", "XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "RLM_SESSION_DIR", "RLM_HARNESS_STATE_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "PI_POOL_DIR"]
    .map((key) => [key, path.join(live, key.toLowerCase())]));
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const socket = path.join(live, "daemon.sock");
  const accepted = [];
  const server = createServer((connection) => { accepted.push(connection); connection.destroy(); }).listen(socket);
  t.after(() => server.close());
  await new Promise((done) => server.once("listening", done));
  const secrets = { PRIME_API_KEY: "sentinel-prime-key", PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN: "sentinel-worker-token", LINEAR_API_KEY: "sentinel-linear-key" };
  const hostile = { ...dirs, ...secrets, PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET: socket, PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID: "sentinel-session", PI_CODING_AGENT: "true", RLM_DEPTH: "1", SSH_AUTH_SOCK: socket, NODE_OPTIONS: "--title=sentinel" };
  const result = await f.releaseAsync([f.c1], { ...hostile, SIEUN_PI_CHAT_SERVICE_MANAGER: "systemd" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.current(), id(f.c1));
  assert.deepEqual(f.kicked(), ["--user restart sieun-pi-chat.service"]);
  assert.match(readFileSync(path.join(f.dir, "kick.env"), "utf8"), new RegExp(`^XDG_RUNTIME_DIR=${dirs.XDG_RUNTIME_DIR}$`, "m"));
  const own = ["HOME", "TMPDIR", "XDG_RUNTIME_DIR", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"];
  for (const step of ["typecheck", "test"]) {
    const env = f.seen(f.c1, step);
    for (const key of Object.keys(hostile).filter((key) => !own.includes(key))) assert.equal(env[key], undefined, `${step} saw ${key}`);
    for (const key of own) {
      assert.ok(env[key] && !env[key].startsWith(live) && env[key] !== process.env[key], `${step} ${key} is its own`);
      assert.equal(existsSync(env[key]), false, `${step} ${key} is removed after the build`);
    }
    assert.ok(env.PATH.endsWith(process.env.PATH), `${step} PATH`);
  }
  assert.deepEqual(readdirSync(live, { recursive: true }).sort(), [...Object.values(dirs).map((dir) => path.relative(live, dir)), "daemon.sock"].sort());
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(accepted.length, 0);
});

test("a release deletes the folders nothing runs and keeps current, the one before, the started one and one a process uses", async (t) => {
  // 10-18: ~/.local/share/sieun-pi-chat held 118 release folders (1.5 GB) on us-metal02, and nothing ran 116 of them.
  const f = fixture(t);
  assert.equal(f.release([f.c1]).status, 0);
  assert.equal(f.release([f.c2, "--no-kickstart"]).status, 0);
  assert.equal(f.release([f.c3, "--no-kickstart"]).status, 0);
  writeFileSync(path.join(f.home, "release-4f1c45a-d1canary.log"), "");
  mkdirSync(path.join(f.home, ".building-release-abcdef0-999999"));
  const user = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: path.join(f.home, id(f.c2)) });
  t.after(() => user.kill());
  const result = f.release([f.c4, "--no-kickstart"]);
  assert.equal(result.status, 0, result.stderr);
  user.kill();
  assert.deepEqual(readdirSync(f.home).filter(name => name.startsWith("release-") || name.startsWith(".building-")).sort(),
    [id(f.c1), id(f.c2), id(f.c3), id(f.c4), "release-4f1c45a-d1canary.log"].sort());
  await new Promise(done => user.on("close", done));
  const next = f.commit("five");
  f.publish();
  assert.equal(f.release([next, "--no-kickstart"]).status, 0);
  assert.deepEqual(readdirSync(f.home).filter(name => name.startsWith("release-")).sort(), [id(f.c1), id(f.c4), id(next), "release-4f1c45a-d1canary.log"].sort());
});

test("six queued linear requests fold into one build and one restart, and each caller names the release that covers it", { timeout: 120000 }, async (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const shas = [f.c2, f.c3, f.c4, f.commit("five"), f.commit("six"), f.commit("seven")];
  f.publish();
  const before = built(f);
  const results = await queued(f, shas.map((sha) => [[sha]]));
  const newest = id(shas.at(-1));
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), newest, `request ${index}`);
  }
  const leaders = results.filter((result) => /folding the queued requests/.test(result.stderr));
  assert.equal(leaders.length, 1);
  assert.match(leaders[0].stderr, new RegExp(`${newest} covers the requests of ${shas.map(() => "[0-9a-f]{7} \\(pid \\d+(, this release)?\\)").join(", ")}$`, "m"));
  for (const sha of shas) assert.match(leaders[0].stderr, new RegExp(`${sha.slice(0, 7)} \\(pid`));
  for (const result of results.filter((result) => result !== leaders[0])) assert.match(result.stderr, new RegExp(`already live in ${newest}; nothing to do`));
  assert.deepEqual(built(f).filter((name) => !before.includes(name)), [newest]);
  assert.equal(f.kicked().length, 1);
  assert.equal(f.current(), newest);
  assert.equal(JSON.parse(readFileSync(path.join(f.home, "started.json"), "utf8")).id, newest);
  assert.equal(existsSync(path.join(f.home, "restart.owed")), false);
  assert.equal(drafts(f.home), 0);
});

test("requests that arrive during a batch's build wait for the next batch, and the first batch still goes live with its restart", { timeout: 120000 }, async (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const c5 = f.commit("five");
  const c6 = f.commit("six");
  f.publish();
  const firstBatch = queued(f, [[[f.c2]], [[f.c3], { TYPECHECK_MS: "1500" }]]);
  await waitWhile(() => !existsSync(path.join(f.dir, "seen", `${id(f.c3)}-typecheck.json`)));
  const late = [f.releaseAsync([f.c4]), f.releaseAsync([c5]), f.releaseAsync([c6])];
  await waitWhile(() => drafts(f.home) < 4);
  const [a, b] = await firstBatch;
  for (const result of [a, b]) {
    assert.equal(result.status, 0, result.stderr);
    assert.ok([id(f.c3), id(c6)].includes(result.stdout.trim()), result.stderr);
  }
  const first = [a, b].find((result) => /folding the queued requests/.test(result.stderr));
  assert.match(first.stderr, new RegExp(`current: ${id(f.c1)} -> ${id(f.c3)}`));
  assert.match(first.stderr, new RegExp(`${id(f.c3)} covers the requests of `));
  assert.doesNotMatch(first.stderr, new RegExp(`${f.c4.slice(0, 7)}|${c5.slice(0, 7)}|${c6.slice(0, 7)}`));
  const rest = await Promise.all(late);
  for (const result of rest) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), id(c6));
  }
  assert.deepEqual(f.kicksAt(c6, "typecheck"), [`kickstart -k gui/${userInfo().uid}/com.sieun.agent-chat`]);
  assert.deepEqual(built(f), [id(f.c1), id(f.c3), id(c6)].sort());
  assert.equal(f.kicked().length, 2);
  assert.equal(f.current(), id(c6));
  assert.equal(JSON.parse(readFileSync(path.join(f.home, "started.json"), "utf8")).id, id(c6));
});

test("a failed build of the newest queued commit fails only its own request, and the older ones go live in one build", { timeout: 120000 }, async (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const [r2, r3, r4] = await queued(f, [[[f.c2]], [[f.c3]], [[f.c4], { TEST_FAIL: "1" }]]);
  assert.equal(r4.status, 1, r4.stderr);
  assert.match(r4.stderr, /npm run --silent test failed/);
  for (const result of [r2, r3]) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), id(f.c3));
  }
  assert.match(r2.stderr + r3.stderr, new RegExp(`${id(f.c3)} covers the requests of `));
  assert.equal(f.current(), id(f.c3));
  assert.equal(existsSync(path.join(f.home, id(f.c4))), false);
  assert.deepEqual(built(f), [id(f.c1), id(f.c3), id(f.c4)].sort());
  assert.equal(f.kicked().length, 1);
  assert.equal(existsSync(path.join(f.home, "release.lock")), false);
});

test("a batch restarts when any covered request asks for it, and only flips when every one passed --no-kickstart", { timeout: 120000 }, async (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1]).status, 0);
  const quiet = await queued(f, [[[f.c2, "--no-kickstart"]], [[f.c3, "--no-kickstart"]]]);
  for (const result of quiet) assert.equal(result.status, 0, result.stderr);
  assert.equal(f.current(), id(f.c3));
  assert.equal(f.kicked().length, 1);
  const c5 = f.commit("five");
  f.publish();
  const mixed = await queued(f, [[[f.c4]], [[c5, "--no-kickstart"]]]);
  for (const result of mixed) assert.equal(result.status, 0, result.stderr);
  assert.equal(f.current(), id(c5));
  assert.equal(f.kicked().length, 2);
  assert.equal(JSON.parse(readFileSync(path.join(f.home, "started.json"), "utf8")).id, id(c5));
});

test("a queued commit that neither holds nor is held by the leader's is not acknowledged by its batch", { timeout: 120000 }, async (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  f.git("merge", "-q", "-s", "ours", "--no-edit", "side");
  f.publish();
  const results = await queued(f, [[[f.c2]], [[f.side]]]);
  assert.deepEqual(results.map((result) => result.status).sort(), [0, 3], results.map((result) => result.stderr).join("\n"));
  const won = results.find((result) => result.status === 0);
  const refused = results.find((result) => result.status === 3);
  assert.match(won.stderr, /leaving [0-9a-f]{7} \(pid \d+\) to a release of their own/);
  assert.doesNotMatch(won.stderr, /folding the queued requests/);
  assert.match(refused.stderr, /does not descend from the live/);
  assert.equal(f.current(), won.stdout.trim());
  assert.equal(f.kicked().length, 1);
});

test("a draft whose pid now belongs to another program is not a waiting request", { timeout: 120000 }, async (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const other = spawn("sleep", ["60"]);
  t.after(() => other.kill());
  writeFileSync(path.join(f.home, `release.lock.${other.pid}`), JSON.stringify({ pid: other.pid, sha: f.c4, startedAt: new Date().toISOString() }));
  const result = f.release([f.c2]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), id(f.c2));
  assert.doesNotMatch(result.stderr, /folding/);
  assert.equal(existsSync(path.join(f.home, id(f.c4))), false);
  assert.equal(f.kicked().length, 1);
  assert.equal(existsSync(path.join(f.home, "restart.owed")), false);
});

test("helpers from before the fold finish next to it: their waiters exit 0 on its batch, and its waiters pay the restart they leave", { timeout: 180000 }, async (t) => {
  const f = fixture(t);
  const old = helperBeforeFold(f.dir);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const c5 = f.commit("five");
  const c6 = f.commit("six");
  const c7 = f.commit("seven");
  f.publish();

  // Whichever takes the lock, the old helper's commit is the one built: the new helper folds its draft, or it builds it and restarts.
  const folded = await queued(f, [[[f.c2]], [[f.c3], {}, old]]);
  for (const result of folded) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), id(f.c3));
  }
  assert.equal(f.kicked().length, 1);
  assert.equal(existsSync(path.join(f.home, id(f.c2))), false);

  const leader = f.releaseAsync([c5], { TYPECHECK_MS: "1500" });
  await waitWhile(() => !existsSync(path.join(f.dir, "seen", `${id(c5)}-typecheck.json`)));
  const oldWaiters = [f.releaseAsync([f.c4], {}, old), f.releaseAsync([c5], {}, old)];
  await waitWhile(() => drafts(f.home) < 2);
  const [led, ...waited] = await Promise.all([leader, ...oldWaiters]);
  assert.equal(led.status, 0, led.stderr);
  for (const result of waited) {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`already live in ${id(c5)}; nothing to do`));
  }
  assert.equal(f.kicked().length, 2);

  const oldLeader = f.releaseAsync([c6], { TYPECHECK_MS: "1500" }, old);
  await waitWhile(() => !existsSync(path.join(f.dir, "seen", `${id(c6)}-typecheck.json`)));
  const newWaiters = [f.releaseAsync([c7]), f.releaseAsync([c7])];
  await waitWhile(() => drafts(f.home) < 2);
  const [oldLed, ...newWaited] = await Promise.all([oldLeader, ...newWaiters]);
  assert.equal(oldLed.status, 0, oldLed.stderr);
  assert.match(oldLed.stderr, /restart left to the waiting release of/);
  for (const result of newWaited) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), id(c7));
  }
  assert.match(newWaited.map((result) => result.stderr).join(""), new RegExp(`restarting onto ${id(c6)} for the restart this release was left`));
  assert.equal(f.kicksAt(c7, "typecheck").length, 3);
  assert.equal(f.kicked().length, 4);
  assert.equal(f.current(), id(c7));
  assert.equal(JSON.parse(readFileSync(path.join(f.home, "started.json"), "utf8")).id, id(c7));
  assert.equal(existsSync(path.join(f.home, "restart.owed")), false);
});
