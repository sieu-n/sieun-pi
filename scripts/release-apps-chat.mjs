#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prune } from "./release-prune.mjs";

const USAGE = `usage: node scripts/release-apps-chat.mjs <commit|release-id> [--rollback] [--no-restart] [--repo <dir>]

Builds ~/.local/share/sieun-pi-apps-chat/release-<sha7> from the commit, points current at it and reloads the systemd user unit
sieun-pi-apps-chat.service (apps/chat on 127.0.0.1:5184), whose server hands the port held by sieun-pi-apps-chat.socket to a successor on the new
release (apps/chat/server/handoff.ts). It never touches sieun-pi-chat.service (:5182), sieun-pi-chat-pi.service (:5183) or the Prime daemon.
The rules follow scripts/release-chat.mjs.
1. One release runs at a time through <home>/release.lock; a lock whose pid is gone is taken over, and a waiting release's
   release.lock.<pid> draft whose pid is gone is removed.
2. The commit must be on origin's main, fetched at the start: push it first.
3. A commit that does not descend from the live release's commit is refused, so a late release never rolls back a newer one; --rollback allows it,
   and --rollback onto a release folder already built skips the origin check.
4. A commit the live release holds already ends as done once the unit's main process runs from the live release, and the lock's holder releases
   the newest commit a waiting release asked for when that one holds its own, so releases queued behind one lock start the unit once. When the
   main process runs from another release, as after a --no-restart release that took a waiting release's commit, the run starts the live one.
APPS_CHAT_RELEASE_HOME, APPS_CHAT_RELEASE_UNIT and APPS_CHAT_RELEASE_PORT point it at another release folder, unit and port, as the hand-over
rig's release race does (apps/chat/scripts/handoff-rig/release-race.mjs); the defaults are the live ones.
The build copies the commit with git archive, runs npm ci, the server typecheck and the fixture specs in apps/chat with a private HOME and TMPDIR,
and npm ci and npm run build in apps/chat/web. When the release's deploy/linux service or socket unit differs from ~/.config/systemd/user, it
installs it, runs daemon-reload and restarts the unit instead of a reload, and it removes the socket unit when the release has none. Then it checks
that a new main process runs from the release, answers GET http://127.0.0.1:5184/api/ready and stays up for 8 s; when it does not, current goes
back to the release before and the command exits 5.
Prints the live release id on the last line. Exit 1 on a failed build step, 2 on bad usage, 3 on a refused rollback, 4 on a commit not on origin main,
5 on a start that did not stay up.`;

const UNIT = process.env.APPS_CHAT_RELEASE_UNIT ?? "sieun-pi-apps-chat.service";
/** The port's socket unit, which keeps 127.0.0.1:5184 open across restarts and hand-overs (deploy/linux/sieun-pi-apps-chat.socket). */
const SOCKET = UNIT.replace(/\.service$/, ".socket");
const PORT = Number(process.env.APPS_CHAT_RELEASE_PORT ?? 5184);
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

/**
 * Refused unless `sha` holds the live release's commit, or --rollback. Returns the live release when it holds `sha` already, such as one a
 * release queued behind the same lock made, else null.
 */
function checkNewer(repo, home, sha, rollback) {
  const live = liveRelease(home);
  if (!live || rollback) return null;
  const liveSha = releaseCommit(repo, resolve(home, live));
  if (!liveSha) throw new Refused(`current points at ${live}, whose commit is not in ${repo}; pass --rollback to replace it anyway`);
  if (contains(repo, liveSha, sha)) return live;
  if (!contains(repo, sha, liveSha)) throw new Refused(`${sha.slice(0, 7)} does not descend from the live ${live} (${liveSha.slice(0, 7)}); pass --rollback to go back on purpose`);
  return null;
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

/**
 * The newest commit a release waiting for the lock asked for, when it holds `sha` and every other waiting one. On 11-22 the unit started 70
 * times, nearly all from 65 releases that separate jobs ran one after another through the lock, each of a newer main that held the one
 * before; the holder now releases the newest once and the waiting ones end as done (`checkNewer`).
 */
function newestWaiting(repo, home, sha) {
  const waiting = readdirSync(home).filter(entry => entry.startsWith("release.lock.")).flatMap(entry => {
    try {
      const request = JSON.parse(readFileSync(join(home, entry), "utf8"));
      return request.pid !== process.pid && !request.rollback && typeof request.sha === "string" && alive(request.pid) ? [request.sha] : [];
    } catch { return []; }
  });
  const later = [...new Set(waiting)].filter(other => other !== sha && contains(repo, other, sha));
  return later.find(other => later.every(each => contains(repo, other, each))) ?? null;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

/** Takes <home>/release.lock, waiting while a live process holds it. */
async function takeLock(home, request) {
  const lock = join(home, "release.lock");
  const draft = `${lock}.${process.pid}`;
  const body = `${JSON.stringify(request)}\n`;
  writeFileSync(draft, body);
  // A release killed while it waited skips the finally below and leaves its draft, as two from 11-21 did; drop each draft whose pid is gone.
  for (const entry of readdirSync(home)) {
    const pid = Number(/^release\.lock\.(\d+)$/.exec(entry)?.[1]);
    if (pid && !alive(pid)) rmSync(join(home, entry), { force: true });
  }
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
  // A commit from before the hand-over holds no socket unit, and git archive fails on a path the commit lacks.
  const socket = spawnSync("git", ["-C", repo, "cat-file", "-e", `${sha}:deploy/linux/${SOCKET}`], { env: gitEnv }).status === 0 ? [`deploy/linux/${SOCKET}`] : [];
  const source = spawn("git", ["-C", repo, "archive", "--format=tar", sha, "apps/chat", "config/allowed-models.ts", "packages/pi-host/src/durable/index-db.ts", "deploy/linux/sieun-pi-apps-chat.service", ...socket,
    // scripts/duties/relay-posts.ts counts room posts with pi-host's relay words, the ones its comm guard refuses.
    "packages/pi-host/src/durable/relay-line.ts",
    // It reads an owner post as asking the way the comm guard does (comm-guard.ts asks), so a progress post that answers him is no relay.
    "packages/pi-host/src/durable/comm-guard.ts",
    // server/agent-folder.ts lists a folder's instruction files with the function pi-host's prompt loads them by.
    "packages/pi-host/src/durable/context-files.ts",
    // server/skills-review.ts deletes and restores harness notes through pi-harness's store, under the lock every harness writer takes.
    "packages/pi-harness/src/core/store.ts", "packages/pi-harness/src/core/lock.ts",
    // The fixture server's skills DB scans its throwaway tree with the real scanner (server/skills-db-fixture.ts).
    "scripts/skills-inventory.py", "scripts/skills_usage.py",
    // server/host/relay-host.ts speaks the agent relay's frames as agents/protocol.ts defines them, and the legacy shared types the step rules
    // import (server/step-owners.ts) name host-stats.ts's machine view.
    "components/prime-relay",
    // server/wakes.ts imports today's chat's wake ticker, server/accounts.ts its pool code and server/step-owners.ts d9's step rules
    // (src/apps-step-owners.ts) as they are, so the release takes all of src; its package.json makes those files ES modules.
    "legacy/prime/user-history/package.json", "legacy/prime/user-history/src"], { stdio: ["ignore", "pipe", "inherit"], env: gitEnv });
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

/**
 * Installs the release's service and socket units into ~/.config/systemd/user when they differ, and removes the socket unit when the
 * release has none (a --rollback to a commit from before the hand-over). Returns whether any unit changed, which the running server
 * cannot take over by a reload.
 */
function installUnits(home) {
  const dir = join(homedir(), ".config/systemd/user");
  let changed = false;
  for (const name of [UNIT, SOCKET]) {
    const source = join(home, "current/deploy/linux", name);
    const target = join(dir, name);
    let want = null, have = null;
    try { want = readFileSync(source, "utf8"); } catch {}
    try { have = readFileSync(target, "utf8"); } catch {}
    if (have === want) continue;
    changed = true;
    if (want === null) {
      run("systemctl", ["--user", "disable", "--now", name], home);
      rmSync(target, { force: true });
      log(`removed ${target}`);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, want);
    log(`installed ${target}`);
  }
  if (!changed) return false;
  run("systemctl", ["--user", "daemon-reload"], home);
  run("systemctl", ["--user", "enable", ...[UNIT, SOCKET].filter(name => existsSync(join(dir, name)))], home);
  return true;
}

const mainPid = () => Number(spawnSync("systemctl", ["--user", "show", "-p", "MainPID", "--value", UNIT], { encoding: "utf8" }).stdout.trim()) || 0;
const isActive = () => spawnSync("systemctl", ["--user", "is-active", "--quiet", UNIT]).status === 0;
const cwdOf = pid => { try { return realpathSync(`/proc/${pid}/cwd`); } catch { return null; } };

/**
 * Where the unit's main process runs from, and whether that is the release current names. On 11-23 at 22:43Z a --no-restart release of 01910ba
 * took f006ef8 from a waiting release, built it and pointed current at it with no reload; the waiting releases of f006ef8 and 76a2860 then
 * found current holding their commits and ended as live, while the server still ran from release-f6b2825.
 */
function serving(home) {
  const cwd = cwdOf(mainPid());
  let want = null;
  try { want = realpathSync(join(home, "current/apps/chat")); } catch {}
  return { cwd, current: cwd !== null && cwd === want };
}

/**
 * Starts the release: a reload when the unit runs and its units did not change, so the running server hands the port to a successor and the
 * port never closes (apps/chat/server/handoff.ts), else a restart, during which calls wait in the socket's queue.
 */
function startRelease(home, unitsChanged) {
  const handsOver = existsSync(join(homedir(), ".config/systemd/user", SOCKET));
  const how = handsOver && !unitsChanged && isActive() ? "reload" : "restart";
  run("systemctl", ["--user", how, UNIT], home);
  return how;
}

/**
 * Waits until a process other than `before` is the unit's main one, runs from the release `dir`, answers GET /api/ready as itself, and
 * stays the main one for 8 s.
 */
async function upCheck(before, dir) {
  const app = realpathSync(join(dir, "apps/chat"));
  const end = Date.now() + 60_000;
  let pid = 0;
  for (;;) {
    pid = mainPid();
    let answered = 0;
    if (pid && pid !== before && cwdOf(pid) === app) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/api/ready`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) answered = (await res.json()).pid ?? pid;
      } catch {}
    }
    if (answered === pid && pid) break;
    if (Date.now() > end) throw new NotUp(`${UNIT} did not answer /api/ready from ${basename(dir)} on :${PORT} in 60 s`);
    await new Promise(done => setTimeout(done, 250));
  }
  await new Promise(done => setTimeout(done, 8000));
  if (mainPid() !== pid || !isActive()) throw new NotUp(`${UNIT} did not stay up for 8 s after its start`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const home = process.env.APPS_CHAT_RELEASE_HOME ?? join(homedir(), ".local/share/sieun-pi-apps-chat");
  mkdirSync(home, { recursive: true });
  const prebuilt = options.rollback && RELEASE_NAME.test(options.target) && existsSync(join(home, options.target, "release.json"));
  const sha = prebuilt ? releaseCommit(options.repo, join(home, options.target)) ?? options.target : git(options.repo, ["rev-parse", "--verify", "--quiet", `${options.target}^{commit}`]);
  if (!sha) throw new UsageError(`${options.target} is not a commit in ${options.repo}`);
  const releaseLock = await takeLock(home, { pid: process.pid, sha, startedAt: new Date().toISOString(), rollback: options.rollback });
  try {
    const live = checkNewer(options.repo, home, sha, options.rollback);
    if (live) {
      const server = serving(home);
      if (!options.restart || server.current) {
        log(`${sha.slice(0, 7)} is live already in ${live}`);
        console.log(live);
        return;
      }
      log(`${sha.slice(0, 7)} is in ${live}, which current names, but ${UNIT}'s main process runs from ${server.cwd ?? "nothing"}; starting ${live}`);
    }
    const own = live ? releaseCommit(options.repo, resolve(home, live)) : sha;
    let target = own;
    const newest = options.rollback ? null : newestWaiting(options.repo, home, own);
    if (newest) {
      try {
        checkPublished(options.repo, newest);
        target = newest;
        log(`releasing ${newest.slice(0, 7)}, which a waiting release asked for and which holds ${own.slice(0, 7)}`);
      } catch (error) {
        log(`${error.message}; releasing ${own.slice(0, 7)} itself`);
      }
    }
    if (!prebuilt && !live && target === sha) checkPublished(options.repo, sha);
    const before = liveRelease(home);
    const name = prebuilt ? options.target : live && target === own ? live : await build(options.repo, home, target);
    flip(home, name);
    const unitsChanged = installUnits(home);
    if (options.restart) {
      const pid = mainPid();
      const how = startRelease(home, unitsChanged);
      try {
        await upCheck(pid, join(home, name));
      } catch (error) {
        if (before && before !== name) {
          log(`${error.message}; going back to ${before}`);
          flip(home, before);
          installUnits(home);
          // After a failed hand-over the server before still serves; only a new main process that failed needs a restart.
          if (how === "restart" || mainPid() !== pid) run("systemctl", ["--user", "restart", UNIT], home);
        }
        throw error;
      }
      log(`${name} serves after a ${how}`);
    }
    const held = prune(home, RELEASE_NAME, [name, before].filter(Boolean));
    if (held.length) log(`kept ${held.join(", ")}, since a live process still runs in it; a later release removes it`);
    console.log(name);
  } finally {
    releaseLock();
  }
}

main().catch(error => {
  log(error.message);
  process.exit(error instanceof UsageError ? 2 : error instanceof Refused ? 3 : error instanceof Unpublished ? 4 : error instanceof NotUp ? 5 : 1);
});
