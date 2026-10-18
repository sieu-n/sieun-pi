#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: node scripts/release-chat.mjs <commit|release-id> [--rollback] [--no-kickstart] [--repo <dir>]

Builds ~/.local/share/sieun-pi-chat/release-<sha7> from the commit, points current at it and kickstarts com.sieun.agent-chat (:5182),
or on Linux restarts the systemd user unit sieun-pi-chat.service. When the release's deploy/linux sieun-pi-chat.service or .socket differs from
~/.config/systemd/user, it installs them, runs daemon-reload, stops the service, enables and starts the socket, and starts the service.
The commit must be on origin's main, fetched at the start: push it first. The command never pushes or publishes anyone's source itself.
One release runs at a time: a second command waits for the first one's lock, then checks again, so a commit that the release holding
the lock holds goes live through that release, or through its own build when that release fails.
A commit that current already holds exits 0 with nothing built ("already live in release-X") once the chat runs current with its units;
until then it makes that restart and installs those units (after --no-kickstart, or when the installed units were changed).
Any other commit that does not descend from the live release's commit is refused, so a late release never rolls back a newer one. --rollback allows it.
--rollback onto a release folder already built skips the origin check and needs no network, so a known-good release stays usable offline
or when its commit was rebased off main. --rollback onto a commit not built yet is checked against origin like any release.
The build runs npm run typecheck and npm test of components/user-history inside the release before the flip, then writes the packed client bundle.
Those steps get PATH and the locale from this shell and a private HOME, TMPDIR and XDG dirs, so they see no agent socket, token, session dir or key.
--no-kickstart flips current only, for a release whose diff touches only scripts/duties or tests.
A release that ends while a newer one waits for the lock leaves the restart to it (restart.owed), and that release makes it as soon as it takes
the lock, before its own build, so a build that hangs or fails never holds the chat on older code.
A restart counts as applied only while the service manager reports the service running (systemctl is-active, launchctl print).
After the flip it deletes each release folder except current, the one current named before, the one the chat was last started on, a waiting
release's and any folder a running process names, so a rollback further back than the release before current builds that commit again.
Prints the live release id on the last line. Exit 1 on a failed build step, 2 on bad usage, 3 on a refused rollback, 4 on a commit not on origin main.`;

const LABEL = "com.sieun.agent-chat";
const UNIT = "sieun-pi-chat.service";
const RELEASE_NAME = /^release-([0-9a-f]{7,40})(?:-.+)?$/;
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"].includes(key)));

class Refused extends Error {}
class UsageError extends Error {}
class Unpublished extends Error {}

function parseArgs(argv) {
  const options = { target: null, rollback: false, kickstart: true, repo: resolve(dirname(fileURLToPath(import.meta.url)), "..") };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--rollback") options.rollback = true;
    else if (arg === "--no-kickstart") options.kickstart = false;
    else if (arg === "--repo") {
      const value = argv[++index];
      if (!value) throw new UsageError(`${arg} needs a value`);
      options.repo = resolve(value);
    } else if (arg === "-h" || arg === "--help") { console.log(USAGE); process.exit(0); }
    else if (arg.startsWith("-") || options.target) throw new UsageError(`unexpected argument ${arg}`);
    else options.target = arg;
  }
  if (!options.target) throw new UsageError("name the commit to release");
  return options;
}

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: gitEnv });
  return result.status === 0 ? result.stdout.trim() : null;
}

const log = message => process.stderr.write(`release-chat: ${message}\n`);

function run(command, args, cwd, env = gitEnv) {
  log(`${command} ${args.join(" ")} (in ${cwd})`);
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", process.stderr, process.stderr], env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.signal ?? result.status})`);
}

/** The commit a release folder was built from: its release.json, else the hex in its name. Null when neither resolves in the repo. */
function releaseCommit(repo, dir) {
  try { return git(repo, ["rev-parse", "--verify", "--quiet", `${JSON.parse(readFileSync(join(dir, "release.json"), "utf8")).sha}^{commit}`]); } catch {}
  const match = RELEASE_NAME.exec(basename(dir));
  return match ? git(repo, ["rev-parse", "--verify", "--quiet", `${match[1]}^{commit}`]) : null;
}

function liveRelease(home) {
  try { return readlinkSync(join(home, "current")); } catch { return null; }
}

/**
 * Throws Refused unless `sha` holds every change of the live release, or `rollback` is set. A descendant holds them, and so does a commit whose
 * history has an equal patch for each live commit it lacks (git cherry shows no `+`): on 10-18 release-4f1c45a was built from a commit that was
 * then rebased onto main as 3c414f2fd, and every later main commit read as older and was refused.
 */
function checkNewer(repo, home, sha, rollback) {
  const live = liveRelease(home);
  if (!live || rollback) return;
  const liveSha = releaseCommit(repo, resolve(home, live));
  if (!liveSha) throw new Refused(`current points at ${live}, whose commit is not in ${repo}; pass --rollback to replace it anyway`);
  if (spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", liveSha, sha], { env: gitEnv }).status === 0) return;
  const cherry = spawnSync("git", ["-C", repo, "cherry", sha, liveSha], { env: gitEnv, encoding: "utf8" });
  if (cherry.status !== 0 || /^\+/m.test(cherry.stdout))
    throw new Refused(`${sha.slice(0, 7)} does not descend from the live ${live} (${liveSha.slice(0, 7)}); a newer release is live. Pass --rollback to go back on purpose`);
}

/**
 * Throws Unpublished unless `sha` is on origin's main as fetched now. On 10-18 releases built from commits no one had pushed went live
 * (release-322de20 had to be merged into main afterwards so later releases descended from it), and each such release let the chat drift from main.
 * The fetch goes to a ref of this process's own, since releases and jobs fetch in the same repo at once and a shared ref's lock would fail one of them.
 */
function checkPublished(repo, sha) {
  const ref = `refs/release-chat/origin-main-${process.pid}`;
  const fetched = spawnSync("git", ["-C", repo, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", `+refs/heads/main:${ref}`], { encoding: "utf8", env: gitEnv });
  try {
    if (fetched.status !== 0)
      throw new Unpublished(`could not fetch origin main to check that ${sha.slice(0, 7)} is published (${fetched.stderr.trim().split("\n").pop()}); retry when origin answers, or pass --rollback <release-id> to go to a release already built`);
    if (!contains(repo, ref, sha)) throw new Unpublished(`${sha.slice(0, 7)} is not on origin/main; push it to main first, then release it`);
  } finally {
    spawnSync("git", ["-C", repo, "update-ref", "-d", ref], { env: gitEnv });
  }
}

/**
 * The release that already holds `sha`: the live release when `sha` is its commit or an ancestor of it, else null. Such a release is a no-op:
 * at 11:25Z on 10-18 three jobs queued da7e7e0c3 behind 8957c594a, which held it already, and each would have waited for the lock to exit 3.
 */
function liveHolding(repo, home, sha) {
  const live = liveRelease(home);
  const liveSha = live ? releaseCommit(repo, resolve(home, live)) : null;
  return liveSha && contains(repo, liveSha, sha) ? live : null;
}

/** Whether commit `outer` holds `inner`: the same commit or a descendant. */
const contains = (repo, outer, inner) => spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", inner, outer], { env: gitEnv }).status === 0;

class Covered extends Error {}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

/**
 * Takes <home>/release.lock, waiting while a live process holds it; a lock whose pid is gone is taken over. Returns the release function.
 * A release waits even when the holder's commit holds its own: that build can still fail, and then this one is the release that ships the commit.
 */
async function takeLock(home, sha) {
  const lock = join(home, "release.lock");
  const body = JSON.stringify({ pid: process.pid, sha, startedAt: new Date().toISOString() }) + "\n";
  const draft = `${lock}.${process.pid}`;
  writeFileSync(draft, body);
  let told = false;
  try {
    for (;;) {
      try { linkSync(draft, lock); break; } catch (error) { if (error.code !== "EEXIST") throw error; }
      let held = null;
      try { held = readFileSync(lock, "utf8"); } catch { continue; }
      let holder = null;
      try { holder = JSON.parse(held); } catch {}
      if (!holder || !alive(holder.pid)) {
        try { if (readFileSync(lock, "utf8") === held) unlinkSync(lock); } catch {}
        log(`took over a stale lock (${held.trim() || "empty"})`);
        continue;
      }
      if (!told) { log(`waiting for the release of ${String(holder.sha).slice(0, 7)} by pid ${holder.pid}, started ${holder.startedAt}`); told = true; }
      await new Promise(done => setTimeout(done, 500));
    }
  } finally { rmSync(draft, { force: true }); }
  const release = () => { try { if (readFileSync(lock, "utf8") === body) unlinkSync(lock); } catch {} };
  process.on("exit", release);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { release(); process.exit(1); });
  return release;
}

async function archive(repo, sha, into) {
  const tar = spawn("tar", ["-x", "-C", into], { stdio: ["pipe", "inherit", "inherit"] });
  const source = spawn("git", ["-C", repo, "archive", "--format=tar", sha], { stdio: ["ignore", "pipe", "inherit"], env: gitEnv });
  source.stdout.pipe(tar.stdin);
  const codes = await Promise.all([source, tar].map(child => new Promise(done => child.on("close", done))));
  if (codes.some(code => code !== 0)) throw new Error(`git archive ${sha} | tar -x failed (${codes.join(", ")})`);
}

const CHECK_PASSES = /^(PATH|LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|USER|LOGNAME|SHELL)$/;
const CHECK_DIRS = { HOME: "home", TMPDIR: "tmp", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", XDG_RUNTIME_DIR: "run" };

/**
 * The environment of the release's typecheck and tests: PATH and the locale from this process, and a HOME, TMPDIR and XDG dirs of their own under
 * `root`, a fresh folder under /tmp rather than the caller's TMPDIR, kept short for the tests' unix sockets. A release started from an agent's shell carries its worker token, supervisor socket, session leases, RLM session dirs and API keys, and
 * on 10-18 at 10:42Z the tests of release 39680d859 ran with all of them and the real HOME. The restart after the build keeps this process's env.
 */
function checkEnv(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => CHECK_PASSES.test(key)));
  for (const [key, name] of Object.entries(CHECK_DIRS)) {
    env[key] = join(root, name);
    mkdirSync(env[key], { mode: 0o700 });
  }
  return { ...env, npm_config_update_notifier: "false" };
}

/** Builds release-<sha7> in a scratch folder and renames it into place, so a release folder that exists is complete. */
async function build(options, home, sha, dir) {
  const scratch = join(home, `.building-${basename(dir)}-${process.pid}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const checks = mkdtempSync("/tmp/release-chat-");
  try {
    log(`git archive ${sha.slice(0, 7)} into ${scratch}`);
    await archive(options.repo, sha, scratch);
    symlinkSync(join(options.repo, "node_modules"), join(scratch, "node_modules"));
    symlinkSync(join(options.repo, "components/user-history/node_modules"), join(scratch, "components/user-history/node_modules"));
    const app = join(scratch, "components/user-history");
    const env = checkEnv(checks);
    run("npm", ["run", "--silent", "typecheck"], app, env);
    run("npm", ["run", "--silent", "test"], app, env);
    // The packed client bundle, so the service start reads it instead of compiling it (6.5 s at a load of 50 on 10-18) while every shell waits.
    run("node", ["src/chat-assets-prebuild.mjs"], app, env);
    writeFileSync(join(scratch, "release.json"), JSON.stringify({ sha, id: basename(dir), builtAt: new Date().toISOString() }, null, 2) + "\n");
    renameSync(scratch, dir);
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(checks, { recursive: true, force: true });
  }
}

/** Points <home>/current at `id` with one rename, so a reader never sees it missing. */
function flip(home, id) {
  const next = join(home, `.current-${process.pid}`);
  rmSync(next, { force: true });
  symlinkSync(id, next);
  renameSync(next, join(home, "current"));
}

/** The releases waiting for the lock: each writes its lock draft `release.lock.<pid>` while it waits. */
function waiting(home) {
  const found = [];
  for (const name of readdirSync(home)) {
    const pid = Number(/^release\.lock\.(\d+)$/.exec(name)?.[1]);
    if (!pid || pid === process.pid || !alive(pid)) continue;
    try { found.push({ pid, sha: String(JSON.parse(readFileSync(join(home, name), "utf8")).sha) }); } catch {}
  }
  return found;
}

const OWED = "restart.owed";

/**
 * Restarts the service for this release unless the chat already runs current, or leaves it in restart.owed when a release that descends from
 * `sha` waits for the lock. That waiter pays it as soon as it takes the lock (payOwed), before its own build, so a waiter whose build hangs or
 * fails never holds the chat on older code: on 10-18 a steady queue of releases passed one restart on 12 times and the chat ran code 51 min
 * older than current.
 */
function restart(options, home, sha) {
  const owed = join(home, OWED);
  if (applied(home)) { rmSync(owed, { force: true }); return; }
  if (!options.kickstart && !existsSync(owed)) return;
  const later = waiting(home).filter(entry => spawnSync("git", ["-C", options.repo, "merge-base", "--is-ancestor", sha, entry.sha], { env: gitEnv }).status === 0);
  if (later.length) {
    writeFileSync(owed, JSON.stringify({ sha, at: new Date().toISOString() }) + "\n");
    log(`restart left to the waiting release of ${later.map(entry => `${entry.sha.slice(0, 7)} (pid ${entry.pid})`).join(", ")}, which makes it when it takes the lock`);
    return;
  }
  kickstart(home);
  rmSync(owed, { force: true });
}

/** Makes the restart restart.owed holds, onto the release current already points at, right after this release takes the lock. */
function payOwed(home) {
  const owed = join(home, OWED);
  if (!existsSync(owed)) return;
  if (!applied(home)) {
    log(`restarting onto ${liveRelease(home)} for the restart this release was left (restart.owed), before its own build`);
    kickstart(home);
  }
  rmSync(owed, { force: true });
}

const SOCKET = "sieun-pi-chat.socket";
const STARTED = "started.json";
const readText = path => { try { return readFileSync(path, "utf8"); } catch { return null; } };
const unitDir = () => process.env.SIEUN_PI_CHAT_UNIT_DIR || join(homedir(), ".config/systemd/user");
const systemd = () => (process.env.SIEUN_PI_CHAT_SERVICE_MANAGER || (process.platform === "linux" ? "systemd" : "launchd")) === "systemd";
const systemctl = () => process.env.SIEUN_PI_CHAT_SYSTEMCTL || "systemctl";
const launchctl = () => process.env.SIEUN_PI_CHAT_LAUNCHCTL || "/bin/launchctl";
const launchdTarget = () => `gui/${userInfo().uid}/${LABEL}`;

/** Whether the service manager reports the chat service running now: systemctl is-active, or launchctl print's state line. */
function serviceRunning() {
  if (systemd()) return spawnSync(systemctl(), ["--user", "is-active", "--quiet", UNIT], { stdio: "ignore" }).status === 0;
  const printed = spawnSync(launchctl(), ["print", launchdTarget()], { encoding: "utf8" });
  return printed.status === 0 && /^\s*state = running\s*$/m.test(printed.stdout);
}

/** The live release's deploy/linux unit texts, null for one it lacks, when they differ from the installed ones; null when they match or it has no service unit. */
function unitsToInstall(home) {
  const source = join(home, "current", "deploy/linux");
  if (readText(join(source, UNIT)) === null) return null;
  const wants = Object.fromEntries([UNIT, SOCKET].map(name => [name, readText(join(source, name))]));
  return Object.entries(wants).every(([name, text]) => readText(join(unitDir(), name)) === text) ? null : wants;
}

/**
 * Whether the chat runs current: the last restart a release made was onto the release current points at now (started.json), on systemd the
 * installed units are current's, and the service manager reports the service running. The marker alone proves only what was started, so a
 * stopped service, a --no-kickstart release or a changed unit file leaves this false until a release restarts.
 */
function applied(home) {
  const started = (() => { try { return JSON.parse(readText(join(home, STARTED))).id; } catch { return null; } })();
  return typeof started === "string" && started === liveRelease(home) && !(systemd() && unitsToInstall(home)) && serviceRunning();
}

/**
 * Installs the live release's deploy/linux units when they differ from the installed ones, and switches the port over: the service lets go of
 * 5182, the socket takes it, the service starts on the socket's fd. A release without the socket unit (a rollback) takes the socket away the same
 * way, since its code binds the port itself. False when the units match and a plain restart is enough.
 */
function switchUnits(home) {
  const ctl = systemctl();
  const wants = unitsToInstall(home);
  if (!wants) return false;
  const units = unitDir();
  log(`installing ${Object.keys(wants).filter(name => wants[name] !== null).join(" and ")} from ${join(home, "current", "deploy/linux")} into ${units}`);
  mkdirSync(units, { recursive: true });
  if (wants[SOCKET] === null && readText(join(units, SOCKET)) !== null) spawnSync(ctl, ["--user", "disable", "--now", SOCKET], { stdio: ["ignore", process.stderr, process.stderr] });
  for (const [name, text] of Object.entries(wants)) {
    if (text === null) rmSync(join(units, name), { force: true });
    else writeFileSync(join(units, name), text, { mode: 0o644 });
  }
  run(ctl, ["--user", "daemon-reload"], process.cwd());
  run(ctl, ["--user", "stop", UNIT], process.cwd());
  if (wants[SOCKET] !== null) run(ctl, ["--user", "enable", "--now", SOCKET], process.cwd());
  run(ctl, ["--user", "start", UNIT], process.cwd());
  return true;
}

/** Restarts the chat service on current and records which release it started on. */
function kickstart(home) {
  const id = liveRelease(home);
  if (systemd()) {
    if (!switchUnits(home)) run(systemctl(), ["--user", "restart", UNIT], process.cwd());
  } else run(launchctl(), ["kickstart", "-k", launchdTarget()], process.cwd());
  writeFileSync(join(home, STARTED), JSON.stringify({ id, at: new Date().toISOString() }) + "\n");
}

/** The text of every running process that can name a folder: its cwd, exe, command line, open files and mapped files (/proc), else its command line and cwd (ps, lsof). */
function processText() {
  if (existsSync("/proc/self/maps")) {
    const parts = [];
    const read = fn => { try { parts.push(fn()); } catch {} };
    for (const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
      const dir = join("/proc", pid);
      read(() => readlinkSync(join(dir, "cwd")));
      read(() => readlinkSync(join(dir, "exe")));
      read(() => readFileSync(join(dir, "cmdline"), "utf8").replaceAll("\0", " "));
      read(() => readFileSync(join(dir, "maps"), "utf8"));
      read(() => { for (const fd of readdirSync(join(dir, "fd"))) read(() => readlinkSync(join(dir, "fd", fd))); });
    }
    return parts.join("\n");
  }
  const out = (command, args) => spawnSync(command, args, { encoding: "utf8" }).stdout ?? "";
  return out("ps", ["-axww", "-o", "command="]) + out("lsof", ["-nP", "-a", "-d", "cwd", "-Fn"]);
}

/**
 * Deletes each release folder except current, the release current named before this flip (the rollback target), the release the chat was last
 * started on, the release of each waiting release's commit and any folder a running process names, and each build scratch whose release process
 * is gone. On us-metal02 on 10-18 the folder held 118 releases of 15 MB each (1.5 GB) that nothing ran, and 1.3 GB of them came in that day.
 */
function prune(home, keep) {
  const prefix = realpathSync(home).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const used = new Set([...processText().matchAll(new RegExp(`${prefix}/([^/\\s]+)`, "g"))].map(match => match[1]));
  const started = (() => { try { return JSON.parse(readText(join(home, STARTED))).id; } catch { return null; } })();
  const kept = new Set([...keep, started, ...waiting(home).map(entry => `release-${entry.sha.slice(0, 7)}`)]);
  for (const name of readdirSync(home)) {
    const scratch = /^\.building-release-.+-(\d+)$/.exec(name);
    if (used.has(name) || (scratch ? alive(Number(scratch[1])) : !RELEASE_NAME.test(name) || kept.has(name) || !lstatSync(join(home, name)).isDirectory())) continue;
    rmSync(join(home, name), { recursive: true, force: true });
    log(`removed ${name}, which nothing runs`);
  }
}

const chatHome = () => resolve(process.env.SIEUN_PI_CHAT_HOME || join(homedir(), ".local/share/sieun-pi-chat"));

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const home = chatHome();
  mkdirSync(home, { recursive: true });
  const named = RELEASE_NAME.test(options.target) && existsSync(join(home, options.target)) ? join(home, options.target) : null;
  const sha = named ? releaseCommit(options.repo, named) : git(options.repo, ["rev-parse", "--verify", "--quiet", `${options.target}^{commit}`]);
  if (!sha) throw new UsageError(`${options.target} is not a commit in ${options.repo}`);
  const dir = named ?? join(home, `release-${sha.slice(0, 7)}`);
  const id = basename(dir);
  const short = sha.slice(0, 7);
  if (!(options.rollback && existsSync(dir))) checkPublished(options.repo, sha);
  const holding = () => (options.rollback ? null : liveHolding(options.repo, home, sha));
  const live = holding();
  if (live && !existsSync(join(home, OWED))) {
    if (applied(home)) throw new Covered(`${short} already live in ${live}; nothing to do`);
    if (!options.kickstart) throw new Covered(`${short} already in current ${live}; --no-kickstart, so nothing to do`);
  }
  if (!live) checkNewer(options.repo, home, sha, options.rollback);
  await takeLock(home, sha);
  payOwed(home);
  const kept = holding();
  if (kept) {
    log(applied(home) ? `${short} already live in ${kept}; nothing to do` : `${short} is already in ${kept}, which the chat does not run yet with its units`);
    restart(options, home, releaseCommit(options.repo, resolve(home, kept)) ?? sha);
    console.log(kept);
    return;
  }
  checkNewer(options.repo, home, sha, options.rollback);
  if (existsSync(dir)) log(`${id} is built already; reusing it`);
  else await build(options, home, sha, dir);
  checkNewer(options.repo, home, sha, options.rollback);
  const before = liveRelease(home);
  flip(home, id);
  log(`current: ${before ?? "(none)"} -> ${id}`);
  restart(options, home, sha);
  prune(home, [id, before]);
  console.log(id);
}

main().catch(error => {
  log(error.message);
  if (error instanceof Covered) { console.log(liveRelease(chatHome()) ?? ""); process.exit(0); }
  if (error instanceof UsageError) process.stderr.write(`${USAGE}\n`);
  process.exit(error instanceof Refused ? 3 : error instanceof UsageError ? 2 : error instanceof Unpublished ? 4 : 1);
});
