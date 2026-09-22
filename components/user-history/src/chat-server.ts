import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createGzip, type Gzip } from "node:zlib";
import type { ChatBackend } from "./chat-backend.ts";
import type { ClientBundle, Asset } from "./chat-assets.ts";
import { parseChatImages } from "./chat-images.ts";
import { listAccounts, runAccountAction } from "./chat-pool.ts";
import { ThreadError } from "./chat-threads.ts";
import type { AccountAction, SendMode, ThinkingLevel } from "./shared/types.ts";

const maxBodyBytes = 12 * 1024 * 1024;
const maxMessageLength = 32000;
const requestIdPattern = /^[a-zA-Z0-9_-]{16,100}$/;
const idPattern = /^[a-zA-Z0-9_.:-]{1,256}$/;
export const contentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function escapeAttribute(text: string): string { return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;"); }

export function renderShell(csrfToken: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Prime Agent chat</title>
<link rel="stylesheet" href="app.css">
</head>
<body data-chat-token="${escapeAttribute(csrfToken)}">
<div id="app"></div>
<script type="module" src="app.js"></script>
</body>
</html>
`;
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new RequestError(415, "Expected application/json.");
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) { request.resume(); throw new RequestError(413, "Request is too large."); }
  const chunks = await new Promise<Buffer[]>((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    const cleanup = () => { request.off("data", data); request.off("end", end); request.off("error", failed); request.off("aborted", aborted); };
    function failed(error: Error) { cleanup(); reject(error); }
    function aborted() { failed(new RequestError(400, "Request was interrupted.")); }
    function data(bytes: Buffer) {
      size += bytes.length;
      if (size > maxBodyBytes) { cleanup(); request.resume(); reject(new RequestError(413, "Request is too large.")); } else parts.push(bytes);
    }
    function end() { cleanup(); resolve(parts); }
    request.on("data", data); request.once("end", end); request.once("error", failed); request.once("aborted", aborted);
  });
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RequestError(400, "Invalid JSON."); }
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new RequestError(400, "Expected a JSON object.");
  return value;
}
function text(value: unknown, field: string, max = maxMessageLength): string {
  if (typeof value !== "string" || value.length > max) throw new RequestError(400, `Expected ${field} as text up to ${max} characters.`);
  return value;
}
function requestId(value: unknown): string {
  if (typeof value !== "string" || !requestIdPattern.test(value)) throw new RequestError(400, "Expected a request ID.");
  return value;
}
function threadId(value: string): string {
  if (!idPattern.test(value)) throw new RequestError(400, "Invalid thread ID.");
  return value;
}
function parseImages(value: unknown) {
  try { return parseChatImages(value); }
  catch (error) { throw new RequestError(400, error instanceof Error ? error.message : "Invalid images."); }
}
function parseMode(value: unknown): SendMode {
  const mode = value ?? "followUp";
  if (mode !== "steer" && mode !== "followUp") throw new RequestError(400, "Choose steer or followUp.");
  return mode;
}
function parseAccountAction(body: Record<string, unknown>): AccountAction {
  const provider = text(body.provider, "provider", 64);
  const account = typeof body.account === "string" ? text(body.account, "account", 256) : undefined;
  const id = typeof body.id === "string" ? threadId(body.id) : undefined;
  switch (body.action) {
    case "use": if (!account || !id) throw new RequestError(400, "Choose an account and a thread."); return { action: "use", provider, account, id, force: body.force === true };
    case "follow": if (!id) throw new RequestError(400, "Choose a thread."); return { action: "follow", provider, id };
    case "pin": if (!account) throw new RequestError(400, "Choose an account."); return { action: "pin", provider, account };
    case "unpin": return { action: "unpin", provider };
    case "switch": return { action: "switch", provider };
    case "refresh": return { action: "refresh", provider };
    case "recheck": return { action: "recheck", provider };
    default: throw new RequestError(400, "Unknown account action.");
  }
}

class EventStream {
  private readonly gzip: Gzip | null;
  private readonly ping: ReturnType<typeof setInterval>;
  closed = false;
  constructor(private readonly res: ServerResponse, acceptGzip: boolean) {
    this.gzip = acceptGzip ? createGzip({ level: 1 }) : null;
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no",
      ...(this.gzip ? { "Content-Encoding": "gzip" } : {}) });
    if (this.gzip) this.gzip.pipe(res);
    this.write(": open\n\n");
    this.ping = setInterval(() => this.write(": ping\n\n"), 20000);
    res.once("close", () => this.close());
  }
  private write(chunk: string): void {
    if (this.closed) return;
    if (this.gzip) { this.gzip.write(chunk); this.gzip.flush(); } else this.res.write(chunk);
  }
  send(event: string, data: unknown): void { this.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ping);
    if (this.gzip) this.gzip.end(); else this.res.end();
  }
}

class Bounded<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly limit: number) {}
  get(key: string): V | undefined { return this.map.get(key); }
  set(key: string, value: V): void {
    this.map.set(key, value);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value!);
  }
  clear(): void { this.map.clear(); }
}

export async function startChatServer({ backend, bundle, port, capability, csrfToken, identity, stopToken, onStop, identityReady = Promise.resolve() }: {
  backend: ChatBackend; bundle: ClientBundle; port: number; capability: string; csrfToken: string;
  identity: { pid: number; instanceId: string; socketPath: string }; stopToken: string;
  onStop(): Promise<void>; identityReady?: Promise<void>;
}): Promise<{ url: string; close(): Promise<void> }> {
  const base = "/" + capability + "/";
  const shell = renderShell(csrfToken);
  const sends = new Bounded<{ fingerprint: string; result: Promise<void> }>(500);
  const creations = new Bounded<{ fingerprint: string; result: Promise<{ id: string }> }>(200);
  const streams = new Set<EventStream>();
  let host = "";
  let closing: Promise<void> | undefined;

  const server = createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 30;
  server.on("clientError", (_error, socket) => { socket.destroy(); });

  function json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }
  function serveAsset(req: IncomingMessage, res: ServerResponse, asset: Asset) {
    if (req.headers["if-none-match"] === asset.etag) { res.writeHead(304, { ETag: asset.etag, "Cache-Control": "no-cache" }); res.end(); return; }
    res.writeHead(200, { "Content-Type": asset.contentType, ETag: asset.etag, "Cache-Control": "no-cache", "Content-Length": asset.body.length });
    res.end(asset.body);
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      for (const stream of streams) stream.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      sends.clear();
      await backend.close();
    })();
    return closing;
  }
  function openStream(req: IncomingMessage, res: ServerResponse): EventStream {
    const stream = new EventStream(res, /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? "")));
    streams.add(stream);
    res.once("close", () => streams.delete(stream));
    return stream;
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", contentSecurityPolicy);
    try {
      if (req.headers.host !== host) throw new RequestError(421, "Unexpected host.");
      if (req.headers["sec-fetch-site"] === "cross-site" || (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)) {
        throw new RequestError(403, "Cross-origin requests are blocked.");
      }
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (url.origin !== `http://${host}` || !url.pathname.startsWith(base)) throw new RequestError(404, "Not found.");
      const route = url.pathname.slice(base.length);
      if (closing) throw new RequestError(410, "Chat service is stopping. Run sieun-pi chat start again.");
      const method = req.method ?? "GET";
      if (method === "GET" && route === "api/identity") { await identityReady; json(res, 200, { service: "sieun-pi-chat", ...identity }); return; }
      if (route === "api/service-stop") {
        if (method !== "POST") throw new RequestError(405, "Expected POST.");
        if (req.headers["x-chat-stop-token"] !== stopToken || req.headers.origin !== `http://${host}`) throw new RequestError(403, "Service authorization is missing.");
        const body = record(await jsonBody(req));
        if (body.instanceId !== identity.instanceId) throw new RequestError(409, "The service instance changed. Check chat status before stopping.");
        res.once("finish", () => { void onStop(); });
        json(res, 200, { stopped: true });
        return;
      }
      if (method === "GET") {
        if (route === "") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(shell); return; }
        if (route === "app.js") { serveAsset(req, res, bundle.js); return; }
        if (route === "app.css") { serveAsset(req, res, bundle.css); return; }
        if (route === "api/sessions/stream") {
          const stream = openStream(req, res);
          const unsubscribe = backend.catalog.subscribe(event => stream.send("sessions", event));
          res.once("close", unsubscribe);
          return;
        }
        if (route === "api/workspaces") { json(res, 200, { workspaces: await backend.catalog.workspaces() }); return; }
        if (route === "api/models") {
          const id = url.searchParams.get("id");
          json(res, 200, await backend.threads.models(id ? threadId(id) : null)); return;
        }
        if (route === "api/commands") { json(res, 200, { commands: await backend.threads.commands(null) }); return; }
        if (route === "api/accounts") {
          const id = url.searchParams.get("id");
          json(res, 200, await listAccounts(id ? threadId(id) : null)); return;
        }
        const image = /^api\/images\/([a-f0-9]{64})$/.exec(route);
        if (image) {
          const entry = backend.threads.images.get(image[1]!);
          if (!entry) throw new RequestError(404, "Image is no longer cached. Reopen the thread.");
          res.writeHead(200, { "Content-Type": entry.mimeType, "Content-Length": entry.bytes.length, "Cache-Control": "private, max-age=3600, immutable" });
          res.end(entry.bytes);
          return;
        }
        const thread = /^api\/threads\/([^/]+)\/([a-z-]+)$/.exec(route);
        if (thread) {
          const id = threadId(decodeURIComponent(thread[1]!));
          const action = thread[2];
          if (action === "stream") {
            const stream = openStream(req, res);
            try {
              const unsubscribe = await backend.threads.subscribe(id, event => stream.send("thread", event));
              res.once("close", unsubscribe);
              if (stream.closed) unsubscribe();
            } catch (error) {
              stream.send("thread", { type: "status", connection: "closed", error: error instanceof Error ? error.message : String(error) });
              stream.close();
            }
            return;
          }
          if (action === "tool-output") {
            const toolCallId = url.searchParams.get("toolCallId") ?? "";
            if (!toolCallId || toolCallId.length > 512) throw new RequestError(400, "Choose a tool call.");
            json(res, 200, await backend.threads.toolOutput(id, toolCallId)); return;
          }
          if (action === "part") {
            const message = Number(url.searchParams.get("message")); const part = Number(url.searchParams.get("part") ?? 0);
            if (!Number.isSafeInteger(message) || message < 0 || !Number.isSafeInteger(part) || part < 0) throw new RequestError(400, "Choose a message part.");
            json(res, 200, await backend.threads.part(id, message, part)); return;
          }
          if (action === "commands") { json(res, 200, { commands: await backend.threads.commands(id) }); return; }
          if (action === "stats") { json(res, 200, await backend.threads.stats(id)); return; }
        }
        throw new RequestError(404, "Not found.");
      }
      if (method !== "POST") throw new RequestError(405, "Expected POST.");
      if (req.headers["x-chat-token"] !== csrfToken || req.headers.origin !== `http://${host}`) throw new RequestError(403, "Write authorization is missing. Reopen the chat URL.");
      const body = record(await jsonBody(req));
      if (route === "api/threads") {
        const id = requestId(body.requestId);
        const cwd = text(body.cwd, "cwd", 1024);
        if (!cwd.startsWith("/")) throw new RequestError(400, "Choose an absolute workspace path.");
        const message = text(body.message, "message");
        const images = parseImages(body.images);
        if (!message.trim() && !images.length) throw new RequestError(400, "Add a message or image.");
        const provider = typeof body.provider === "string" ? text(body.provider, "provider", 128) : undefined;
        const modelId = typeof body.modelId === "string" ? text(body.modelId, "modelId", 256) : undefined;
        const thinkingLevel = typeof body.thinkingLevel === "string" ? text(body.thinkingLevel, "thinkingLevel", 16) as ThinkingLevel : undefined;
        const fingerprint = createHash("sha256").update(JSON.stringify([cwd, provider, modelId, thinkingLevel, message, images])).digest("hex");
        let creation = creations.get(id);
        if (creation && creation.fingerprint !== fingerprint) throw new RequestError(409, "This request ID belongs to another new chat.");
        if (!creation) {
          creation = { fingerprint, result: (async () => {
            const thread = await backend.threads.create({ cwd, ...(provider ? { provider } : {}), ...(modelId ? { modelId } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) });
            await backend.threads.prompt(thread.id, { message, images, mode: "followUp" });
            return { id: thread.id };
          })() };
          creations.set(id, creation);
        }
        json(res, 200, await creation.result); return;
      }
      if (route === "api/warm") { await backend.threads.warm(threadId(text(body.id, "id", 256))); json(res, 200, { ok: true }); return; }
      if (route === "api/accounts") {
        const action = parseAccountAction(body);
        const notice = await runAccountAction(action);
        json(res, 200, { ...await listAccounts("id" in action ? action.id : null), ...(notice ? { notice } : {}) }); return;
      }
      const thread = /^api\/threads\/([^/]+)\/([a-z-]+)$/.exec(route);
      if (!thread) throw new RequestError(404, "Not found.");
      const id = threadId(decodeURIComponent(thread[1]!));
      switch (thread[2]) {
        case "prompt": {
          const rid = requestId(body.requestId);
          const message = text(body.message, "message");
          const images = parseImages(body.images);
          const mode = parseMode(body.mode);
          if (!message.trim() && !images.length) throw new RequestError(400, "Add a message or image.");
          const fingerprint = createHash("sha256").update(JSON.stringify([id, message, images, mode])).digest("hex");
          let pending = sends.get(rid);
          if (pending && pending.fingerprint !== fingerprint) throw new RequestError(409, "This request ID belongs to a different message.");
          if (!pending) { pending = { fingerprint, result: backend.threads.prompt(id, { message, images, mode }) }; sends.set(rid, pending); }
          await pending.result;
          json(res, 200, { accepted: true }); return;
        }
        case "abort": await backend.threads.abort(id); break;
        case "rename": {
          const name = text(body.name, "name", 200).trim();
          if (!name) throw new RequestError(400, "Use a name of 1 to 200 characters.");
          await backend.threads.rename(id, name); break;
        }
        case "model": await backend.threads.setModel(id, text(body.provider, "provider", 128), text(body.modelId, "modelId", 256)); break;
        case "thinking": await backend.threads.setThinking(id, text(body.level, "level", 16)); break;
        case "queue": {
          const lane = body.lane;
          if (lane !== "steering" && lane !== "followUp") throw new RequestError(400, "Choose a queue lane.");
          const index = body.index;
          if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) throw new RequestError(400, "Choose a queued message.");
          const expectedText = text(body.expectedText, "expectedText");
          const replacement = "text" in body && body.text !== undefined ? text(body.text, "text") : undefined;
          if (replacement !== undefined && !replacement.trim()) throw new RequestError(400, "Queued text cannot be empty.");
          const status = await backend.threads.mutateQueue(id, { lane, index, expectedText, ...(replacement === undefined ? {} : { text: replacement }) });
          json(res, status === "applied" ? 200 : 409, { status, ...(status === "applied" ? {} : { error: "The queue changed. It was refreshed." }) }); return;
        }
        case "read": {
          const summary = await backend.catalog.summary(id);
          const activity = Date.parse(summary?.lastActivityAt ?? summary?.modified ?? "");
          await backend.readState.mark(id, { entryId: String(summary?.messageCount ?? 0), timestamp: Math.max(Date.now(), Number.isFinite(activity) ? activity : 0) });
          await backend.catalog.notify();
          break;
        }
        default: throw new RequestError(404, "Not found.");
      }
      json(res, 200, { ok: true });
    } catch (error) {
      const status = error instanceof RequestError || error instanceof ThreadError ? error.status : 502;
      if (!res.headersSent && !res.destroyed) json(res, status, { error: error instanceof Error ? error.message : "Prime Agent is unavailable." });
    }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a loopback TCP address.");
    host = `127.0.0.1:${address.port}`;
    server.on("error", () => { void close(); });
    return { url: `http://${host}${base}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}
