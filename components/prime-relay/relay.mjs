#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, realpathSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hostStats, usableRaw } from "./host-stats.ts";
import { DELTA_HEADER, encodeLineDeltas } from "./line-delta.ts";
import { SLIM_HEADER, slimSnapshots } from "./slim-snapshot.mjs";

const VERSION = 1;
const UPGRADE = "prime-daemon";

const expand = path => path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

/** Reads relay.json: { listen, port, daemonSocket, roots, tokenFile }. */
export function loadConfig(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const config = {
    listen: String(raw.listen), port: Number(raw.port), daemonSocket: expand(String(raw.daemonSocket)),
    roots: (raw.roots ?? ["~/.prime/agent/sessions", "~/.prime/agent/session-artifacts", "~/.prime/agent/logs"]).map(root => expand(String(root))),
    token: readFileSync(expand(String(raw.tokenFile)), "utf8").trim(),
  };
  if (!config.listen || !Number.isInteger(config.port) || !isAbsolute(config.daemonSocket) || config.token.length < 32) throw new Error(`${file}: needs listen, port, an absolute daemonSocket and a tokenFile with at least 32 characters`);
  return config;
}

const digest = text => createHash("sha256").update(text).digest();

function authorized(request, token) {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") && timingSafeEqual(digest(header.slice(7).trim()), digest(token));
}

function daemonAnswers(socketPath) {
  return new Promise(resolve => {
    const socket = createConnection(socketPath);
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1500, () => done(false));
    socket.once("data", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** The real path of `path` when it lies inside one of the roots, else null. */
async function allowed(path, roots) {
  if (!isAbsolute(path)) return null;
  let real;
  try { real = await realpath(path); } catch { return undefined; }
  for (const root of roots) {
    let base;
    try { base = await realpath(root); } catch { continue; }
    if (real === base || real.startsWith(base + sep)) return real;
  }
  return null;
}

async function serveFile(request, response, url, roots) {
  const real = await allowed(url.searchParams.get("path") ?? "", roots);
  if (real === undefined) return send(response, 404, { error: "no such file" });
  if (real === null) return send(response, 403, { error: "path is outside the relay roots" });
  const info = await stat(real);
  if (info.isDirectory()) {
    const entries = await Promise.all((await readdir(real, { withFileTypes: true })).map(async entry => {
      const child = await stat(join(real, entry.name)).catch(() => null);
      return { name: entry.name, type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other", size: child?.size ?? 0, mtimeMs: child?.mtimeMs ?? 0 };
    }));
    return send(response, 200, { entries });
  }
  const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
  const start = range ? Number(range[1]) : 0;
  const headers = { "Last-Modified": info.mtime.toUTCString(), "X-File-Size": String(info.size), "Accept-Ranges": "bytes", "Content-Type": "application/octet-stream" };
  if (start > info.size) { response.writeHead(416, { ...headers, "Content-Range": `bytes */${info.size}` }); return response.end(); }
  const status = range ? 206 : 200;
  response.writeHead(status, { ...headers, "Content-Length": String(info.size - start), ...(range ? { "Content-Range": `bytes ${start}-${Math.max(start, info.size - 1)}/${info.size}` } : {}) });
  if (request.method === "HEAD" || start === info.size) return response.end();
  createReadStream(real, { start, end: info.size - 1 }).pipe(response);
}

/** sieun-pi's worker footprint helper, installed beside the relay (install.mjs), so the chat service on another box can measure this box's workers. */
const FOOTPRINT_HELPER = join(dirname(fileURLToPath(import.meta.url)), "worker-footprint.py");
/** Worker pids are small integers; a body past this is no pid list. */
const WATCH_BODY_BYTES = 64 * 1024;

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; if (body.length > limit) { reject(new Error("body too large")); request.destroy(); } });
    request.once("end", () => resolve(body));
    request.once("error", reject);
  });
}

/** The footprint helper's answer for `pids`, as the chat service's own watch runs it (src/mac-usable-watch.ts runHelper). */
function footprints(pids) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/python3", ["-B", FOOTPRINT_HELPER], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.setEncoding("utf8").on("data", chunk => { out += chunk; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); if (code !== 0) return reject(new Error(`footprint helper exited ${code}`)); try { resolve(JSON.parse(out)); } catch (error) { reject(error); } });
    child.stdin.end(pids.join("\n") + "\n");
  });
}

/** POST /v1/watch: the body lists worker pids, one per line; the answer is this box's usability reading and those workers' footprints. */
async function serveWatch(request, response) {
  const pids = (await readBody(request, WATCH_BODY_BYTES)).split("\n").map(line => line.trim()).filter(line => /^\d+$/.test(line)).map(Number);
  const [usable, measured] = await Promise.all([usableRaw(), footprints(pids)]);
  send(response, 200, { usable, footprints: measured });
}

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

/** The relay: checks the bearer token, tunnels `GET /v1/daemon` upgrades to the daemon socket (byte for byte, unless the client asks for slim snapshots, `slimSnapshots`, or message update deltas, `encodeLineDeltas`), serves reads under the roots and the box's CPU, memory and turn queue. */
export function createRelay(config, log = () => {}) {
  const server = createServer(async (request, response) => {
    try {
      if (!authorized(request, config.token)) return send(response, 401, { error: "unauthorized" });
      const url = new URL(request.url ?? "/", "http://relay");
      if (request.method === "GET" && url.pathname === "/v1/health") return send(response, 200, { ok: true, daemon: await daemonAnswers(config.daemonSocket) ? "answering" : "down", version: VERSION });
      if (request.method === "GET" && url.pathname === "/v1/host") return send(response, 200, await hostStats());
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/v1/file") return await serveFile(request, response, url, config.roots);
      if (request.method === "POST" && url.pathname === "/v1/watch") return await serveWatch(request, response);
      send(response, 404, { error: "unknown route" });
    } catch (error) {
      if (!response.headersSent) send(response, 500, { error: error instanceof Error ? error.message : String(error) });
      else response.destroy();
    }
  });
  server.on("upgrade", (request, socket, head) => {
    const refuse = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (!authorized(request, config.token)) return refuse("401 Unauthorized");
    if (new URL(request.url ?? "/", "http://relay").pathname !== "/v1/daemon" || String(request.headers.upgrade).toLowerCase() !== UPGRADE) return refuse("404 Not Found");
    const daemon = createConnection(config.daemonSocket);
    let opened = false;
    daemon.once("connect", () => {
      opened = true;
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${UPGRADE}\r\n\r\n`);
      if (head.length) daemon.write(head);
      const slim = request.headers[SLIM_HEADER] === "images";
      const deltas = request.headers[DELTA_HEADER] === "1";
      socket.pipe(daemon);
      let out = slim ? daemon.pipe(slimSnapshots()) : daemon;
      if (deltas) out = out.pipe(encodeLineDeltas());
      out.pipe(socket);
      log(`tunnel open from ${socket.remoteAddress}${slim ? ", snapshots without older images" : ""}${deltas ? ", message updates as deltas" : ""}`);
    });
    daemon.once("error", error => { if (opened) socket.destroy(); else refuse("502 Bad Gateway"); log(`daemon socket: ${error.message}`); });
    socket.once("error", () => daemon.destroy());
    daemon.once("close", () => socket.destroy());
    socket.once("close", () => daemon.destroy());
  });
  // A box's chat service keeps its file reads on open connections (src/hosts.ts agentFor); Node's 5 s default closed them between bursts.
  server.keepAliveTimeout = 10 * 60_000;
  return server;
}

/** One `list` over the daemon socket: true when a session is in a turn, a tool call or a compaction; null when the daemon did not answer. */
export function daemonWorking(socketPath, timeoutMs = 10_000) {
  return new Promise(resolve => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(null));
    socket.once("error", () => done(null));
    socket.on("data", chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.type === "daemon_hello") {
          const protocol = message.protocol;
          socket.write(`${JSON.stringify({ type: "command", id: "awake", protocol, clientId: "prime-relay", command: { id: "awake", type: "list" } })}\n`);
        } else if (message.id === "awake") {
          const rows = message.success && Array.isArray(message.data?.sessions) ? message.data.sessions : null;
          done(rows && rows.some(row => row.activity === "working" || row.isStreaming || row.isRunningTools || row.isCompacting));
        }
      }
    });
  });
}

/** The Mac may idle-sleep again once no session has worked for this long; the chat service's own hold (chat-awake.ts) uses the same 2 min. */
const AWAKE_RELEASE_MS = 2 * 60_000;
const AWAKE_POLL_MS = 30_000;

/**
 * On macOS, `caffeinate -i -w <relay pid>` runs while the box's daemon has a session at work and until AWAKE_RELEASE_MS after the last one, so a
 * turn on this Mac never idle-sleeps when the chat service runs on another box. Lid-close sleep still happens.
 */
export function holdAwake(socketPath, log, options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") return () => {};
  let hold = null;
  let lastWorkAt = null;
  const check = async () => {
    const working = await daemonWorking(socketPath);
    const now = Date.now();
    if (working) lastWorkAt = now;
    if (working && !hold) {
      hold = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
      const child = hold;
      child.once("exit", () => { if (hold === child) hold = null; });
      child.once("error", error => log(`awake: caffeinate: ${error.message}`));
      log("awake: a session works; holding idle sleep off");
    } else if (!working && hold && (lastWorkAt === null || now - lastWorkAt >= AWAKE_RELEASE_MS)) {
      hold.kill();
      hold = null;
      log("awake: nothing has worked for 2 min; idle sleep allowed again");
    }
  };
  void check();
  const timer = setInterval(() => { void check(); }, AWAKE_POLL_MS);
  return () => { clearInterval(timer); hold?.kill(); };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const file = expand(process.argv[2] ?? "~/.config/prime-relay/relay.json");
  const config = loadConfig(file);
  const log = line => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  createRelay(config, log).listen(config.port, config.listen, () => log(`prime-relay ${VERSION} on ${config.listen}:${config.port} for ${config.daemonSocket}`));
  holdAwake(config.daemonSocket, log);
}
