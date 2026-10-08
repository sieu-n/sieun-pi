import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createGzip, type Gzip } from "node:zlib";
import type { ChatBackend } from "./chat-backend.ts";
import type { ClientBundle, Asset } from "./chat-assets.ts";
import { parseChatImages } from "./chat-images.ts";
import { BOARD_PREFIX, BoardError, parseBoardOps } from "./shared/chat-board.ts";
import { buildRenderBundle, LocalFileError, readLocalImage, readLocalText, renderPage, renderPolicy } from "./chat-render.ts";
import { readWikiPage, type WikiPageView } from "./chat-wiki.ts";
import { parsePublicOrigin } from "./chat-origin.ts";
import { FeedSockets } from "./chat-socket.ts";
import { isPriority, isProgress, LabelError, TAG_NAME_MAX } from "./chat-labels.ts";
import { AccountLogins, listAccounts, PoolError, runAccountAction, UsageRefreshes } from "./chat-pool.ts";
import { NOTE_MAX } from "./chat-notes.ts";
import { ThreadError } from "./chat-threads.ts";
import { type CheckInChange, validCheckInEvery } from "./chat-checkin.ts";
import { chooseFolder, resolveWorkspace, WorkspaceError } from "./chat-workspace.ts";
import { parseBucket, parseGroup, parseMetric, parseWindow, UsageError } from "./usage/service.ts";
import { interruptedRuns } from "./chat-resume.ts";
import type { RemoteControl } from "./chat-remote.ts";
import type { SlackControl } from "./chat-slack.ts";
import type { SdkSync } from "./chat-sdk.ts";
import { CHECK_IN_MAX_MINUTES, CHECK_IN_MIN_MINUTES, CHECK_IN_PAUSES, isThinkingLevel, type AccountAction, type ChatDefaultsInput, type LabelAction, type ModelCatalog, type RemoteAccessInput, type SendMode, type SlackInput, type ThinkingLevel } from "./shared/types.ts";

const maxBodyBytes = 12 * 1024 * 1024;
const maxMessageLength = 32000;
const requestIdPattern = /^[a-zA-Z0-9_-]{16,100}$/;
const idPattern = /^[a-zA-Z0-9_.:-]{1,256}$/;
export const contentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; frame-src 'self'; connect-src 'self'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function escapeAttribute(text: string): string { return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;"); }

export function renderShell(csrfToken: string, version: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Prime Agent chat</title>
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">
<link rel="icon" type="image/png" sizes="64x64" href="favicon-64.png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f8f9fb">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#17181c">
<link rel="stylesheet" href="app.css">
</head>
<body data-chat-token="${escapeAttribute(csrfToken)}" data-build="${escapeAttribute(version)}">
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
/** The kind of thread `POST api/threads` creates: a plain thread, or a chat. */
function parseCheckInChange(body: Record<string, unknown>): CheckInChange {
  const change: CheckInChange = {};
  if (body.everyMs !== undefined) {
    if (!validCheckInEvery(body.everyMs)) throw new RequestError(400, `Use whole minutes from ${CHECK_IN_MIN_MINUTES} to ${CHECK_IN_MAX_MINUTES}.`);
    change.everyMs = body.everyMs;
  }
  if (body.pause !== undefined) {
    const pause = CHECK_IN_PAUSES.find(entry => entry === body.pause);
    if (body.pause !== null && !pause) throw new RequestError(400, `Pause with ${CHECK_IN_PAUSES.join(", ")} or null.`);
    change.pause = pause ?? null;
  }
  if (change.everyMs === undefined && change.pause === undefined) throw new RequestError(400, "Choose everyMs or pause.");
  return change;
}

function parseKind(value: unknown): "thread" | "chat" {
  if (value === undefined || value === null || value === "thread") return "thread";
  if (value === "chat") return "chat";
  throw new RequestError(400, "Choose kind thread or chat.");
}
/** The pool account a new chat starts on; absent means follow the pool. */
function parseNewChatAccount(value: unknown): { provider: string; id: string; force: boolean } | undefined {
  if (value === undefined || value === null) return undefined;
  const account = record(value);
  const id = text(account.id, "account.id", 256);
  if (id.startsWith("-")) throw new RequestError(400, "Choose an account.");
  return { provider: text(account.provider, "account.provider", 64), id, force: account.force === true };
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
    case "recheck": return { action: "recheck", provider };
    case "resets": return { action: "resets", provider, ...(account ? { account } : {}) };
    case "reset": {
      if (!account) throw new RequestError(400, "Choose an account.");
      const grant = typeof body.grant === "string" ? text(body.grant, "grant", 40) : undefined;
      return { action: "reset", provider, account, ...(grant ? { grant } : {}) };
    }
    case "disable": case "enable": case "remove": if (!account) throw new RequestError(400, "Choose an account."); return { action: body.action, provider, account };
    default: throw new RequestError(400, "Unknown account action.");
  }
}

/** The defaults a new chat starts with; the model must be in the catalog and the effort, when given, one of that model's levels. */
function parseDefaults(body: Record<string, unknown>, catalog: ModelCatalog): ChatDefaultsInput {
  const provider = text(body.provider, "provider", 128);
  const modelId = text(body.modelId, "modelId", 256);
  const model = catalog.models.find(entry => entry.provider === provider && entry.id === modelId);
  if (!model) throw new RequestError(400, "Choose a model from the catalog.");
  if (body.thinkingLevel === undefined || body.thinkingLevel === null) return { provider, modelId };
  if (!isThinkingLevel(body.thinkingLevel) || !model.thinkingLevels?.includes(body.thinkingLevel)) throw new RequestError(400, `Choose an effort ${model.name} supports.`);
  return { provider, modelId, thinkingLevel: body.thinkingLevel };
}

function threadIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000 || !value.every(id => typeof id === "string")) throw new RequestError(400, "Expected up to 1000 thread IDs.");
  return [...new Set(value.map(id => threadId(id)))];
}
function parseLabelAction(body: Record<string, unknown>): LabelAction {
  const tagId = () => text(body.tagId, "tagId", 64);
  const name = () => text(body.name, "name", TAG_NAME_MAX * 2);
  switch (body.op) {
    case "create": return { op: "create", name: name(), ids: body.ids === undefined ? [] : threadIds(body.ids) };
    case "rename": return { op: "rename", tagId: tagId(), name: name() };
    case "delete": return { op: "delete", tagId: tagId() };
    case "tag":
      if (typeof body.on !== "boolean") throw new RequestError(400, "Choose on or off.");
      return { op: "tag", tagId: tagId(), ids: threadIds(body.ids), on: body.on };
    case "priority":
      if (!isPriority(body.priority)) throw new RequestError(400, "Choose a priority from 0 to 3.");
      return { op: "priority", ids: threadIds(body.ids), priority: body.priority };
    case "progress":
      if (!isProgress(body.progress)) throw new RequestError(400, "Choose none, plan, implementation or qa.");
      return { op: "progress", ids: threadIds(body.ids), progress: body.progress };
    default: throw new RequestError(400, "Unknown label action.");
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

/** A fixed `publicOrigin` with no Tailscale management, for tests and embedded servers. */
function fixedRemote(publicOrigin: string | null, capability: string): RemoteControl {
  const origin = parsePublicOrigin(publicOrigin);
  return {
    origin: () => origin,
    view: editable => ({ mode: origin ? "custom" : "off", state: origin ? "on" : "off", origin, phoneUrl: origin ? `${origin}/${capability}/` : null, checkedAt: null, reachable: null, editable,
      message: origin ? `On through ${origin}.` : "Off. Only this Mac can open the chat.",
      keepRunning: { available: false, enabled: false, state: "off", message: "Start at login is not available for this chat instance." },
      openAppAtLogin: { available: false, enabled: false, appName: null, message: "Opening the app at login is not available for this chat instance." } }),
    set: async () => { throw new RequestError(409, "Phone access is fixed for this chat instance."); },
    check: async () => {},
  };
}

function parseSlackInput(body: Record<string, unknown>): SlackInput {
  const input: SlackInput = {};
  if (body.enabled !== undefined) { if (typeof body.enabled !== "boolean") throw new RequestError(400, "enabled must be true or false."); input.enabled = body.enabled; }
  if (body.ownerUserId !== undefined) {
    if (body.ownerUserId !== null && typeof body.ownerUserId !== "string") throw new RequestError(400, "ownerUserId must be a member id or null.");
    input.ownerUserId = typeof body.ownerUserId === "string" ? body.ownerUserId.trim() || null : null;
  }
  if (input.enabled === undefined && input.ownerUserId === undefined) throw new RequestError(400, "Choose enabled or ownerUserId.");
  return input;
}

function parseRemoteInput(body: Record<string, unknown>): RemoteAccessInput {
  const input: RemoteAccessInput = {};
  if (body.tailscale !== undefined) { if (typeof body.tailscale !== "boolean") throw new RequestError(400, "tailscale must be true or false."); input.tailscale = body.tailscale; }
  if (body.keepRunning !== undefined) { if (typeof body.keepRunning !== "boolean") throw new RequestError(400, "keepRunning must be true or false."); input.keepRunning = body.keepRunning; }
  if (body.openAppAtLogin !== undefined) {
    if (typeof body.openAppAtLogin !== "boolean") throw new RequestError(400, "openAppAtLogin must be true or false.");
    input.openAppAtLogin = body.openAppAtLogin;
  }
  if (input.tailscale === undefined && input.keepRunning === undefined && input.openAppAtLogin === undefined) throw new RequestError(400, "Choose tailscale, keepRunning or openAppAtLogin.");
  return input;
}

export async function startChatServer({ backend, bundle, port, capability, csrfToken, publicOrigin = null, remote = fixedRemote(publicOrigin, capability), slack = null, sdk = null, identity, stopToken, onStop, identityReady = Promise.resolve(), logins = new AccountLogins(), refreshes = new UsageRefreshes(), wikiPage = readWikiPage }: {
  backend: ChatBackend; bundle: ClientBundle | Promise<ClientBundle>; port: number; capability: string; csrfToken: string;
  identity: { pid: number; instanceId: string; socketPath: string }; stopToken: string; publicOrigin?: string | null;
  /** Phone access: which remote HTTPS origin is allowed right now, and the Settings view and switches. */
  remote?: RemoteControl;
  /** Settings > Slack; null for instances that run no Slack bridge (tests, extra data dirs). */
  slack?: SlackControl | null;
  /** Settings > Versions and the SDK auto-update; null for instances that do not manage their packages. */
  sdk?: SdkSync | null;
  onStop(): Promise<void>; identityReady?: Promise<void>; logins?: AccountLogins; refreshes?: UsageRefreshes;
  /** How `api/wiki-page` reads a page; a probe points it at its own wiki and content folder. */
  wikiPage?: (path: string) => Promise<WikiPageView>;
}): Promise<{ url: string; close(): Promise<void> }> {
  const base = "/" + capability + "/";
  /** The serving process builds the page bundle after it listens; a feed names the build once it exists (a failed build was logged there). */
  const sendBuild = (send: (version: string) => void) => { void Promise.resolve(bundle).then(built => send(built.version), () => {}); };
  const sends = new Bounded<{ fingerprint: string; result: Promise<void> }>(500);
  const creations = new Bounded<{ fingerprint: string; result: Promise<{ id: string; notice?: string }> }>(200);
  const streams = new Set<EventStream>();
  let host = "";
  let closing: Promise<void> | undefined;

  const server = createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 30;
  server.on("clientError", (_error, socket) => { socket.destroy(); });
  const feeds = new FeedSockets(async (feed, send) => {
    if (feed.feed === "sessions") {
      sendBuild(version => send("build", { version }));
      return backend.catalog.subscribe(event => send("sessions", event));
    }
    if (feed.feed === "login") return logins.subscribe(login => send("login", login));
    if (feed.feed === "refresh") return refreshes.subscribe(refresh => send("refresh", refresh));
    if (feed.feed === "usage") {
      if (!backend.usage) throw new Error("Usage analytics is off in this chat.");
      return backend.usage.subscribe(summary => send("usage", summary));
    }
    try { return await backend.threads.subscribe(threadId(feed.id), event => send("thread", event)); }
    catch (error) {
      send("thread", { type: "status", connection: "closed", error: error instanceof Error ? error.message : String(error) });
      return () => {};
    }
  });
  server.on("upgrade", (req, socket, head) => { upgrade(req, socket, head); });

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
      feeds.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      sends.clear();
      await logins.close();
      await refreshes.close();
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
  /** The page origin for the requested host: loopback HTTP, or the remote HTTPS origin while phone access is on. */
  function requestOrigin(req: IncomingMessage): string | null {
    // The remote origin can change while the server runs (Settings, a renamed tailnet machine), so it is read per request.
    const externalOrigin = remote.origin();
    return req.headers.host === host ? `http://${host}`
      : externalOrigin !== null && req.headers.host === new URL(externalOrigin).host ? externalOrigin : null;
  }
  /**
   * The live feeds socket at `<capability>/api/ws`. Browsers send Origin on every WebSocket handshake and do not apply
   * CORS to it, so the exact Origin and the page token in `?token=` stand in for the checks a POST gets.
   */
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, reason: string) => {
      socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`);
    };
    socket.on("error", () => { socket.destroy(); });
    const origin = requestOrigin(req);
    if (origin === null) { refuse(421, "Misdirected Request"); return; }
    let url: URL;
    try { url = new URL(req.url ?? "/", origin); } catch { refuse(400, "Bad Request"); return; }
    if (url.origin !== origin || url.pathname !== base + "api/ws") { refuse(404, "Not Found"); return; }
    if (closing) { refuse(410, "Gone"); return; }
    if (req.headers.origin !== origin || url.searchParams.get("token") !== csrfToken) { refuse(403, "Forbidden"); return; }
    feeds.accept(req, socket, head);
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", contentSecurityPolicy);
    try {
      const origin = requestOrigin(req);
      if (origin === null) throw new RequestError(421, "Unexpected host.");
      const url = new URL(req.url ?? "/", origin);
      // A typed or bookmarked http://127.0.0.1:<port>/ opens the chat. The browser sends Sec-Fetch-Site: none only for
      // navigations the person started, so a link or script on another site still gets 404 and never learns the path.
      if (origin === `http://${host}` && url.pathname === "/" && req.method === "GET" && req.headers["sec-fetch-site"] === "none" &&
        req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document") {
        res.writeHead(302, { Location: base }); res.end(); return;
      }
      if (url.origin !== origin || !url.pathname.startsWith(base)) throw new RequestError(404, "Not found.");
      // The diagram frame is sandboxed with an opaque origin, so its own script request arrives cross-site. Both are static.
      const frameRoute = url.pathname.slice(base.length);
      if (req.method === "GET" && frameRoute === "render" && req.headers["sec-fetch-dest"] === "iframe") {
        res.removeHeader("X-Frame-Options");
        res.setHeader("Content-Security-Policy", renderPolicy(origin, base));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(renderPage); return;
      }
      if (req.method === "GET" && frameRoute === "render.js" && req.headers["sec-fetch-dest"] === "script") { serveAsset(req, res, await buildRenderBundle()); return; }
      const shellNavigation = req.method === "GET" && url.pathname === base &&
        req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document";
      if ((req.headers["sec-fetch-site"] === "cross-site" && !shellNavigation) ||
        (req.headers.origin !== undefined && req.headers.origin !== origin)) {
        throw new RequestError(403, "Cross-origin requests are blocked.");
      }
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
        if (!route.startsWith("api/")) {
          const built = await bundle;
          if (route === "") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(renderShell(csrfToken, built.version)); return; }
          if (route === "app.js") { serveAsset(req, res, built.js); return; }
          if (route === "app.css") { serveAsset(req, res, built.css); return; }
          const appFile = built.app?.(route);
          if (appFile) { serveAsset(req, res, appFile); return; }
        }
        if (route === "api/sessions/stream") {
          const stream = openStream(req, res);
          sendBuild(version => stream.send("build", { version }));
          const unsubscribe = backend.catalog.subscribe(event => stream.send("sessions", event));
          res.once("close", unsubscribe);
          return;
        }
        if (route === "api/labels") { json(res, 200, await backend.labels.snapshot()); return; }
        if (route === "api/interrupted") { json(res, 200, await interruptedRuns.check()); return; }
        const usage = /^api\/threads\/([^/]+)\/child-usage$/.exec(route);
        if (usage) { json(res, 200, { children: backend.catalog.childUsage(threadId(decodeURIComponent(usage[1]!))) }); return; }
        if (route === "api/workspaces") { json(res, 200, { workspaces: await backend.catalog.workspaces() }); return; }
        if (route === "api/models") {
          const id = url.searchParams.get("id");
          json(res, 200, await backend.threads.models(id ? threadId(id) : null)); return;
        }
        if (route === "api/commands") { json(res, 200, { commands: await backend.threads.commands(null) }); return; }
        if (route === "api/defaults") { json(res, 200, backend.defaults.read()); return; }
        if (route === "api/remote") { json(res, 200, remote.view(origin === `http://${host}`)); return; }
        if (route === "api/slack") { json(res, 200, slack ? slack.view(origin === `http://${host}`) : null); return; }
        if (route === "api/sdk") { json(res, 200, sdk ? await sdk.view() : null); return; }
        if (route.startsWith("api/usage/")) {
          const analytics = backend.usage;
          if (!analytics) throw new RequestError(503, "Usage analytics is off in this chat.");
          const query = url.searchParams;
          if (route === "api/usage/summary") { json(res, 200, await analytics.summary()); return; }
          if (route === "api/usage/series") { json(res, 200, await analytics.series(parseWindow(query.get("window")), parseBucket(query.get("bucket")), parseGroup(query.get("group")), parseMetric(query.get("metric")))); return; }
          if (route === "api/usage/models") { json(res, 200, await analytics.models(parseWindow(query.get("window")))); return; }
        }
        if (route === "api/accounts/login/stream") {
          const stream = openStream(req, res);
          const unsubscribe = logins.subscribe(login => stream.send("login", login));
          res.once("close", unsubscribe);
          return;
        }
        if (route === "api/accounts") {
          const id = url.searchParams.get("id");
          const model = url.searchParams.get("model");
          json(res, 200, await listAccounts(id ? threadId(id) : null, model ? text(model, "model", 256) : null)); return;
        }
        if (route === "api/local-image") {
          let image: Awaited<ReturnType<typeof readLocalImage>>;
          try { image = await readLocalImage(url.searchParams.get("path") ?? ""); }
          catch (error) { throw error instanceof LocalFileError ? new RequestError(error.status, error.message) : error; }
          // An SVG opened on its own is a document; the sandbox keeps any script in it from running as this page.
          if (image.mimeType === "image/svg+xml") res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
          res.writeHead(200, { "Content-Type": image.mimeType, "Content-Length": image.bytes.length });
          res.end(image.bytes);
          return;
        }
        if (route === "api/local-file") {
          // A `file:` artifact link on the board: read-only text under the chat's allowed folders (readLocalText).
          try { json(res, 200, await readLocalText(url.searchParams.get("path") ?? "")); }
          catch (error) { throw error instanceof LocalFileError ? new RequestError(error.status, error.message) : error; }
          return;
        }
        if (route === "api/wiki-page") {
          // A `wiki:` artifact link or a report's linked page: its HTML or markdown through the llm-wiki dev server, so a phone on the tailnet can read it too.
          try { json(res, 200, await wikiPage(url.searchParams.get("path") ?? "")); }
          catch (error) { throw error instanceof LocalFileError ? new RequestError(error.status, error.message) : error; }
          return;
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
          if (action === "note") { json(res, 200, await backend.notes.get(id)); return; }
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
          if (action === "check-in") {
            const view = await backend.chats.checkInView(id);
            if (!view) throw new RequestError(404, "This thread is not a chat.");
            json(res, 200, view); return;
          }
          if (action === "duties") {
            if (!backend.duties || !(await backend.chats.ids()).has(id)) throw new RequestError(404, "This thread is not a chat.");
            json(res, 200, { duties: await backend.duties.view(id) }); return;
          }
          if (action === "agents") {
            // The chat's agents as its row carries them; the chat_board tool reads this for its "Agents:" lines.
            if (!(await backend.chats.ids()).has(id)) throw new RequestError(404, "This thread is not a chat.");
            await backend.catalog.summary(id);
            const row = (await backend.catalog.rows()).find(candidate => candidate.id === id);
            json(res, 200, { agents: row?.agents ?? [] }); return;
          }
        }
        throw new RequestError(404, "Not found.");
      }
      if (method !== "POST") throw new RequestError(405, "Expected POST.");
      if (req.headers["x-chat-token"] !== csrfToken || req.headers.origin !== origin) throw new RequestError(403, "Write authorization is missing. Reopen the chat URL.");
      const body = record(await jsonBody(req));
      if (route === "api/threads") {
        const id = requestId(body.requestId);
        const cwd = await resolveWorkspace(text(body.cwd, "cwd", 1024));
        const message = text(body.message, "message");
        const images = parseImages(body.images);
        if (!message.trim() && !images.length) throw new RequestError(400, "Add a message or image.");
        const provider = typeof body.provider === "string" ? text(body.provider, "provider", 128) : undefined;
        const modelId = typeof body.modelId === "string" ? text(body.modelId, "modelId", 256) : undefined;
        const thinkingLevel = typeof body.thinkingLevel === "string" ? text(body.thinkingLevel, "thinkingLevel", 16) as ThinkingLevel : undefined;
        const account = parseNewChatAccount(body.account);
        const name = typeof body.name === "string" ? text(body.name, "name", 200).trim() : "";
        const kind = parseKind(body.kind);
        if (body.slack !== undefined && typeof body.slack !== "boolean") throw new RequestError(400, "slack must be true or false.");
        const syncSlack = body.slack === true && kind === "chat";
        const fingerprint = createHash("sha256").update(JSON.stringify([cwd, provider, modelId, thinkingLevel, message, images, account, name, kind, syncSlack])).digest("hex");
        let creation = creations.get(id);
        if (creation && creation.fingerprint !== fingerprint) throw new RequestError(409, "This request ID belongs to another new chat.");
        if (!creation) {
          creation = { fingerprint, result: (async () => {
            const input = { cwd, ...(provider ? { provider } : {}), ...(modelId ? { modelId } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) };
            // A chat is created with its name (a job replies to it by name), pinned and set to steering mode all; the server tick does its check-ins.
            const thread = kind === "chat" ? await backend.chats.create({ ...input, ...(name ? { name } : {}) }) : await backend.threads.create(input);
            // Both kinds go in threads.json: a thread this server created is the person's (origin "user"), whatever its session file says.
            await backend.created.add(thread.id).catch(() => {});
            if (account) {
              // The account is set on the new session before the prompt, so its first model request already uses it. A failed use sends nothing.
              try { await runAccountAction({ action: "use", provider: account.provider, account: account.id, id: thread.id, force: account.force, newSession: true }); }
              catch (error) {
                await backend.threads.archive(thread.id).catch(() => {});
                if (kind === "chat") await backend.chats.forget(thread.id).catch(() => {});
                throw new RequestError(502, error instanceof Error ? error.message : String(error));
              }
            }
            // The name is set before the prompt, so the thread never shows the first message as its title. A failed rename still sends the message.
            if (name && kind !== "chat") await backend.threads.rename(thread.id, name).catch(() => {});
            // Every send to a chat is a steer, so the owner's text lands after the current tool batch and the queue stays invisible.
            await backend.threads.prompt(thread.id, { message, images, mode: kind === "chat" ? "steer" : "followUp" });
            // The chat exists either way; a Slack refusal comes back as a notice and the header switch can try again.
            if (syncSlack) {
              const failure = !slack ? "This chat instance runs no Slack bridge." : await slack.setChat(thread.id, true).then(() => null, (error: unknown) => error instanceof Error ? error.message : String(error));
              if (failure) return { id: thread.id, notice: `Not synced to Slack: ${failure}` };
            }
            return { id: thread.id };
          })() };
          creations.set(id, creation);
        }
        json(res, 200, await creation.result); return;
      }
      if (route === "api/workspaces/resolve") { json(res, 200, { cwd: await resolveWorkspace(text(body.path, "path", 1024)) }); return; }
      if (route === "api/workspaces/choose") {
        if (origin !== `http://${host}`) throw new RequestError(409, "The folder dialog opens only on the Mac running the chat. Type the path instead.");
        const start = typeof body.start === "string" ? await resolveWorkspace(body.start).catch(() => null) : null;
        json(res, 200, { cwd: await chooseFolder(start) }); return;
      }
      if (route === "api/labels") {
        const result = await backend.labels.apply(parseLabelAction(body));
        await backend.catalog.notify();
        json(res, 200, { ok: true, ...result }); return;
      }
      if (route === "api/defaults") {
        await backend.defaults.write(parseDefaults(body, await backend.threads.models(null)));
        json(res, 200, backend.defaults.read()); return;
      }
      if (route === "api/remote") {
        // A leaked link must not be able to widen or cut network access, so the switches change only on the Mac itself.
        if (origin !== `http://${host}`) throw new RequestError(403, "Change phone access on the Mac that runs the chat.");
        await remote.set(parseRemoteInput(body));
        json(res, 200, remote.view(true)); return;
      }
      if (route === "api/sdk") {
        if (!sdk) throw new RequestError(409, "This chat instance does not manage its prime-agent packages.");
        if (body.action === "update") await sdk.start().catch(error => { throw new RequestError(409, error instanceof Error ? error.message : String(error)); });
        else if (body.action === "auto" && typeof body.auto === "boolean") await sdk.setAuto(body.auto);
        else throw new RequestError(400, "Use action update, or action auto with auto true or false.");
        json(res, 200, await sdk.view()); return;
      }
      if (route === "api/chats/update") {
        // Settings > Chats: every chat reloads onto the current brief, an idle one now, a busy one when its turn ends; the rows show the progress.
        json(res, 200, { chats: await backend.chats.updateAll() }); return;
      }
      if (route === "api/interrupted") {
        json(res, 200, await interruptedRuns.resume(async sessionId => {
          await backend.threads.abort(sessionId);
          // A native abort holds the session's input until the next human prompt; reopen it so its head's message gets through.
          await backend.threads.resumeQueue(sessionId).catch(() => {});
        }));
        return;
      }
      if (route === "api/slack" || route === "api/slack/check") {
        // Like phone access: a leaked link must not be able to connect this Mac's agents to Slack or cut them off.
        if (!slack) throw new RequestError(409, "This chat instance runs no Slack bridge.");
        if (origin !== `http://${host}`) throw new RequestError(403, "Change Slack on the Mac that runs the chat.");
        if (route === "api/slack") await slack.set(parseSlackInput(body)).catch(error => { throw new RequestError(400, error instanceof Error ? error.message : String(error)); });
        else await slack.check();
        json(res, 200, slack.view(true)); return;
      }
      if (route === "api/remote/check") { await remote.check(); json(res, 200, remote.view(origin === `http://${host}`)); return; }
      if (route === "api/warm") { await backend.threads.warm(threadId(text(body.id, "id", 256))); json(res, 200, { ok: true }); return; }
      if (route === "api/accounts") {
        const action = parseAccountAction(body);
        const notice = await runAccountAction(action);
        // A thread moved to another account goes again now if its turn failed or waits on a provider retry.
        if ((action.action === "use" || action.action === "follow") && action.id) await backend.chats.retryNow(action.id);
        json(res, 200, { ...await listAccounts("id" in action ? action.id : null), ...(notice ? { notice } : {}) }); return;
      }
      if (route === "api/accounts/login") {
        const account = body.account === undefined || body.account === null ? null : text(body.account, "account", 256);
        json(res, 200, logins.start(text(body.provider, "provider", 64), account)); return;
      }
      if (route === "api/accounts/refresh") {
        const account = body.account === undefined || body.account === null ? null : text(body.account, "account", 256);
        json(res, 200, refreshes.start(text(body.provider, "provider", 64), account)); return;
      }
      if (route === "api/accounts/login/paste") { json(res, 200, logins.paste(text(body.id, "id", 64), text(body.code, "code", 4096))); return; }
      if (route === "api/accounts/login/cancel") { json(res, 200, logins.cancel(text(body.id, "id", 64))); return; }
      const thread = /^api\/threads\/([^/]+)\/([a-z-]+)$/.exec(route);
      if (!thread) throw new RequestError(404, "Not found.");
      const id = threadId(decodeURIComponent(thread[1]!));
      switch (thread[2]) {
        case "prompt": {
          const rid = requestId(body.requestId);
          const message = text(body.message, "message");
          const images = parseImages(body.images);
          const mode = (await backend.chats.ids()).has(id) ? "steer" : parseMode(body.mode);
          if (!message.trim() && !images.length) throw new RequestError(400, "Add a message or image.");
          const fingerprint = createHash("sha256").update(JSON.stringify([id, message, images, mode])).digest("hex");
          let pending = sends.get(rid);
          if (pending && pending.fingerprint !== fingerprint) throw new RequestError(409, "This request ID belongs to a different message.");
          if (!pending) { pending = { fingerprint, result: backend.threads.prompt(id, { message, images, mode }) }; sends.set(rid, pending); }
          await pending.result;
          json(res, 200, { accepted: true }); return;
        }
        case "abort": {
          const chat = (await backend.chats.ids()).has(id);
          await backend.threads.abort(id);
          if (chat) await backend.threads.resumeQueue(id);
          break;
        }
        case "archive":
          await backend.threads.archive(id);
          if ((await backend.chats.ids()).has(id)) {
            await backend.chats.forget(id);
            // The Slack bridge watches the catalog: this update archives a synced chat's channel without waiting for its minute sync.
            await backend.catalog.notify();
          }
          break;
        case "unarchive":
          // Undo keeps a chat a chat: its session file still carries the chat_mode entry, so it goes back into the index, pinned, with its check-in.
          await backend.threads.unarchive(id);
          if (await backend.chats.restore(id)) await backend.catalog.notify();
          break;
        case "slack": {
          // A chat's own sync switch, like archive: any page with the write token may flip it. Connecting the workspace stays Mac-only (api/slack).
          if (!slack) throw new RequestError(409, "This chat instance runs no Slack bridge.");
          if (!(await backend.chats.ids()).has(id)) throw new RequestError(404, "This thread is not a chat.");
          if (typeof body.on !== "boolean") throw new RequestError(400, "on must be true or false.");
          if (slack.view(false).state !== "on") throw new RequestError(409, "Slack is not connected. Connect it in Settings > Slack.");
          await slack.setChat(id, body.on);
          json(res, 200, slack.view(origin === `http://${host}`)); return;
        }
        case "note": json(res, 200, await backend.notes.set(id, text(body.text, "note", NOTE_MAX))); return;
        case "board": {
          // The owner's side of the chat board: todo and scratchpad ops. The chat then gets a steer that says in plain words what the owner did.
          if (!(await backend.chats.ids()).has(id)) throw new RequestError(404, "This thread is not a chat.");
          let applied: Awaited<ReturnType<typeof backend.boards.apply>>;
          try {
            const ops = parseBoardOps(body.ops);
            if (!ops.length) throw new RequestError(400, "Add a board op.");
            applied = await backend.boards.apply(id, ops, "owner");
          } catch (error) {
            if (error instanceof BoardError) throw new RequestError(error.kind === "forbidden" ? 403 : error.kind === "unknown" ? 409 : 400, error.message);
            throw error;
          }
          const board = applied.board!;
          backend.threads.setBoard(id, board);
          let sent = true;
          let error: string | undefined;
          try { await backend.threads.prompt(id, { message: BOARD_PREFIX + applied.summaries.join("; "), images: [], mode: "steer" }); }
          catch (failure) { sent = false; error = failure instanceof Error ? failure.message : String(failure); }
          json(res, 200, { board, sent, ...(error ? { error } : {}) }); return;
        }
        case "duties": {
          // The owner's Run now, Pause and Resume on the Duties card; the reply is the chat's duties after the change.
          if (!backend.duties || !(await backend.chats.ids()).has(id)) throw new RequestError(404, "This thread is not a chat.");
          const duty = text(body.duty, "duty", 16);
          const action = body.action;
          if (action !== "run" && action !== "pause" && action !== "resume") throw new RequestError(400, "Choose run, pause or resume.");
          const found = action === "run" ? await backend.duties.runNow(id, duty) || (await backend.duties.view(id)).some(view => view.duty.id === duty)
            : await backend.duties.setStatus(id, duty, action === "pause" ? "paused" : "active");
          if (!found) throw new RequestError(404, "This chat has no such duty.");
          json(res, 200, { duties: await backend.duties.view(id) }); return;
        }
        case "check-in": {
          // The owner's interval and pause for the chat's check-in; the chat reads it on the board tool and has no op to change it.
          const view = await backend.chats.setCheckIn(id, parseCheckInChange(body));
          if (!view) throw new RequestError(404, "This thread is not a chat.");
          await backend.catalog.notify();
          json(res, 200, view); return;
        }
        case "rename": {
          const name = text(body.name, "name", 200).trim();
          if (!name) throw new RequestError(400, "Use a name of 1 to 200 characters.");
          await backend.threads.rename(id, name); break;
        }
        case "model":
          // A turn that failed or waits on a provider retry goes again now on the new model, so the next send is not stuck behind it.
          await backend.threads.setModel(id, text(body.provider, "provider", 128), text(body.modelId, "modelId", 256));
          await backend.chats.retryNow(id);
          break;
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
      const status = error instanceof RequestError || error instanceof ThreadError || error instanceof LabelError || error instanceof PoolError || error instanceof UsageError ? error.status : error instanceof WorkspaceError ? 400 : 502;
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
