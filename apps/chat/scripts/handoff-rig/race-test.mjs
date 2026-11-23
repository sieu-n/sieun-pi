#!/usr/bin/env node
/**
 * The hand-over rig's release race (run.sh with TEST=race-test.mjs). Each round of `race` starts <releases> releases at once. Each takes
 * one lock as release-apps-chat.mjs does, waits a build time of 0 to 20 s, reloads the unit, and runs that script's up check: a new main
 * process that answers /api/ready as itself and stays the main one for 8 s, else a restart. Clients keep connections open meanwhile, so an
 * old server lingers up to http.ts KEEP_ALIVE_MS + 5 s and the next reload lands while it lives, the three-server chain of 21:24Z on 11-23.
 * Each round of `stray` makes systemd lose the serving process as it did then: a short-lived process in the unit tells systemd MAINPID= of
 * itself and ends, while the server keeps the data dir's lock in the core scope; the unit's next start must end that server and serve.
 * A round passes when it ends with one `server/main.ts --port <port>` process that is the unit's MainPID and holds the lock (its pid in
 * server.lock.pid), the unit active, NRestarts unchanged (`race`) or up by at most one (`stray`), every release's up check passed, and no
 * call refused, reset or answered with an error. It prints a JSON report and exits 1 when a round failed.
 * Usage: race-test.mjs <unit> <port> <data dir> <race|stray> <releases> <rounds>
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const [unit, portText, dataDir, mode = "race", releasesText = "2", roundsText = "10"] = process.argv.slice(2);
const port = Number(portText);
const releases = Number(releasesText);
const rounds = Number(roundsText);
const uid = process.getuid();
const unitCgroup = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${unit}`;

const show = prop => execFileSync("systemctl", ["--user", "show", "-p", prop, "--value", unit], { encoding: "utf8" }).trim();
const mainPid = () => Number(show("MainPID")) || 0;
const read = path => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
const cmdline = pid => read(`/proc/${pid}/cmdline`).split("\0").filter(Boolean).join(" ");
const cgroup = pid => read(`/proc/${pid}/cgroup`).trim().split("\n").find(line => line.startsWith("0::"))?.slice(3) ?? "";
const ppid = pid => Number(read(`/proc/${pid}/stat`).split(") ")[1]?.split(" ")[1] ?? 0);
const lockPid = () => Number(read(`${dataDir}/server.lock.pid`).trim()) || 0;
const servers = () => execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).split("\n")
  .filter(line => line.includes("server/main.ts") && line.includes(`--port ${port} `)).map(line => Number(line.trim().split(/\s+/)[0]));

const get = (path, agent) => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path, agent, timeout: 15_000 }, res => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", chunk => (body += chunk));
    res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    res.on("error", reject);
  });
  req.on("timeout", () => req.destroy(new Error("no answer in 15 s")));
  req.on("error", reject);
  req.end();
});

/** Calls on kept connections (the browser's way, which makes an old server linger) and on fresh ones, with every failure kept. */
const load = { calls: 0, failures: [] };
let loading = true;
const kept = new Agent({ keepAlive: true, maxSockets: 4 });
const loop = async (agent, path, gapMs) => {
  while (loading) {
    try {
      const answer = await get(path, agent);
      load.calls += 1;
      if (answer.status !== 200) load.failures.push(`${new Date().toISOString()} ${path} ${answer.status}`);
    } catch (error) {
      load.failures.push(`${new Date().toISOString()} ${path} ${error.code ?? error.message}`);
    }
    await sleep(gapMs);
  }
};
const loops = [...Array(4)].map(() => loop(kept, "/api/sidebar", 100)).concat([loop(false, "/api/ready", 200)]);

/** Every MainPID systemd held, with the process behind it, polled every 100 ms. */
const mains = [];
let watching = true;
const watch = (async () => {
  let last = -1;
  while (watching) {
    const pid = mainPid();
    if (pid !== last) mains.push({ at: new Date().toISOString(), pid, ppid: pid ? ppid(pid) : 0, cgroup: pid ? cgroup(pid) : "", cmd: pid ? cmdline(pid).slice(0, 160) : "" });
    last = pid;
    await sleep(100);
  }
})();

let releaseLock = Promise.resolve();
/** One release as release-apps-chat.mjs runs it: lock, build time, reload, up check, a restart when the up check fails. */
const release = async (name, buildMs) => {
  let unlock;
  const mine = new Promise(resolve => (unlock = resolve));
  const before = releaseLock;
  releaseLock = before.then(() => mine);
  await before;
  try {
    await sleep(buildMs);
    const was = mainPid();
    execFileSync("systemctl", ["--user", "reload", unit]);
    const end = Date.now() + 60_000;
    let pid = 0;
    for (;;) {
      pid = mainPid();
      let answered = 0;
      if (pid && pid !== was) {
        try {
          const answer = await get("/api/ready", false);
          if (answer.status === 200) answered = JSON.parse(answer.body).pid;
        } catch { /* not up yet */ }
      }
      if (answered && answered === pid) break;
      if (Date.now() > end) throw new Error(`${name}: no new main process answered in 60 s`);
      await sleep(250);
    }
    await sleep(8000);
    if (mainPid() !== pid || show("ActiveState") !== "active") throw new Error(`${name}: main ${pid} did not stay up for 8 s (now ${mainPid()}, ${show("ActiveState")})`);
    return { name, ok: true, main: pid };
  } catch (error) {
    execFileSync("systemctl", ["--user", "restart", unit]);
    return { name, ok: false, error: error.message };
  } finally {
    unlock();
  }
};

/** Makes systemd take a short-lived process in the unit as its main one, then ends it, as pid 888497 did at 21:24:22Z on 11-23. */
const loseServer = async () => {
  const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
  await new Promise(resolve => sleeper.once("spawn", resolve));
  writeFileSync(`${unitCgroup}/cgroup.procs`, String(sleeper.pid));
  const notify = `${process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`}/systemd/notify`;
  execFileSync("sh", ["-c", `echo $$ > ${unitCgroup}/cgroup.procs && exec systemd-notify --pid=${sleeper.pid} READY=1`], { env: { ...process.env, NOTIFY_SOCKET: notify } });
  for (let at = Date.now(); mainPid() !== sleeper.pid; await sleep(50)) if (Date.now() - at > 5000) throw new Error(`systemd did not take ${sleeper.pid} as the main process`);
  const server = lockPid();
  sleeper.kill("SIGKILL");
  return { sleeper: sleeper.pid, server };
};

const settle = async (restartsBefore, allowed) => {
  // The unit settles once one server holds the lock as MainPID, or after 90 s.
  for (let at = Date.now(); Date.now() - at < 90_000; await sleep(500)) {
    const list = servers();
    if (list.length === 1 && list[0] === mainPid() && list[0] === lockPid() && show("ActiveState") === "active") break;
  }
  await sleep(3000);
  const list = servers();
  const main = mainPid();
  const restarts = Number(show("NRestarts")) - restartsBefore;
  const problems = [];
  if (list.length !== 1) problems.push(`${list.length} servers on :${port}: ${list.join(", ")}`);
  if (list[0] !== main) problems.push(`the server ${list[0]} is not MainPID ${main}`);
  if (lockPid() !== main) problems.push(`server.lock.pid ${lockPid()} is not MainPID ${main}`);
  if (show("ActiveState") !== "active") problems.push(`the unit is ${show("ActiveState")}`);
  if (restarts > allowed) problems.push(`${restarts} restarts`);
  return { main, servers: list, restarts, problems };
};

const report = { mode, releases, rounds: [] };
await sleep(2000);
for (let round = 1; round <= rounds; round += 1) {
  const restartsBefore = Number(show("NRestarts"));
  const failuresBefore = load.failures.length;
  const mainsBefore = mains.length;
  const began = Date.now();
  let releasesRun = [];
  let lost = null;
  if (mode === "stray") {
    lost = await loseServer();
  } else {
    releasesRun = await Promise.all([...Array(releases)].map((_, i) => release(`r${round}.${i + 1}`, Math.round(Math.random() * 20_000))));
  }
  const end = await settle(restartsBefore, mode === "stray" ? 1 : 0);
  const failed = load.failures.slice(failuresBefore);
  const problems = [...end.problems, ...releasesRun.filter(each => !each.ok).map(each => each.error), ...failed.map(line => `call failed: ${line}`)];
  if (lost && end.main === lost.server) problems.push(`the lost server ${lost.server} still serves as MainPID`);
  // A failed round leaves the lost server holding the lock; it is ended here so the next round starts from one server again.
  if (problems.length && lost && servers().includes(lost.server)) {
    process.kill(lost.server, "SIGTERM");
    await settle(Number(show("NRestarts")), 1000);
  }
  report.rounds.push({ round, ms: Date.now() - began, ok: problems.length === 0, problems, lost, releases: releasesRun, end, mains: mains.slice(mainsBefore) });
  process.stderr.write(`round ${round}: ${problems.length ? `FAIL ${problems.join("; ")}` : "ok"}\n`);
}
loading = false;
watching = false;
await Promise.all([...loops, watch]);
report.passed = report.rounds.filter(each => each.ok).length;
report.calls = load.calls;
report.failedCalls = load.failures.length;
console.log(JSON.stringify(report, null, 2));
process.exit(report.passed === rounds ? 0 : 1);
