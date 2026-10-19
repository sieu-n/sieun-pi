import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, Server as NetServer, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { assetName, type PackedBundle, readBuiltBundle } from "./client-bundle.ts";
import { FirstPages } from "./first-page.ts";
import { contentSecurityPolicy, shellHead, shellTail } from "./shell.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
type Upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
/** The listening server a starting service answers page shells on before the rest of it loads; `take` hands every request to the real server. */
export interface EarlyShell {
  /** Hands every request to the real server; a Promise when the hand-over waits (early-shell-start.mjs), which the caller awaits before it reads the address. */
  server: Server; take(handler: Handler, upgrade: Upgrade): void | Promise<void>;
  /**
   * Resolves once the requests already waiting on the port are answered or queued, and 25 ms passed with none arriving. The service's own import
   * holds the thread for about 2 s, so the shells systemd queued during the restart go out before it starts.
   */
  settled(): Promise<void>;
}

const idPattern = /^[a-zA-Z0-9_.:-]{1,256}$/;

/**
 * Listens first thing in a service start and answers a page shell from what is on disk: the release's or the cache's packed bundle
 * (client-bundle.ts), the chat index, and the thread's first page from <data>/first-pages (first-page.ts `FirstPages`). Every other request
 * and every socket upgrade waits until the real server `take`s over. A cached app.js then paints the thread from the shell alone while the
 * catalog, the threads and the daemon links still load. At 12:42Z on 10-18 a shell during a restart waited 12.1 s.
 */
export async function startEarlyShell(options: { listenFd: number | null; port: number; capability: string; csrfToken: string; dataDir: string;
  bundle?: () => Promise<PackedBundle | null> }): Promise<EarlyShell> {
  const base = "/" + options.capability + "/";
  const pages = new FirstPages(join(options.dataDir, "first-pages"));
  const built = (options.bundle ?? (async () => (await readBuiltBundle()).bundle))().catch(() => null);
  const chats = readFile(join(options.dataDir, "chats.json"), "utf8").then(text => (JSON.parse(text) as { ids?: unknown }).ids, () => []).then(ids => Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  let waiting: (() => void)[] = [];
  let handler: Handler | null = null;
  let upgrade: Upgrade | null = null;
  async function shell(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" || url.pathname !== base || req.headers["sec-fetch-mode"] !== "navigate" || req.headers["sec-fetch-dest"] !== "document") return false;
    const bundle = await built;
    if (!bundle || handler) return false;
    const named = url.searchParams.get("t");
    const id = named && idPattern.test(named) ? named : null;
    // A page from before the restart paints at once; the feed brings what came since a moment later.
    const json = id ? await pages.get(id, true) : undefined;
    const html = shellHead(options.csrfToken, bundle.version, null, { js: assetName("app", "js", bundle.js), css: assetName("app", "css", bundle.css) }, await chats)
      + shellTail(id && json ? { id, json } : null);
    const packed = /\bbr\b/.test(String(req.headers["accept-encoding"] ?? ""));
    const body = packed ? brotliCompressSync(html, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }) : Buffer.from(html);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY", "Content-Security-Policy": contentSecurityPolicy, Vary: "Accept-Encoding", "Content-Length": body.length, ...(packed ? { "Content-Encoding": "br" } : {}) });
    res.end(body);
    return true;
  }
  let busy = 0, lastAt = Date.now();
  const server = createServer((req, res) => {
    if (handler) { handler(req, res); return; }
    busy++; lastAt = Date.now();
    void shell(req, res).finally(() => { busy--; lastAt = Date.now(); }).catch(() => false).then(answered => {
      if (answered) return;
      if (handler) handler(req, res); else waiting.push(() => handler!(req, res));
    });
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (upgrade) upgrade(req, socket, head); else waiting.push(() => upgrade!(req, socket, head));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    const listening = () => { server.removeListener("error", reject); resolve(); };
    if (options.listenFd === null) server.listen(options.port, "127.0.0.1", listening);
    else server.listen({ fd: options.listenFd }, listening);
  });
  return {
    server,
    async settled() { while (busy > 0 || Date.now() - lastAt < 25) await new Promise(resolve => setTimeout(resolve, 5)); },
    take(next, nextUpgrade) {
      handler = next; upgrade = nextUpgrade;
      const queued = waiting;
      waiting = [];
      for (const run of queued) run();
    },
  };
}

const netClose = NetServer.prototype.close;
const hopHeaders = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"]);

/** A request the early shell held, sent on to the real server on the same port; the answer closes the connection, so the next one goes there itself. */
function forwardRequest(port: number): Handler {
  return (req, res) => {
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !hopHeaders.has(name)));
    const out = request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers }, answer => {
      const kept = Object.fromEntries(Object.entries(answer.headers).filter(([name]) => !hopHeaders.has(name)));
      res.writeHead(answer.statusCode ?? 502, { ...kept, Connection: "close" });
      answer.pipe(res);
    });
    out.on("error", () => { if (res.headersSent) res.destroy(); else { res.writeHead(502, { Connection: "close" }); res.end(); } });
    req.pipe(out);
  };
}

/** A socket upgrade the early shell held, piped byte for byte to the real server on the same port. */
function forwardUpgrade(port: number): Upgrade {
  return (req, socket, head) => {
    const out = connect(port, "127.0.0.1");
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let at = 0; at < req.rawHeaders.length; at += 2) lines.push(`${req.rawHeaders[at]}: ${req.rawHeaders[at + 1]}`);
    out.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length) out.write(head);
    socket.pipe(out); out.pipe(socket);
    const end = () => { socket.destroy(); out.destroy(); };
    out.on("error", end); socket.on("error", end); out.on("close", end); socket.on("close", end);
  };
}

/**
 * The early shell in a process of its own (src/early-shell-child.mjs), on its copy of systemd's socket at fd 3, so the service's own import
 * cannot hold it: on 10-18 a scratch start answered the shells systemd had queued in 0.29 s, and every shell that came 0.5 to 2.8 s after
 * exec then waited until about 2.7 s while chat-service.ts loaded on the thread. When the parent says "ready" (it listens on the same socket
 * by then) this process stops accepting, sends what it held on to the port, and exits once those connections end.
 */
export async function serveEarlyChild(options: { dataDir: string }): Promise<void> {
  const config = JSON.parse(await readFile(join(options.dataDir, "configuration.json"), "utf8")) as { capability?: unknown; csrfToken?: unknown };
  if (typeof config.capability !== "string" || typeof config.csrfToken !== "string") return;
  const early = await startEarlyShell({ listenFd: 3, port: 0, capability: config.capability, csrfToken: config.csrfToken, dataDir: options.dataDir });
  const { port } = early.server.address() as AddressInfo;
  let handedOver = false;
  const handOver = () => {
    if (handedOver) return;
    handedOver = true;
    // net's close stops the listening only: http's close (Node 19 and on) also drops idle connections, and one accepted just before the
    // hand-over with its request not read yet was reset (ECONNRESET in 2 of 6 scratch hand-overs on 10-19).
    netClose.call(early.server);
    early.take(forwardRequest(port), forwardUpgrade(port));
    // Kept-alive connections get 1 s to send one more request, which goes on to the real server; the process exits when the last ends.
    early.server.keepAliveTimeout = 1_000;
    setTimeout(() => early.server.closeIdleConnections(), 1_000).unref();
    if (process.connected) process.disconnect?.();
  };
  process.on("message", message => { if (message === "ready") handOver(); });
  process.once("disconnect", handOver);
  process.send?.("listening");
}
