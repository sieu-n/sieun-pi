// The restart walk: does an apps/chat release drop the owner's calls? It drives a real chat page in Chromium and WebKit through an HTTP/2
// over TLS front at a 200 ms round trip, as his page reaches the server from Korea through tailscale serve, while a release command runs
// several times back to back. It reports per browser the calls that failed, the calls that took 2 s or more beyond their route's normal
// time, the live socket's time back after each restart, and whether each send landed.
//
// The rig, as in the p155 read-ahead walk (~/work/p155-readahead/summary.md): a Playwright container whose loopback has netem 100 ms each
// way and MTU 1280, so its TCP sees the owner's round trip and slow start; restart-walk-front.mjs in it as the TLS front; and a unix
// socket bridge from this process to the server's port. A pure-delay relay over HTTP/1.1 showed no queueing in p155.
// The page half is restart-walk-page.mjs. Two test channels (POST /api/rooms test:true) take the sends, so no agent wakes, and the first
// shows the home agent's board pane, as the owner's rooms do; both are archived at the end.
// Before each release it makes a test agent (POST /api/agents test:true), and after the release it sends to that agent's DM and checks
// for 200 and the post in the DM's items, the case a d3 run hit on 11-22; each agent's DM is archived at the end.
//
// Run it as a detached unit from the repo root, never inside an agent's Python kernel:
//   systemd-run --user --unit=restart-walk-<label> --collect --same-dir -E PATH -E HOME sh -c \
//     'node apps/chat/scripts/restart-walk.mjs --label <label> > ~/work/apps-chat-restart/<label>.log 2>&1'
// Options (defaults in brackets):
//   --base <url>        the chat server to walk [http://127.0.0.1:5184]
//   --release <cmd>     the release command, run with sh -c from the repo root; {live} is the live release folder's name, read just
//                       before each run [node scripts/release-apps-chat.mjs --rollback {live}]
//   --releases <n>      releases back to back [5]
//   --browsers <list>   [chromium,webkit]
//   --warm <s>, --tail <s>  seconds walked before the first and after the last release, which give each route's normal time [45, 40]
//   --home <agent id>   the agent whose board pane the first test channel shows, skipped when the server has no such agent [ag_agent-factory]
//   --label <name>, --out <dir>, --scratch <dir>  [walk-<time>, ~/work/apps-chat-restart/<label>, ~/scratch/restart-walk-<label>]
//   --release-home <dir>  where {live} is read and whose release.lock a run waits out [~/.local/share/sieun-pi-apps-chat]
//   --data-dir <dir>    the server's data dir, whose test room post logs show a seq written twice [~/.pi/agent/chat]
//   --report <out dir>  only rebuild the report of a finished walk from its raw files
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const repo = resolve(appDir, "../..");
const IMAGE = "mcr.microsoft.com/playwright:v1.64.1-noble";
const FRONT_PORT = 5841;
/** Calls inside a release window: from the command's start until 10 s after it ends, which covers the restart and the page's catch up. */
const AFTER_MS = 10_000;
/** A call is slow in a release window when it took this much more than its route's median outside the windows (the goal's 2 s). */
const BEYOND_MS = 2_000;

function parseArgs(argv) {
  const stamp = new Date().toISOString().slice(5, 19).replace(/[-T:]/g, "");
  const o = {
    base: "http://127.0.0.1:5184", release: "node scripts/release-apps-chat.mjs --rollback {live}", releases: 5, browsers: "chromium,webkit",
    warm: 45, tail: 40, home: "ag_agent-factory", label: `walk-${stamp}`, out: null, scratch: null,
    releaseHome: join(homedir(), ".local/share/sieun-pi-apps-chat"), dataDir: join(homedir(), ".pi/agent/chat"), report: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => argv[++i];
    if (flag === "--base") o.base = value().replace(/\/$/, "");
    else if (flag === "--release") o.release = value();
    else if (flag === "--releases") o.releases = Number(value());
    else if (flag === "--browsers") o.browsers = value();
    else if (flag === "--warm") o.warm = Number(value());
    else if (flag === "--tail") o.tail = Number(value());
    else if (flag === "--home") o.home = value();
    else if (flag === "--label") o.label = value();
    else if (flag === "--out") o.out = resolve(value());
    else if (flag === "--scratch") o.scratch = resolve(value());
    else if (flag === "--release-home") o.releaseHome = resolve(value());
    else if (flag === "--report") o.report = resolve(value());
    else if (flag === "--data-dir") o.dataDir = resolve(value());
    else throw new Error(`unknown option ${flag}`);
  }
  o.out ??= join(homedir(), "work/apps-chat-restart", o.label);
  o.scratch ??= join(homedir(), "scratch", `restart-walk-${o.label}`);
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

/** Polls the server's /api/ready every 100 ms and keeps each span it did not answer 200. */
function watchReady(base) {
  const outages = [];
  let down = null, stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const at = Date.now();
      let ok = false;
      try { ok = (await fetch(`${base}/api/ready`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (!ok && down === null) down = at;
      if (ok && down !== null) { outages.push({ down, up: at }); down = null; }
      await sleep(Math.max(0, 100 - (Date.now() - at)));
    }
  })();
  return async () => { stopped = true; await loop; if (down !== null) outages.push({ down, up: null }); return outages; };
}

async function walk(o) {
  mkdirSync(o.out, { recursive: true });
  mkdirSync(o.scratch, { recursive: true });
  const target = new URL(o.base);
  const browsers = o.browsers.split(",");
  const rig = `restart-walk-${o.label}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const socket = join(o.scratch, "chat.sock");
  const cleanups = [];
  const meta = { label: o.label, base: o.base, release: o.release, releases: [], fresh: [], agents: [], browsers, rig, startedAt: Date.now() };
  try {
    // Test rooms: sends land in A; A shows the home agent's board pane when the server has that agent.
    const stamp = o.label.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const roomA = await call(o.base, "POST", "/api/rooms", { kind: "channel", name: `restart-walk-${stamp}-a`, agenda: "", members: [], test: true });
    const roomB = await call(o.base, "POST", "/api/rooms", { kind: "channel", name: `restart-walk-${stamp}-b`, agenda: "", members: [], test: true });
    meta.rooms = [roomA.id, roomB.id];
    cleanups.push(async () => {
      for (const id of [...meta.rooms, ...meta.agents]) await call(o.base, "PATCH", `/api/c/${id}`, { archived: true }).catch(error => log(`archive ${id} failed: ${error.message}`));
    });
    if (o.home && (await fetch(`${o.base}/api/agents/${o.home}/board`).then(r => r.ok, () => false))) {
      await call(o.base, "PATCH", `/api/rooms/${roomA.id}`, { homeChat: o.home });
      meta.home = o.home;
    }
    log(`rooms ${meta.rooms.join(" ")}${meta.home ? `, ${roomA.id} shows ${meta.home}'s board` : ""}`);

    // The bridge from the rig's network namespace to the server's port.
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
    // tc needs root and NET_ADMIN in the rig's namespace; this container writes no file.
    sh("docker", ["run", "--rm", "--cap-add", "NET_ADMIN", "--network", `container:${rig}`, "alpine:3.20", "sh", "-c", "apk add -q iproute2-tc && ip link set lo mtu 1280 && tc qdisc add dev lo root netem delay 100ms limit 100000"]);
    log(`rig ${rig} up with netem 100 ms each way, MTU 1280`);

    const front = spawn("docker", ["exec", rig, "node", join(here, "restart-walk-front.mjs"), String(FRONT_PORT), socket, join(o.scratch, "key.pem"), join(o.scratch, "cert.pem"), join(o.scratch, "timings.jsonl"), ...meta.rooms], { stdio: ["ignore", "pipe", "pipe"] });
    front.stdout.on("data", chunk => appendFileSync(join(o.out, "front.log"), chunk));
    front.stderr.on("data", chunk => appendFileSync(join(o.out, "front.log"), chunk));
    await sleep(1500);
    const page = spawn("docker", ["exec", rig, "node", join(here, "restart-walk-page.mjs"), `https://127.0.0.1:${FRONT_PORT}`, o.scratch, o.browsers, ...meta.rooms], { stdio: ["ignore", "pipe", "pipe"] });
    page.stdout.on("data", chunk => appendFileSync(join(o.out, "page.log"), chunk));
    page.stderr.on("data", chunk => appendFileSync(join(o.out, "page.log"), chunk));
    const pageDone = new Promise(done => page.on("exit", done));

    const readyBy = Date.now() + 120_000;
    while (!browsers.every(b => existsSync(join(o.scratch, `ready-${b}`)) || existsSync(join(o.scratch, `done-${b}`)))) {
      if (Date.now() > readyBy) throw new Error("the pages did not show a room in 120 s; see page.log");
      await sleep(500);
    }
    log(`pages ready: ${browsers.join(", ")}; walking ${o.warm} s before the first release`);
    const stopReady = watchReady(o.base);
    await sleep(o.warm * 1000);

    for (let n = 1; n <= o.releases; n++) {
      const lock = join(o.releaseHome, "release.lock");
      let waited = 0;
      while (existsSync(lock)) {
        if (!waited) log(`release ${n}: another release holds ${lock}; waiting for it`);
        waited += 500;
        await sleep(500);
      }
      let live = "";
      try { live = basename(readlinkSync(join(o.releaseHome, "current"))); } catch {}
      const command = o.release.replaceAll("{live}", live);
      // The case a d3 run hit on 11-22: an agent made just before a hand-over, and a send to it right after, which got 404 'No thread'.
      const fresh = { n };
      try {
        const made = Date.now();
        const agent = await call(o.base, "POST", "/api/agents", { name: `restart walk ${o.label} ${n}`, test: true, thinkingLevel: "low", cwd: repo, brief: "A throwaway test agent of the restart walk. Answer any message with the one word ok." });
        Object.assign(fresh, { agent: agent.id, room: agent.room ?? `dm_${agent.id.slice(3)}`, madeMs: Date.now() - made, madeAt: Date.now() });
        meta.agents.push(fresh.room);
      } catch (error) {
        fresh.makeError = String(error.message).slice(0, 300);
      }
      const start = Date.now();
      log(`release ${n}: ${command}`);
      const run = spawn("sh", ["-c", command], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      run.stdout.on("data", chunk => { output += chunk; });
      run.stderr.on("data", chunk => { output += chunk; });
      const exit = await new Promise(done => run.on("exit", code => done(code)));
      const end = Date.now();
      writeFileSync(join(o.out, `release-${n}.log`), output);
      // Two servers on one socket split the posts (the 11-22 after-walk), so each release counts them.
      const servers = Number(spawnSync("pgrep", ["-fc", `[s]erver/main.ts --port ${target.port || 80}`], { encoding: "utf8" }).stdout.trim() || 0);
      meta.releases.push({ n, command, live, start, end, exit, waitedForLockMs: waited, servers });
      if (fresh.room) {
        const text = `restart walk check ${o.label} ${n} ${Date.now()}`;
        const sent = Date.now();
        try {
          await call(o.base, "POST", `/api/c/${fresh.room}/send`, { text, requestId: randomUUID() });
          fresh.send = 200;
        } catch (error) {
          fresh.send = String(error.message).slice(0, 300);
        }
        fresh.sendMs = Date.now() - sent;
        const shows = async () => ((await call(o.base, "GET", `/api/c/${fresh.room}/items?limit=50`).catch(() => ({ items: [] }))).items ?? []).some(item => item.text === text);
        fresh.inItems = await shows();
        if (!fresh.inItems) {
          await sleep(5000);
          fresh.inItemsAfter5s = await shows();
        }
      }
      meta.fresh.push(fresh);
      log(`release ${n}: fresh agent ${fresh.agent ?? fresh.makeError}, send ${fresh.send}, in its DM ${fresh.inItems}`);
      log(`release ${n}: exit ${exit} in ${((end - start) / 1000).toFixed(1)} s`);
    }

    log(`walking ${o.tail} s after the last release`);
    await sleep(o.tail * 1000);
    meta.outages = await stopReady();
    writeFileSync(join(o.scratch, "stop"), String(Date.now()));
    await Promise.race([pageDone, sleep(90_000)]);
    front.kill();

    // Which sends the server stored.
    // Both rooms: a send typed while WebKit still showed room B lands there (two in the 11-22 after2 walk).
    meta.stored = [];
    for (const room of meta.rooms) {
      const items = await call(o.base, "GET", `/api/c/${room}/items?limit=500`).catch(() => ({ items: [] }));
      meta.stored.push(...(items.items ?? []).filter(item => item.kind === "message").map(item => item.text ?? item.body ?? ""));
    }
    // The room's post log, when the server's data dir is on this box: a seq written twice means two servers took posts.
    for (const room of meta.rooms) {
      const logFile = join(o.dataDir, "rooms", `${room}.jsonl`);
      if (!existsSync(logFile)) continue;
      const seqs = readFileSync(logFile, "utf8").split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line).post?.seq]; } catch { return []; } }).filter(seq => seq !== undefined);
      meta.postLog ??= { lines: 0, repeatedSeqs: 0 };
      meta.postLog.lines += seqs.length;
      meta.postLog.repeatedSeqs += seqs.length - new Set(seqs).size;
    }
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(error => log(`cleanup failed: ${error.message}`));
    meta.endedAt = Date.now();
    for (const name of ["timings.jsonl", "front-calls.jsonl", ...meta.browsers.map(b => `page-${b}.jsonl`)]) {
      if (existsSync(join(o.scratch, name))) cpSync(join(o.scratch, name), join(o.out, name));
    }
    writeFileSync(join(o.out, "meta.json"), `${JSON.stringify(meta, null, 1)}\n`);
    rmSync(o.scratch, { recursive: true, force: true });
  }
  return report(o.out);
}

const readJsonl = file => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : []);
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
/** A path with the walk's room ids and any other ids put back to their route shape, so normal times group by route. */
const routeOf = (path, rooms) => {
  let route = path;
  rooms.forEach((room, i) => { route = route.replaceAll(room, i ? ":roomB" : ":roomA"); });
  return route.replace(/\/(ag_[\w-]+)/g, "/:agent").replace(/^\/api\/c\/(?!:room)[^/]+/, "/api/c/:other");
};
const failed = s => s === 0 || s >= 500;
const browserOfUa = ua => (/Chrome\//.test(ua) ? "chromium" : /AppleWebKit/.test(ua) ? "webkit" : "other");

/** Builds report.json and report.md in a walk's out dir from its raw files. */
export function report(out) {
  const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
  const windows = meta.releases.map(r => ({ n: r.n, from: r.start, to: r.end + AFTER_MS }));
  const windowOf = at => windows.find(w => at >= w.from && at <= w.to) ?? null;
  const timings = readJsonl(join(out, "timings.jsonl")).flatMap(batch => {
    let samples = [];
    try { samples = JSON.parse(batch.body).samples ?? []; } catch {}
    return samples.map(sample => ({ ...sample, at: batch.at, browser: browserOfUa(batch.ua) }));
  });
  const browsers = {};
  for (const browser of meta.browsers) {
    const records = readJsonl(join(out, `page-${browser}.jsonl`));
    // A fetch the page aborted itself, as a room switch does to the old room's reads, is no failure.
    const all = records.filter(r => r.kind === "fetch" && r.p !== "/api/timings").map(r => ({ ...r, route: `${r.m} ${routeOf(r.p, meta.rooms ?? [])}`, ms: r.end - r.start }));
    const fetches = all.filter(r => !/abort/i.test(r.err ?? ""));
    const normal = new Map();
    for (const f of fetches) if (!windowOf(f.start) && !failed(f.s)) normal.set(f.route, [...(normal.get(f.route) ?? []), f.ms]);
    const allNormal = median(fetches.filter(f => !windowOf(f.start)).map(f => f.ms)) ?? 0;
    const normalOf = route => median(normal.get(route) ?? []) ?? allNormal;
    const inWindows = fetches.filter(f => windowOf(f.start) || windowOf(f.end));
    const fetchFailed = fetches.filter(f => failed(f.s));
    const fetchSlow = inWindows.filter(f => !failed(f.s) && f.ms > normalOf(f.route) + BEYOND_MS);
    // Where a slow call's time went, from the front's own line of it: before the front, behind it (server and bridge), after it.
    const frontCalls = readJsonl(join(out, "front-calls.jsonl")).filter(c => c.ua === browser);
    const split = f => {
      const c = frontCalls.filter(x => x.p === f.p && x.m === f.m && x.in >= f.start - 50 && x.in <= f.end).sort((a, b) => a.in - b.in)[0];
      return c ? { toFront: c.in - f.start, behindFront: (c.head ?? c.out) - c.in, frontOut: c.out - (c.head ?? c.out), afterFront: f.end - c.out } : null;
    };

    const lines = timings.filter(t => t.browser === browser && t.p !== "/api/timings").map(t => ({ ...t, route: `${t.m} ${routeOf(t.p, meta.rooms ?? [])}` }));
    // A page line reaches the front when its batch is posted: at once for a failed call, else within the page's 10 s timer.
    const lineInWindow = t => windows.some(w => t.at >= w.from && t.at <= w.to + 10_000);
    const lineNormal = new Map();
    for (const t of lines) if (!lineInWindow(t) && !t.err) lineNormal.set(t.route, [...(lineNormal.get(t.route) ?? []), t.ms]);
    const lineFailed = lines.filter(t => t.err || failed(t.s));
    const lineSlow = lines.filter(t => lineInWindow(t) && !t.err && t.ms > (median(lineNormal.get(t.route) ?? []) ?? allNormal) + BEYOND_MS);

    const ws = records.filter(r => r.kind === "ws");
    // Each failed reconnect closes again, so the socket's time back runs from the first close of a release window to the next open.
    const closes = [];
    for (const close of ws.filter(r => r.event === "close")) {
      if (closes.some(c => c.openAt === null || close.at <= c.openAt)) continue;
      const open = ws.find(r => r.event === "open" && r.at > close.at);
      closes.push({ at: close.at, openAt: open?.at ?? null, backMs: open ? open.at - close.at : null, release: windowOf(close.at)?.n ?? null });
    }
    const sends = records.filter(r => r.kind === "send");
    const end = records.find(r => r.kind === "end");
    // A send counts as landed when the server stored the text the page posted for it, matched by the send's stamp.
    const stamp = text => text.split(" ").at(-1);
    const stored = new Set(meta.stored ?? []);
    const posted = new Map();
    for (const f of all) if (f.text !== undefined) posted.set(f.requestId, f.text);
    const landed = send => [...posted.values()].some(text => stamp(text) === stamp(send.text) && stored.has(text))
      || (posted.size === 0 && [...stored].some(text => stamp(text) === stamp(send.text)));
    const countBy = list => Object.entries(list.reduce((acc, x) => ({ ...acc, [x.route]: (acc[x.route] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
    browsers[browser] = {
      fetches: fetches.length, aborted: all.length - fetches.length, fetchesInWindows: inWindows.length,
      fetchFailed: fetchFailed.length, fetchFailedByRoute: countBy(fetchFailed), fetchFailedErrors: [...new Set(fetchFailed.map(f => f.err ?? `status ${f.s}`))].slice(0, 6),
      fetchSlow: fetchSlow.length, fetchSlowList: fetchSlow.map(f => ({ route: f.route, at: f.start, ms: f.ms, normal: normalOf(f.route), release: windowOf(f.start)?.n ?? null, split: split(f) })),
      fetchOver2s: fetches.filter(f => !failed(f.s) && f.ms > 2000).map(f => ({ route: f.route, at: f.start, ms: f.ms, inWindow: Boolean(windowOf(f.start)), split: split(f) })),
      pageLines: lines.length, pageFailed: lineFailed.length, pageFailedByRoute: countBy(lineFailed), pageFailedErrors: [...new Set(lineFailed.map(t => t.err ?? `status ${t.s}`))].slice(0, 6),
      pageSlow: lineSlow.length,
      socketCloses: closes.length, socketBackMs: closes.map(c => c.backMs), socketBackMax: closes.length ? Math.max(...closes.map(c => c.backMs ?? Infinity)) : null,
      sends: sends.length, sendsStored: sends.filter(landed).length, sendsMissing: sends.filter(send => !landed(send)).map(send => send.text), notDeliveredShown: end?.notDelivered ?? null,
      stepErrors: records.filter(r => r.kind === "step-error").length, pageErrors: records.filter(r => r.kind === "pageerror").length,
      fatal: records.find(r => r.kind === "fatal")?.err ?? null,
    };
  }
  // One poll can answer between two misses of the same restart, so misses less than 500 ms apart are one outage.
  const merged = [];
  for (const x of meta.outages ?? []) {
    const last = merged.at(-1);
    if (last && last.up !== null && x.down - last.up < 500) last.up = x.up;
    else merged.push({ ...x });
  }
  const outages = merged.map(x => ({ ...x, ms: x.up ? x.up - x.down : null, release: windowOf(x.down)?.n ?? null }));
  const fresh = meta.fresh ?? [];
  const result = { label: meta.label, base: meta.base, fresh, releases: meta.releases.map(({ n, exit, live, start, end, servers }) => ({ n, exit, live, servers, seconds: Math.round((end - start) / 100) / 10 })), outages, postLog: meta.postLog ?? null, browsers };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(result, null, 1)}\n`);
  const md = [
    `# Restart walk ${meta.label}`, "",
    `${meta.releases.length} releases of \`${meta.release}\` against ${meta.base}; exits ${meta.releases.map(r => r.exit).join(", ")}.`,
    `Servers after each release: ${meta.releases.map(r => r.servers ?? "?").join(", ")}; the test rooms' post logs ${meta.postLog ? `hold ${meta.postLog.lines} posts and ${meta.postLog.repeatedSeqs} repeated seqs` : "was not read"}.`,
    ...(fresh.length ? [`Fresh agent made before each release, then a send after it: ${fresh.map(f => `${f.n}: ${f.agent ? `send ${f.send}, ${f.inItems ? "in its DM" : f.inItemsAfter5s ? "in its DM after 5 s" : "not in its DM"}` : `not made (${f.makeError})`}`).join("; ")}.`] : []),
    `The server missed /api/ready for ${outages.map(x => (x.ms === null ? "never back" : `${x.ms} ms`)).join(", ") || "no span"}.`, "",
    "| Browser | Calls | In release windows | Failed calls | Page lines failed | Calls 2 s over normal | Page lines 2 s over normal | Socket back after each close (ms) | Sends stored |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...Object.entries(browsers).map(([name, b]) => `| ${name} | ${b.fetches} | ${b.fetchesInWindows} | ${b.fetchFailed} | ${b.pageFailed} | ${b.fetchSlow} | ${b.pageSlow} | ${b.socketBackMs.join(", ") || "none"} | ${b.sendsStored} of ${b.sends} |`),
    "",
    ...Object.entries(browsers).flatMap(([name, b]) => [
      `${name}: failed by route ${b.fetchFailedByRoute.map(([r, n]) => `${r} ${n}`).join(", ") || "none"}; errors ${b.fetchFailedErrors.join("; ") || "none"}; Not delivered shown ${b.notDeliveredShown}; step errors ${b.stepErrors}${b.fatal ? `; fatal ${b.fatal.split("\n")[0]}` : ""}.`,
    ]),
    "",
  ].join("\n");
  writeFileSync(join(out, "report.md"), md);
  console.log(md);
  return result;
}

const options = parseArgs(process.argv.slice(2));
if (options.report) report(options.report);
else {
  await walk(options);
  process.exit(0);
}
