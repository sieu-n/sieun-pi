#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, realpathSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hostStats } from "./host-stats.ts";

const VERSION = 1;
const UPGRADE = "prime-daemon";

const expand = path => path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

/** Reads relay.json: { listen, port, daemonSocket, roots, tokenFile }. */
export function loadConfig(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const config = {
    listen: String(raw.listen), port: Number(raw.port), daemonSocket: expand(String(raw.daemonSocket)),
    roots: (raw.roots ?? ["~/.prime/agent/sessions", "~/.prime/agent/session-artifacts"]).map(root => expand(String(root))),
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

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

/** The relay: checks the bearer token, tunnels `GET /v1/daemon` upgrades byte for byte to the daemon socket, serves reads under the roots and the box's CPU, memory and turn queue. */
export function createRelay(config, log = () => {}) {
  const server = createServer(async (request, response) => {
    try {
      if (!authorized(request, config.token)) return send(response, 401, { error: "unauthorized" });
      const url = new URL(request.url ?? "/", "http://relay");
      if (request.method === "GET" && url.pathname === "/v1/health") return send(response, 200, { ok: true, daemon: await daemonAnswers(config.daemonSocket) ? "answering" : "down", version: VERSION });
      if (request.method === "GET" && url.pathname === "/v1/host") return send(response, 200, await hostStats());
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/v1/file") return await serveFile(request, response, url, config.roots);
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
      socket.pipe(daemon).pipe(socket);
      log(`tunnel open from ${socket.remoteAddress}`);
    });
    daemon.once("error", error => { if (opened) socket.destroy(); else refuse("502 Bad Gateway"); log(`daemon socket: ${error.message}`); });
    socket.once("error", () => daemon.destroy());
    daemon.once("close", () => socket.destroy());
    socket.once("close", () => daemon.destroy());
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const file = expand(process.argv[2] ?? "~/.config/prime-relay/relay.json");
  const config = loadConfig(file);
  const log = line => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  createRelay(config, log).listen(config.port, config.listen, () => log(`prime-relay ${VERSION} on ${config.listen}:${config.port} for ${config.daemonSocket}`));
}
