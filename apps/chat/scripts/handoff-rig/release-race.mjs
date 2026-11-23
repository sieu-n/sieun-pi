#!/usr/bin/env node
/**
 * The hand-over rig's race of real releases: scripts/release-apps-chat.mjs itself, pointed at the copy unit, its port and a release folder
 * of the rig's own through APPS_CHAT_RELEASE_HOME, APPS_CHAT_RELEASE_UNIT and APPS_CHAT_RELEASE_PORT. Each release folder is built here
 * instead of by the script: a release.json naming a commit of origin main, deploy/linux holding the copy's installed units, and an apps/chat
 * folder of links to the live release's apps/chat, so each release runs the same code from its own folder and /proc/<pid>/cwd tells them apart.
 * Each round starts a release of commit a, and while it holds the lock a --no-restart release of b and a release of c, with a < b < c on main.
 * When the --no-restart one takes the lock first it releases c for the waiting one, as d3-release-01910ba did for f006ef8 at 22:43Z on 11-23.
 * A round passes when every release exited 0, current names release-<c>, and one `server/main.ts --port <port>` process runs, is the unit's
 * MainPID, holds the data dir's lock and runs from current. It prints a JSON report and exits 1 when a round failed.
 *
 *   OUT=<empty dir>; CODE=$(node release-race.mjs prepare "$OUT" 10) &&
 *     env -u NOTIFY_SOCKET -u WATCHDOG_USEC -u WATCHDOG_PID TEST=release-race.mjs TEST_ARGS=10 run.sh "$CODE" "$OUT"
 *
 * Run it from a folder the live release prune keeps, such as the live release (systemd-run --working-directory), because each rig release
 * links into it. RELEASE_SCRIPT names another copy of the script to race, such as the one before a fix; it must read the three variables.
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const script = process.env.RELEASE_SCRIPT ?? join(repo, "scripts/release-apps-chat.mjs");
const short = sha => sha.slice(0, 7);
const read = path => { try { return readFileSync(path, "utf8"); } catch { return ""; } };

/** The first-parent commits of origin main, oldest first: the rig's starting release, then three a round. */
const commits = count => execFileSync("git", ["-C", repo, "rev-list", "--first-parent", "-n", String(count), "origin/main"], { encoding: "utf8" }).trim().split("\n").reverse();

/** Builds <rel>/release-<sha7> as the script would leave it, with deploy/linux copied from `units` when given. */
function makeRelease(rel, base, sha, units) {
  const dir = join(rel, `release-${short(sha)}`);
  const app = join(dir, "apps/chat");
  if (!existsSync(app)) {
    mkdirSync(app, { recursive: true });
    for (const entry of readdirSync(join(base, "apps/chat"))) symlinkSync(join(base, "apps/chat", entry), join(app, entry));
  }
  if (units) {
    mkdirSync(join(dir, "deploy/linux"), { recursive: true });
    for (const unit of units) copyFileSync(join(homedir(), ".config/systemd/user", unit), join(dir, "deploy/linux", unit));
  }
  writeFileSync(join(dir, "release.json"), `${JSON.stringify({ sha, builtAt: new Date().toISOString() })}\n`);
  return basename(dir);
}

if (process.argv[2] === "prepare") {
  const out = resolve(process.argv[3]);
  const rel = join(out, "rel");
  const base = realpathSync(join(homedir(), ".local/share/sieun-pi-apps-chat/current"));
  const list = commits(1 + 3 * Number(process.argv[4] ?? 10));
  mkdirSync(rel, { recursive: true });
  writeFileSync(join(rel, "base"), base);
  writeFileSync(join(rel, "commits"), `${list.join("\n")}\n`);
  const name = makeRelease(rel, base, list[0], null);
  symlinkSync(name, join(rel, "current"));
  console.log(join(rel, "current/apps/chat"));
  process.exit(0);
}

const [unit, portText, dataDir, roundsText = "10"] = process.argv.slice(2);
const port = Number(portText);
const rounds = Number(roundsText);
const rel = join(dirname(dataDir), "rel");
const base = read(join(rel, "base")).trim();
const units = [unit, unit.replace(/\.service$/, ".socket")];
if (!/APPS_CHAT_RELEASE_UNIT/.test(read(script))) throw new Error(`${script} does not read APPS_CHAT_RELEASE_UNIT, so it would release the live unit`);
if (!base || !unit.startsWith("apps-chat-handoff-copy")) throw new Error(`run this through run.sh on its copy unit after prepare (unit ${unit}, base ${base || "none"})`);

const show = prop => execFileSync("systemctl", ["--user", "show", "-p", prop, "--value", unit], { encoding: "utf8" }).trim();
const mainPid = () => Number(show("MainPID")) || 0;
const cwdOf = pid => { try { return realpathSync(`/proc/${pid}/cwd`); } catch { return null; } };
const lockPid = () => Number(read(`${dataDir}/server.lock.pid`).trim()) || 0;
const servers = () => execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).split("\n")
  .filter(line => line.includes("server/main.ts") && line.includes(`--port ${port} `)).map(line => Number(line.trim().split(/\s+/)[0]));
const lockHolder = () => { try { return JSON.parse(read(join(rel, "release.lock"))).pid ?? 0; } catch { return 0; } };

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["NOTIFY_SOCKET", "WATCHDOG_USEC", "WATCHDOG_PID"].includes(key)));
Object.assign(env, { APPS_CHAT_RELEASE_HOME: rel, APPS_CHAT_RELEASE_UNIT: unit, APPS_CHAT_RELEASE_PORT: String(port) });
const children = new Set();
process.on("exit", () => { for (const child of children) child.kill("SIGTERM"); });

/** One run of the script; resolves with its exit code, its pid and its stderr. */
function release(name, args) {
  const child = spawn(process.execPath, [script, ...args, "--repo", repo], { cwd: base, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  child.stdout.on("data", chunk => (output += chunk));
  child.stderr.on("data", chunk => (output += chunk));
  const done = new Promise(resolve => child.on("close", code => { children.delete(child); resolve({ name, args: args.join(" "), code, built: output.includes(".building-"), lines: output.trim().split("\n").filter(line => line.startsWith("release-apps-chat:") && !line.includes(" (in ")) }); }));
  return { pid: child.pid, done };
}

const list = read(join(rel, "commits")).trim().split("\n");
if (list.length < 1 + 3 * rounds) throw new Error(`prepare listed ${list.length} commits, and ${rounds} rounds take ${1 + 3 * rounds}`);
makeRelease(rel, base, list[0], units);
const report = { script, rounds: [] };
for (let round = 0; round < rounds; round += 1) {
  const [a, b, c] = list.slice(1 + 3 * round, 4 + 3 * round);
  // The script prunes every release folder no process runs in once its release serves, and would build the waiting ones' folders for real;
  // a process in each keeps them (scripts/release-prune.mjs releasesInUse).
  const holders = [a, b, c].map(sha => spawn("sleep", ["3600"], { cwd: join(rel, makeRelease(rel, base, sha, units)), stdio: "ignore" }));
  for (const holder of holders) children.add(holder);
  const restartsBefore = Number(show("NRestarts"));
  const began = Date.now();
  const holder = release("a", [a]);
  for (let at = Date.now(); lockHolder() !== holder.pid && Date.now() - at < 30_000; await sleep(50));
  await sleep(1000);
  const noRestart = release("b", [b, "--no-restart"]);
  await sleep(300);
  const waiting = release("c", [c]);
  const runs = await Promise.all([holder.done, noRestart.done, waiting.done]);
  for (const each of holders) { each.kill(); children.delete(each); }
  for (let at = Date.now(); Date.now() - at < 60_000; await sleep(500)) {
    const now = servers();
    if (now.length === 1 && now[0] === mainPid() && now[0] === lockPid()) break;
  }
  await sleep(2000);
  const main = mainPid();
  const now = servers();
  const current = readlinkSync(join(rel, "current"));
  const want = realpathSync(join(rel, "current/apps/chat"));
  const problems = [];
  for (const run of runs) if (run.code !== 0) problems.push(`release ${run.name} (${run.args.split(" ")[0].slice(0, 7)}) exited ${run.code}`);
  for (const run of runs) if (run.built) problems.push(`release ${run.name} built a folder itself`);
  if (current !== `release-${short(c)}`) problems.push(`current is ${current}, not release-${short(c)}`);
  if (cwdOf(main) !== want) problems.push(`MainPID ${main} runs from ${cwdOf(main)}, not ${want}`);
  if (now.length !== 1) problems.push(`${now.length} servers on :${port}: ${now.join(", ")}`);
  if (lockPid() !== main) problems.push(`server.lock.pid ${lockPid()} is not MainPID ${main}`);
  if (show("ActiveState") !== "active") problems.push(`the unit is ${show("ActiveState")}`);
  if (Number(show("NRestarts")) !== restartsBefore) problems.push(`${Number(show("NRestarts")) - restartsBefore} restarts`);
  const adopted = runs[1].lines.some(line => line.includes(`releasing ${short(c)}, which a waiting release asked for`));
  report.rounds.push({ round: round + 1, ms: Date.now() - began, ok: problems.length === 0, adopted, problems, current, main, mainCwd: cwdOf(main), runs });
  process.stderr.write(`round ${round + 1}: ${adopted ? "no-restart release took c" : "c took the lock first"}; ${problems.length ? `FAIL ${problems.join("; ")}` : "ok"}\n`);
}
report.passed = report.rounds.filter(each => each.ok).length;
report.adopted = report.rounds.filter(each => each.adopted).length;
console.log(JSON.stringify(report, null, 2));
process.exit(report.passed === rounds ? 0 : 1);
