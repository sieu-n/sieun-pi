/**
 * The HTTP side: every endpoint under /api (apps/chat/API.md), the live socket at /api/live, the wiki under /wiki (server/wiki), and the built
 * web client for any other path.
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { ConversationPatch, DutyAction, MemoryInput, RoomInput, RoomPatch, SendRequest } from "../web/src/lib/api/types.ts";
import { parseSchedule } from "../web/src/lib/api/shared/chat-duties.ts";
import { agentConfig, agentRecordOf } from "./agent-config.ts";
import { EntryExists, EntryMissing, HARNESS_KINDS, type HarnessKind } from "./agent-folder.ts";
import { parseItemId } from "./for-me.ts";
import type { AgentRecord, WakeOn } from "./agent-store.ts";
import { App, MODELS, NotFound } from "./app.ts";
import { LocalImageError, readLocalImage } from "./local-image.ts";
import { ReactionError } from "./reactions.ts";
import { CwdRefused } from "./projects.ts";
import { isHostAway } from "./host/types.ts";
import { readJson } from "./store.ts";
import { usageReport, hostsReport } from "./usage.ts";
import { type ClientVia, clientTimings, RequestLog } from "./request-log.ts";
import { accountRoutes, PoolError } from "./accounts.ts";
import { serveWiki } from "./wiki/routes.ts";

type Params = Record<string, string>;
type Handler = (req: IncomingMessage, params: Params, query: URLSearchParams, body: () => Promise<unknown>) => Promise<unknown>;
type Route = { method: string; path: string; pattern: RegExp; keys: string[]; handler: Handler };

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
  return { method, path, pattern, keys, handler };
}

/** The route pattern a request's path matches, such as `/api/c/:id/items`, for the request log. */
function routeLabel(table: Route[], method: string, path: string): string {
  const found = table.find(r => r.method === method && r.pattern.test(path));
  if (found) return found.path;
  const prefix = ["/api/images/", "/api/uploads/"].find(start => path.startsWith(start));
  return prefix ? `${prefix}*` : path === "/api/local-image" ? path : "unmatched";
}

async function readBytes(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BadRequest("The request body is over 40 MB.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const bytes = await readBytes(req);
  if (!bytes.length) return {};
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new BadRequest("The request body is not JSON.");
  }
}

const num = (value: string | null): number | undefined => (value === null || value === "" ? undefined : Number(value));

/** A memory write's body: a title and content that are not blank, and an optional path, as Prime's harness requires. */
function memoryInput(body: unknown): MemoryInput {
  const { title, content, path } = (body ?? {}) as Record<string, unknown>;
  if (typeof title !== "string" || !title.trim()) throw new BadRequest("A memory needs a title, a string that is not blank.");
  if (typeof content !== "string" || !content.trim()) throw new BadRequest("A memory needs content, a string that is not blank.");
  if (path !== undefined && (typeof path !== "string" || !path.trim())) throw new BadRequest("A memory's path is a string that is not blank when given.");
  return { title, content, ...(path === undefined ? {} : { path }) };
}

/** A duties POST body: `set` with a duty definition, which upsertDuty checks, or another action with the duty's id. */
function dutyAction(body: unknown): DutyAction {
  const { action, duty, schedule } = (body ?? {}) as Record<string, unknown>;
  if (action === "set") {
    if (typeof duty !== "object" || duty === null) throw new BadRequest("A set takes the duty definition as duty.");
    return { action, duty };
  }
  if (typeof duty !== "string" || !duty) throw new BadRequest("A duty action names the duty's id as duty.");
  if (action === "run" || action === "pause" || action === "resume" || action === "remove") return { action, duty };
  if (action === "schedule") {
    try { return { action, duty, schedule: parseSchedule(schedule) }; } catch (error) { throw new BadRequest(error instanceof Error ? error.message : String(error)); }
  }
  throw new BadRequest("A duty action is set, run, pause, resume, schedule or remove.");
}

/** `?kind=` of a harness entry, memory when absent. */
function harnessKind(query: URLSearchParams): HarnessKind {
  const kind = query.get("kind") ?? "memory";
  if (!(HARNESS_KINDS as readonly string[]).includes(kind)) throw new BadRequest(`An entry's kind is one of ${HARNESS_KINDS.join(", ")}.`);
  return kind as HarnessKind;
}

export function routes(app: App): Route[] {
  const str = (value: string | null): string | undefined => (value === null || value === "" ? undefined : value);
  const folderAgent = (id: string): AgentRecord => {
    const agent = agentRecordOf(app, id);
    if (!agent) throw new NotFound(`No agent ${id}.`);
    return agent;
  };
  return [
    route("GET", "/api/ready", async () => ({ ready: true })),
    route("GET", "/api/me", async () => app.me()),
    route("GET", "/api/sidebar", async () => app.sidebar()),
    route("GET", "/api/conversations", async (_r, _p, q) => app.threads.conversations().filter(c => q.get("archived") === "1" || !c.archived)),
    route("GET", "/api/directory", async () => ({ agents: app.threads.agents(), jobs: app.threads.jobList(), rooms: app.groups.list() })),
    route("GET", "/api/models", async () => MODELS),
    route("GET", "/api/agents", async (_r, _p, q) => app.threads.agents({ archived: q.get("archived") === "1", test: q.get("test") === "1" })),
    route("GET", "/api/jobs", async (_r, _p, q) => app.threads.jobList({ archived: q.get("archived") === "1" })),
    route("GET", "/api/agents/:id/config", async (_r, p) => agentConfig(app, p.id!)),
    route("GET", "/api/agents/:id/for-me", async (_r, p, q) => {
      const status = q.get("status") ?? "pending";
      if (status !== "pending" && status !== "completed" && status !== "all") throw new BadRequest("A For list's status is pending, completed or all.");
      return app.forMeList(p.id!, status);
    }),
    route("POST", "/api/agents/:id/for-me", async (_r, p, _q, body) => {
      const { messageId, completed } = ((await body()) ?? {}) as { messageId?: unknown; completed?: unknown };
      const item = parseItemId(messageId);
      if (!item) throw new BadRequest(`${JSON.stringify(messageId ?? "")} is no For item id; pass messageId as <room id>/<post id>, such as dm_vent/p41 or ch_1a2b3c4d/p12.`);
      if (typeof completed !== "boolean") throw new BadRequest("A mark's completed is true to mark the item completed or false to make it pending again.");
      return app.markForMe(p.id!, `${item.room}/${item.post}`, completed);
    }),
    route("GET", "/api/agents/:id/folder", async (_r, p) => app.folders.read(folderAgent(p.id!))),
    route("PUT", "/api/agents/:id/brief", async (_r, p, _q, body) => {
      const agent = folderAgent(p.id!);
      const { text } = ((await body()) ?? {}) as { text?: unknown };
      if (typeof text !== "string") throw new BadRequest("A brief needs text, a string; empty text deletes it.");
      await app.folders.writeBrief(agent, text);
      return app.folders.read(agent);
    }),
    route("POST", "/api/agents/:id/memory", async (_r, p, _q, body) => {
      const agent = folderAgent(p.id!);
      await app.folders.create(agent, "memory", memoryInput(await body()));
      return app.folders.read(agent);
    }),
    route("PUT", "/api/agents/:id/memory/:entry", async (_r, p, q, body) => {
      const agent = folderAgent(p.id!);
      await app.folders.update(agent, harnessKind(q), p.entry!, memoryInput(await body()));
      return app.folders.read(agent);
    }),
    route("DELETE", "/api/agents/:id/memory/:entry", async (_r, p, q) => {
      const agent = folderAgent(p.id!);
      await app.folders.delete(agent, harnessKind(q), p.entry!);
      return app.folders.read(agent);
    }),
    route("GET", "/api/agent-hosts", async () => app.agentHosts()),
    route("POST", "/api/agents", async (_r, _p, _q, body) => app.createAgent((await body()) as Parameters<App["createAgent"]>[0])),
    route("POST", "/api/agents/:id/split", async (_r, p, _q, body) => {
      const { apply } = ((await body()) ?? {}) as { apply?: unknown };
      if (apply !== undefined && typeof apply !== "boolean") throw new BadRequest("A split's apply is true or false when given.");
      return app.split(p.id!, apply === true);
    }),
    route("GET", "/api/projects", async () => app.projects()),
    route("GET", "/api/c/:id", async (_r, p) => app.header(p.id!)),
    route("PATCH", "/api/c/:id", async (_r, p, _q, body) => app.patch(p.id!, (await body()) as ConversationPatch)),
    route("GET", "/api/c/:id/items", async (_r, p, q) => {
      const opts = { before: str(q.get("before")), after: str(q.get("after")), around: str(q.get("around")), limit: num(q.get("limit")) };
      return app.items(p.id!, opts);
    }),
    route("GET", "/api/c/:id/output/:entry", async (_r, p) => {
      const entry = Number(p.entry);
      if (!Number.isSafeInteger(entry) || entry < 0) throw new BadRequest(`An output names a tool result entry id, a whole number, got ${p.entry}.`);
      const output = await app.threads.stepOutput(p.id!, entry);
      if (!output) throw new NotFound(`No tool result ${entry} in ${p.id}.`);
      return output;
    }),
    route("GET", "/api/c/:id/replies/:root", async (_r, p) => app.groups.replies(p.id!, p.root!)),
    route("POST", "/api/uploads", async req => app.upload(req.headers["content-type"] ?? "", await readBytes(req))),
    route("POST", "/api/c/:id/send", async (_r, p, _q, body) => app.send(p.id!, (await body()) as SendRequest)),
    route("POST", "/api/c/:id/send/:requestId/retry", async (_r, p) => app.retrySend(p.id!, p.requestId!)),
    route("DELETE", "/api/c/:id/send/:requestId", async (_r, p) => {
      app.discardSend(p.id!, p.requestId!);
      return { ok: true };
    }),
    route("PATCH", "/api/c/:id/posts/:post", async (_r, p, _q, body) => {
      const input = ((await body()) ?? {}) as { text?: unknown; testSend?: { by?: unknown; reason?: unknown } };
      if ("text" in input) {
        if (Object.keys(input).length > 1) throw new BadRequest("A post edit carries only text.");
        return app.editPost(p.id!, p.post!, input);
      }
      const { testSend, ...rest } = input;
      if (!testSend || typeof testSend !== "object" || Object.keys(rest).length) throw new BadRequest("A post patch carries only testSend: {by, reason}.");
      return app.markTestSend(p.id!, p.post!, testSend);
    }),
    route("DELETE", "/api/c/:id/posts/:post", async (_r, p) => app.deletePost(p.id!, p.post!)),
    route("GET", "/api/unfurl", async (_r, _p, q) => ({ preview: await app.unfurl.get(q.get("url") ?? "") })),
    route("POST", "/api/c/:id/posts/:post/reactions", async (_r, p, _q, body) => {
      return app.react(p.id!, p.post!, ((await body()) ?? {}) as { emoji?: unknown; on?: unknown });
    }),
    route("POST", "/api/threads/:id/reactions", async (_r, p, _q, body) => {
      return app.reactAsAgent(p.id!, ((await body()) ?? {}) as { message?: unknown; emoji?: unknown; on?: unknown });
    }),
    route("POST", "/api/c/:id/abort", async (_r, p) => {
      await app.abort(p.id!);
      return { ok: true };
    }),
    route("POST", "/api/c/:id/read", async (_r, p, _q, body) => {
      app.markRead(p.id!, ((await body()) as { seq?: number }).seq);
      return { ok: true };
    }),
    route("GET", "/api/threads/:id/jobs", async (_r, p) => app.threads.jobs(p.id!)),
    route("GET", "/api/rooms", async (_r, _p, q) => app.groups.list({ test: q.get("test") === "1" })),
    route("POST", "/api/rooms", async (_r, _p, _q, body) => app.groups.create((await body()) as RoomInput)),
    route("PATCH", "/api/rooms/:id", async (_r, p, _q, body) => app.groups.update(p.id!, ((await body()) ?? {}) as RoomPatch)),
    route("POST", "/api/rooms/:id/members", async (_r, p, _q, body) => {
      const input = ((await body()) ?? {}) as { agents?: string[]; wakeOn?: WakeOn };
      return app.groups.addMembers(p.id!, input.agents ?? [], input.wakeOn);
    }),
    route("DELETE", "/api/rooms/:id/members/:agent", async (_r, p) => app.groups.removeMember(p.id!, p.agent!)),
    route("POST", "/api/dms", async (_r, _p, _q, body) => app.openDm(((await body()) as { agent: string }).agent)),
    route("GET", "/api/dms", async () => app.rooms.summaries()),
    route("GET", "/api/search", async (_r, _p, q) => app.search.run({
      q: q.get("q") ?? "", from: str(q.get("from")), in: str(q.get("in")), after: str(q.get("after")), before: str(q.get("before")),
      sort: q.get("sort") === "recent" ? "recent" : "relevance", limit: num(q.get("limit")), cursor: str(q.get("cursor")),
      ...(q.get("type") === "messages" || q.get("type") === "tools" ? { type: q.get("type") as "messages" | "tools" } : {}),
    })),
    // An agent's board, duties, check-in and jobs by agent id. The thread routes take a thread id and resolve it to its agent through the
    // aliases, because pi-host's chat_board tool and the duty briefs name the thread.
    ...(["agents", "threads"] as const).flatMap(scope => [
      route("GET", `/api/${scope}/:id/board`, async (_r, p) => app.boards.view(p.id!)),
      route("POST", `/api/${scope}/:id/board`, async (_r, p, _q, body) => {
        const input = (await body()) as { ops: unknown; actor?: string };
        // A refused op (a bad shape, or an agent answering a todo) is the caller's error.
        return app.boards.apply(p.id!, input.ops, input.actor === "agent" ? "agent" : "owner").catch(error => {
          throw new BadRequest(error instanceof Error ? error.message : String(error));
        });
      }),
      route("GET", `/api/${scope}/:id/agents`, async (_r, p) => ({ agents: app.boards.chatAgents(p.id!) })),
      route("GET", `/api/${scope}/:id/duties`, async (_r, p) => ({ duties: app.boards.duties(p.id!) })),
      route("POST", `/api/${scope}/:id/duties`, async (_r, p, _q, body) => {
        const action = dutyAction(await body());
        if (!app.boards.has(p.id!)) throw new NotFound(`No agent or thread ${p.id}.`);
        // A duty definition upsertDuty refuses, or a duty id the board lacks, is the caller's error.
        return app.boards.dutyAction(p.id!, action).catch(error => {
          throw new BadRequest(error instanceof Error ? error.message : String(error));
        });
      }),
      route("GET", `/api/${scope}/:id/check-in`, async (_r, p) => app.boards.checkIn(p.id!)),
      route("POST", `/api/${scope}/:id/check-in`, async (_r, p, _q, body) => app.boards.setCheckIn(p.id!, (await body()) as never)),
    ]),
    route("POST", "/api/threads/:id/wakes", async (_r, p, _q, body) => {
      try {
        return await app.boards.addWake(p.id!, (await body()) as Record<string, unknown>);
      } catch (error) {
        throw new BadRequest(error instanceof Error ? error.message : String(error));
      }
    }),
    route("POST", "/api/threads/:id/import-prime", async (_r, p, _q, body) => {
      const input = (await body()) as { prime?: string; cwd?: string };
      // `cwd` names the project folder of the moved Prime chat; the thread keeps the cwd its import gave it without one.
      if (typeof input.cwd === "string") await app.patch(p.id!, { cwd: input.cwd });
      return app.boards.importPrime(p.id!, String(input.prime ?? ""), app.config.sharedDir);
    }),
    route("GET", "/api/for-you", async () => ({ items: await app.boards.forYou() })),
    route("GET", "/api/boards", async () => app.boards.index()),
    route("GET", "/api/usage", async (_r, _p, q) => usageReport(app.host, app.threads, app.config.box, { days: num(q.get("days")) ?? 7, thread: str(q.get("thread")), host: str(q.get("host")) })),
    ...accountRoutes(app, route),
    route("GET", "/api/hosts", async () => hostsReport(app.host, app.threads, app.config.box, app.config.socket, app.config.hostsFile)),
    route("GET", "/api/corrections", async () => readJson(join(app.config.sharedDir, "corrections.json"), { corrections: [] })),
  ];
}

export function serve(app: App): Server {
  const table = routes(app);
  const requests = new RequestLog(join(app.config.dataDir, "requests"), app.log);
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const method = req.method ?? "GET";
    if (path === "/api/timings" && method === "POST") return void takeTimings(table, requests, req, res);
    if (path.startsWith("/api/")) {
      const started = performance.now();
      res.once("close", () => requests.write({
        at: Date.now(), src: "server", m: method, r: routeLabel(table, method, path), p: path, s: res.writableFinished ? res.statusCode : 0, ms: performance.now() - started,
      }));
    }
    void handle(app, table, req, res);
  });
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

/** POST /api/timings: the web client's wait for each call it made (request-log.ts), with each path named by its route. */
async function takeTimings(table: Route[], requests: RequestLog, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const at = Date.now();
    const samples = clientTimings(await readBody(req));
    const via: ClientVia = req.headers["tailscale-user-login"] ? "tailnet" : "local";
    for (const sample of samples) requests.write({ at, src: "client", ...sample, r: routeLabel(table, sample.m, sample.p), via });
    json(res, 200, { taken: samples.length });
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
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
    if (await serveWiki(app, req, res, url)) return;
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
    if ((error instanceof PoolError || error instanceof ReactionError) && !res.headersSent) return json(res, error.status, { error: error.message });
    const message = error instanceof Error ? error.message : String(error);
    const status = isHostAway(error) ? 503 : error instanceof NotFound || error instanceof EntryMissing ? 404 : error instanceof EntryExists ? 409 : error instanceof BadRequest || error instanceof CwdRefused || /^(No |A |An |Dates|around|after|.* is not in (#|Solo "))/.test(message) ? 400 : 500;
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
