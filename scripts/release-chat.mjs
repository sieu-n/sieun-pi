#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: node scripts/release-chat.mjs <commit|release-id> [--rollback] [--no-kickstart] [--repo <dir>]

Builds ~/.local/share/sieun-pi-chat/release-<sha7> from the commit, points current at it and kickstarts com.sieun.agent-chat (:5182),
or on Linux restarts the systemd user unit sieun-pi-chat.service.
One release runs at a time: a second command waits for the first one's lock, then checks again.
A commit that does not descend from the live release's commit is refused, so a late release never rolls back a newer one. --rollback allows it.
The build runs npm run typecheck and npm test of components/user-history inside the release before the flip.
--no-kickstart flips current only, for a release whose diff touches only scripts/duties or tests.
Prints the live release id on the last line. Exit 1 on a failed build step, 2 on bad usage, 3 on a refused rollback.`;

const LABEL = "com.sieun.agent-chat";
const UNIT = "sieun-pi-chat.service";
const RELEASE_NAME = /^release-([0-9a-f]{7,40})(?:-.+)?$/;
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"].includes(key)));

class Refused extends Error {}
class UsageError extends Error {}

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

function run(command, args, cwd) {
  log(`${command} ${args.join(" ")} (in ${cwd})`);
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", process.stderr, process.stderr], env: gitEnv });
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

/** Throws Refused unless `sha` is the live release's commit or a descendant of it, or `rollback` is set. */
function checkNewer(repo, home, sha, rollback) {
  const live = liveRelease(home);
  if (!live || rollback) return;
  const liveSha = releaseCommit(repo, resolve(home, live));
  if (!liveSha) throw new Refused(`current points at ${live}, whose commit is not in ${repo}; pass --rollback to replace it anyway`);
  if (spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", liveSha, sha], { env: gitEnv }).status !== 0)
    throw new Refused(`${sha.slice(0, 7)} does not descend from the live ${live} (${liveSha.slice(0, 7)}); a newer release is live. Pass --rollback to go back on purpose`);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

/** Takes <home>/release.lock, waiting while a live process holds it; a lock whose pid is gone is taken over. Returns the release function. */
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

/** Builds release-<sha7> in a scratch folder and renames it into place, so a release folder that exists is complete. */
async function build(options, home, sha, dir) {
  const scratch = join(home, `.building-${basename(dir)}-${process.pid}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  try {
    log(`git archive ${sha.slice(0, 7)} into ${scratch}`);
    await archive(options.repo, sha, scratch);
    symlinkSync(join(options.repo, "node_modules"), join(scratch, "node_modules"));
    symlinkSync(join(options.repo, "components/user-history/node_modules"), join(scratch, "components/user-history/node_modules"));
    const app = join(scratch, "components/user-history");
    run("nice", ["-n", "10", "npm", "run", "--silent", "typecheck"], app);
    run("nice", ["-n", "10", "npm", "run", "--silent", "test"], app);
    writeFileSync(join(scratch, "release.json"), JSON.stringify({ sha, id: basename(dir), builtAt: new Date().toISOString() }, null, 2) + "\n");
    renameSync(scratch, dir);
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

/** Points <home>/current at `id` with one rename, so a reader never sees it missing. */
function flip(home, id) {
  const next = join(home, `.current-${process.pid}`);
  rmSync(next, { force: true });
  symlinkSync(id, next);
  renameSync(next, join(home, "current"));
}

function kickstart() {
  if ((process.env.SIEUN_PI_CHAT_SERVICE_MANAGER || (process.platform === "linux" ? "systemd" : "launchd")) === "systemd") {
    run(process.env.SIEUN_PI_CHAT_SYSTEMCTL || "systemctl", ["--user", "restart", UNIT], process.cwd());
    return;
  }
  const launchctl = process.env.SIEUN_PI_CHAT_LAUNCHCTL || "/bin/launchctl";
  run(launchctl, ["kickstart", "-k", `gui/${userInfo().uid}/${LABEL}`], process.cwd());
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const home = resolve(process.env.SIEUN_PI_CHAT_HOME || join(homedir(), ".local/share/sieun-pi-chat"));
  mkdirSync(home, { recursive: true });
  const named = RELEASE_NAME.test(options.target) && existsSync(join(home, options.target)) ? join(home, options.target) : null;
  const sha = named ? releaseCommit(options.repo, named) : git(options.repo, ["rev-parse", "--verify", "--quiet", `${options.target}^{commit}`]);
  if (!sha) throw new UsageError(`${options.target} is not a commit in ${options.repo}`);
  const dir = named ?? join(home, `release-${sha.slice(0, 7)}`);
  const id = basename(dir);
  checkNewer(options.repo, home, sha, options.rollback);
  await takeLock(home, sha);
  checkNewer(options.repo, home, sha, options.rollback);
  if (existsSync(dir)) log(`${id} is built already; reusing it`);
  else await build(options, home, sha, dir);
  checkNewer(options.repo, home, sha, options.rollback);
  const before = liveRelease(home);
  flip(home, id);
  log(`current: ${before ?? "(none)"} -> ${id}`);
  if (options.kickstart) kickstart();
  console.log(id);
}

main().catch(error => {
  log(error.message);
  if (error instanceof UsageError) process.stderr.write(`${USAGE}\n`);
  process.exit(error instanceof Refused ? 3 : error instanceof UsageError ? 2 : 1);
});
