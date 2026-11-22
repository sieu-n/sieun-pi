// The wake walk: how long after the network comes back does the owner's page show what changed while it was gone? It drives a real chat
// page in Chromium and WebKit through the restart walk's HTTP/2 over TLS front at a 200 ms round trip (restart-walk.mjs has the rig), cuts
// the page's network by dropping every packet, as a Mac lid close or a tailnet drop does, and while the network is gone changes four
// things the page shows: a step on the home agent's board, a duty's daily time, a message in the open room, and the open room's name. It brings
// the network back and times, per browser, from that moment until each change shows in the page.
// The page half is wake-walk-page.mjs. The room is a test channel (POST /api/rooms test:true) and the agent a test agent, so no agent
// wakes; both are archived at the end.
//
// Run it as a detached unit from the repo root, never inside an agent's Python kernel:
//   systemd-run --user --unit=wake-walk-<label> --collect --same-dir -E PATH -E HOME sh -c \
//     'node apps/chat/scripts/wake-walk.mjs --label <label> > ~/work/p209-wake/<label>.log 2>&1'
// Options (defaults in brackets):
//   --base <url>       the chat server to walk [http://127.0.0.1:5184]
//   --cuts <list>      seconds of each cut, in order; 0 is a control with the network up [0,5,60,5,60]
//   --browsers <list>  [chromium,webkit]
//   --freeze           also freeze the Chromium page for the cut (CDP Page.setWebLifecycleState), as a Mac sleep stops its timers
//   --label <name>, --out <dir>  [wake-<time>, ~/work/p209-wake/<label>]
//   --scratch <dir>    the rig's throwaway folder, deleted at the end; put it under your job's own scratch folder [~/scratch/wake-walk-<label>]
//   --report <out dir> only rebuild the report of a finished walk
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const repo = resolve(appDir, "../..");
const IMAGE = "mcr.microsoft.com/playwright:v1.64.1-noble";
const FRONT_PORT = 5843;
/** How long a probe waits for every change to show before it counts the rest as never shown. */
const GIVE_UP_MS = 90_000;
const MARKERS = ["board", "duty", "message", "room"];

function parseArgs(argv) {
  const stamp = new Date().toISOString().slice(5, 19).replace(/[-T:]/g, "");
  const o = { base: "http://127.0.0.1:5184", cuts: "0,5,60,5,60", browsers: "chromium,webkit", freeze: false, label: `wake-${stamp}`, out: null, scratch: null, report: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => argv[++i];
    if (flag === "--base") o.base = value().replace(/\/$/, "");
    else if (flag === "--cuts") o.cuts = value();
    else if (flag === "--browsers") o.browsers = value();
    else if (flag === "--freeze") o.freeze = true;
    else if (flag === "--label") o.label = value();
    else if (flag === "--out") o.out = resolve(value());
    else if (flag === "--scratch") o.scratch = resolve(value());
    else if (flag === "--report") o.report = resolve(value());
    else throw new Error(`unknown option ${flag}`);
  }
  o.out ??= join(homedir(), "work/p209-wake", o.label);
  o.scratch ??= join(homedir(), "scratch", `wake-walk-${o.label}`);
  return o;
}

const log = line => console.log(`${new Date().toISOString().slice(11, 23)} ${line}`);
const sleep = ms => new Promise(done => setTimeout(done, ms));

async function call(base, method, path, body) {
  const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

function sh(command, args) {
  const done = spawnSync(command, args, { encoding: "utf8" });
  if (done.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${done.status}: ${(done.stderr || done.stdout).slice(-400)}`);
  return done.stdout.trim();
}

async function walk(o) {
  mkdirSync(o.out, { recursive: true });
  mkdirSync(o.scratch, { recursive: true });
  const target = new URL(o.base);
  const browsers = o.browsers.split(",");
  const cuts = o.cuts.split(",").map(Number);
  const rig = `wake-walk-${o.label}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const tc = `${rig}-tc`;
  const socket = join(o.scratch, "chat.sock");
  const cleanups = [];
  const meta = { label: o.label, base: o.base, browsers, cuts, freeze: o.freeze, probes: [], startedAt: Date.now() };
  try {
    const stamp = o.label.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const agent = await call(o.base, "POST", "/api/agents", { name: `wake walk ${stamp}`, test: true, thinkingLevel: "low", cwd: repo, brief: "A throwaway test agent of the wake walk. Do nothing." });
    meta.agent = agent.id;
    const room = await call(o.base, "POST", "/api/rooms", { kind: "channel", name: `wake-walk-${stamp}`, agenda: "", members: [], test: true });
    meta.room = room.id;
    cleanups.push(async () => {
      for (const id of [meta.room, agent.room ?? `dm_${agent.id.slice(3)}`]) await call(o.base, "PATCH", `/api/c/${id}`, { archived: true }).catch(error => log(`archive ${id} failed: ${error.message}`));
    });
    await call(o.base, "PATCH", `/api/rooms/${room.id}`, { homeChat: agent.id });
    await call(o.base, "POST", `/api/agents/${agent.id}/board`, { ops: [{ op: "plan_add", text: "wake walk first step" }] });
    // A paused duty, so the walk's test agent never runs one; each probe changes its time.
    const duty = { name: "wake walk duty", ownerWords: "wake walk", goal: "wake walk first goal", onMiss: "nothing", metrics: [{ key: "x", label: "x", op: "<=", target: 0 }], precheck: { command: ["true"], cwd: "/tmp" } };
    const set = await call(o.base, "POST", `/api/agents/${agent.id}/duties`, { action: "set", duty });
    meta.duty = set.duties.find(row => row.duty.name === duty.name).duty.id;
    await call(o.base, "POST", `/api/agents/${agent.id}/duties`, { action: "pause", duty: meta.duty });
    log(`agent ${agent.id} with duty ${meta.duty}, room ${room.id}`);

    rmSync(socket, { force: true });
    const bridge = net.createServer(client => {
      const server = net.connect(Number(target.port || 80), target.hostname);
      client.pipe(server);
      server.pipe(client);
      client.on("error", () => server.destroy());
      server.on("error", () => client.destroy());
      server.on("close", () => client.destroy());
      client.on("close", () => server.destroy());
    });
    await new Promise(done => bridge.listen(socket, done));
    cleanups.push(() => new Promise(done => bridge.close(done)));

    sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(o.scratch, "key.pem"), "-out", join(o.scratch, "cert.pem"), "-subj", "/CN=127.0.0.1", "-days", "2"]);
    const user = `${process.getuid()}:${process.getgid()}`;
    sh("docker", ["run", "-d", "--rm", "--name", rig, "--init", "--ipc=host", "--user", user, "-e", "HOME=/tmp", "-v", `${appDir}:${appDir}:ro`, "-v", `${o.scratch}:${o.scratch}`, IMAGE, "sleep", "infinity"]);
    cleanups.push(async () => { spawnSync("docker", ["rm", "-f", rig]); });
    // tc needs root and NET_ADMIN in the rig's namespace. This side container stays up, so a cut takes one exec; it writes no file.
    sh("docker", ["run", "-d", "--rm", "--name", tc, "--cap-add", "NET_ADMIN", "--network", `container:${rig}`, "alpine:3.20", "sleep", "infinity"]);
    cleanups.push(async () => { spawnSync("docker", ["rm", "-f", tc]); });
    sh("docker", ["exec", tc, "sh", "-c", "apk add -q iproute2-tc && ip link set lo mtu 1280 && tc qdisc add dev lo root netem delay 100ms limit 100000"]);
    const netem = loss => sh("docker", ["exec", tc, "tc", "qdisc", "change", "dev", "lo", "root", "netem", "delay", "100ms", ...(loss ? ["loss", "100%"] : []), "limit", "100000"]);
    log(`rig ${rig} up with netem 100 ms each way, MTU 1280`);

    const front = spawn("docker", ["exec", rig, "node", join(here, "restart-walk-front.mjs"), String(FRONT_PORT), socket, join(o.scratch, "key.pem"), join(o.scratch, "cert.pem"), join(o.scratch, "timings.jsonl"), room.id], { stdio: ["ignore", "pipe", "pipe"] });
    front.stdout.on("data", chunk => appendFileSync(join(o.out, "front.log"), chunk));
    front.stderr.on("data", chunk => appendFileSync(join(o.out, "front.log"), chunk));
    await sleep(1500);
    const page = spawn("docker", ["exec", rig, "node", join(here, "wake-walk-page.mjs"), `https://127.0.0.1:${FRONT_PORT}`, o.scratch, o.browsers, room.id, o.freeze ? "freeze" : "awake"], { stdio: ["ignore", "pipe", "pipe"] });
    page.stdout.on("data", chunk => appendFileSync(join(o.out, "page.log"), chunk));
    page.stderr.on("data", chunk => appendFileSync(join(o.out, "page.log"), chunk));
    const pageDone = new Promise(done => page.on("exit", done));

    const readyBy = Date.now() + 120_000;
    while (!browsers.every(b => existsSync(join(o.scratch, `ready-${b}`)) || existsSync(join(o.scratch, `done-${b}`)))) {
      if (Date.now() > readyBy) throw new Error("the pages did not show the room in 120 s; see page.log");
      await sleep(500);
    }
    log(`pages ready: ${browsers.join(", ")}`);
    await sleep(10_000);

    for (const [i, seconds] of cuts.entries()) {
      const n = i + 1;
      const tag = randomUUID().slice(0, 8);
      // The duty card shows its schedule and not its goal, so the duty's change is a new daily time.
      const at = `${13 + Math.floor(Math.random() * 11)}:${String(Math.floor(Math.random() * 60)).padStart(2, "0")}`;
      const markers = { board: `wake step ${n} ${tag}`, duty: `Daily at ${at}`, message: `wake message ${n} ${tag}`, room: `wake-room-${n}-${tag}` };
      const probe = { n, seconds, markers, load: Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]) };
      writeFileSync(join(o.scratch, `probe-${n}.json`), JSON.stringify(probe));
      // A cut of 0 s is the control: the same changes with the network up.
      if (seconds) netem(true);
      probe.cutAt = Date.now();
      log(`probe ${n}: network cut for ${seconds} s`);
      await sleep(1000);
      const writes = [
        call(o.base, "POST", `/api/agents/${agent.id}/board`, { ops: [{ op: "plan_add", text: markers.board }] }),
        call(o.base, "POST", `/api/agents/${agent.id}/duties`, { action: "schedule", duty: meta.duty, schedule: { kind: "daily", at } }),
        call(o.base, "POST", `/api/c/${room.id}/send`, { text: markers.message, requestId: randomUUID() }),
        call(o.base, "PATCH", `/api/rooms/${room.id}`, { name: markers.room }),
      ];
      probe.writes = (await Promise.allSettled(writes)).map(result => (result.status === "fulfilled" ? "ok" : String(result.reason?.message).slice(0, 200)));
      await sleep(Math.max(0, probe.cutAt + seconds * 1000 - Date.now()));
      if (seconds) netem(false);
      probe.backAt = Date.now();
      writeFileSync(join(o.scratch, `back-${n}.json`), JSON.stringify({ backAt: probe.backAt }));
      log(`probe ${n}: network back; writes ${probe.writes.join(", ")}`);
      const by = probe.backAt + GIVE_UP_MS + 5000;
      while (!browsers.every(b => existsSync(join(o.scratch, `result-${n}-${b}.json`))) && Date.now() < by) await sleep(500);
      probe.results = Object.fromEntries(browsers.map(b => {
        const file = join(o.scratch, `result-${n}-${b}.json`);
        return [b, existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null];
      }));
      meta.probes.push(probe);
      for (const b of browsers) {
        const seen = probe.results[b]?.seen ?? {};
        log(`probe ${n} ${b}: ${MARKERS.map(m => `${m} ${seen[m] === undefined ? "never" : `${((seen[m] - probe.backAt) / 1000).toFixed(2)} s`}`).join(", ")}`);
      }
      await sleep(10_000);
    }
    writeFileSync(join(o.scratch, "stop"), String(Date.now()));
    await Promise.race([pageDone, sleep(60_000)]);
    front.kill();
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(error => log(`cleanup failed: ${error.message}`));
    meta.endedAt = Date.now();
    for (const name of ["timings.jsonl", "front-calls.jsonl", ...meta.browsers.flatMap(b => [`page-${b}.jsonl`])]) {
      if (existsSync(join(o.scratch, name))) cpSync(join(o.scratch, name), join(o.out, name));
    }
    spawnSync("sh", ["-c", `cp ${o.scratch}/*.png ${o.out}/ 2>/dev/null`]);
    writeFileSync(join(o.out, "meta.json"), `${JSON.stringify(meta, null, 1)}\n`);
    rmSync(o.scratch, { recursive: true, force: true });
  }
  return report(o.out);
}

/** Builds report.md in a walk's out dir: per probe and browser, the seconds from the network's return until each change showed. */
export function report(out) {
  const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
  const lines = [`# Wake walk ${meta.label}`, "", `Base ${meta.base}, browsers ${meta.browsers.join(", ")}, Chromium frozen during the cut: ${meta.freeze ? "yes" : "no"}.`, "",
    `| probe | cut s | load | browser | ${MARKERS.join(" | ")} |`, `|---|---|---|---|${MARKERS.map(() => "---").join("|")}|`];
  for (const probe of meta.probes) {
    for (const browser of meta.browsers) {
      const seen = probe.results?.[browser]?.seen ?? {};
      const cells = MARKERS.map(m => (seen[m] === undefined ? "never" : ((seen[m] - probe.backAt) / 1000).toFixed(2)));
      lines.push(`| ${probe.n} | ${probe.seconds} | ${probe.load} | ${browser} | ${cells.join(" | ")} |`);
    }
  }
  lines.push("", "Each cell is the seconds from the network's return until the change showed in the page; a negative one showed before it.");
  writeFileSync(join(out, "report.md"), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  return meta;
}

const o = parseArgs(process.argv.slice(2));
if (o.report) report(o.report);
else await walk(o);
