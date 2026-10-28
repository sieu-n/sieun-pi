#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: node scripts/release-apps-chat.mjs <commit|release-id> [--rollback] [--no-restart] [--repo <dir>]

Builds ~/.local/share/sieun-pi-apps-chat/release-<sha7> from the commit, points current at it and restarts the systemd user unit
sieun-pi-apps-chat.service (apps/chat on 127.0.0.1:5184). It never touches sieun-pi-chat.service (:5182), sieun-pi-chat-pi.service (:5183)
or the Prime daemon.
The rules follow scripts/release-chat.mjs.
1. One release runs at a time through <home>/release.lock; a lock whose pid is gone is taken over.
2. The commit must be on origin's main, fetched at the start: push it first.
3. A commit that does not descend from the live release's commit is refused, so a late release never rolls back a newer one; --rollback allows it,
   and --rollback onto a release folder already built skips the origin check.
The build copies the commit with git archive, runs npm ci, the server typecheck and the fixture specs in apps/chat with a private HOME and TMPDIR,
and npm ci and npm run build in apps/chat/web. When the release's deploy/linux/sieun-pi-apps-chat.service differs from ~/.config/systemd/user, it
installs it and runs daemon-reload. After the restart it checks that GET http://127.0.0.1:5184/api/ready answers and the process stays up for 8 s;
when it does not, current goes back to the release before and the command exits 5.
Prints the live release id on the last line. Exit 1 on a failed build step, 2 on bad usage, 3 on a refused rollback, 4 on a commit not on origin main,
5 on a start that did not stay up.`;

const UNIT = "sieun-pi-apps-chat.service";
const PORT = 5184;
const RELEASE_NAME = /^release-([0-9a-f]{7,40})$/;
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"].includes(key)));
const log = message => process.stderr.write(`release-apps-chat: ${message}\n`);

class Refused extends Error {}
class Unpublished extends Error {}
class UsageError extends Error {}
class NotUp extends Error {}

function parseArgs(argv) {
  const options = { target: null, rollback: false, restart: true, repo: resolve(dirname(fileURLToPath(import.meta.url)), "..") };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rollback") options.rollback = true;
    else if (arg === "--no-restart") options.restart = false;
    else if (arg === "--repo") options.repo = resolve(argv[++i] ?? "");
    else if (arg === "-h" || arg === "--help") { console.log(USAGE); process.exit(0); }
    else if (arg.startsWith("-") || options.target) throw new UsageError(`unexpected argument ${arg}`);
    else options.target = arg;
  }
  if (!options.target) throw new UsageError("name the commit to release");
  return options;
}

const git = (repo, args) => {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: gitEnv });
  return result.status === 0 ? result.stdout.trim() : null;
};
const contains = (repo, outer, inner) => spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", inner, outer], { env: gitEnv }).status === 0;

function run(command, args, cwd, env = gitEnv) {
  log(`${command} ${args.join(" ")} (in ${cwd})`);
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", process.stderr, process.stderr], env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.signal ?? result.status})`);
}

const liveRelease = home => { try { return readlinkSync(join(home, "current")); } catch { return null; } };
function releaseCommit(repo, dir) {
  try { return git(repo, ["rev-parse", "--verify", "--quiet", `${JSON.parse(readFileSync(join(dir, "release.json"), "utf8")).sha}^{commit}`]); } catch {}
  const match = RELEASE_NAME.exec(basename(dir));
  return match ? git(repo, ["rev-parse", "--verify", "--quiet", `${match[1]}^{commit}`]) : null;
}

/** Refused unless `sha` holds the live release's commit, or --rollback. */
function checkNewer(repo, home, sha, rollback) {
  const live = liveRelease(home);
  if (!live || rollback) return;
  const liveSha = releaseCommit(repo, resolve(home, live));
  if (!liveSha) throw new Refused(`current points at ${live}, whose commit is not in ${repo}; pass --rollback to replace it anyway`);
  if (!contains(repo, sha, liveSha)) throw new Refused(`${sha.slice(0, 7)} does not descend from the live ${live} (${liveSha.slice(0, 7)}); pass --rollback to go back on purpose`);
}

/** Unpublished unless `sha` is on origin's main as fetched now, into a ref of this process's own. */
function checkPublished(repo, sha) {
  const ref = `refs/release-apps-chat/origin-main-${process.pid}`;
  const fetched = spawnSync("git", ["-C", repo, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", `+refs/heads/main:${ref}`], { encoding: "utf8", env: gitEnv });
  try {
    if (fetched.status !== 0) throw new Unpublished(`could not fetch origin main (${fetched.stderr.trim().split("\n").pop()}); retry when origin answers`);
    if (!contains(repo, ref, sha)) throw new Unpublished(`${sha.slice(0, 7)} is not on origin/main; push it to main first, then release it`);
  } finally {
    spawnSync("git", ["-C", repo, "update-ref", "-d", ref], { env: gitEnv });
  }
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

/** Takes <home>/release.lock, waiting while a live process holds it. */
async function takeLock(home, request) {
  const lock = join(home, "release.lock");
  const draft = `${lock}.${process.pid}`;
  const body = `${JSON.stringify(request)}\n`;
  writeFileSync(draft, body);
  let told = false;
  try {
    for (;;) {
      try { linkSync(draft, lock); break; } catch (error) { if (error.code !== "EEXIST") throw error; }
      let held = "";
      try { held = readFileSync(lock, "utf8"); } catch { continue; }
      let holder = null;
      try { holder = JSON.parse(held); } catch {}
      if (!holder || !alive(holder.pid)) {
        try { if (readFileSync(lock, "utf8") === held) unlinkSync(lock); } catch {}
        log(`took over a stale lock (${held.trim() || "empty"})`);
        continue;
      }
      if (!told) { log(`waiting for the release of ${String(holder.sha).slice(0, 7)} by pid ${holder.pid}`); told = true; }
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
  const source = spawn("git", ["-C", repo, "archive", "--format=tar", sha, "apps/chat", "config/allowed-models.ts", "packages/pi-host/src/durable/index-db.ts", "deploy/linux/sieun-pi-apps-chat.service"], { stdio: ["ignore", "pipe", "inherit"], env: gitEnv });
  source.stdout.pipe(tar.stdin);
  const codes = await Promise.all([source, tar].map(child => new Promise(done => child.on("close", done))));
  if (codes.some(code => code !== 0)) throw new Error(`git archive ${sha} | tar -x failed (${codes.join(", ")})`);
}

/** PATH and the locale from this shell, and a HOME and TMPDIR of their own, so the checks see no agent socket, token or session dir. */
function checkEnv(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|USER|LOGNAME|SHELL)$/.test(key)));
  for (const [key, dir] of Object.entries({ HOME: "home", TMPDIR: "tmp", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_RUNTIME_DIR: "run" })) {
    env[key] = join(root, dir);
    mkdirSync(env[key], { recursive: true, mode: 0o700 });
  }
  env.npm_config_cache = join(homedir(), ".npm");
  return env;
}

async function build(repo, home, sha) {
  const name = `release-${sha.slice(0, 7)}`;
  const dir = join(home, name);
  if (existsSync(join(dir, "release.json"))) { log(`${name} is built already`); return name; }
  const work = `${dir}.building-${process.pid}`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    await archive(repo, sha, work);
    const app = join(work, "apps/chat");
    const env = checkEnv(join("/tmp", `apps-chat-release-${process.pid}`));
    run("npm", ["ci", "--no-audit", "--no-fund"], app, { ...env, HOME: homedir() });
    run("npm", ["run", "--silent", "typecheck"], app, env);
    run("node", ["--import", "tsx", "--test", "--test-force-exit", "--test-isolation=none", "test/server/fixture.test.ts"], app, env);
    const web = join(app, "web");
    if (existsSync(join(web, "package.json"))) {
      run("npm", [existsSync(join(web, "package-lock.json")) ? "ci" : "install", "--no-audit", "--no-fund"], web, { ...env, HOME: homedir() });
      run("npm", ["run", "--silent", "build"], web, env);
    }
    writeFileSync(join(work, "release.json"), `${JSON.stringify({ sha, builtAt: new Date().toISOString() })}\n`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(work, dir);
    return name;
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(join("/tmp", `apps-chat-release-${process.pid}`), { recursive: true, force: true });
  }
}

function flip(home, name) {
  const next = join(home, `current.${process.pid}`);
  rmSync(next, { force: true });
  symlinkSync(name, next);
  renameSync(next, join(home, "current"));
}

function installUnit(home) {
  const source = join(home, "current/deploy/linux", UNIT);
  const target = join(homedir(), ".config/systemd/user", UNIT);
  const want = readFileSync(source, "utf8");
  let have = null;
  try { have = readFileSync(target, "utf8"); } catch {}
  if (have === want) return;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, want);
  run("systemctl", ["--user", "daemon-reload"], home);
  run("systemctl", ["--user", "enable", UNIT], home);
  log(`installed ${target}`);
}

async function upCheck() {
  const pid = () => spawnSync("systemctl", ["--user", "show", "-p", "MainPID", "--value", UNIT], { encoding: "utf8" }).stdout.trim();
  const end = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < end && !ready) {
    try { ready = (await fetch(`http://127.0.0.1:${PORT}/api/ready`, { signal: AbortSignal.timeout(3000) })).ok; } catch {}
    if (!ready) await new Promise(done => setTimeout(done, 500));
  }
  if (!ready) throw new NotUp(`${UNIT} did not answer /api/ready on :${PORT} in 60 s`);
  const first = pid();
  await new Promise(done => setTimeout(done, 8000));
  if (pid() !== first || spawnSync("systemctl", ["--user", "is-active", "--quiet", UNIT]).status !== 0) throw new NotUp(`${UNIT} did not stay up for 8 s after its start`);
}

function prune(home, keep) {
  for (const entry of readdirSync(home)) if (RELEASE_NAME.test(entry) && !keep.includes(entry)) rmSync(join(home, entry), { recursive: true, force: true });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const home = join(homedir(), ".local/share/sieun-pi-apps-chat");
  mkdirSync(home, { recursive: true });
  const prebuilt = options.rollback && RELEASE_NAME.test(options.target) && existsSync(join(home, options.target, "release.json"));
  const sha = prebuilt ? releaseCommit(options.repo, join(home, options.target)) ?? options.target : git(options.repo, ["rev-parse", "--verify", "--quiet", `${options.target}^{commit}`]);
  if (!sha) throw new UsageError(`${options.target} is not a commit in ${options.repo}`);
  const releaseLock = await takeLock(home, { pid: process.pid, sha, startedAt: new Date().toISOString(), rollback: options.rollback });
  try {
    if (!prebuilt) checkPublished(options.repo, sha);
    checkNewer(options.repo, home, sha, options.rollback);
    const before = liveRelease(home);
    const name = prebuilt ? options.target : await build(options.repo, home, sha);
    flip(home, name);
    installUnit(home);
    if (options.restart) {
      run("systemctl", ["--user", "restart", UNIT], home);
      try {
        await upCheck();
      } catch (error) {
        if (before && before !== name) {
          log(`${error.message}; going back to ${before}`);
          flip(home, before);
          run("systemctl", ["--user", "restart", UNIT], home);
        }
        throw error;
      }
    }
    prune(home, [name, before].filter(Boolean));
    console.log(name);
  } finally {
    releaseLock();
  }
}

main().catch(error => {
  log(error.message);
  process.exit(error instanceof UsageError ? 2 : error instanceof Refused ? 3 : error instanceof Unpublished ? 4 : error instanceof NotUp ? 5 : 1);
});
