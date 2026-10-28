/**
 * The HTTP side: every endpoint under /api (apps/chat/API.md), the live socket at /api/live, and the built web client for any other path.
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { ChannelInput, ConversationPatch, SendRequest } from "../web/src/lib/api/types.ts";
import { App, MODELS, NotFound } from "./app.ts";
import { LocalImageError, readLocalImage } from "./local-image.ts";
import { readJson } from "./store.ts";
import { usageReport, readPool, hostsReport } from "./usage.ts";

type Params = Record<string, string>;
type Handler = (req: IncomingMessage, params: Params, query: URLSearchParams, body: () => Promise<unknown>) => Promise<unknown>;
type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler };

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".json": "application/json", ".woff2": "font/woff2", ".ico": "image/x-icon",
};
const MAX_BODY = 40 * 1024 * 1024;

export class BadRequest extends Error {}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, key: string) => {
    keys.push(key);
    return "([^/]+)";
  })}$`);
  return { method, pattern, keys, handler };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BadRequest("The request body is over 40 MB.");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequest("The request body is not JSON.");
  }
}

const num = (value: string | null): number | undefined => (value === null || value === "" ? undefined : Number(value));

export function routes(app: App): Route[] {
  const str = (value: string | null): string | undefined => (value === null || value === "" ? undefined : value);
  return [
    route("GET", "/api/ready", async () => ({ ready: true })),
    route("GET", "/api/me", async () => app.me()),
    route("GET", "/api/sidebar", async () => app.sidebar()),
    route("GET", "/api/conversations", async (_r, _p, q) => app.threads.conversations().filter(c => q.get("archived") === "1" || !c.archived)),
    route("GET", "/api/directory", async () => ({ agents: app.threads.agents(), channels: app.channels.list() })),
    route("GET", "/api/models", async () => MODELS),
    route("GET", "/api/agents", async (_r, _p, q) => app.threads.agents({ archived: q.get("archived") === "1" })),
    route("POST", "/api/agents", async (_r, _p, _q, body) => app.createAgent((await body()) as Parameters<App["createAgent"]>[0])),
    route("GET", "/api/c/:id", async (_r, p) => app.header(p.id!)),
    route("PATCH", "/api/c/:id", async (_r, p, _q, body) => app.patch(p.id!, (await body()) as ConversationPatch)),
    route("GET", "/api/c/:id/items", async (_r, p, q) => {
      const opts = { before: str(q.get("before")), after: str(q.get("after")), around: str(q.get("around")), limit: num(q.get("limit")) };
      return app.isChannel(p.id!) ? app.channels.timeline(p.id!, opts) : app.threads.timeline(p.id!, opts);
    }),
    route("GET", "/api/c/:id/replies/:root", async (_r, p) => app.channels.replies(p.id!, p.root!)),
    route("POST", "/api/c/:id/send", async (_r, p, _q, body) => app.send(p.id!, (await body()) as SendRequest)),
    route("POST", "/api/c/:id/abort", async (_r, p) => {
      await app.abort(p.id!);
      return { ok: true };
    }),
    route("POST", "/api/c/:id/read", async (_r, p, _q, body) => {
      app.markRead(p.id!, ((await body()) as { seq?: number }).seq);
      return { ok: true };
    }),
    route("GET", "/api/threads/:id/jobs", async (_r, p) => app.threads.jobs(p.id!)),
    route("GET", "/api/channels", async () => app.channels.list()),
    route("POST", "/api/channels", async (_r, _p, _q, body) => app.channels.create((await body()) as ChannelInput)),
    route("PATCH", "/api/channels/:id", async (_r, p, _q, body) => app.channels.update(p.id!, (await body()) as { name?: string; purpose?: string; archived?: boolean })),
    route("POST", "/api/channels/:id/members", async (_r, p, _q, body) => {
      const input = (await body()) as { agents: string[]; wakeOn?: "mention" | "all" | "none" };
      return app.channels.addMembers(p.id!, input.agents ?? [], input.wakeOn);
    }),
    route("DELETE", "/api/channels/:id/members/:agent", async (_r, p) => app.channels.removeMember(p.id!, p.agent!)),
    route("POST", "/api/dms", async (_r, _p, _q, body) => app.openDm(((await body()) as { agent: string }).agent)),
    route("GET", "/api/search", async (_r, _p, q) => app.search.run({
      q: q.get("q") ?? "", from: str(q.get("from")), in: str(q.get("in")), after: str(q.get("after")), before: str(q.get("before")),
      sort: q.get("sort") === "recent" ? "recent" : "relevance", limit: num(q.get("limit")), cursor: str(q.get("cursor")),
    })),
    route("GET", "/api/threads/:id/board", async (_r, p) => app.boards.view(p.id!)),
    route("POST", "/api/threads/:id/board", async (_r, p, _q, body) => {
      const input = (await body()) as { ops: unknown; actor?: string };
      // A refused op (a bad shape, or an agent answering a todo) is the caller's error.
      return app.boards.apply(p.id!, input.ops, input.actor === "agent" ? "agent" : "owner").catch(error => {
        throw new BadRequest(error instanceof Error ? error.message : String(error));
      });
    }),
    route("POST", "/api/threads/:id/import-prime", async (_r, p, _q, body) =>
      app.boards.importPrime(p.id!, String(((await body()) as { prime?: string }).prime ?? ""), app.config.sharedDir)),
    route("GET", "/api/threads/:id/agents", async (_r, p) => ({ agents: app.boards.chatAgents(p.id!) })),
    route("GET", "/api/threads/:id/duties", async (_r, p) => ({ duties: app.boards.duties(p.id!) })),
    route("POST", "/api/threads/:id/duties", async (_r, p, _q, body) => ({ duties: await app.boards.dutyAction(p.id!, (await body()) as never) })),
    route("GET", "/api/threads/:id/check-in", async (_r, p) => app.boards.checkIn(p.id!)),
    route("POST", "/api/threads/:id/check-in", async (_r, p, _q, body) => app.boards.setCheckIn(p.id!, (await body()) as never)),
    route("GET", "/api/for-you", async () => ({ items: await app.boards.forYou() })),
    route("GET", "/api/boards", async () => app.boards.index()),
    route("GET", "/api/usage", async (_r, _p, q) => usageReport(app.host, app.threads, app.config.box, { days: num(q.get("days")) ?? 7, thread: str(q.get("thread")), host: str(q.get("host")) })),
    route("GET", "/api/pool", async () => (app.config.fixture ? fixturePool() : readPool())),
    route("GET", "/api/hosts", async () => hostsReport(app.host, app.threads, app.config.box, app.config.socket)),
    route("GET", "/api/corrections", async () => readJson(join(app.config.sharedDir, "corrections.json"), { corrections: [] })),
  ];
}

function fixturePool() {
  const window = (label: string, pct: number, kind: "session" | "weekly") => ({ kind, label, pct, resetsAt: Date.now() + 3 * 3600_000 });
  const row = (n: number, session: number, weekly: number, usable: boolean, reason: string | null) => ({
    id: `acct-${n}`, email: `claude${n}@example.test`, label: `claude${n}@example.test`, usage: `${session}%/${weekly}%`, session_pct: session, weekly_pct: weekly, usable, reason,
    current: n === 1, pinned: false, score: usable ? 100 - session : null, tier: "max 20x", windows: [window("5h", session, "session"), window("week", weekly, "weekly")],
    usageAt: Date.now() - 60_000, cooldownUntil: reason === "cooldown" ? Date.now() + 900_000 : null, cooldownReason: reason, limitedUntil: null, disabled: false, sessions: usable ? 3 : 0,
  });
  return {
    sessionId: null, checkedAt: new Date().toISOString(), poolConfig: { working_max: 20, tree_working_max: 60, admit_5h_max_pct: 100, seven_day_max_pct: 98 },
    providers: [
      { provider: "anthropic", rows: [row(1, 42, 61, true, null), row(2, 88, 70, true, null), row(3, 100, 99, false, "cooldown")], resolution: null },
      { provider: "openai-codex", rows: [row(4, 10, 20, true, null)], resolution: null },
    ],
  };
}

export function serve(app: App): Server {
  const table = routes(app);
  const server = createServer((req, res) => void handle(app, table, req, res));
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/api/live") {
      socket.destroy();
      return;
    }
    app.wss.handleUpgrade(req, socket, head, ws => app.wss.emit("connection", ws, req));
  });
  return server;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

async function handle(app: App, table: Route[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  try {
    if (path.startsWith("/api/images/")) return await serveEntryImage(app, path, res);
    if (path.startsWith("/api/uploads/")) return serveFile(res, app.store.imagePath(path.slice("/api/uploads/".length).replace(/[^\w.-]/g, "")), true);
    if (path === "/api/local-image" && req.method === "GET") return await serveLocalImage(url.searchParams.get("path") ?? "", res);
    if (path.startsWith("/api/")) {
      for (const r of table) {
        if (r.method !== req.method) continue;
        const match = r.pattern.exec(path);
        if (!match) continue;
        const params: Params = {};
        r.keys.forEach((key, i) => (params[key] = decodeURIComponent(match[i + 1]!)));
        let parsed: Promise<unknown> | undefined;
        const value = await r.handler(req, params, url.searchParams, () => (parsed ??= readBody(req)));
        return json(res, 200, value ?? { ok: true });
      }
      return json(res, 404, { error: `No endpoint ${req.method} ${path}.` });
    }
    return serveWeb(app, path, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof NotFound ? 404 : error instanceof BadRequest || /^(No |A |An |Dates|around|after|.* is not in #)/.test(message) ? 400 : 500;
    if (status === 500) app.log(`${req.method} ${path} failed: ${error instanceof Error ? error.stack : message}`);
    if (!res.headersSent) json(res, status, { error: message });
    else res.end();
  }
}

async function serveEntryImage(app: App, path: string, res: ServerResponse): Promise<void> {
  const [, , , thread, entry, index] = path.split("/");
  const got = await app.host.entries(decodeURIComponent(thread!), { before: Number(entry) + 1, limit: 1, conversation: undefined as never });
  let found = got.entries.find(e => e.id === Number(entry));
  if (!found) {
    for (const node of app.threads.tree(decodeURIComponent(thread!))) {
      const child = await app.host.entries(decodeURIComponent(thread!), { conversation: node.id, before: Number(entry) + 1, limit: 1 });
      found = child.entries.find(e => e.id === Number(entry));
      if (found) break;
    }
  }
  const content = found?.model?.[0]?.content;
  const block = Array.isArray(content) ? content[Number(index)] : undefined;
  if (!block || block.type !== "image") throw new NotFound("No such image.");
  res.writeHead(200, { "content-type": block.mimeType, "cache-control": "private, max-age=31536000, immutable" });
  res.end(Buffer.from(block.data, "base64"));
}

/** An image file an agent linked by its path on this box (local-image.ts). */
async function serveLocalImage(path: string, res: ServerResponse): Promise<void> {
  let image: Awaited<ReturnType<typeof readLocalImage>>;
  try {
    image = await readLocalImage(path);
  } catch (error) {
    if (error instanceof LocalImageError) return json(res, error.status, { error: error.message });
    throw error;
  }
  // An SVG opened on its own is a document; the sandbox keeps any script in it from running as this page.
  if (image.mimeType === "image/svg+xml") res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  res.writeHead(200, { "content-type": image.mimeType, "content-length": image.bytes.length, "cache-control": "private, max-age=60", "x-content-type-options": "nosniff" });
  res.end(image.bytes);
}

function serveFile(res: ServerResponse, file: string, immutable = false): void {
  if (!existsSync(file) || !statSync(file).isFile()) throw new NotFound("Not found.");
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": immutable ? "private, max-age=31536000, immutable" : "no-cache" });
  createReadStream(file).pipe(res);
}

function serveWeb(app: App, path: string, res: ServerResponse): void {
  const root = app.config.webDir;
  const file = normalize(join(root, path));
  if (file.startsWith(root) && existsSync(file) && statSync(file).isFile()) return serveFile(res, file, path.startsWith("/assets/"));
  const index = join(root, "index.html");
  if (existsSync(index)) {
    res.writeHead(200, { "content-type": TYPES[".html"]!, "cache-control": "no-cache" });
    res.end(readFileSync(index));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("apps/chat server is running. Build the web client with `npm run build` in apps/chat/web.\n");
}
