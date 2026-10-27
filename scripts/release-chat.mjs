#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { get } from "node:http";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
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
The build runs npm run typecheck and npm test of legacy/prime/user-history inside the release before the flip, then writes the packed client bundle.
Those steps get PATH and the locale from this shell and a private HOME, TMPDIR and XDG dirs, so they see no agent socket, token, session dir or key.
--no-kickstart flips current only, for a release whose diff touches only scripts/duties or tests.
A waiting release whose commit a release puts live (current holds it and the chat runs current) exits 0 at once, while the lock is still held.
After a failed build the name of each failing test goes into the log and build.failed, and the next release that waited for the lock also tries
origin main's tip first, unless the failed build was that same tip's retry.
Releases that queue up are folded: the release that takes the lock reads the requests waiting for it, picks the queued commit on origin main
that holds its own commit and the most queued ones, builds that one, flips current, restarts and names each request it covered. The covered
waiters then exit 0 with nothing built. A request that arrives during the build waits for the next batch. When the picked build fails, the
release builds the next candidate down to its own commit, so a newer request that fails never takes the older ones with it. --rollback is
never folded. The batch restarts unless every covered request passed --no-kickstart, and it never leaves its restart to a later release.
A release that takes the lock with restart.owed, which helpers before the fold left to a waiting release, makes that restart before its build.
A restart counts as applied only while the service manager reports the service running (systemctl is-active, launchctl print).
After each restart it checks that the chat answers http://127.0.0.1:5182/, is still the same process 8 s after its start, and stays that process
until GET /ready answers 200 at the end of its first pass (up to 180 s; a release without /ready answers 404 and stands on the 8 s). When it is not,
current goes back to the release the chat ran before, that release restarts, and the command exits 5 naming the failure.
After the flip it deletes each release folder except current, the one current named before, the one the chat was last started on, a waiting
release's and any folder a running process names, so a rollback further back than the release before current builds that commit again.
A box whose hosts.json entry (SIEUN_PI_HOSTS, else ~/.config/sieun-pi/hosts.json, matched by short hostname) has no chat role runs no chat
service, so the release there builds nothing and names the box that holds the chat role.
Prints the live release id on the last line. Exit 1 on a failed build step, 2 on bad usage, 3 on a refused rollback, 4 on a commit not on origin main, 5 on a start that did not stay up,
6 on a box with no chat role.`;

const LABEL = "com.sieun.agent-chat";
const UNIT = "sieun-pi-chat.service";
const RELEASE_NAME = /^release-([0-9a-f]{7,40})(?:-.+)?$/;
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"].includes(key)));

class Refused extends Error {}
class NoChatRole extends Error {}
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

/** The build step running now, and the signal this release got while it ran: the step gets the signal, and its failure ends the release. */
let step = null, stopping = null;

/**
 * Runs a build step like `run`, its output passed through to stderr, and names each test the node test runner lists under "failing tests"
 * in the error: on 10-19 the c29cf48 build failed 3 tests at a load of 280, and the queue's logs said only "npm run --silent test failed (1)".
 */
function runNamingFailures(command, args, cwd, env) {
  log(`${command} ${args.join(" ")} (in ${cwd})`);
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env });
  step = child;
  const failing = [];
  let section = false, file = "", rest = "";
  const read = chunk => {
    process.stderr.write(chunk);
    const lines = (rest + chunk).split("\n");
    rest = lines.pop();
    for (const line of lines) {
      if (/^✖ failing tests:/.test(line)) section = true;
      else if (section && /^test at /.test(line)) file = line.slice(8).replace(/:\d+:\d+$/, "");
      else if (section && /^✖ /.test(line)) failing.push(`${file ? `${file}: ` : ""}${line.slice(2).replace(/ \([\d.]+ms\)$/, "")}`);
    }
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  return new Promise((done, fail) => child.on("close", (status, signal) => {
    step = null;
    if (status === 0 && !stopping) { done(); return; }
    const error = new Error(`${command} ${args.join(" ")} failed (${signal ?? status})${failing.length ? `; failing tests: ${failing.join("; ")}` : ""}`);
    error.failing = failing;
    fail(error);
  }));
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
 * Fetches origin's main into a ref of this process's own and calls `use` with that ref, or with null and git's last error line when the fetch
 * fails. Releases and jobs fetch in the same repo at once, and a shared ref's lock would fail one of them.
 */
function withOriginMain(repo, use) {
  const ref = `refs/release-chat/origin-main-${process.pid}`;
  const fetched = spawnSync("git", ["-C", repo, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", `+refs/heads/main:${ref}`], { encoding: "utf8", env: gitEnv });
  try {
    return use(fetched.status === 0 ? ref : null, fetched.stderr.trim().split("\n").pop());
  } finally {
    spawnSync("git", ["-C", repo, "update-ref", "-d", ref], { env: gitEnv });
  }
}

/**
 * Throws Unpublished unless `sha` is on origin's main as fetched now. On 10-18 releases built from commits no one had pushed went live
 * (release-322de20 had to be merged into main afterwards so later releases descended from it), and each such release let the chat drift from main.
 */
function checkPublished(repo, sha) {
  withOriginMain(repo, (ref, error) => {
    if (!ref)
      throw new Unpublished(`could not fetch origin main to check that ${sha.slice(0, 7)} is published (${error}); retry when origin answers, or pass --rollback <release-id> to go to a release already built`);
    if (!contains(repo, ref, sha)) throw new Unpublished(`${sha.slice(0, 7)} is not on origin/main; push it to main first, then release it`);
  });
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
 * Takes <home>/release.lock, waiting while a live process holds it; a lock whose pid is gone is taken over. Returns the release function and
 * whether this release waited for another one.
 * The lock and the draft `release.lock.<pid>` written while it waits hold the request: pid, sha, startedAt, kickstart and rollback.
 * A release waits even when the holder's commit holds its own: that build can still fail, and then this one is the release that ships the commit.
 * `covered` runs on each wait and throws Covered once a release put this commit live: on 10-19 from 17:52Z waiters that release-bf42653 held
 * stayed queued behind the next build for 12 min and more, since they checked only when they took the lock.
 */
async function takeLock(home, request, covered = () => {}) {
  const lock = join(home, "release.lock");
  const body = JSON.stringify(request) + "\n";
  const draft = `${lock}.${process.pid}`;
  writeFileSync(draft, body);
  let told = false, waited = false;
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
      covered();
      waited = true;
      await new Promise(done => setTimeout(done, 500));
    }
  } finally { rmSync(draft, { force: true }); }
  const release = () => { try { if (readFileSync(lock, "utf8") === body) unlinkSync(lock); } catch {} };
  process.on("exit", release);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {
    if (!step) { release(); process.exit(1); }
    stopping = signal;
    step.kill(signal);
  });
  return { release, waited };
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

const LEGACY_APP = "legacy/prime/user-history";
const OLD_APP = "components/user-history";

/**
 * Where the chat sits in a release tree: legacy/prime/user-history since the layout move, components/user-history before it, so a
 * --rollback onto a commit from before the move still builds. A release of the new layout also gets components/user-history as a link to
 * the chat, because units, installed watchdog and reaper copies, chat duties and auto-sns-agent's ci-monitoring duty name
 * ~/.local/share/sieun-pi-chat/current/components/user-history until the switch to Pi deletes legacy/prime.
 */
function chatAppPath(tree) {
  return existsSync(join(tree, LEGACY_APP, "package.json")) ? LEGACY_APP : OLD_APP;
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
    const appPath = chatAppPath(scratch);
    symlinkSync(join(options.repo, appPath, "node_modules"), join(scratch, appPath, "node_modules"));
    if (appPath === LEGACY_APP && !existsSync(join(scratch, OLD_APP))) {
      mkdirSync(join(scratch, "components"), { recursive: true });
      symlinkSync("../legacy/prime/user-history", join(scratch, OLD_APP));
    }
    const app = join(scratch, appPath);
    const env = checkEnv(checks);
    run("npm", ["run", "--silent", "typecheck"], app, env);
    await runNamingFailures("npm", ["run", "--silent", "test"], app, env);
    // The packed client bundle, so the service start reads it instead of compiling it (6.5 s at a load of 50 on 10-18) while every shell waits.
    run("node", ["src/chat-assets-prebuild.mjs"], app, env);
    // The service's own bundle, which chat-service-cli.mjs loads with no tsx: a start in a new release folder compiled every .ts file again,
    // and on a scratch serve of 10-20 the bundle took the start to listening from 4.1 to 4.3 s of main-thread CPU to 2.3 to 2.4 s.
    run("node", ["src/chat-service-bundle.mjs"], app, env);
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

/** Whether `pid` is a running release-chat process. A draft outlives a release that was killed, and its pid can come back as another program. */
function releaseProcess(pid) {
  if (!alive(pid)) return false;
  const command = existsSync("/proc/self/cmdline")
    ? readText(`/proc/${pid}/cmdline`)
    : spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout;
  return /release-chat/.test(command ?? "");
}

/**
 * The requests waiting for the lock: each release writes its lock draft `release.lock.<pid>` while it waits. A draft from a helper before the
 * fold names no kickstart or rollback, and counts as a release that restarts and is no rollback. On us-metal02 at 21:20Z on 10-18 the folder
 * held 15 drafts whose release processes were gone.
 */
function waiting(home) {
  const found = [];
  for (const name of readdirSync(home)) {
    const pid = Number(/^release\.lock\.(\d+)$/.exec(name)?.[1]);
    if (!pid || pid === process.pid || !releaseProcess(pid)) continue;
    try {
      const draft = JSON.parse(readFileSync(join(home, name), "utf8"));
      found.push({ pid, sha: String(draft.sha), kickstart: draft.kickstart !== false, rollback: draft.rollback === true });
    } catch {}
  }
  return found;
}

const OWED = "restart.owed";
const FAILED = "build.failed";

/** The last failed build (build.failed): its commit, the failing tests it named and whether it was a retry of origin main's tip; null when none. */
function readFailed(home) {
  try {
    const failed = JSON.parse(readFileSync(join(home, FAILED), "utf8"));
    return typeof failed.sha === "string" ? { sha: failed.sha, tests: Array.isArray(failed.tests) ? failed.tests.map(String) : [], retry: failed.retry === true } : null;
  } catch { return null; }
}
const shortSha = sha => sha.slice(0, 7);
const describe = requests => requests.map(request => `${shortSha(request.sha)} (pid ${request.pid}${request.pid === process.pid ? ", this release" : ""})`).join(", ");

/**
 * The builds this release may make for `own` and the requests that wait for the lock, best first. Each is a queued commit that holds `own`,
 * is on origin main as fetched now and holds the live release, with the requests it holds (covered) and whether any of them restarts.
 * The last one is `own` alone, so a failed build of a newer queued commit falls back to the next and never loses the older requests.
 * When origin does not answer, only `own` is built, since its own check passed at the start. On us-metal02 the journal shows 11 chat
 * restarts from 16:04Z to 17:59Z on 10-18, one for each release that built.
 */
function batches(repo, home, own, waited) {
  const queued = waiting(home).filter(request => !request.rollback);
  const { published, tip } = withOriginMain(repo, ref => (ref ? { published: queued.filter(request => contains(repo, ref, request.sha)), tip: git(repo, ["rev-parse", ref]) } : { published: [], tip: null }));
  const requests = [own, ...queued];
  const failed = readFailed(home);
  const retry = waited && failed && tip && !(failed.sha === tip && failed.retry) ? tip : null;
  if (retry) log(`the last build, of ${shortSha(failed.sha)}, failed${failed.tests.length ? ` on ${failed.tests.join("; ")}` : ""}; trying origin main's tip ${shortSha(retry)} first`);
  const shas = [...new Set([...(retry ? [retry] : []), own.sha, ...published.map(request => request.sha)])].filter(sha => {
    if (!contains(repo, sha, own.sha)) return false;
    try { checkNewer(repo, home, sha, false); return true; } catch (error) { if (error instanceof Refused) return false; throw error; }
  });
  const candidates = shas.map(sha => {
    const covered = requests.filter(request => contains(repo, sha, request.sha));
    return { sha, covered, kickstart: covered.some(request => request.kickstart), retry: sha === retry };
  });
  const order = (a, b) => (a.sha === own.sha) - (b.sha === own.sha) || b.retry - a.retry || b.covered.length - a.covered.length;
  return { plans: candidates.sort(order), left: queued.filter(request => !candidates[0].covered.includes(request)) };
}

/**
 * Restarts the service unless the chat already runs current. A batch whose covered requests all passed --no-kickstart only flips, unless a
 * helper before the fold left restart.owed. A batch always makes its own restart, even when more releases wait: a waiting release could fail
 * or hang, and on 10-18 a steady queue that passed one restart on 12 times left the chat 51 min behind current. `before` is the release current
 * named before this release flipped it, the release to go back to when the new one does not stay up and the chat ran no other.
 */
async function restart(home, wanted, before = null) {
  const owed = join(home, OWED);
  if (applied(home)) { rmSync(owed, { force: true }); return; }
  if (!wanted && !existsSync(owed)) return;
  try { await kickstart(home, before); } finally { rmSync(owed, { force: true }); }
}

/** Makes the restart restart.owed holds, onto the release current already points at, right after this release takes the lock. */
async function payOwed(home) {
  const owed = join(home, OWED);
  if (!existsSync(owed)) return;
  if (!applied(home)) {
    log(`restarting onto ${liveRelease(home)} for the restart this release was left (restart.owed), before its own build`);
    try { await kickstart(home); } finally { rmSync(owed, { force: true }); }
  } else rmSync(owed, { force: true });
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

class StartFailed extends Error {}

const chatUrl = () => process.env.SIEUN_PI_CHAT_URL || "http://127.0.0.1:5182/";
/**
 * How long a start may take to answer: from the journal's "Started" line to the early shell's "handed over" line in service.log, 58 starts on
 * us-metal02 from 10-16 to 10-19 took 1.9 to 37.7 s (median 3.9 s), so 60 s fails only a start that hangs. A start that exits fails at once.
 */
const ANSWER_MS = Number(process.env.SIEUN_PI_CHAT_ANSWER_MS || 60_000);
/**
 * How long after its start the service must still be the same process: the release of 10-19 01:14Z crash-looped with 19 exits that each came
 * 4.7 to 6.8 s after their start (journalctl --user -u sieun-pi-chat), so 8 s covers the latest of them.
 */
const HOLD_MS = Number(process.env.SIEUN_PI_CHAT_HOLD_MS || 8_000);
/**
 * How long a start may take to end its first pass (GET /ready, `Chats.ready`) before the release stands on the hold alone. On 10-23 release
 * fbd5a0a0 answered 3 s after each start and threw in its first pass 30 s after it, 4 times, so the release waits for that pass. A release
 * from before /ready answers 404 there and stands on the hold.
 */
const READY_MS = Number(process.env.SIEUN_PI_CHAT_READY_MS || 180_000);
/** systemctl show answered in 20 ms on us-metal02 on 10-19, so polling it every 250 ms finds an exit within a quarter second for little CPU. */
const POLL_MS = 250;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const seconds = ms => `${(ms / 1000).toFixed(1)} s`;

/** The running service process: systemd's invocation id and main pid, or launchd's pid. Null while none runs. */
function serviceProcess() {
  if (systemd()) {
    const shown = spawnSync(systemctl(), ["--user", "show", "-p", "ActiveState", "-p", "MainPID", "-p", "InvocationID", UNIT], { encoding: "utf8" });
    const props = Object.fromEntries((shown.stdout ?? "").split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    return shown.status === 0 && props.ActiveState === "active" && Number(props.MainPID) > 0 ? `invocation ${props.InvocationID} pid ${props.MainPID}` : null;
  }
  const printed = spawnSync(launchctl(), ["print", launchdTarget()], { encoding: "utf8" });
  const pid = /^\s*pid = (\d+)\s*$/m.exec(printed.stdout ?? "")?.[1];
  return printed.status === 0 && /^\s*state = running\s*$/m.test(printed.stdout) && pid ? `pid ${pid}` : null;
}

/** The HTTP status `url` answers with, or the error code of a request that got none. */
const ask = (url, signal) => new Promise(done => {
  const request = get(url, { agent: false, signal }, response => { response.resume(); done(response.statusCode); });
  request.on("error", error => done(error.code ?? error.message));
});

/**
 * Null when the service started at `startedAt` answers the chat URL with a status below 500, is still the same process HOLD_MS after its
 * start, and its GET /ready answers 200 (or 404 from a release without it, or still 503 after READY_MS); else what went wrong. A request to
 * the systemd socket waits while no service accepts it, so the process is polled next to it: on 10-19 at 01:14Z the release died at listen
 * on that socket, the socket kept the port, and the page sat on its red banner for 5 min.
 */
async function checkStart(startedAt) {
  const url = chatUrl();
  const readyUrl = new URL("/ready", url).href;
  const first = serviceProcess();
  if (!first) return "was not running right after its restart";
  const controller = new AbortController();
  let answered = null, last = "no answer yet", trial = false;
  const asking = (async () => {
    while (!controller.signal.aborted) {
      const status = await ask(url, controller.signal);
      if (typeof status === "number" && status < 500) { answered = Date.now(); return; }
      last = typeof status === "number" ? `HTTP ${status}` : status;
      await sleep(POLL_MS);
    }
  })();
  try {
    for (;;) {
      const now = serviceProcess(), after = seconds(Date.now() - startedAt);
      if (now !== first) return `${now ? `restarted as ${now}` : "exited"} ${after} after its start (${first})${trial ? ", before it ended its first pass" : answered ? "" : `, before it answered ${url}`}`;
      if (answered && Date.now() - startedAt >= HOLD_MS) {
        const ready = await ask(readyUrl, AbortSignal.timeout(2_000));
        if (serviceProcess() !== first) continue;
        const ran = `the chat answered ${url} ${seconds(answered - startedAt)} after its start`;
        if (ready === 200) { log(`${ran}, ended its first pass and still runs as ${first} after ${seconds(Date.now() - startedAt)}`); return null; }
        if (typeof ready === "number" && ready !== 503) { log(`${ran} and still runs as ${first} after ${after}`); return null; }
        trial = true;
        if (Date.now() - startedAt >= READY_MS) {
          log(`${ran} and still runs as ${first} after ${after}, but its first pass has not ended (${readyUrl}: ${ready}); the release stands`);
          return null;
        }
      }
      if (!answered && Date.now() - startedAt >= ANSWER_MS) return `did not answer ${url} within ${seconds(ANSWER_MS)} of its start (${last})`;
      await sleep(POLL_MS);
    }
  } finally {
    controller.abort();
    await asking;
  }
}

/** Restarts the chat service on current: on systemd it installs current's units first when they differ. */
function restartService(home) {
  if (systemd()) {
    if (!switchUnits(home)) run(systemctl(), ["--user", "restart", UNIT], process.cwd());
  } else run(launchctl(), ["kickstart", "-k", launchdTarget()], process.cwd());
}

/**
 * Restarts the chat service on current, checks that it stays up (checkStart) and records the release it started on. When it does not, current
 * goes back to the release the chat ran before (started.json), else to `before`, that release restarts, and StartFailed names the failure.
 */
async function kickstart(home, before = null) {
  const id = liveRelease(home);
  const ran = (() => { try { return JSON.parse(readText(join(home, STARTED))).id; } catch { return null; } })();
  const startedAt = Date.now();
  restartService(home);
  const failure = await checkStart(startedAt);
  if (!failure) {
    writeFileSync(join(home, STARTED), JSON.stringify({ id, at: new Date().toISOString() }) + "\n");
    return;
  }
  const back = [ran, before].find(release => release && release !== id && existsSync(join(home, release)));
  if (!back) throw new StartFailed(`the chat on ${id} ${failure}; no release before it to go back to`);
  log(`the chat on ${id} ${failure}; going back to ${back}`);
  flip(home, back);
  const backAt = Date.now();
  restartService(home);
  const again = await checkStart(backAt);
  if (!again) writeFileSync(join(home, STARTED), JSON.stringify({ id: back, at: new Date().toISOString() }) + "\n");
  throw new StartFailed(`the chat on ${id} ${failure}, so current went back to ${back}${again ? `, and the chat on ${back} ${again} too` : ", which runs again"}`);
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

/**
 * Throws NoChatRole when hosts.json lists this box without a chat role. The Mac ran this for b6219fb at 10-21 17:55Z and failed 9 Linux-only tests,
 * though its boards live on us-metal02's :5182 and nothing on the Mac listens on 5182.
 */
function checkChatRole() {
  let hosts;
  try { hosts = JSON.parse(readFileSync(process.env.SIEUN_PI_HOSTS || join(homedir(), ".config/sieun-pi/hosts.json"), "utf8")).hosts; } catch { return; }
  if (!Array.isArray(hosts)) return;
  const short = name => String(name ?? "").toLowerCase().split(".")[0];
  const self = hosts.find(host => short(host?.hostname) === short(hostname()));
  if (!self || self.roles?.chat) return;
  const holder = hosts.find(host => host?.roles?.chat);
  throw new NoChatRole(`${self.name} has no chat role in hosts.json, so it runs no chat service and builds no release; ` +
    (holder ? `the chat runs on ${holder.name}, so run scripts/release-chat.mjs from its sieun-pi checkout (ssh ${holder.ssh})` : "no box holds the chat role"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  checkChatRole();
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
  const own = { pid: process.pid, sha, startedAt: new Date().toISOString(), kickstart: options.kickstart, rollback: options.rollback };
  // Checked again only when current or started.json changes, or while the live release holds this commit but the chat does not run it yet.
  let seen = null;
  const wentLive = () => {
    const now = `${liveRelease(home)}\n${readText(join(home, STARTED))}`;
    if (now === seen) return;
    const holder = holding();
    seen = holder ? null : now;
    if (holder && !existsSync(join(home, OWED)) && (!options.kickstart || applied(home)))
      throw new Covered(`${short} already live in ${holder}; nothing to do, since it went live while this release waited`);
  };
  const { waited } = await takeLock(home, own, wentLive);
  await payOwed(home);
  const kept = holding();
  if (kept) {
    log(applied(home) ? `${short} already live in ${kept}; nothing to do` : `${short} is already in ${kept}, which the chat does not run yet with its units`);
    await restart(home, options.kickstart);
    console.log(kept);
    return;
  }
  checkNewer(options.repo, home, sha, options.rollback);
  const { plans, left } = options.rollback ? { plans: [{ sha, covered: [own], kickstart: options.kickstart }], left: [] } : batches(options.repo, home, own, waited);
  if (plans[0].covered.length > 1) log(`folding the queued requests ${describe(plans[0].covered)} into one build of ${shortSha(plans[0].sha)}`);
  if (left.length) log(`leaving ${describe(left)} to a release of their own, since ${shortSha(plans[0].sha)} does not hold them`);
  for (const plan of plans) {
    const planDir = plan.sha === sha ? dir : join(home, `release-${shortSha(plan.sha)}`);
    const planId = basename(planDir);
    try {
      if (existsSync(planDir)) log(`${planId} is built already; reusing it`);
      else await build(options, home, plan.sha, planDir);
    } catch (error) {
      writeFileSync(join(home, FAILED), JSON.stringify({ sha: plan.sha, tests: error.failing ?? [], retry: plan.retry === true, at: new Date().toISOString() }) + "\n");
      if (plan.sha === sha || stopping) throw error;
      log(`the build of ${shortSha(plan.sha)} failed (${error.message}); its request stays queued, and this release builds the next candidate`);
      continue;
    }
    checkNewer(options.repo, home, plan.sha, options.rollback);
    const before = liveRelease(home);
    flip(home, planId);
    log(`current: ${before ?? "(none)"} -> ${planId}`);
    try { await restart(home, plan.kickstart, before); } catch (error) {
      if (!(error instanceof StartFailed) || plan.sha === sha) throw error;
      log(`${error.message}; its request stays queued, and this release builds the next candidate`);
      continue;
    }
    const failed = readFailed(home);
    if (failed && contains(options.repo, plan.sha, failed.sha)) rmSync(join(home, FAILED), { force: true });
    log(`${planId} covers the requests of ${describe(plan.covered)}`);
    prune(home, [planId, before]);
    console.log(planId);
    return;
  }
}

main().catch(error => {
  log(error.message);
  if (error instanceof Covered) { console.log(liveRelease(chatHome()) ?? ""); process.exit(0); }
  if (error instanceof UsageError) process.stderr.write(`${USAGE}\n`);
  process.exit(error instanceof Refused ? 3 : error instanceof UsageError ? 2 : error instanceof Unpublished ? 4 : error instanceof StartFailed ? 5 : error instanceof NoChatRole ? 6 : 1);
});
