// The copy rig's hand-over test: N back-to-back `systemctl --user reload <unit>` of an apps/chat copy whose main process mover.py keeps in a
// scope outside the unit's cgroup, under a read loop of fresh connections and a send loop into one test channel. It fails when the port
// refused or reset a call, when more than one server process runs on the data dir after a reload, when a reload did not hand over in 60 s,
// or when the channel holds a duplicate seq or misses a send that answered 200. Prints one JSON report.
// Usage: node rig-test.mjs <unit> <port> <data dir> [rounds=5]; run.sh in this folder sets up the copy unit, mover.py and the data dir.
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const [unit, portText, dataDir, roundsText = "5"] = process.argv.slice(2);
const port = Number(portText);
const rounds = Number(roundsText);
const show = prop => execFileSync("systemctl", ["--user", "show", "-p", prop, "--value", unit], { encoding: "utf8" }).trim();

const call = (method, path, body) => new Promise((resolve, reject) => {
  const started = performance.now();
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const req = request({ host: "127.0.0.1", port, path, method, agent: false, timeout: 20_000, headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, res => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", chunk => (text += chunk));
    res.on("end", () => resolve({ status: res.statusCode, text, ms: performance.now() - started }));
    res.on("error", reject);
  });
  req.on("timeout", () => req.destroy(new Error("no answer in 20 s")));
  req.on("error", reject);
  req.end(data);
});

/** The pids whose command line serves `dataDir`, so a second server shows wherever its cgroup is. */
const servers = () => readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(pid => {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return argv.some(arg => arg.endsWith("server/main.ts")) && argv.includes(dataDir) ? [Number(pid)] : [];
  } catch { return []; }
});

const room = JSON.parse((await call("POST", "/api/rooms", { kind: "channel", name: `rig-${Date.now()}`, members: [], test: true })).text);
const roomId = room.id ?? room.room?.id;
if (!roomId) throw new Error(`no room id in ${JSON.stringify(room)}`);
const failures = [];
const sent = [];
let calls = 0, slowest = 0, loading = true, round = 0;
const readLoop = async path => {
  while (loading) {
    try {
      const answer = await call("GET", path);
      calls += 1;
      slowest = Math.max(slowest, answer.ms);
      if (answer.status !== 200) failures.push(`${new Date().toISOString()} GET ${path} ${answer.status}`);
    } catch (error) { failures.push(`${new Date().toISOString()} GET ${path} ${error.code ?? error.message}`); }
    await sleep(5);
  }
};
const sends = async lane => {
  for (let n = 1; loading; n++) {
    const requestId = `rig-${lane}-${n}-${Date.now()}`;
    const text = `rig send ${lane}.${n} in round ${round}`;
    try {
      const answer = await call("POST", `/api/c/${roomId}/send`, { text, requestId });
      calls += 1;
      slowest = Math.max(slowest, answer.ms);
      if (answer.status === 200) sent.push(text);
      else failures.push(`${new Date().toISOString()} send ${answer.status} ${answer.text.slice(0, 120)}`);
    } catch (error) { failures.push(`${new Date().toISOString()} send ${error.code ?? error.message}`); }
    await sleep(50);
  }
};
const loops = [readLoop("/api/ready"), readLoop("/api/sidebar"), readLoop(`/api/c/${roomId}/items`), sends("a"), sends("b")];
const restartsBefore = Number(show("NRestarts"));
await sleep(3000);
const results = [];
for (round = 1; round <= rounds; round++) {
  const before = Number(show("MainPID"));
  // An idle keep-alive connection whose client keeps it half open after the server ends it, as a net pipe does; on 11-22 such clients held
  // the old server's stop to its 2 s cap in 4 of 5 live hand-overs.
  const idle = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  idle.on("error", () => {});
  await new Promise(resolve => { idle.on("data", resolve); idle.write("GET /api/ready HTTP/1.1\r\nHost: rig\r\n\r\n"); });
  const since = Math.floor(Date.now() / 1000);
  const at = performance.now();
  execFileSync("systemctl", ["--user", "reload", unit]);
  // Writes that land on the old server while the successor loads: a room change, a read mark and a post, each read back through the successor.
  const windowWrites = Promise.allSettled([
    call("PATCH", `/api/rooms/${roomId}`, { agenda: `round ${round}` }),
    call("POST", `/api/c/${roomId}/read`, { seq: round }),
    call("POST", `/api/c/${roomId}/send`, { text: `rig window ${round}`, requestId: `rig-window-${round}-${Date.now()}` }),
  ]);
  let handed = false;
  while (performance.now() - at < 60_000) {
    await sleep(100);
    const pid = Number(show("MainPID"));
    if (pid && pid !== before) {
      try { if (JSON.parse((await call("GET", "/api/ready")).text).pid === pid) { handed = true; break; } } catch {}
    }
  }
  const written = (await windowWrites).map(each => each.status === "fulfilled" ? each.value.status : each.reason?.code ?? String(each.reason));
  if (written.some(status => status !== 200)) failures.push(`round ${round}: a write in the hand-over window answered ${written.join(", ")}`);
  const rooms = JSON.parse((await call("GET", "/api/rooms?test=1")).text);
  const agenda = (rooms.rooms ?? rooms).find(each => each.id === roomId)?.agenda;
  if (agenda !== `round ${round}`) failures.push(`round ${round}: the successor shows the room's agenda as ${JSON.stringify(agenda)}`);
  const windowPost = readFileSync(`${dataDir}/rooms/${roomId}.jsonl`, "utf8").includes(`"rig window ${round}"`);
  if (!windowPost) failures.push(`round ${round}: the post sent in the hand-over window is not in the room's log`);
  await sleep(3000);
  idle.destroy();
  const stopLine = execFileSync("journalctl", ["--user", "-u", unit, "-u", unit.replace(/\.service$/, "-core.scope"), "--since", `@${since}`, "--no-pager", "-o", "cat"], { encoding: "utf8" })
    .split("\n").find(line => line.includes("this process stopped in")) ?? "";
  const stopMs = Number(/stopped in (\d+) ms/.exec(stopLine)?.[1] ?? NaN);
  // The main process logs from the core scope that mover.py, like cpu-protect.py, moves it into.
  // The old server's stop is the time new calls wait in the socket's queue before the successor's own start of about 0.5 s.
  if (!(stopMs < 1000)) failures.push(`round ${round}: the old server's stop took ${stopMs} ms: ${stopLine}`);
  const running = servers();
  results.push({ round, from: before, to: Number(show("MainPID")), handed, handedMs: Math.round(performance.now() - at - 3000), stopMs, written, agenda, windowPost, servers: running });
  if (!handed) failures.push(`round ${round}: no hand-over to a new main process in 60 s`);
  if (running.length !== 1) failures.push(`round ${round}: ${running.length} server processes on ${dataDir}: ${running.join(", ")}`);
}
loading = false;
await Promise.all(loops);
await sleep(1000);
// The room's post log, where the 11-22 split showed: two servers each gave out the same seqs.
const posts = readFileSync(`${dataDir}/rooms/${roomId}.jsonl`, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
  .filter(row => row.t === "post" && row.post.text.startsWith("rig send")).map(row => row.post);
const seqs = posts.map(post => post.seq);
const duplicateSeqs = seqs.length - new Set(seqs).size + posts.length - new Set(posts.map(post => post.id)).size;
const shown = new Set(posts.map(post => post.text));
const missing = sent.filter(text => !shown.has(text));
if (duplicateSeqs) failures.push(`${duplicateSeqs} duplicate seqs in ${roomId}`);
if (missing.length) failures.push(`${missing.length} of ${sent.length} sends answered 200 and are not in ${roomId}`);
const reads = JSON.parse(readFileSync(`${dataDir}/state.json`, "utf8")).reads?.[roomId];
if (JSON.stringify(reads ?? null).indexOf(String(rounds)) < 0) failures.push(`the room's read mark reads ${JSON.stringify(reads)} after round ${rounds}'s mark`);
const restarts = Number(show("NRestarts")) - restartsBefore;
if (restarts) failures.push(`systemd restarted the unit ${restarts} times`);

// A successor that crashes or hangs after its hand-over must be replaced by systemd on its own, as a crashed server was before: kill -9,
// then SIGSTOP, each on the main process right after a hand-over, timed until a new server answers.
const handOver = async () => {
  const before = Number(show("MainPID"));
  execFileSync("systemctl", ["--user", "reload", unit]);
  for (const end = Date.now() + 60_000; Date.now() < end; await sleep(100)) {
    const pid = Number(show("MainPID"));
    try { if (pid !== before && JSON.parse((await call("GET", "/api/ready")).text).pid === pid) return pid; } catch {}
  }
  throw new Error("no hand-over in 60 s");
};
const replaced = async (victim, signal) => {
  process.kill(victim, signal);
  const at = Date.now();
  for (const end = at + 60_000; Date.now() < end; await sleep(100)) {
    try {
      const answer = await call("GET", "/api/ready");
      const pid = JSON.parse(answer.text).pid;
      if (pid !== victim) return { signal, victim, by: pid, backMs: Date.now() - at };
    } catch {}
  }
  return { signal, victim, by: null, backMs: null };
};
const crashes = [];
for (const signal of ["SIGKILL", "SIGSTOP"]) {
  const victim = await handOver();
  const result = await replaced(victim, signal);
  if (signal === "SIGSTOP") try { process.kill(victim, "SIGKILL"); } catch {}
  await sleep(3000);
  result.servers = servers().filter(pid => pid !== victim);
  crashes.push(result);
  // A crash ends a process systemd watches, and RestartSec=2 plus a start of about 3 s brings a new one; a hang waits for WatchdogSec=15 first.
  const limit = signal === "SIGKILL" ? 10_000 : 25_000;
  if (result.backMs === null || result.backMs > limit) failures.push(`after ${signal} on the main process ${victim} no new server answered in ${result.backMs === null ? "60 s" : `${result.backMs} ms`}`);
  if (result.servers.length !== 1) failures.push(`after ${signal}: ${result.servers.length} server processes`);
}
console.log(JSON.stringify({ unit, port, dataDir, rounds, room: roomId, calls, sends: sent.length, posts: posts.length, duplicateSeqs, missing: missing.length,
  restarts, slowestCallMs: Math.round(slowest), pass: failures.length === 0, results, crashes, failures: failures.slice(0, 40) }, null, 1));
process.exit(failures.length ? 1 : 0);
