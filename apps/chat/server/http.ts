/**
 * The HTTP side: every endpoint under /api (apps/chat/API.md), the live socket at /api/live, the wiki under /wiki (server/wiki), and the built
 * web client for any other path.
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Server as NetServer, type Socket } from "node:net";
import { extname, join, normalize } from "node:path";
import type { ConversationPatch, DutyAction, LaterPatch, MemoryInput, ReadPoint, RoomInput, RoomPatch, SendRequest } from "../web/src/lib/api/types.ts";
import { parseSchedule } from "../web/src/lib/api/shared/chat-duties.ts";
import { agentConfig, agentRecordOf } from "./agent-config.ts";
import type { Config } from "./config.ts";
import { EntryExists, EntryMissing, HARNESS_KINDS, type HarnessKind } from "./agent-folder.ts";
import { parseItemId } from "./for-me.ts";
import type { AgentRecord, WakeOn } from "./agent-store.ts";
import { App, MODELS, NotFound } from "./app.ts";
import { uploadHeaders } from "./files.ts";
import { LocalImageError, readLocalImage } from "./local-image.ts";
import { ReactionError } from "./reactions.ts";
import { parsePrefsPatch } from "./sidebar-prefs.ts";
import { LaterError } from "./later.ts";
import { CwdRefused } from "./projects.ts";
import { listValues, SearchFilterError } from "./search.ts";
import type { SearchSplit } from "./search-engine.ts";
import { isHostAway } from "./host/types.ts";
import { readJson } from "./store.ts";
import { usageLive, usageReport, hostsReport } from "./usage.ts";
import { Skills } from "./skills.ts";
import { consolesReport } from "./consoles.ts";
import { decideBody, ReviewRefused, SkillsReview, undoBody } from "./skills-review.ts";
import { SkillsDb, SkillsRefused, SkillsStepFailed } from "./skills-db.ts";
import { fixtureScanner, writeSkillsDbFixture } from "./skills-db-fixture.ts";
import type { InstallBody } from "../web/src/lib/api/shared/skills.ts";
import { type ClientVia, clientTimings, LoopStalls, RequestLog } from "./request-log.ts";
import { accountRoutes, PoolError } from "./accounts.ts";
import { serveWiki } from "./wiki/routes.ts";
import { WikiEngine } from "./wiki/engine.ts";
import { wikiPages } from "./wiki/pages.ts";
import { sharedIn } from "./wiki/shared.ts";
import { WORKSPACE_ROUTE } from "./wiki/workspaces.ts";
import { compressibleFile, sendCompressed, sendFileCompressed } from "./compress.ts";

type Params = Record<string, string>;
type Handler = (req: IncomingMessage, params: Params, query: URLSearchParams, body: () => Promise<unknown>) => Promise<unknown>;
type Route = { method: string; path: string; pattern: RegExp; keys: string[]; handler: Handler };

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".json": "application/json", ".woff2": "font/woff2", ".ico": "image/x-icon",
};
/** The most a JSON body reads into memory; POST /api/uploads streams its file to disk instead and takes any size (App.upload). */
const MAX_BODY = 40 * 1024 * 1024;

export class BadRequest extends Error {}

/**
 * A request's split of its time for the request log: the body wait and the handler's own time, and the reason a refused or failed
 * request gave (request-log.ts `RequestTiming`).
 */
type Phase = { body?: number; run?: number; err?: string; split?: SearchSplit };
const phases = new WeakMap<IncomingMessage, Phase>();

/** A search's or a timeline read's split for its request log line, kept on the request's phase. */
function splitOf(req: IncomingMessage): SearchSplit {
  const split: SearchSplit = {};
  const phase = phases.get(req);
  if (phase) phase.split = split;
  return split;
}

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
  const workspace = WORKSPACE_ROUTE.exec(path);
  if (workspace) return `/api/c/:id/workspace${workspace[2] ? `/${workspace[2]}` : ""}`;
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

/** One read point of a Mark all as read Undo, as `POST /api/read` answered it. */
function readPoint(value: unknown): ReadPoint {
  const { room, seq, from } = (value ?? {}) as Record<string, unknown>;
  if (typeof room !== "string" || !room || typeof seq !== "number" || seq < 0) throw new BadRequest("A read point names its room and its seq, a number 0 or more.");
  if (from !== undefined && typeof from !== "string") throw new BadRequest("A read point's from is a post id when given.");
  return { room, seq, ...(from ? { from } : {}) };
}

/** A duties POST body: `set` with a duty definition, which upsertDuty checks, or another action with the duty's id. */
function dutyAction(body: unknown): DutyAction {
  const { action, duty, schedule, goal } = (body ?? {}) as Record<string, unknown>;
  if (action === "set") {
    if (typeof duty !== "object" || duty === null) throw new BadRequest("A set takes the duty definition as duty.");
    return { action, duty };
  }
  if (typeof duty !== "string" || !duty) throw new BadRequest("A duty action names the duty's id as duty.");
  if (action === "run" || action === "pause" || action === "resume" || action === "remove") return { action, duty };
  if (action === "schedule") {
    try { return { action, duty, schedule: parseSchedule(schedule) }; } catch (error) { throw new BadRequest(error instanceof Error ? error.message : String(error)); }
  }
  if (action === "goal") {
    if (typeof goal !== "string" || !goal.trim()) throw new BadRequest("A goal action takes the new goal, a string that is not blank.");
    return { action, duty, goal: goal.trim() };
  }
  throw new BadRequest("A duty action is set, run, pause, resume, schedule, goal or remove.");
}

/** `?kind=` of a harness entry, memory when absent. */
function harnessKind(query: URLSearchParams): HarnessKind {
  const kind = query.get("kind") ?? "memory";
  if (!(HARNESS_KINDS as readonly string[]).includes(kind)) throw new BadRequest(`An entry's kind is one of ${HARNESS_KINDS.join(", ")}.`);
  return kind as HarnessKind;
}

const text = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value) throw new SkillsRefused(`The body names ${field}.`);
  return value;
};
const opt = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/**
 * The skills DB over the live scanner and the live review set, or on the fixture server over a throwaway tree under the data dir that the
 * real scanner reads with HOME pointed at it, so `sw skills` and the layouts run against real files there too.
 */
function skillsDb(config: Config, log: (line: string) => void, broadcast: Broadcast, skills: Skills, review: SkillsReview): { db: SkillsDb; skills: Skills } {
  const piHost = join(config.home, ".local/share/pi-host/current/legacy/prime/user-history/src/chat-brief.ts");
  const file = join(config.dataDir, "chat.sqlite");
  if (!config.skillsReview.fixture) {
    const db = new SkillsDb({ file, box: config.box, home: config.home, piHostPrompt: piHost }, review.diskSteps("live"), log);
    skills.attach({ ingest: once(json => db.ingest(json)), overlay: rows => db.overlay(rows), lastAttempt: () => db.lastAttempt(), installPaths: () => db.installPaths() }, true);
    return { db, skills };
  }
  const root = join(config.dataDir, "skills-db");
  const setFile = join(config.skillsReview.dir, "sets", "skills-db.json");
  const fixture = existsSync(setFile) && existsSync(join(root, "home"))
    ? { home: join(root, "home"), inventory: join(root, "inventory.json"), setName: "skills-db" }
    : writeSkillsDbFixture(root, { reviewDir: config.skillsReview.dir, box: config.box });
  const repo = join(import.meta.dirname, "../../..");
  const own = new Skills({ inventory: fixture.inventory, scanner: fixtureScanner(fixture, repo) }, config.box, log, scan => broadcast({ type: "skills", scan }));
  const db = new SkillsDb({ file, box: config.box, home: fixture.home, piHostPrompt: existsSync(piHost) ? piHost : null }, review.diskSteps(fixture.setName), log);
  own.attach({ ingest: once(json => db.ingest(json)), overlay: rows => db.overlay(rows), lastAttempt: () => db.lastAttempt(), installPaths: () => db.installPaths() }, true);
  return { db, skills: own };
}

type Broadcast = (event: Parameters<App["broadcast"]>[0]) => void;

/**
 * An ingest that skips the inventory it took last. A start parses the inventory once, and both the scanner's parse and its attach hand that
 * same object to the DB, so the first ingest ran twice.
 */
function once(ingest: (json: unknown) => void): (json: unknown) => void {
  let last: unknown;
  return json => {
    if (json === last) return;
    last = json;
    ingest(json);
  };
}

/** The skills scanner, review and DB that the routes use, and `ready`, which settles once the first inventory read and its ingest ended. */
export type SkillsParts = { skills: Skills; review: SkillsReview; db: { db: SkillsDb; skills: Skills }; ready: Promise<void> };

/**
 * Builds the skills parts apart from the App, so the first ingest runs before the server takes the port. On a copy of the live data on 11-22
 * that ingest held the main thread 1.6 s (skills-db.ts ingest in a CPU profile), and on live every hand-over to a server that ran it after
 * it listened held all calls for 3.0 to 3.8 s. A successor builds them before it says it loaded (server/handoff.ts), while the old server
 * still serves; their writes to chat.sqlite are the same rows the old server's own ingest wrote.
 */
export function skillsParts(config: Config, log: (line: string) => void, app: () => App | undefined): SkillsParts {
  const broadcast: Broadcast = event => app()?.broadcast(event);
  const skills = new Skills(config.skills, config.box, log, scan => broadcast({ type: "skills", scan }));
  const review = new SkillsReview(config.skillsReview, skills, config.box, {
    log,
    broadcast,
    // A live fold goes to agent factory's work thread as a message from the review, the way a duty job's report reaches its chat.
    fold: async (text, requestId) => {
      const live = app();
      if (!live) throw new Error("The chat server is still starting.");
      await live.host.submit(live.boards.threadOf("ag_agent-factory"), { text, requestId, whenBusy: "followUp", entry: { kind: "agent.message", data: { from: "skills review", via: "skills review" } } });
    },
  });
  const db = skillsDb(config, log, broadcast, skills, review);
  const ready = db.skills.report().then(() => new Promise<void>(resolve => setImmediate(resolve)));
  return { skills, review, db, ready };
}

export function routes(app: App, parts: SkillsParts): Route[] {
  const str = (value: string | null): string | undefined => (value === null || value === "" ? undefined : value);
  const { skills, review, db } = parts;
  const refused = (error: unknown): never => {
    throw error instanceof ReviewRefused || error instanceof SkillsRefused ? new BadRequest(error.message) : error;
  };
  const change = (run: (body: Record<string, unknown>) => Promise<unknown>) => async (_r: IncomingMessage, _p: Params, _q: URLSearchParams, body: () => Promise<unknown>) => {
    try {
      const raw = await body();
      return await run(raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});
    } catch (error) {
      return refused(error);
    }
  };
  const folderAgent = (id: string): AgentRecord => {
    const agent = agentRecordOf(app, id);
    if (!agent) throw new NotFound(`No agent ${id}.`);
    return agent;
  };
  return [
    route("GET", "/api/ready", async () => ({ ready: true, pid: process.pid })),
    route("GET", "/api/me", async () => app.me()),
    route("GET", "/api/sidebar", async () => app.sidebar()),
    route("PUT", "/api/sidebar/layout", async (_r, _p, _q, body) => {
      const layout = await body();
      if (!layout || typeof layout !== "object" || Array.isArray(layout)) throw new BadRequest("A sidebar layout is an object with sections, placement, collapsed, sort and order.");
      return app.setSidebarLayout(layout);
    }),
    route("GET", "/api/owner-settings", async () => app.ownerSettings.get()),
    route("PATCH", "/api/owner-settings", async (_r, _p, _q, body) => app.ownerSettings.patch(await body())),
    route("PUT", "/api/owner-settings", async (_r, _p, _q, body) => app.ownerSettings.replace(await body())),
    route("POST", "/api/owner-settings/import", async (_r, _p, _q, body) => app.ownerSettings.importOld(await body())),
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
      const { messageId, messageIds, completed } = ((await body()) ?? {}) as { messageId?: unknown; messageIds?: unknown; completed?: unknown };
      if (messageIds !== undefined) {
        const items = Array.isArray(messageIds) ? messageIds.map(parseItemId) : [];
        if (!items.length || items.some(i => !i)) throw new BadRequest("messageIds is a list of For item ids, each <room id>/<post id>, such as [\"dm_vent/p41\", \"ch_1a2b3c4d/p12\"].");
        if (typeof completed !== "boolean") throw new BadRequest("A mark's completed is true to mark the items completed or false to make them pending again.");
        return app.markManyForMe(p.id!, items.map(i => `${i!.room}/${i!.post}`), completed);
      }
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
    route("POST", "/api/agents", async (_r, _p, _q, body) => {
      const input = (await body()) as Parameters<App["createAgent"]>[0];
      if (input.brief !== undefined && typeof input.brief !== "string") throw new BadRequest("A new agent's brief is text, a string, when given.");
      const agent = await app.createAgent(input);
      // A job thread opens by link later, so only a new agent's DM comes with its first page.
      return input.kind === "job" || input.parent || !agent.room ? agent : { ...agent, opened: await app.opened(agent.room) };
    }),
    route("GET", "/api/projects", async () => app.projects()),
    route("GET", "/api/c/:id", async (_r, p) => app.header(p.id!)),
    route("PATCH", "/api/c/:id", async (_r, p, _q, body) => app.patch(p.id!, (await body()) as ConversationPatch)),
    route("GET", "/api/c/:id/items", async (r, p, q) => {
      const opts = { before: str(q.get("before")), after: str(q.get("after")), around: str(q.get("around")), limit: num(q.get("limit")) };
      return app.items(p.id!, opts, splitOf(r));
    }),
    route("GET", "/api/c/:id/output/:entry", async (_r, p) => {
      const entry = Number(p.entry);
      if (!Number.isSafeInteger(entry) || entry < 0) throw new BadRequest(`An output names a tool result entry id, a whole number, got ${p.entry}.`);
      const output = await app.threads.stepOutput(p.id!, entry);
      if (!output) throw new NotFound(`No tool result ${entry} in ${p.id}.`);
      return output;
    }),
    route("GET", "/api/c/:id/replies/:root", async (_r, p) => app.replies(p.id!, p.root!)),
    route("POST", "/api/uploads", async (req, _p, q) => app.upload(req.headers["content-type"] ?? "", req, str(q.get("name")))),
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
    // A thread's done flag (thread-done.ts): the owner's from the page and an agent's set_thread_done, through the one app.ts setThreadDone.
    route("POST", "/api/c/:id/posts/:post/done", async (_r, p, _q, body) => app.threadDone(p.id!, p.post!, ((await body()) ?? {}) as { done?: unknown })),
    // A post's pin flag (pins.ts), the owner's from the page.
    route("POST", "/api/c/:id/posts/:post/pin", async (_r, p, _q, body) => app.pin(p.id!, p.post!, ((await body()) ?? {}) as { pinned?: unknown })),
    route("POST", "/api/threads/:id/done", async (_r, p, _q, body) => {
      return app.threadDoneAsAgent(p.id!, ((await body()) ?? {}) as { message?: unknown; done?: unknown });
    }),
    route("POST", "/api/threads/:id/edits", async (_r, p, _q, body) => {
      return app.editAsAgent(p.id!, ((await body()) ?? {}) as { message?: unknown; text?: unknown });
    }),
    // An agent's save_message, remind_me and list_saved_messages (later-agents.ts), as its thread.
    route("GET", "/api/threads/:id/later", async (_r, p, q) => app.laterListAsAgent(p.id!, q.get("state"))),
    route("POST", "/api/threads/:id/later", async (_r, p, _q, body) => {
      return app.laterAsAgent(p.id!, ((await body()) ?? {}) as { message?: unknown; state?: unknown; remindAt?: unknown });
    }),
    // The owner's Save for later list (later.ts); pi-host's agent tools use the /api/threads/:id/later routes.
    route("GET", "/api/later", async (_r, _p, q) => {
      const state = q.get("state");
      if (state !== null && state !== "open" && state !== "archived" && state !== "done") throw new BadRequest("A Later list's state is open, archived or done.");
      return app.later.list("owner", state ?? undefined, { test: q.get("test") === "1" });
    }),
    route("POST", "/api/later", async (_r, _p, _q, body) => ({ item: app.later.save("owner", ((await body()) ?? {}) as Record<string, unknown>) })),
    route("PATCH", "/api/later/:id", async (_r, p, _q, body) => {
      const { state, remindAt, ...rest } = ((await body()) ?? {}) as Record<string, unknown>;
      if (Object.keys(rest).length) throw new BadRequest("A Later patch carries only state and remindAt.");
      return { item: app.later.update("owner", p.id!, { ...(state !== undefined ? { state } : {}), ...(remindAt !== undefined ? { remindAt } : {}) } as LaterPatch) };
    }),
    route("DELETE", "/api/later/:id", async (_r, p) => ({ item: app.later.remove("owner", p.id!) ?? null })),
    route("PUT", "/api/later/:id", async (_r, p, _q, body) => ({ item: app.restoreLater(p.id!, ((await body()) ?? {}) as Record<string, unknown>) })),
    route("POST", "/api/c/:id/abort", async (_r, p) => {
      await app.abort(p.id!);
      return { ok: true };
    }),
    route("PUT", "/api/c/:id/prefs", async (_r, p, _q, body) => {
      const patch = parsePrefsPatch(await body());
      if (typeof patch === "string") throw new BadRequest(patch);
      return app.setPrefs(p.id!, patch);
    }),
    route("POST", "/api/c/:id/read", async (_r, p, _q, body) => {
      const { seq, unreadFrom } = ((await body()) ?? {}) as { seq?: number; unreadFrom?: string };
      if (typeof unreadFrom === "string") app.markUnread(p.id!, unreadFrom);
      else app.markRead(p.id!, typeof seq === "number" ? seq : undefined);
      return { ok: true };
    }),
    route("POST", "/api/read", async (_r, _p, _q, body) => {
      const input = ((await body()) ?? {}) as Record<string, unknown>;
      if (Array.isArray(input.restore)) {
        app.restoreReads(input.restore.map(readPoint));
        return { ok: true };
      }
      if (!Array.isArray(input.rooms) || !input.rooms.every(id => typeof id === "string")) throw new BadRequest("Mark all as read takes rooms, a list of room ids, or restore.");
      return { before: app.markAllRead(input.rooms as string[]) };
    }),
    route("GET", "/api/threads/:id/jobs", async (_r, p) => app.threads.jobs(p.id!)),
    route("GET", "/api/rooms", async (_r, _p, q) => app.groups.list({ test: q.get("test") === "1", archived: q.get("archived") === "1" })),
    route("POST", "/api/rooms", async (_r, _p, _q, body) => {
      const room = await app.groups.create((await body()) as RoomInput);
      return { ...room, opened: await app.opened(room.id) };
    }),
    route("PATCH", "/api/rooms/:id", async (_r, p, _q, body) => app.groups.update(p.id!, ((await body()) ?? {}) as RoomPatch)),
    // Adding twice, removing a non-member or setting the wakeOn a member has changes nothing; each answers the room (group-rooms.ts
    // `addMembers`, `removeMember`, `setWakeOn`).
    route("POST", "/api/rooms/:id/members", async (_r, p, _q, body) => {
      const input = ((await body()) ?? {}) as { agents?: string[]; wakeOn?: WakeOn };
      return app.addMembers(p.id!, input.agents ?? [], input.wakeOn).room;
    }),
    route("DELETE", "/api/rooms/:id/members/:agent", async (_r, p) => (await app.removeMember(p.id!, p.agent!)).room),
    route("PATCH", "/api/rooms/:id/members/:agent", async (_r, p, _q, body) =>
      app.groups.setWakeOn(p.id!, p.agent!, ((await body()) as { wakeOn?: unknown } | undefined)?.wakeOn)),
    route("POST", "/api/threads/:id/members", async (_r, p, _q, body) => {
      return app.memberAsAgent(p.id!, ((await body()) ?? {}) as { room?: unknown; agent?: unknown; member?: unknown });
    }),
    route("POST", "/api/dms", async (_r, _p, _q, body) => app.openDm(((await body()) as { agent: string }).agent)),
    route("GET", "/api/dms", async () => app.rooms.summaries()),
    // `from`, `where`, `place` and `has` take comma lists and repeated params alike; a value search cannot read is the caller's error.
    route("GET", "/api/search", async (r, _p, q) => app.search.run({
      q: q.get("q") ?? "", from: listValues(q.getAll("from")), where: listValues(q.getAll("where")), place: listValues(q.getAll("place")), in: str(q.get("in")), after: str(q.get("after")),
      before: str(q.get("before")), sort: q.get("sort") === "recent" ? "recent" : "relevance", limit: num(q.get("limit")), cursor: str(q.get("cursor")),
      brief: q.get("brief") === "1", has: listValues(q.getAll("has")),
    }, splitOf(r)).catch((error: unknown) => {
      throw error instanceof SearchFilterError ? new BadRequest(error.message) : error;
    })),
    route("GET", "/api/search/recent", async (_r, _p, q) => app.search.recent({ after: num(q.get("after")), limit: num(q.get("limit")) })),
    route("GET", "/api/pages", async (_r, _p, q) => wikiPages(new WikiEngine(app.config.wikiEngine), q.get("q") ?? "", num(q.get("limit")))),
    route("GET", "/api/pages/shared", async (_r, _p, q) => sharedIn({
      rooms: () => [...app.groups.rows().map(row => row.id), ...app.agents.list().map(record => record.room)],
      postsOf: room => app.agentStore.postsOf(room), isTest: room => app.agentStore.isTest(room),
    }, q.get("path") ?? "")),
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
      route("POST", `/api/${scope}/:id/check-in`, async (_r, p, _q, body) => {
        const patch = (await body()) as never;
        try {
          return app.boards.setCheckIn(p.id!, patch);
        } catch (error) {
          throw new BadRequest(error instanceof Error ? error.message : String(error));
        }
      }),
      // A check-in job's message to a job of its agent (check-in-job.ts); a bad body or a job the agent lacks is the caller's error.
      route("POST", `/api/${scope}/:id/job-steer`, async (_r, p, _q, body) => {
        if (!app.boards.has(p.id!)) throw new NotFound(`No agent or thread ${p.id}.`);
        const input = ((await body()) ?? {}) as { job?: unknown; text?: unknown; from?: unknown };
        return app.boards.steerJob(p.id!, input).catch(error => {
          throw new BadRequest(error instanceof Error ? error.message : String(error));
        });
      }),
      route("POST", `/api/${scope}/:id/board/hidden`, async (_r, p, _q, body) => {
        const input = (await body()) as { hidden?: unknown } | null;
        if (typeof input?.hidden !== "boolean") throw new BadRequest("A board hide body is { hidden: true } or { hidden: false }.");
        if (!app.boards.has(p.id!)) throw new NotFound(`No agent or thread ${p.id}.`);
        return app.boards.setHidden(p.id!, input.hidden);
      }),
    ]),
    route("GET", "/api/threads/:id/wakes", async (_r, p, q) => {
      const conversation = Number(q.get("conversation") ?? 1);
      if (!Number.isInteger(conversation) || conversation < 1) throw new BadRequest("conversation is a whole number from 1.");
      return { wakes: app.boards.wakes(p.id!, conversation) };
    }),
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
    route("GET", "/api/usage", async (_r, _p, q) => {
      const filters = { thread: str(q.get("thread")), host: str(q.get("host")) };
      const [report, live] = await Promise.all([usageReport(app.usage, app.threads, app.config.box, { range: str(q.get("range")), bucket: str(q.get("bucket")), ...filters }), usageLive(app.usage, app.config.box, filters)]);
      return { ...report, live };
    }),
    route("GET", "/api/usage/live", async (_r, _p, q) => usageLive(app.usage, app.config.box, { thread: str(q.get("thread")), host: str(q.get("host")) })),
    ...accountRoutes(app, route),
    route("GET", "/api/hosts", async () => hostsReport(app.host, app.threads, app.config.box, app.config.socket, app.config.hostsFile)),
    route("GET", "/api/consoles", async () => consolesReport(app.config.consoles)),
    route("GET", "/api/skills", async () => db.db.view((await db.skills.report()).scan)),
    route("GET", "/api/skills/inventory", async () => skills.report()),
    route("POST", "/api/skills/scan", async () => ({ scan: db.skills.startScan().scan })),
    route("GET", "/api/skills/check", async () => db.db.check()),
    route("GET", "/api/skills/moves", async () => ({ moves: db.db.moves() })),
    route("POST", "/api/skills/apply", change(async b => db.db.apply({ dryRun: b.dryRun === true }))),
    route("POST", "/api/skills/install", change(async b => db.db.install({
      name: text(b.name, "name"), box: text(b.box, "box"), runtime: text(b.runtime, "runtime") as InstallBody["runtime"], agent: opt(b.agent),
      mode: b.mode === "copy" ? "copy" : "link", path: opt(b.path), source: opt(b.source),
    }))),
    route("POST", "/api/skills/remove", change(async b => db.db.remove({ target: text(b.target, "target") }))),
    route("POST", "/api/skills/adopt", change(async b => db.db.adopt({ copyId: text(b.copyId, "copyId"), skillId: opt(b.skillId) }))),
    route("POST", "/api/skills/move", change(async b => db.db.move({ installId: text(b.installId, "installId"), path: text(b.path, "path") }))),
    route("POST", "/api/skills/merge", change(async b => db.db.merge({ skillId: text(b.skillId, "skillId"), into: text(b.into, "into") }))),
    route("POST", "/api/skills/own", change(async b => db.db.own({ skillId: text(b.skillId, "skillId"), owner: text(b.owner, "owner") }))),
    route("POST", "/api/skills/undo", change(async b => db.db.undo({ moveId: text(b.moveId, "moveId") }))),
    route("GET", "/api/skills/doc", async (_r, _p, q) => {
      const id = q.get("id");
      if (!id) throw new BadRequest("A skill doc names its row as ?id=, the id GET /api/skills lists.");
      return skills.doc(id);
    }),
    route("GET", "/api/skills/review", async (_r, _p, q) => review.report(q.get("set"))),
    route("GET", "/api/skills/review/item", async (_r, _p, q) => {
      const id = q.get("id");
      if (!id) throw new BadRequest("A review item names its id as ?id=, an id GET /api/skills/review lists.");
      return review.item(q.get("set"), id);
    }),
    route("POST", "/api/skills/review/decide", async (_r, _p, _q, body) => {
      try {
        return await review.decide(decideBody(await body()));
      } catch (error) {
        return refused(error);
      }
    }),
    route("POST", "/api/skills/review/undo", async (_r, _p, _q, body) => {
      try {
        return await review.undo(undoBody(await body()));
      } catch (error) {
        return refused(error);
      }
    }),
    route("GET", "/api/corrections", async () => readJson(join(app.config.sharedDir, "corrections.json"), { corrections: [] })),
  ];
}

export function serve(app: App, parts: SkillsParts = skillsParts(app.config, app.log, () => app)): Server {
  const table = routes(app, parts);
  const requests = new RequestLog(join(app.config.dataDir, "requests"), app.log);
  const stalls = new LoopStalls();
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const method = req.method ?? "GET";
    if (path === "/api/timings" && method === "POST") return void takeTimings(table, requests, app.log, req, res);
    if (path.startsWith("/api/")) {
      const started = performance.now();
      const phase: Phase = {};
      phases.set(req, phase);
      res.once("close", () => requests.write({
        at: Date.now(), src: "server", m: method, r: routeLabel(table, method, path), p: path, s: res.writableFinished ? res.statusCode : 0, ms: performance.now() - started,
        ...phase, stall: stalls.longest(started), via: viaOf(req),
      }));
    }
    void handle(app, table, req, res);
  });
  track(server);
  // A whole request may take as long as its body takes to arrive, so an upload of any size over a slow link ends (App.upload);
  // Node's 300 s default cut such uploads off. headersTimeout still drops a client that never finishes its headers.
  server.requestTimeout = 0;
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

/**
 * Each server's connections other than live sockets, with the calls each has in flight, whether it answered one yet and whether `drain`
 * ended it, which `drain` reads.
 */
type Conn = { busy: Map<IncomingMessage, ServerResponse>; served: boolean; ended: boolean; lastAt: number };
const conns = new WeakMap<Server, Map<Socket, Conn>>();
const draining = new WeakSet<Server>();

function track(server: Server): void {
  const open = new Map<Socket, Conn>();
  conns.set(server, open);
  server.on("connection", (socket: Socket) => {
    open.set(socket, { busy: new Map(), served: false, ended: false, lastAt: 0 });
    socket.once("close", () => open.delete(socket));
  });
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const conn = open.get(req.socket as Socket);
    if (!conn) return;
    conn.busy.set(req, res);
    if (draining.has(server)) res.shouldKeepAlive = false;
    res.once("close", () => {
      conn.busy.delete(req);
      conn.served = true;
      conn.lastAt = Date.now();
    });
  });
  server.on("upgrade", (req: IncomingMessage) => open.delete(req.socket as Socket));
}

/**
 * Stops taking connections and resolves once every connection it took has answered its calls, or after `maxMs` with the rest cut, with a
 * line that says what it waited for. A release restart used to end the process mid-call, so a send or a change in flight failed with "Load
 * failed" in the owner's browser. 99.9% of the 128,600 server lines of 11-21 and 11-22 answered within 1.5 s, so the default waits 2 s; the
 * longest took 10.8 s.
 * http's own close also ends a connection accepted just before whose request was not read yet, and the hand-over spec
 * (test/server/handoff.test.ts) saw that as ECONNRESET on 1 or 2 of about 300 calls in 2 of 3 runs on 11-22, so only net's close runs here:
 * a connection that answered a call and holds none is ended, and a new one is kept until its call answered. A new one that sent nothing
 * within SILENT_MS is a client's spare connection and is ended too. A call in flight answers with `Connection: close`, so its client does not
 * send another on that connection.
 * A connection that answered a call within SILENT_MS is ended only once it stayed quiet that long, and a call that comes on it meanwhile
 * answers with `Connection: close`: in after-walk 4 on 11-22, 3 calls that a polling client sent just before an end met the ended
 * connection and got no answer (status 0 in the request log at 09:46:24.219Z), and the walk's front showed 2 of them as 502.
 * An ended connection counts as done once it holds no call, without its client's close: http's server keeps a connection half open after
 * its own end until the client closes, and in 4 of 5 live hand-overs on 11-22 (09:33 to 09:34Z) the stop waited the whole 2 s with no call
 * answered in it. Live sockets end with the app.
 */
export async function drain(server: Server, maxMs = 2000): Promise<string> {
  netClose.call(server);
  draining.add(server);
  const open = conns.get(server) ?? new Map<Socket, Conn>();
  const began = Date.now();
  const end = began + maxMs;
  let ended = 0;
  for (;;) {
    const silent = Date.now() - began >= SILENT_MS;
    let waiting = 0;
    for (const [socket, conn] of open) {
      if (conn.busy.size) {
        for (const res of conn.busy.values()) if (!res.headersSent) res.shouldKeepAlive = false;
        waiting += 1;
        continue;
      }
      if (conn.ended) continue;
      if ((conn.served && Date.now() - conn.lastAt >= SILENT_MS) || (silent && socket.bytesRead === 0)) {
        conn.ended = true;
        ended += 1;
        socket.end();
      } else waiting += 1;
    }
    if (!waiting || Date.now() >= end) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const cut = [...open.values()].flatMap(conn => [...conn.busy.keys()].map(req => `${req.method} ${req.url}`));
  const halfOpen = [...open.values()].filter(conn => conn.ended && !conn.busy.size).length;
  return `drained in ${Date.now() - began} ms: ended ${ended} idle connections (${halfOpen} not closed by their client yet)` +
    (cut.length ? `, cut ${cut.length} calls at ${maxMs} ms: ${cut.slice(0, 5).join(", ")}` : "");
}
const netClose = NetServer.prototype.close;
/**
 * A client on this box, tailscale serve included, sends its request within a few ms of its connect: over 500 loopback connects on us-metal02
 * on 11-22 the first byte came 0.2 ms after the accept at the median, 1.3 ms at p99 and 4.7 ms at most.
 */
const SILENT_MS = 100;

const viaOf = (req: IncomingMessage): ClientVia => (req.headers["tailscale-user-login"] ? "tailnet" : "local");

/** POST /api/timings: the web client's wait for each call it made (request-log.ts), with each path named by its route. */
async function takeTimings(table: Route[], requests: RequestLog, log: (line: string) => void, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const at = Date.now();
    const samples = clientTimings(await readBody(req));
    const via = viaOf(req);
    for (const sample of samples) {
      const r = routeLabel(table, sample.m, sample.p);
      requests.write({ at, src: "client", ...sample, r, via });
      if (sample.err !== undefined) log(`client ${sample.m} ${r} ${sample.p} ${sample.shown ? "Not delivered" : sample.s || "unreached"} (${via}): ${sample.err}`);
    }
    json(res, 200, { taken: samples.length });
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  sendCompressed(res, status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, JSON.stringify(value));
}

async function handle(app: App, table: Route[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  try {
    if (await serveWiki(app, req, res, url)) return;
    if (path.startsWith("/api/images/")) return await serveEntryImage(app, path, res);
    if (path.startsWith("/api/uploads/")) return await serveUpload(res, app.store.imagePath(path.slice("/api/uploads/".length).replace(/[^\w.-]/g, "")), url.searchParams);
    if (path === "/api/local-image" && req.method === "GET") return await serveLocalImage(url.searchParams.get("path") ?? "", res);
    if (path.startsWith("/api/")) {
      for (const r of table) {
        if (r.method !== req.method) continue;
        const match = r.pattern.exec(path);
        if (!match) continue;
        const params: Params = {};
        r.keys.forEach((key, i) => (params[key] = decodeURIComponent(match[i + 1]!)));
        let parsed: Promise<unknown> | undefined;
        const phase = phases.get(req);
        const timedBody = async (): Promise<unknown> => {
          const asked = performance.now();
          try {
            return await readBody(req);
          } finally {
            if (phase) phase.body = performance.now() - asked;
          }
        };
        const ran = performance.now();
        const value = await r.handler(req, params, url.searchParams, () => (parsed ??= timedBody()));
        if (phase) phase.run = performance.now() - ran - (phase.body ?? 0);
        return json(res, 200, value ?? { ok: true });
      }
      return refuse(app, table, req, res, 404, `No endpoint ${req.method} ${path}.`);
    }
    return await serveWeb(app, path, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof PoolError || error instanceof ReactionError || error instanceof LaterError ? error.status : isHostAway(error) ? 503
      : error instanceof NotFound || error instanceof EntryMissing ? 404 : error instanceof EntryExists || error instanceof SkillsStepFailed ? 409
      : error instanceof BadRequest || error instanceof CwdRefused || /^(No |A |An |Dates|around|after|.* is not in (#|Solo "))/.test(message) ? 400 : 500;
    refuse(app, table, req, res, status, message, status === 500 && error instanceof Error ? error.stack : undefined);
  }
}

/**
 * Answers a refused or failed /api request and writes one log line with its route, status and reason, which also goes on its request log
 * line as `err`. On 11-04 at 03:09Z three of the owner's sends answered 400 and the page showed Not delivered, while the server logged
 * nothing about them, so the reason was lost.
 */
function refuse(app: App, table: Route[], req: IncomingMessage, res: ServerResponse, status: number, message: string, stack?: string): void {
  const method = req.method ?? "GET";
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const phase = phases.get(req);
  if (phase) phase.err = message.slice(0, 500);
  app.log(`${method} ${routeLabel(table, method, path)} ${path} ${status}: ${stack ?? message}`);
  if (!res.headersSent) json(res, status, { error: message });
  else res.end();
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

/** An upload: an image as any served file, and any other file inline or as a download under the name it was attached with (files.ts). */
function serveUpload(res: ServerResponse, file: string, query: URLSearchParams): void | Promise<void> {
  const ext = extname(file).slice(1).toLowerCase();
  if (TYPES[`.${ext}`]?.startsWith("image/")) return serveFile(res, file, true);
  const stat = existsSync(file) ? statSync(file) : undefined;
  if (!stat?.isFile()) throw new NotFound("Not found.");
  res.writeHead(200, { ...uploadHeaders(ext, query.get("name"), query.get("download") === "1"), "content-length": stat.size, "cache-control": "private, max-age=31536000, immutable" });
  createReadStream(file).pipe(res);
}

function serveFile(res: ServerResponse, file: string, immutable = false): void | Promise<void> {
  const stat = existsSync(file) ? statSync(file) : undefined;
  if (!stat?.isFile()) throw new NotFound("Not found.");
  const headers = { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": immutable ? "private, max-age=31536000, immutable" : "no-cache" };
  if (compressibleFile(file)) return sendFileCompressed(res, headers, file, stat);
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}

function serveWeb(app: App, path: string, res: ServerResponse): void | Promise<void> {
  const root = app.config.webDir;
  const file = normalize(join(root, path));
  if (file.startsWith(root) && existsSync(file) && statSync(file).isFile()) return serveFile(res, file, path.startsWith("/assets/"));
  const index = join(root, "index.html");
  if (existsSync(index)) {
    return sendCompressed(res, 200, { "content-type": TYPES[".html"]!, "cache-control": "no-cache" }, readFileSync(index));
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("apps/chat server is running. Build the web client with `npm run build` in apps/chat/web.\n");
}
