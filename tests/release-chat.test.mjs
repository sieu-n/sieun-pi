import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
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
  mkdirSync(path.join(dir, "controls"));
  mkdirSync(path.join(dir, "seen"));
  writeFileSync(path.join(dir, "build-step.mjs"), BUILD_STEP);
  const step = (name) => `node ${JSON.stringify(path.join(dir, "build-step.mjs"))} ${name} ${JSON.stringify(dir)}`;
  write("components/user-history/package.json", JSON.stringify({ name: "fixture", private: true, scripts: { typecheck: step("typecheck"), test: step("test") } }));
  mkdirSync(path.join(repo, "node_modules"));
  mkdirSync(path.join(repo, "components/user-history/node_modules"));
  const kicks = path.join(dir, "kicks.log");
  const launchctl = path.join(dir, "launchctl");
  writeFileSync(launchctl, `#!/bin/sh\necho "$@" >> "${kicks}"\nenv > "${path.join(dir, "kick.env")}"\n`, { mode: 0o755 });
  const c1 = commit("one");
  const c2 = commit("two");
  const c3 = commit("three");
  git("checkout", "-q", "-b", "side", c1);
  const side = commit("side");
  git("checkout", "-q", "main");
  const env = (args, extra = {}) => {
    const control = Object.fromEntries(Object.entries(extra).filter(([key]) => BUILD_CONTROLS.includes(key)));
    writeFileSync(path.join(dir, "controls", `${id(args[0])}.json`), JSON.stringify(control));
    const rest = Object.fromEntries(Object.entries(extra).filter(([key]) => !BUILD_CONTROLS.includes(key)));
    return { ...cleanEnv, SIEUN_PI_CHAT_HOME: home, SIEUN_PI_CHAT_LAUNCHCTL: launchctl, SIEUN_PI_CHAT_SYSTEMCTL: launchctl, SIEUN_PI_CHAT_SERVICE_MANAGER: "launchd", ...rest };
  };
  const release = (args, extra) => spawnSync(process.execPath, [script, ...args, "--repo", repo], { encoding: "utf8", env: env(args, extra) });
  const releaseAsync = (args, extra) => new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args, "--repo", repo], { env: env(args, extra) });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
  const current = () => readlinkSync(path.join(home, "current"));
  const kicked = () => (existsSync(kicks) ? readFileSync(kicks, "utf8").trim().split("\n") : []);
  const seen = (sha, step) => JSON.parse(readFileSync(path.join(dir, "seen", `${id(sha)}-${step}.json`), "utf8"));
  return { dir, repo, home, c1, c2, c3, side, env, release, releaseAsync, current, kicked, seen };
}

const id = (sha) => (sha.startsWith("release-") ? sha : `release-${sha.slice(0, 7)}`);

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

test("an older release that waited on the lock behind a newer one is refused", async (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const newer = f.releaseAsync([f.c3], { TYPECHECK_MS: "1500" });
  while (!existsSync(path.join(f.home, "release.lock"))) await new Promise((done) => setTimeout(done, 20));
  const older = await f.releaseAsync([f.c2]);
  const won = await newer;
  assert.equal(won.status, 0, won.stderr);
  assert.equal(older.status, 3, older.stderr);
  assert.match(older.stderr, /waiting for the release of/);
  assert.match(older.stderr, /does not descend from the live release-/);
  assert.equal(f.current(), id(f.c3));
  assert.equal(existsSync(path.join(f.home, id(f.c2))), false);
  assert.equal(f.kicked().length, 1);
});

test("two releases started together end on the newer one", async (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const [older, newer] = await Promise.all([f.releaseAsync([f.c2], { TYPECHECK_MS: "300" }), f.releaseAsync([f.c3], { TYPECHECK_MS: "300" })]);
  assert.equal(newer.status, 0, newer.stderr);
  assert.ok([0, 3].includes(older.status), older.stderr);
  assert.equal(f.current(), id(f.c3));
});

test("going back to an older or unrelated commit needs --rollback", (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  assert.equal(f.release([f.c3, "--no-kickstart"]).status, 0);
  const refused = f.release([f.c1]);
  assert.equal(refused.status, 3);
  assert.match(refused.stderr, /Pass --rollback/);
  assert.equal(f.current(), id(f.c3));
  assert.equal(f.release([f.side, "--no-kickstart"]).status, 3);
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

test("a release stopped during its tests still makes the restart it owes, onto the current it did not flip", async (t) => {
  const f = fixture(t);
  assert.equal(f.release([f.c1, "--no-kickstart"]).status, 0);
  const first = f.releaseAsync([f.c2], { TYPECHECK_MS: "1500" });
  while (!existsSync(path.join(f.home, "release.lock"))) await new Promise((done) => setTimeout(done, 20));
  const second = spawn(process.execPath, [script, f.c3, "--repo", f.repo], { env: f.env([f.c3], { TEST_HANG: "1" }) });
  let stderr = "";
  second.stderr.on("data", (chunk) => { stderr += chunk; });
  const ended = new Promise((done) => second.on("close", done));
  const a = await first;
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stderr, /restart left to the waiting release of/);
  assert.equal(f.kicked().length, 0);
  const pid = path.join(f.dir, "seen", `${id(f.c3)}-test.pid`);
  while (!existsSync(pid)) await new Promise((done) => setTimeout(done, 20));
  second.kill("SIGTERM");
  process.kill(Number(readFileSync(pid, "utf8")), "SIGTERM");
  assert.equal(await ended, 1, stderr);
  assert.match(stderr, /npm run --silent test failed \((SIGTERM|143)\)/);
  assert.equal(f.current(), id(f.c2));
  assert.equal(existsSync(path.join(f.home, id(f.c3))), false);
  assert.deepEqual(f.kicked(), [`kickstart -k gui/${userInfo().uid}/com.sieun.agent-chat`]);
  assert.equal(existsSync(path.join(f.home, "restart.owed")), false);
  assert.equal(existsSync(path.join(f.home, "release.lock")), false);
});

test("the typecheck and tests see none of the agent's sockets, dirs, tokens or keys, and the restart keeps them", async (t) => {
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
