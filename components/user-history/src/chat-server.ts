import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { constants as zlibConstants, createBrotliCompress, createGzip, gzipSync } from "node:zlib";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseWake } from "./wakes.ts";
import { isTopLevel, sessionTitle } from "./chat-catalog.ts";
import { otherBoxRoots, reopenSibling, type RootDirectory, rootsOf, sendCrossHost, siblingRow } from "./cross-host-message.ts";
import { getAgentDir } from "prime-agent";
import { reopenSession, unarchiveOnItsBox } from "./reopen-send.ts";
import { jobRegistry } from "./chat-sources.ts";
import { IdIndex } from "./id-index.ts";
import { CLEAN_ROOM_CHATS_FILE, CLEAN_ROOM_CORRECTIONS_FILE, CorrectionLedger, correctionResult, parseCorrectionCall } from "./chat-corrections.ts";
import type { Duplex } from "node:stream";
import { applyAgentOps } from "./agent-board.ts";
import type { ChatBackend } from "./chat-backend.ts";
import { assetName, type ClientBundle, type Asset } from "./chat-assets.ts";
import { parseChatImages } from "./chat-images.ts";
import { BOARD_PREFIX, BoardError, parseBoardOps } from "./shared/chat-board.ts";
import { buildRenderBundle, LocalFileError, readLocalImage, readLocalText, renderPage, renderPolicy } from "./chat-render.ts";
import { readWikiPage, wikiOrigin, type WikiPageView } from "./chat-wiki.ts";
import { parsePublicOrigin } from "./chat-origin.ts";
import { FeedSockets, parseUrlSubscriptions } from "./chat-socket.ts";
import { contentSecurityPolicy, escapeAttribute, shellHead, shellTail } from "./shell.ts";
import type { EarlyShell } from "./early-shell.ts";
import { AgentsDiff, agentsView, parseHave, SessionsDiff, withoutAgents, withoutArchived } from "./shared/sessions-delta.ts";
import { prepaintHash, prepaintHtml } from "./prepaint.ts";
import { childLabels, wireEvent } from "./first-page.ts";
import { isPriority, LabelError } from "./chat-labels.ts";
import { AccountLogins, listAccounts, PoolError, runAccountAction, UsageRefreshes } from "./chat-pool.ts";
import { ThreadError } from "./chat-threads.ts";
import { OutboxConflict } from "./outbox.ts";
import { chatCheckIn, checkInLine, checkInSettings, type CheckInActor, type CheckInChange, CheckInRefused, OWNER_UI, parseChatCheckIn, UNKNOWN_AGENT, validCheckInEvery } from "./checkin-settings.ts";
import { chooseFolder, resolveWorkspace, WorkspaceError } from "./chat-workspace.ts";
import { parseBucket, parseGroup, parseMetric, parseWindow, UsageError } from "./usage/lgtm.ts";
import { interruptedRuns } from "./chat-resume.ts";
import type { RemoteControl } from "./chat-remote.ts";
import type { SlackControl } from "./chat-slack.ts";
import type { SdkSync } from "./chat-sdk.ts";
import type { ThreadSide } from "./shared/thread-side.ts";
import { hostsView, thisBox } from "./chat-hosts.ts";
import { parseAgentQueueInput } from "./chat-agent-queue.ts";
import { TOOL_CHECKS_FILE, toolChecks } from "./chat-tools.ts";
import { skillsView } from "./chat-skills.ts";
import { nextBriefView } from "./prompt-view.ts";
import { feedBoard } from "./shared/board-delta.ts";
import { CHECK_IN_MIN_MINUTES, CHECK_IN_PAUSES, isThinkingLevel, type AccountAction, type AgentQueueInput, type ChatDefaultsInput, type LabelAction, type ModelCatalog, type RemoteAccessInput, type SendMode, type SlackChannelSetup, type SlackChatInput, type SlackInput, type ThinkingLevel } from "./shared/types.ts";
import { channelNameError } from "./shared/slack-channel.ts";
import { parseStartSkill } from "./shared/start-skill.ts";
import { timeRead } from "./chat-latency.ts";
import { ScheduledJobsLeft } from "./saved-archive.ts";
import { type ArchiveBy, isServiceArchiveReason, SERVICE_ARCHIVES_FILE } from "./service-archives.ts";
import { type CancelBy, parseCancelBy } from "./job-cancels.ts";

const maxBodyBytes = 12 * 1024 * 1024;
const requestIdPattern = /^[a-zA-Z0-9_-]{16,100}$/;
const idPattern = /^[a-zA-Z0-9_.:-]{1,256}$/;

/**
 * The chat files a box without the chat role reads through the service: the corrections ledger and send log for the board skill, and the
 * stop records resume_paused.py reads, since a Mac pass that read its own stale deleted-jobs.json could resume a job deleted after the move.
 */
const AGENT_FILES = new Map([["api/agent/corrections", "corrections.json"], ["api/agent/sends", "sends.jsonl"], ["api/agent/deleted-jobs", "deleted-jobs.json"],
  ["api/agent/archived-chats", "archived-chats.json"], ["api/agent/unloaded", "unloaded.json"], ["api/agent/job-cancels", "job-cancels.json"], ["api/agent/service-archives", SERVICE_ARCHIVES_FILE]]);

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A folder path for another box, taken as typed: it must be absolute there, and that box's daemon refuses one it does not have. */
function remoteWorkspace(input: string, host: string): string {
  const typed = input.trim().replace(/\/+$/, "") || "/";
  if (!typed.startsWith("/")) throw new WorkspaceError(`Type the full folder path on ${host}, starting with /: ${input.trim()}`);
  return typed;
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
/**
 * A text field. `max` bounds only an id-like field (a provider, model id, account or path), never what a person writes: a message, a name or a
 * tag has no length cap (owner 10-18: every arbitrary limit is a soft cap). The request body cap bounds those.
 */
function text(value: unknown, field: string, max?: number): string {
  if (typeof value !== "string" || (max !== undefined && value.length > max)) throw new RequestError(400, max === undefined ? `Expected ${field} as text.` : `Expected ${field} as text up to ${max} characters.`);
  return value;
}
function requestId(value: unknown): string {
  if (typeof value !== "string" || !requestIdPattern.test(value)) throw new RequestError(400, "Expected a request ID.");
  return value;
}
/** Every box's live roots and the daemon send for the cross-host message routes, from the catalog that lists each box's daemon. */
function rootDirectory(backend: ChatBackend): RootDirectory {
  const catalog = backend.catalog;
  return {
    roots: async () => {
      const self = catalog.selfHost() ?? thisBox();
      const chats = await backend.chats.ids();
      return rootsOf([...catalog.daemonRows(), ...catalog.remoteRows()].filter(isTopLevel).map(row => ({ sessionId: row.sessionId,
        ...(row.activeSessionId ? { activeSessionId: row.activeSessionId } : {}), name: sessionTitle(row), host: catalog.hostOf(row.sessionId) ?? self,
        status: row.activity ?? row.lifecycle ?? "unknown", ...(row.lifecycle ? { lifecycle: row.lifecycle } : {}) })), chats);
    },
    // The message waits on disk and the outbox delivers it, so the sender's kernel gets its receipt before the daemon answers (src/agent-outbox.ts).
    send: async (sessionId, message) => {
      await backend.messages.deliver(sessionId, message, sessionId);
      return { deliveryStatus: "queued", target: { sessionId } };
    },
    reopen: sessionId => reopenSession(catalog, { agentDir: getAgentDir() }, sessionId),
  };
}

function threadId(value: string): string {
  if (!idPattern.test(value)) throw new RequestError(400, "Invalid thread ID.");
  return value;
}
function archiveAudit(req: IncomingMessage, targetSessionId: string): (outcome: "started" | "completed" | "failed") => void {
  const requestId = randomUUID();
  const claim = req.headers["x-chat-agent-session"];
  const sessionId = typeof claim === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claim) ? claim : null;
  const agent = req.headers["user-agent"] ?? "";
  const userAgent = agent === "node" || agent === "undici" ? "node" : agent.startsWith("curl/") ? "curl"
    : agent.startsWith("python-") || agent.startsWith("Python/") ? "python" : agent.startsWith("Mozilla/") ? "browser" : agent ? "other" : "missing";
  return outcome => {
    try {
      process.stderr.write(JSON.stringify({ event: "chat_archive", at: new Date().toISOString(), requestId, targetSessionId, outcome,
        unverifiedClientClaims: { sessionId, userAgent } }) + "\n");
    } catch {}
  };
}
/**
 * Who asks for a Stop or Archive of a job: the owner, or the chat that owns the job when the body says `by: "chat"` with that chat's session id
 * in `chat`. On 10-21 at 08:11:31Z a job of chat-057a stopped vent's finished job at vent's request through this route, and the cancel could only
 * say the owner asked. The chat must be one this service holds, shown or archived.
 */
async function askerOf(body: Record<string, unknown>, chats: { ids(): Promise<ReadonlySet<string>>; archivedIds(): Promise<ReadonlySet<string>> }): Promise<CancelBy> {
  if (body.by !== "chat") return { by: "owner" };
  const asker = parseCancelBy(body);
  if (asker?.by !== "chat") throw new RequestError(400, "Name the asking chat's session id in chat.");
  if (!(await chats.ids()).has(asker.chat) && !(await chats.archivedIds()).has(asker.chat)) throw new RequestError(400, `${asker.chat} is not a chat of this service.`);
  return asker;
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
/**
 * Who changes a check-in through this API. The page token proves the caller can reach the page, and an agent driving the owner's browser has
 * it too (10-10 12:54Z: one agent session paused 9 chats from the owner's tab), so it says nothing about who asks. The owner's page marks its
 * check-in requests with `X-Chat-Owner-Ui: 1`; an agent names itself with `X-Chat-Agent-Session: <session id>`, which wins; any other caller
 * is an agent nobody named.
 */
function checkInActor(req: IncomingMessage): CheckInActor {
  const session = req.headers["x-chat-agent-session"];
  if (typeof session === "string") return { by: "agent", setter: idPattern.test(session) ? session : UNKNOWN_AGENT };
  return req.headers["x-chat-owner-ui"] === "1" ? OWNER_UI : { by: "agent", setter: UNKNOWN_AGENT };
}
/** One service.log line per `POST api/accounts`: the action, its thread, and who asked (checkInActor's headers), from which address and client. */
export function accountActionLine(action: AccountAction, req: IncomingMessage): string {
  const actor = checkInActor(req);
  const who = actor.by === "owner" ? "the owner's page" : actor.setter === UNKNOWN_AGENT ? "an unnamed caller" : `agent ${actor.setter}`;
  const target = "account" in action && action.account ? ` ${action.account}` : "";
  const thread = "id" in action && action.id ? ` on ${action.id}` : "";
  const agent = String(req.headers["user-agent"] ?? "-").slice(0, 80);
  return `accounts: ${action.action}${target} (${action.provider})${thread} by ${who} from ${req.socket.remoteAddress ?? "-"} (${agent})`;
}
/** The kind of thread `POST api/threads` creates: a plain thread, or a chat. */
function parseCheckInChange(body: Record<string, unknown>): CheckInChange {
  const change: CheckInChange = {};
  if (body.everyMs !== undefined) {
    if (!validCheckInEvery(body.everyMs)) throw new RequestError(400, `Use whole minutes, ${CHECK_IN_MIN_MINUTES} or more.`);
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
function parseNewChatAccount(value: unknown): { provider: string; id: string } | undefined {
  if (value === undefined || value === null) return undefined;
  const account = record(value);
  const id = text(account.id, "account.id", 256);
  if (id.startsWith("-")) throw new RequestError(400, "Choose an account.");
  return { provider: text(account.provider, "account.provider", 64), id };
}
function parseAccountAction(body: Record<string, unknown>): AccountAction {
  const provider = text(body.provider, "provider", 64);
  const account = typeof body.account === "string" ? text(body.account, "account", 256) : undefined;
  const id = typeof body.id === "string" ? threadId(body.id) : undefined;
  switch (body.action) {
    case "use": if (!account || !id) throw new RequestError(400, "Choose an account and a thread."); return { action: "use", provider, account, id };
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
  if (!Array.isArray(value) || !value.every(id => typeof id === "string")) throw new RequestError(400, "Expected thread IDs.");
  return [...new Set(value.map(id => threadId(id)))];
}
function parseLabelAction(body: Record<string, unknown>): LabelAction {
  const tagId = () => text(body.tagId, "tagId", 64);
  const name = () => text(body.name, "name");
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
    default: throw new RequestError(400, "Unknown label action.");
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

/** The chat header's Slack dialog: connect (with the channel's name and visibility, or an existing channel), rename, or stop. */
function parseSlackChatInput(body: Record<string, unknown>): SlackChatInput {
  const name = (): string => {
    if (typeof body.name !== "string") throw new RequestError(400, "name must be a channel name.");
    const error = channelNameError(body.name);
    if (error) throw new RequestError(400, error);
    return body.name;
  };
  switch (body.action) {
    case "connect": {
      const input: SlackChatInput = { action: "connect" };
      if (body.existing !== undefined) {
        if (typeof body.existing !== "string" || !body.existing.trim()) throw new RequestError(400, "existing must be a channel id or #name.");
        input.existing = body.existing.trim();
      } else {
        if (body.name !== undefined) input.name = name();
        if (body.isPrivate !== undefined) { if (typeof body.isPrivate !== "boolean") throw new RequestError(400, "isPrivate must be true or false."); input.isPrivate = body.isPrivate; }
      }
      return input;
    }
    case "rename": return { action: "rename", name: name() };
    case "stop": return { action: "stop" };
    default: throw new RequestError(400, "action must be connect, rename or stop.");
  }
}

/** A new chat's Slack channel: absent for no sync, else its name (the default when empty) and visibility. */
function parseSlackSetup(value: unknown): SlackChannelSetup | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new RequestError(400, "slack must be { name, isPrivate } or absent.");
  const setup = value as Record<string, unknown>;
  if (typeof setup.name !== "string") throw new RequestError(400, "slack.name must be a channel name.");
  const error = channelNameError(setup.name);
  if (error) throw new RequestError(400, error);
  if (setup.isPrivate !== undefined && typeof setup.isPrivate !== "boolean") throw new RequestError(400, "slack.isPrivate must be true or false.");
  return { name: setup.name, isPrivate: setup.isPrivate !== false };
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

export async function startChatServer({ backend, bundle, port, listenFd = null, early = null, capability, csrfToken, publicOrigin = null, remote = fixedRemote(publicOrigin, capability), slack = null, sdk = null, identity, stopToken, onStop, identityReady = Promise.resolve(), logins = new AccountLogins(), refreshes = new UsageRefreshes(), wikiPage = readWikiPage, tailnetOwner = async () => null }: {
  backend: ChatBackend; bundle: ClientBundle | Promise<ClientBundle>; port: number; capability: string; csrfToken: string;
  /** The port's socket that systemd holds across restarts (`takeListenFd`); the server listens on it instead of binding `port`. */
  listenFd?: number | null;
  /** The server a starting service already listens on and answers page shells with (src/early-shell.ts); it gets every request from here on. */
  early?: EarlyShell | null;
  identity: { pid: number; instanceId: string; socketPath: string }; stopToken: string; publicOrigin?: string | null;
  /** Phone access: which remote HTTPS origin is allowed right now, and the Settings view and switches. */
  remote?: RemoteControl;
  /** Settings > Slack; null for instances that run no Slack bridge (tests, extra data dirs). */
  slack?: SlackControl | null;
  /** Settings > Updates and the SDK auto-update; null for instances that do not manage their packages. */
  sdk?: SdkSync | null;
  onStop(): Promise<void>; identityReady?: Promise<void>; logins?: AccountLogins; refreshes?: UsageRefreshes;
  /** How `api/wiki-page` reads a page; a probe points it at its own wiki and content folder. */
  wikiPage?: (path: string) => Promise<WikiPageView>;
  /** The tailnet login whose devices may open the chat from the bare tailnet URL (`tailnetOwner` in chat-remote.ts); null turns that off. */
  tailnetOwner?: () => Promise<string | null>;
}): Promise<{ url: string; close(): Promise<void> }> {
  const base = "/" + capability + "/";
  let owner: Promise<string | null> | undefined;
  const ownerLogin = () => owner ??= tailnetOwner().catch(() => null);
  /** The serving process builds the page bundle after it listens; a feed names the build once it exists (a failed build was logged there). */
  /**
   * The build event names the build and its hashed asset names, so a page on older code fetches them into its cache before it reloads
   * (client/build-reload.ts `warmAssets`) and the reload paints from cache instead of pulling app.js over the 185 ms link from Korea.
   */
  const sendBuild = (send: (build: { version: string; assets: string[] }) => void) => {
    void Promise.resolve(bundle).then(built => send({ version: built.version, assets: [assetName("app", "js", built.js), assetName("app", "css", built.css), ...built.preload ?? []] }), () => {});
  };
  const tools = toolChecks({ dutyStore: backend.duties?.store, ...backend.boards ? { file: join(dirname(backend.boards.dir), TOOL_CHECKS_FILE) } : {} });
  const hosts = hostsView({ title: id => backend.catalog.title(id), picks: () => backend.newChat.picks(),
    rows: name => name === null ? backend.catalog.daemonRows() : backend.catalog.remoteHosts().find(({ host }) => host.name === name)?.rows ?? [],
    ...backend.calls ? { hung: () => backend.calls!.hung() } : {},
    selfQueue: async () => backend.agentQueue ? (await backend.agentQueue.view()).pool : { state: "unread", error: "This chat instance runs no agent queue." } });
  const creations = new Bounded<{ fingerprint: string; result: Promise<{ id: string; notice?: string }> }>(200);
  let host = "";
  let closing: Promise<void> | undefined;

  const server = early?.server ?? createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 30;
  server.on("clientError", (_error, socket) => { socket.destroy(); });
  /** A thread feed's `side` frames (src/shared/thread-side.ts): job costs at once, then the chat's duties and the accounts list as each is read. */
  const pushSide = (id: string, send: (side: ThreadSide) => void) => {
    const fail = (what: string) => (error: unknown) => { process.stderr.write(`side ${id.slice(0, 8)} ${what}: ${error instanceof Error ? error.message : String(error)}\n`); };
    try { send({ childUsage: backend.catalog.childUsage(id) }); } catch (error) { fail("job costs")(error); }
    const duties = backend.duties;
    if (duties) void backend.chats.ids().then(async chats => { if (chats.has(id)) send({ duties: await duties.view(id) }); }).catch(fail("duties"));
    const model = backend.threads.state(id)?.info.model?.id ?? null;
    void listAccounts(id, model).then(view => send({ accounts: { model, view } }), fail("accounts"));
  };
  const feeds = new FeedSockets(async (feed, send) => {
    if (feed.feed === "sessions") {
      sendBuild(build => send("build", build));
      if (!feed.delta) return backend.catalog.subscribe(event => send("sessions", event));
      const diff = new SessionsDiff();
      const held = feed.have ? parseHave(feed.have) : null;
      if (held) diff.resume(held);
      return backend.catalog.subscribe(event => { const frame = diff.frame(withoutAgents(feed.archived ? event : withoutArchived(event))); if (frame) send("sessions", frame); });
    }
    if (feed.feed === "agents") {
      if (feed.delta) {
        const diff = new AgentsDiff(feed.have ? parseHave(feed.have) : null);
        return backend.catalog.watch(event => { const frame = diff.frame(agentsView(event.sessions, feed.id)); if (frame) send("agents", frame); });
      }
      let sent = "";
      return backend.catalog.watch(event => {
        const view = agentsView(event.sessions, feed.id);
        const text = JSON.stringify(view);
        if (text !== sent) { sent = text; send("agents", view); }
      });
    }
    if (feed.feed === "login") return logins.subscribe(login => send("login", login));
    if (feed.feed === "refresh") return refreshes.subscribe(refresh => send("refresh", refresh));
    if (feed.feed === "usage") {
      if (!backend.usage) throw new Error("Usage analytics is off in this chat.");
      return backend.usage.subscribe(reading => send("usage", reading));
    }
    try {
      const id = threadId(feed.id);
      const stop = await backend.threads.subscribe(id, event => send("thread", wireEvent(event)), false, feed.have, feed.delta === true);
      pushSide(id, side => send("side", side));
      return stop;
    } catch (error) {
      send("thread", { type: "status", connection: "closed", error: error instanceof Error ? error.message : String(error) });
      return () => {};
    }
  });
  if (!early) server.on("upgrade", (req, socket, head) => { upgrade(req, socket, head); });

  /**
   * JSON over 8 KB and the page's assets go out gzipped when the browser takes it. The Mac in Korea reads this box at about 370 KB/s, and on
   * 10-18 app.js (651 KB), app.css (172 KB) and api/models (255 KB) went out raw, so each reload after a release spent about 2 s on app.js.
   */
  const gzips = (req: IncomingMessage | undefined) => /\bgzip\b/.test(String(req?.headers["accept-encoding"] ?? ""));
  function json(res: ServerResponse, status: number, value: unknown) { jsonText(res, JSON.stringify(value), status); }
  function jsonText(res: ServerResponse, body: string, status = 200) {
    if (body.length > 8192 && gzips(res.req)) {
      const packed = gzipSync(body, { level: 1 });
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip", Vary: "Accept-Encoding", "Content-Length": packed.length });
      res.end(packed);
      return;
    }
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
  }
  /**
   * The JSON block of a thread's first frames for the shell, or null when it takes longer than `inlineWaitMs`. From Korea the page's own socket brings
   * them about three round trips (560 ms) after the shell, so a shell that waits longer than that for them is slower than going without.
   */
  const inlineWaitMs = 400;
  async function inlineFrames(id: string): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), inlineWaitMs); });
    const frames = backend.threads.firstFrames(id).catch((error: unknown) => {
      process.stderr.write(`${new Date().toISOString()} shell ${id.slice(0, 8)}: no inline page: ${error instanceof Error ? error.message : String(error)}\n`);
      return null;
    });
    try { return await Promise.race([frames, late]); } finally { clearTimeout(timer); }
  }
  /** The still view of chat `id` from its first page, kept while the page is the same text; empty when the build has no server half or the render throws. */
  let prepainted: { json: string; html: string } | null = null;
  function prepaintFor(built: ClientBundle, id: string, json: string): string {
    if (prepainted?.json === json) return prepainted.html;
    let html = "";
    try {
      const page = built.prepaint?.prepaintLines(id, json);
      if (page) html = prepaintHtml(page);
    } catch (error) { process.stderr.write(`${new Date().toISOString()} shell ${id.slice(0, 8)}: no still view: ${error instanceof Error ? error.message : String(error)}\n`); }
    prepainted = { json, html };
    return html;
  }
  /** The wiki origin from hosts.json, read again at most every 30 s and behind the shell, so a shell never waits on the file. */
  let wikiLast: string | null | undefined;
  let wikiAt = 0;
  function wikiCached(): Promise<string | null> | string | null {
    if (Date.now() - wikiAt < 30_000 && wikiLast !== undefined) return wikiLast;
    wikiAt = Date.now();
    const next = wikiOrigin().then(found => { wikiLast = found; return found; }, () => wikiLast ?? null);
    return wikiLast === undefined ? next : wikiLast;
  }
  /**
   * The shell goes out as a packed stream: its head is flushed at once, so the browser fetches app.js and opens the socket while the server
   * still reads the thread's first page, and the tail with that page follows (brotli at quality 5 packs it in about a millisecond).
   */
  function startHtml(req: IncomingMessage, res: ServerResponse): { write(text: string): void; end(text: string): void } {
    const accepts = String(req.headers["accept-encoding"] ?? "");
    const encoding = /\bbr\b/.test(accepts) ? "br" : gzips(req) ? "gzip" : null;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...(encoding ? { "Content-Encoding": encoding } : {}), Vary: "Accept-Encoding" });
    if (!encoding) return { write: text => { res.write(text); }, end: text => { res.end(text); } };
    const packer = encoding === "br" ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }) : createGzip({ level: 6 });
    packer.pipe(res);
    packer.on("error", () => { res.destroy(); });
    return { write: text => { packer.write(text); packer.flush(); }, end: text => { packer.end(text); } };
  }
  const packedAssets = new WeakMap<Asset, Buffer>();
  /** `immutable` for a hashed name (`assetName`): its body never changes, so the browser asks again only after a release renames it. */
  function serveAsset(req: IncomingMessage, res: ServerResponse, asset: Asset, immutable = false) {
    const caching = immutable ? "public, max-age=31536000, immutable" : "no-cache";
    if (req.headers["if-none-match"] === asset.etag) { res.writeHead(304, { ETag: asset.etag, "Cache-Control": caching, Vary: "Accept-Encoding" }); res.end(); return; }
    const accepts = String(req.headers["accept-encoding"] ?? "");
    let packed: { body: Buffer; encoding: string } | null = null;
    if (asset.br && /\bbr\b/.test(accepts)) packed = { body: asset.br, encoding: "br" };
    else if (asset.body.length > 1024 && gzips(req)) {
      let gzip = asset.gzip ?? packedAssets.get(asset);
      if (!gzip) { gzip = gzipSync(asset.body, { level: 9 }); packedAssets.set(asset, gzip); }
      packed = { body: gzip, encoding: "gzip" };
    }
    const body = packed?.body ?? asset.body;
    res.writeHead(200, { "Content-Type": asset.contentType, ...(packed ? { "Content-Encoding": packed.encoding } : {}), Vary: "Accept-Encoding", ETag: asset.etag, "Cache-Control": caching, "Content-Length": body.length });
    res.end(body);
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      feeds.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      await logins.close();
      await refreshes.close();
      await backend.close();
    })();
    return closing;
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
    feeds.accept(req, socket, head, parseUrlSubscriptions(url.searchParams.get("subs")));
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    timeRead(req, res, base);
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
      // https://<machine>.<tailnet>.ts.net/ opens the chat on the owner's own tailnet devices, also after the http://<machine>/ short-name
      // redirect, which arrives cross-site. tailscale serve sets Tailscale-User-Login and drops a client's own, and funnel visitors get none.
      const login = req.headers["tailscale-user-login"];
      if (origin !== `http://${host}` && url.pathname === "/" && req.method === "GET" && typeof login === "string" &&
        req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document" && login === await ownerLogin()) {
        res.writeHead(302, { Location: base }); res.end(); return;
      }
      if (url.origin !== origin || !url.pathname.startsWith(base)) throw new RequestError(404, "Not found.");
      // The diagram frame is sandboxed with an opaque origin, so its page request arrives cross-site. The page is static.
      const frameRoute = url.pathname.slice(base.length);
      if (req.method === "GET" && frameRoute === "render" && req.headers["sec-fetch-dest"] === "iframe") {
        res.removeHeader("X-Frame-Options");
        res.setHeader("Content-Security-Policy", renderPolicy(origin));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(renderPage); return;
      }
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
          const js = assetName("app", "js", built.js), css = assetName("app", "css", built.css);
          if (route === "") {
            const named = url.searchParams.get("t");
            const id = named && idPattern.test(named) ? named : null;
            const frames = id ? inlineFrames(id) : Promise.resolve(null);
            const [wiki, chats] = await Promise.all([wikiCached(), backend.chats ? backend.chats.ids().catch(() => []) : []]);
            const html = startHtml(req, res);
            html.write(shellHead(csrfToken, built.version, wiki, { js, css, ...built.preload ? { preload: built.preload } : {} }, chats));
            const found = await frames;
            html.end(shellTail(id && found ? { id, json: found } : null, id && found && [...chats].includes(id) ? prepaintFor(built, id, found) : ""));
            return;
          }
          if (route === js) { serveAsset(req, res, built.js, true); return; }
          if (route === css) { serveAsset(req, res, built.css, true); return; }
          const chunk = built.chunks && Object.hasOwn(built.chunks, route) ? built.chunks[route] : undefined;
          if (chunk) { serveAsset(req, res, chunk, true); return; }
          // A page from before a restart, or a tool that reads the plain names, gets the current build uncached.
          if (route === "app.js" || /^app\.[0-9a-f]+\.js$/.test(route)) { serveAsset(req, res, built.js); return; }
          if (route === "app.css" || /^app\.[0-9a-f]+\.css$/.test(route)) { serveAsset(req, res, built.css); return; }
          const appFile = built.app?.(route);
          if (appFile) { serveAsset(req, res, appFile); return; }
          // The diagram renderer: the chat page fetches it once and hands it to each sandboxed frame (`renderPage`).
          if (route === "render.js") { serveAsset(req, res, await buildRenderBundle()); return; }
        }
        if (route === "api/labels") { json(res, 200, await backend.labels.snapshot()); return; }
        // The board skill on a box without the chat role reads the chat's files here (skills/board, hosts.json roles.chat).
        if (route === "api/agent/board") {
          const board = await backend.boards.read(threadId(url.searchParams.get("chat") ?? ""));
          if (!board) throw new RequestError(404, "No board for this chat.");
          json(res, 200, board); return;
        }
        if (route === "api/agent/siblings") {
          if (!backend.catalog.hostsListed()) throw new RequestError(503, "Another box has not listed its sessions yet; try again shortly.");
          const roots = await otherBoxRoots(rootDirectory(backend), text(url.searchParams.get("session"), "session", 128)).catch(error => { throw new RequestError(404, (error as Error).message); });
          json(res, 200, { agents: roots.map(siblingRow) }); return;
        }
        if (route === "api/agent/jobs") {
          const text = await readFile(join(dirname(backend.boards.dir), "chat-jobs.json"), "utf8").catch(() => "{\"jobs\":{}}");
          res.writeHead(200, { "Content-Type": "application/json" }); res.end(text); return;
        }
        const name = AGENT_FILES.get(route);
        if (name) {
          const text = await readFile(join(dirname(backend.boards.dir), name), "utf8").catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
          if (text === null) throw new RequestError(404, `No ${name} on the chat host.`);
          res.writeHead(200, { "Content-Type": name.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8" }); res.end(text); return;
        }
        if (route === "api/interrupted") { json(res, 200, await interruptedRuns.check()); return; }
        const usage = /^api\/threads\/([^/]+)\/child-usage$/.exec(route);
        if (usage) { json(res, 200, { children: backend.catalog.childUsage(threadId(decodeURIComponent(usage[1]!))) }); return; }
        const prefetch = /^api\/threads\/([^/]+)\/first-frame$/.exec(route);
        if (prefetch) {
          jsonText(res, await backend.threads.prefetchFrames(threadId(decodeURIComponent(prefetch[1]!)))); return;
        }
        const labels = /^api\/threads\/([^/]+)\/child-labels$/.exec(route);
        if (labels) { json(res, 200, { labels: childLabels(backend.threads.state(threadId(decodeURIComponent(labels[1]!)))?.children ?? []) }); return; }
        if (route === "api/workspaces") { json(res, 200, { workspaces: await backend.catalog.workspaces() }); return; }
        if (route === "api/models") {
          const id = url.searchParams.get("id");
          json(res, 200, await backend.threads.models(id ? threadId(id) : null)); return;
        }
        if (route === "api/commands") { json(res, 200, { commands: await backend.threads.commands(null) }); return; }
        if (route === "api/defaults") { json(res, 200, backend.defaults.read()); return; }
        if (route === "api/new-chat") { json(res, 200, await backend.newChat.read()); return; }
        if (route === "api/remote") { json(res, 200, remote.view(origin === `http://${host}`)); return; }
        if (route === "api/slack") { json(res, 200, slack ? slack.view(origin === `http://${host}`) : null); return; }
        if (route === "api/slack/channels") {
          // The setup dialog's existing-channel list; null when the bot cannot list, so the dialog shows a field for an id or #name instead.
          if (!slack) throw new RequestError(409, "This chat instance runs no Slack bridge.");
          json(res, 200, { channels: await slack.channels().catch(() => null) }); return;
        }
        if (route === "api/sdk") { json(res, 200, sdk ? await sdk.view() : null); return; }
        if (route === "api/hosts") { json(res, 200, await hosts()); return; }
        if (route === "api/agent-queue") {
          if (!backend.agentQueue) throw new RequestError(409, "This chat instance runs no agent queue.");
          json(res, 200, await backend.agentQueue.view()); return;
        }
        if (route === "api/tools") { json(res, 200, await tools.view(false)); return; }
        if (route === "api/skills") { json(res, 200, await skillsView()); return; }
        if (route.startsWith("api/usage/")) {
          const analytics = backend.usage;
          if (!analytics) throw new RequestError(503, "Usage analytics is off in this chat.");
          const query = url.searchParams;
          if (route === "api/usage/series") { json(res, 200, await analytics.series(parseWindow(query.get("window")), parseBucket(query.get("bucket")), parseGroup(query.get("group")), parseMetric(query.get("metric")))); return; }
          if (route === "api/usage/models") { json(res, 200, await analytics.models(parseWindow(query.get("window")))); return; }
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
          const bytes = "bytes" in entry ? entry.bytes : await readFile(entry.path).catch(() => { throw new RequestError(404, "The image file is gone."); });
          res.writeHead(200, { "Content-Type": entry.mimeType, "Content-Length": bytes.length, "Cache-Control": "private, max-age=3600, immutable" });
          res.end(bytes);
          return;
        }
        const thread = /^api\/threads\/([^/]+)\/([a-z-]+)$/.exec(route);
        if (thread) {
          const id = threadId(decodeURIComponent(thread[1]!));
          const action = thread[2];
          if (action === "tool-output") {
            const toolCallId = url.searchParams.get("toolCallId") ?? "";
            if (!toolCallId || toolCallId.length > 512) throw new RequestError(400, "Choose a tool call.");
            json(res, 200, await backend.threads.toolOutput(id, toolCallId)); return;
          }
          if (action === "part") {
            const at = Number(url.searchParams.get("at")); const n = Number(url.searchParams.get("n") ?? 0); const part = Number(url.searchParams.get("part") ?? 0);
            if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(part) || part < 0) throw new RequestError(400, "Choose a message part.");
            json(res, 200, await backend.threads.part(id, { at, n }, part)); return;
          }
          if (action === "older") {
            const cursor = url.searchParams.get("cursor") ?? "";
            if (!cursor || cursor.length > 256) throw new RequestError(400, "Choose where the earlier messages start.");
            json(res, 200, await backend.threads.olderPage(id, cursor)); return;
          }
          if (action === "commands") { json(res, 200, { commands: await backend.threads.commands(id) }); return; }
          // A page that missed a board delta asks for the whole board once (shared/board-delta.ts BoardFollower).
          if (action === "board") { const board = backend.threads.state(id)?.board ?? await backend.boards.view(id); json(res, 200, { board: board && feedBoard(board) }); return; }
          if (action === "stats") { json(res, 200, await backend.threads.stats(id)); return; }
          if (action === "prompt") {
            const via = (url.searchParams.get("via") ?? "").split(",").filter(Boolean).map(threadId);
            const view = backend.prompt ? await backend.prompt(id, via) : null;
            if (!view) throw new RequestError(404, "This session has no session file left.");
            json(res, 200, view); return;
          }
          if (action === "check-in") {
            const view = await backend.chats.checkInView(id);
            if (!view) throw new RequestError(404, "This thread is not a chat.");
            json(res, 200, view); return;
          }
          if (action === "duties") {
            if (!backend.duties || !(await backend.chats.ids()).has(id)) throw new RequestError(404, "This thread is not a chat.");
            json(res, 200, { duties: await backend.duties.view(id) }); return;
          }
          if (action === "duty-brief") {
            const duty = url.searchParams.get("duty") ?? "";
            if (!backend.duties || !(await backend.chats.ids()).has(id)) throw new RequestError(404, "This thread is not a chat.");
            const brief = duty ? await backend.duties.nextBrief(id, duty) : null;
            if (!brief) throw new RequestError(404, "This chat has no such duty.");
            json(res, 200, nextBriefView(id, duty, brief, `Next run of ${(await backend.duties.view(id)).find(view => view.duty.id === duty)?.duty.name ?? duty}`)); return;
          }
          if (action === "agents") {
            // The chat's agents as its row carries them; the chat_board tool reads this for its "Agents:" lines and gives up after 3 s. The last
            // frame's row answers when there is one (Catalog.framedRows); a chat not in it yet gets a projection of its own.
            if (!(await backend.chats.ids()).has(id)) throw new RequestError(404, "This thread is not a chat.");
            const framed = backend.catalog.framedRows()?.find(candidate => candidate.id === id);
            if (framed) { json(res, 200, { agents: framed.agents ?? [] }); return; }
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
      // agent_message.send from a root to a root on another box, which the sender's daemon does not run (src/cross-host-message.ts).
      if (route === "api/agent/message") {
        // Right after a restart the other boxes' roots are not listed yet (10-18 05:14:37Z start, Mac listed 05:14:55Z), and a send then read
        // 'No sibling matches ... on any box either' for Fable and the release owner; 503 tells the sender's kernel to try again.
        if (!backend.catalog.hostsListed()) throw new RequestError(503, "Another box has not listed its sessions yet; try again shortly.");
        const receipt = await sendCrossHost(rootDirectory(backend), text(body.from, "from", 128), text(body.to, "to", 256), text(body.message, "message"))
          .catch(error => { throw new RequestError(409, (error as Error).message); });
        json(res, 200, receipt); return;
      }
      // A sibling send the sender's own daemon refused as "Session worker is failed" or "Unknown active session": open that root from its file.
      if (route === "api/agent/reopen") {
        if (!backend.catalog.hostsListed()) throw new RequestError(503, "Another box has not listed its sessions yet; try again shortly.");
        const answer = await reopenSibling(rootDirectory(backend), text(body.from, "from", 128), text(body.to, "to", 256))
          .catch(error => { throw new RequestError(409, (error as Error).message); });
        json(res, 200, answer); return;
      }
      // An agent_message.send the daemon refused for the target's pending message limit: it waits in the agent outbox (message-limit-check.py).
      if (route === "api/agent/queue") {
        const from = record(body.from);
        const role = body.role === "child" || body.role === "parent" || body.role === "sibling" ? body.role : undefined;
        if (!role) throw new RequestError(400, "Choose role child, parent or sibling.");
        const count = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
        const pending = count(body.pending), limit = count(body.limit);
        json(res, 200, await backend.messages.queue({ session: threadId(text(body.to, "to", 128)), text: text(body.message, "message"),
          from: { id: text(from.id, "from.id", 128), name: text(from.name, "from.name") }, role, behind: body.behind === true,
          ...pending === undefined ? {} : { pending }, ...limit === undefined ? {} : { limit },
          ...typeof body.root === "string" ? { root: threadId(body.root) } : {} })); return;
      }
      // The chat tools of a session on a box without the chat role (src/chat-host.ts): its check-in setting, the job registry and the ledger.
      if (route === "api/agent/check-in") {
        const chat = threadId(text(body.chat, "chat", 128));
        const settings = checkInSettings(join(dirname(backend.boards.dir), "check-in-settings.json"));
        const now = Date.now();
        const changed = body.change === undefined ? [] : [await chatCheckIn(settings, chat, parseChatCheckIn(body.change), now)];
        json(res, 200, { changed, line: checkInLine(await settings.get(chat), now) }); return;
      }
      if (route === "api/agent/jobs") {
        const jobs = jobRegistry(join(dirname(backend.boards.dir), "chat-jobs.json"));
        const names = Array.isArray(body.names) ? body.names.filter((name): name is string => typeof name === "string") : [];
        if (body.op === "add") await jobs.add(names, text(body.chat, "chat", 256), typeof body.chatId === "string" ? body.chatId : undefined);
        else if (body.op === "remove") await jobs.remove(names);
        else throw new RequestError(400, "Send {op: add|remove, names, chat?, chatId?}.");
        json(res, 200, { ok: true }); return;
      }
      if (route === "api/agent/corrections") {
        const call = parseCorrectionCall(body.call);
        const chat = record(body.chat);
        const ref = { id: threadId(text(chat.id, "chat.id", 128)), name: typeof chat.name === "string" ? chat.name : "" };
        // A clean-room chat's owner messages are the script's, so its corrections go to a scratch ledger no other chat reads (extension/index.ts).
        const dataDir = dirname(backend.boards.dir);
        const cleanRoom = await new IdIndex(join(dataDir, CLEAN_ROOM_CHATS_FILE), "Clean-room chat index").ids().then(ids => ids.includes(ref.id), () => false);
        const ledger = new CorrectionLedger(dataDir, cleanRoom ? CLEAN_ROOM_CORRECTIONS_FILE : undefined);
        json(res, 200, { text: correctionResult(await ledger.apply(call, ref)) }); return;
      }
      if (route === "api/agent/wakes") {
        // board.wake from a box without the chat role: the same file it writes on the chat host, delivered through that box's relay (src/wakes.ts).
        const wake = parseWake(body);
        if (!wake) throw new RequestError(400, "Send {session, on: {kind: run|time, ...}, note, since}.");
        const key = wake.on.kind === "run" ? `run-${wake.on.run}` : `time-${Math.floor(wake.on.at / 1000)}`;
        const folder = join(dirname(backend.boards.dir), "wakes");
        const path = join(folder, `${wake.session}-${key}.json`);
        await writeFile(`${path}.tmp`, JSON.stringify(wake), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
        json(res, 200, { path }); return;
      }
      if (route === "api/threads") {
        const id = requestId(body.requestId);
        // The hosts.json box the New chat picker chose; absent means the box this service runs on.
        const host = typeof body.host === "string" ? text(body.host, "host", 64) : undefined;
        // Another box's folder is on its disk, so its daemon checks it when it starts the session.
        const cwd = backend.catalog.isOtherHost(host) ? remoteWorkspace(text(body.cwd, "cwd", 1024), host!) : await resolveWorkspace(text(body.cwd, "cwd", 1024));
        const message = text(body.message, "message");
        const images = parseImages(body.images);
        if (!message.trim() && !images.length) throw new RequestError(400, "Add a message or image.");
        const provider = typeof body.provider === "string" ? text(body.provider, "provider", 128) : undefined;
        const modelId = typeof body.modelId === "string" ? text(body.modelId, "modelId", 256) : undefined;
        const thinkingLevel = typeof body.thinkingLevel === "string" ? text(body.thinkingLevel, "thinkingLevel", 16) as ThinkingLevel : undefined;
        const account = parseNewChatAccount(body.account);
        const name = typeof body.name === "string" ? text(body.name, "name").trim() : "";
        const kind = parseKind(body.kind);
        // A clean-room fixture's name is set before its first message goes (ThreadHub.create).
        const nameBeforeFirst = body.nameBeforeFirst === true;
        const syncSlack = kind === "chat" ? parseSlackSetup(body.slack) : undefined;
        const fingerprint = createHash("sha256").update(JSON.stringify([cwd, host, provider, modelId, thinkingLevel, message, images, account, name, kind, nameBeforeFirst, syncSlack])).digest("hex");
        let creation = creations.get(id);
        if (creation && creation.fingerprint !== fingerprint) throw new RequestError(409, "This request ID belongs to another new chat.");
        if (!creation) {
          creation = { fingerprint, result: (async () => {
            // Every send to a chat is a steer, so the owner's text lands after the current tool batch and the queue stays invisible.
            const mode = kind === "chat" ? "steer" : "followUp";
            // Text with no account to set first rides on the create, which sends it before its attach (ThreadHub.create). That includes the text the
            // New chat box starts with its start skill (startMessage): on 10-20 the owner's start skill was poteto-mode, so every first message he
            // sent began with "/skill:poteto-mode " and took the old path, the create's answer, then a commands lookup, then the prompt.
            const slash = message.trimStart().startsWith("/");
            const startSkill = slash ? (await backend.newChat.read().catch(() => ({ startSkill: null }))).startSkill : null;
            const plain = !slash || (startSkill !== null && message.startsWith(`/skill:${startSkill} `));
            const first = !account && !images.length && plain ? { message, mode } as const : undefined;
            const input = { cwd, ...(provider ? { provider } : {}), ...(modelId ? { modelId } : {}), ...(thinkingLevel ? { thinkingLevel } : {}), ...(host ? { host } : {}),
              ...(name ? { name } : {}), ...(first ? { first } : {}), ...(nameBeforeFirst ? { nameBeforeFirst } : {}) };
            // A chat is created with its name (a job replies to it by name), pinned and set to steering mode all; the server tick does its check-ins.
            const thread = kind === "chat" ? await backend.chats.create(input) : await backend.threads.create(input);
            // Both kinds go in threads.json: a thread this server created is the person's (origin "user"), whatever its session file says.
            await Promise.all([backend.created.add(thread.id).catch(() => {}), backend.newChat.remember(host ?? backend.catalog.selfHost() ?? thisBox(), cwd).catch(() => {})]);
            if (account) {
              // The account is set on the new session before the prompt, so its first model request already uses it. A failed use sends nothing.
              try { await runAccountAction({ action: "use", provider: account.provider, account: account.id, id: thread.id, newSession: true }); }
              catch (error) {
                await backend.threads.archive(thread.id, "service_cleanup").catch(() => {});
                if (kind === "chat") await backend.chats.forget(thread.id).catch(() => {});
                throw new RequestError(502, error instanceof Error ? error.message : String(error));
              }
            }
            // A thread the owner starts is high in the pool; its first turn is already admitted at once as the owner's (ThreadHub.prompt).
            await backend.poolPriorities?.set(thread.id, "high");
            if (!first) await backend.threads.prompt(thread.id, { message, images, mode, owner: true });
            // The chat exists either way; a Slack refusal comes back as a notice and the header switch can try again.
            if (syncSlack) {
              const failure = !slack ? "This chat instance runs no Slack bridge." : await slack.chat(thread.id, { action: "connect", ...syncSlack }).then(() => null, (error: unknown) => error instanceof Error ? error.message : String(error));
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
        const action = parseLabelAction(body);
        const result = await backend.labels.apply(action);
        await backend.catalog.notify();
        if (action.op === "priority") void backend.poolPriorities?.sync();
        json(res, 200, { ok: true, ...result }); return;
      }
      if (route === "api/defaults") {
        await backend.defaults.write(parseDefaults(body, await backend.threads.models(null)));
        json(res, 200, backend.defaults.read()); return;
      }
      if (route === "api/new-chat/prewarm") {
        // The New chat box asks for a spare session on another box while the owner writes; host null drops it (ThreadHub.prewarm).
        const host = typeof body.host === "string" ? text(body.host, "host", 64) : null;
        const ready = host && typeof body.cwd === "string" && backend.catalog.isOtherHost(host) ? await backend.threads.prewarm({ host, cwd: remoteWorkspace(text(body.cwd, "cwd", 1024), host),
          ...(typeof body.provider === "string" && typeof body.modelId === "string" ? { provider: text(body.provider, "provider", 128), modelId: text(body.modelId, "modelId", 256) } : {}),
          ...(typeof body.thinkingLevel === "string" ? { thinkingLevel: text(body.thinkingLevel, "thinkingLevel", 16) as ThinkingLevel } : {}) }) : await backend.threads.prewarm(null);
        json(res, 200, { ready }); return;
      }
      if (route === "api/new-chat") {
        let startSkill: string | null;
        try { startSkill = parseStartSkill(body.startSkill); } catch (error) { throw new RequestError(400, error instanceof Error ? error.message : String(error)); }
        json(res, 200, await backend.newChat.write({ startSkill })); return;
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
        // Settings > Updates, Update all chats: every chat reloads onto the current brief, an idle one now, a busy one when its turn ends; the rows show the progress.
        json(res, 200, { chats: await backend.chats.updateAll() }); return;
      }
      if (route === "api/interrupted") {
        json(res, 200, await interruptedRuns.resume(async sessionId => {
          await backend.threads.abort(sessionId);
          // A native abort holds the session's input until the next human prompt; reopen it so its head's message gets through.
          await backend.threads.resumeQueue(sessionId).catch(() => {});
        }, async sessionId => { await backend.threads.resume(sessionId); }));
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
      if (route === "api/agent-queue") {
        if (!backend.agentQueue) throw new RequestError(409, "This chat instance runs no agent queue.");
        let input: AgentQueueInput;
        try { input = parseAgentQueueInput(body); } catch (error) { throw new RequestError(400, error instanceof Error ? error.message : String(error)); }
        json(res, 200, await backend.agentQueue.apply(input).catch(error => { throw new RequestError(502, error instanceof Error ? error.message : String(error)); })); return;
      }
      if (route === "api/tools/check") { json(res, 200, await tools.view(true)); return; }
      if (route === "api/remote/check") { await remote.check(); json(res, 200, remote.view(origin === `http://${host}`)); return; }
      if (route === "api/warm") { await backend.threads.warm(threadId(text(body.id, "id", 256))); json(res, 200, { ok: true }); return; }
      if (route === "api/accounts") {
        const action = parseAccountAction(body);
        const notice = await runAccountAction(action);
        // The pool's own log names no caller: on 10-19 a pin of chat 01a15427 to an Off account (12:33:52Z to 12:36:07Z) could not be traced.
        process.stderr.write(`${new Date().toISOString()} ${accountActionLine(action, req)}\n`);
        // A thread moved to another account goes again now if its turn failed or waits on a provider retry.
        if ((action.action === "use" || action.action === "follow") && action.id) await backend.chats.retryNow(action.id);
        json(res, 200, { ...await listAccounts("id" in action ? action.id : null), ...(notice ? { notice } : {}) }); return;
      }
      if (route === "api/accounts/login") {
        const account = body.account === undefined || body.account === null ? null : text(body.account, "account", 256);
        if (body.off !== undefined && typeof body.off !== "boolean") throw new PoolError(400, "off must be a boolean.");
        json(res, 200, logins.start(text(body.provider, "provider", 64), account, body.off === true)); return;
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
          // The answer comes once the send is on disk; the outbox delivers it to the daemon and the thread feed shows where it is (src/outbox.ts).
          const rid = requestId(body.requestId);
          const message = text(body.message, "message");
          const images = parseImages(body.images);
          const mode = (await backend.chats.ids()).has(id) || (await backend.chats.archivedIds()).has(id) ? "steer" : parseMode(body.mode);
          if (!message.trim() && !images.length) throw new RequestError(400, "Add a message or image.");
          await backend.chats.reopenJob(id);
          const fingerprint = createHash("sha256").update(JSON.stringify([id, message, images, mode])).digest("hex");
          try { json(res, 200, await backend.outbox.submit({ id: rid, threadId: id, text: message, images, mode, fingerprint })); }
          catch (error) { throw error instanceof OutboxConflict ? new RequestError(409, error.message) : error; }
          return;
        }
        case "abort": {
          // The owner's Stop of a job is his cancel, recorded before the abort so the parent's child-exited notice already reads it. A chat that
          // asks for the Stop names itself (`askerOf`). A clean-room stall that stands in for an interruption sends cancel: false.
          const chat = (await backend.chats.ids()).has(id);
          const asker = await askerOf(body, backend.chats);
          if (!chat && body.cancel !== false) await backend.chats.cancelJob(id, "stop", asker);
          if (body.cancel !== false) backend.threads.ownerStopped(id);
          await backend.threads.abort(id);
          if (chat) await backend.threads.resumeQueue(id);
          break;
        }
        case "archive": {
          const audit = archiveAudit(req, id);
          audit("started");
          const chat = await backend.chats.archivesAsChat(id);
          // A script's teardown of a thread it made names a service reason, so neither Prime's owner_archive line nor a job cancel reads as the owner's.
          const by: ArchiveBy = isServiceArchiveReason(body.by) ? body.by : "owner";
          const asker = await askerOf(body, backend.chats);
          try {
            if (chat) await backend.chats.archive(id, by);
            else await backend.chats.archiveJob(id, by, asker);
          } catch (error) {
            // The archive holds and the saved archive queue retries the cancel of its scheduled jobs: on 10-20 06:26:34Z that case answered 502.
            if (!(error instanceof ScheduledJobsLeft && error.retrying)) { audit("failed"); throw error; }
            audit("completed");
            if (chat) await backend.catalog.notify();
            json(res, 200, { ok: true, notice: error.message }); return;
          }
          if (chat) await backend.catalog.notify();
          audit("completed");
          break;
        }
        case "unarchive":
          // Undo keeps a chat a chat: its session file still carries the chat_mode entry, so it goes back into the index, pinned, with its check-in.
          await backend.chats.reopenJob(id);
          await backend.threads.supersedeArchive(id);
          await unarchiveOnItsBox(backend.catalog, { agentDir: getAgentDir() }, id);
          await backend.threads.unarchive(id);
          if (await backend.chats.restore(id)) await backend.catalog.notify();
          break;
        case "slack": {
          // A chat's own channel, like archive: any page with the write token may change it. Connecting the workspace stays Mac-only (api/slack).
          // Connect is idempotent: the bridge runs the actions of one chat in turn, so a double click or two tabs make one channel.
          if (!slack) throw new RequestError(409, "This chat instance runs no Slack bridge.");
          if (!(await backend.chats.ids()).has(id)) throw new RequestError(404, "This thread is not a chat.");
          const input = parseSlackChatInput(body);
          if (slack.view(false).state !== "on") throw new RequestError(409, "Slack is not connected. Connect it in Settings > Slack.");
          await slack.chat(id, input).catch(error => { throw new RequestError(400, error instanceof Error ? error.message : String(error)); });
          json(res, 200, slack.view(origin === `http://${host}`)); return;
        }
        case "board": {
          // The owner's side of the chat board: todo ops. The chat then gets a steer that says in plain words what the owner did.
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
          try { await backend.threads.prompt(id, { message: BOARD_PREFIX + applied.summaries.join("; "), images: [], mode: "steer", owner: true }); }
          catch (failure) { sent = false; error = failure instanceof Error ? failure.message : String(failure); }
          json(res, 200, { board, sent, ...(error ? { error } : {}) }); return;
        }
        case "agent-board": {
          // A session's chat_board write (agentOpsViaService), judged by this release's gates; with others, tell_owner's read of other chats' asks.
          try { json(res, 200, await applyAgentOps(dirname(backend.boards.dir), id, body.ops, body.others === true)); return; }
          catch (error) {
            if (error instanceof BoardError) throw new RequestError(error.kind === "forbidden" ? 403 : error.kind === "unknown" ? 409 : 400, error.message);
            throw error;
          }
        }
        case "duties": {
          // The owner's Run now, Pause, Resume and cadence on the Duties card; the reply is the chat's duties after the change. The check-in duty's
          // pause and cadence are the chat's check-in setting, the one the header's control sets.
          if (!backend.duties || !(await backend.chats.ids()).has(id)) throw new RequestError(404, "This thread is not a chat.");
          const duty = text(body.duty, "duty", 16);
          const action = body.action;
          if (action !== "run" && action !== "pause" && action !== "resume" && action !== "schedule") throw new RequestError(400, "Choose run, pause, resume or schedule.");
          let found: boolean;
          if (action === "schedule") {
            try { found = await backend.duties.setSchedule(id, duty, body.schedule, checkInActor(req)); }
            catch (error) { throw new RequestError(400, error instanceof Error ? error.message : String(error)); }
          } else found = action === "run" ? await backend.duties.runNow(id, duty) || (await backend.duties.view(id)).some(view => view.duty.id === duty)
            : await backend.duties.setStatus(id, duty, action === "pause" ? "paused" : "active", checkInActor(req));
          if (!found) throw new RequestError(404, "This chat has no such duty.");
          json(res, 200, { duties: await backend.duties.view(id) }); return;
        }
        case "job-steer": {
          // A check-in job's message to a job of its chat (scripts/job-steer.ts): the server delivers it, because a root cannot message a chat's subagents.
          const steered = await backend.chats.steerJob(id, text(body.job, "job", 256), text(body.message, "message"));
          if (!steered) throw new RequestError(404, "This thread is not a chat.");
          if ("jobs" in steered) throw new RequestError(404, `The chat has no job by that name. Its jobs: ${steered.jobs.join(", ") || "none"}.`);
          if ("cancelled" in steered) throw new RequestError(409, steered.cancelled);
          json(res, 200, steered); return;
        }
        case "check-in": {
          // The interval and pause for the chat's check-in, from the owner's page or an agent (checkInActor); the chat changes its own through chat_board.
          const view = await backend.chats.setCheckIn(id, parseCheckInChange(body), checkInActor(req));
          if (!view) throw new RequestError(404, "This thread is not a chat.");
          await backend.catalog.notify();
          json(res, 200, view); return;
        }
        case "rename": {
          const name = text(body.name, "name").trim();
          if (!name) throw new RequestError(400, "Give the thread a name.");
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
          // The sessions feed carries the new unread count; the answer does not wait for that projection, which took 10 to 27 s on 10-18.
          void backend.catalog.notify().catch(() => {});
          break;
        }
        default: throw new RequestError(404, "Not found.");
      }
      json(res, 200, { ok: true });
    } catch (error) {
      const status = error instanceof RequestError || error instanceof ThreadError || error instanceof LabelError || error instanceof PoolError || error instanceof UsageError || error instanceof CheckInRefused ? error.status : error instanceof WorkspaceError ? 400 : 502;
      if (!res.headersSent && !res.destroyed) json(res, status, { error: error instanceof Error ? error.message : "Prime Agent is unavailable." });
    }
  }
  try {
    // The early shell may listen later (early-shell-start.mjs waits for this thread to be free); the address is read only after it does.
    if (early) await early.take((req, res) => { void handle(req, res); }, upgrade);
    else await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      const listening = () => { server.removeListener("error", reject); resolve(); };
      if (listenFd === null) server.listen(port, "127.0.0.1", listening);
      else server.listen({ fd: listenFd }, listening);
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
