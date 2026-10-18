import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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
  server: Server; take(handler: Handler, upgrade: Upgrade): void;
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
