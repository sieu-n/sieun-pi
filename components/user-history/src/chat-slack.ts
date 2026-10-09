import WebSocket from "ws";
import type { ChatBackend } from "./chat-backend.ts";
import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { runCommand, type Runner } from "./chat-remote.ts";
import { chatLines } from "./shared/chat-feed.ts";
import { channelName, channelNameError, parseChannelRef } from "./shared/slack-channel.ts";
import type { SlackChannelOption, SlackChatInput, SlackChatLink, SlackInput, SlackView, ThreadEvent, ThreadMessage } from "./shared/types.ts";

/**
 * The Slack bridge: one channel per chat the owner syncs (`#vp-<chat name>` by default, private by default), through Socket Mode (one outbound
 * WebSocket, no public URL). Sync is off for every chat until the owner connects it from the chat's header or the new-chat screen, where the
 * channel's name and visibility are set; archiving the chat archives its channel.
 * In: an owner message in a chat's channel is a steer to that chat, the same call the browser composer makes.
 * Out: the agent lines of `chatLines()` (owner-turn replies and `tell_owner` pings), the lines the browser feed shows on the left.
 * Browser-typed owner messages are not mirrored. Only the configured owner member id in the bot's own team is accepted.
 */

/** The Keychain service that holds the two tokens, as accounts `bot-token` (xoxb-) and `app-token` (xapp-). */
export const KEYCHAIN_SERVICE = "sieun-pi-slack";
/** Environment fallback, for `dotenvx run -- sieun-pi chat serve`. */
export const BOT_TOKEN_ENV = "SIEUN_PI_SLACK_BOT_TOKEN";
export const APP_TOKEN_ENV = "SIEUN_PI_SLACK_APP_TOKEN";
/** The reaction on an owner message while the chat works on it. */
export const WORKING_REACTION = "hourglass_flowing_sand";
/** One Slack `markdown` block takes up to 12,000 characters; a longer reply goes as several messages. */
export const MARKDOWN_LIMIT = 12_000;
/** Lines already posted per chat; older keys are dropped and `since` moves up to the oldest kept one. */
const POSTED_KEEP = 400;
/** A chat whose feed does not open (its session is gone) is tried again after this gap, doubling up to PARK_MAX_MS, and logged once. */
const PARK_MIN_MS = 60_000;
const PARK_MAX_MS = 30 * 60_000;
/**
 * 2026-10-08: sync became opt-in per chat. Once, every channel the bridge had linked by then is unlinked and archived, except the probe's.
 * The id goes into `migrations` in slack.json after it ran, so it never runs again.
 */
export const OPT_IN_MIGRATION = "opt-in-2026-10-08";
export const OPT_IN_KEEP = "vp-slack-bridge-probe";

export type SlackTokens = { bot: string; app: string; source: "keychain" | "environment" };
/** A Web API call with the bot token. Resolves the response body when `ok`, rejects with SlackApiError otherwise. */
export type SlackCall = (method: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;

export class SlackApiError extends Error {
  constructor(readonly code: string, readonly retryAfterMs: number | null = null) { super(`Slack: ${code}`); }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Calls `https://slack.com/api/<method>` form-encoded (every method accepts it); objects and arrays go as JSON strings. */
export function slackCall(token: string, fetcher: typeof fetch = fetch): SlackCall {
  return async (method, args = {}) => {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) if (value !== undefined) body.set(key, typeof value === "string" ? value : JSON.stringify(value));
    const response = await fetcher("https://slack.com/api/" + method, { method: "POST", body, signal: AbortSignal.timeout(20_000),
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" } });
    const retry = Number(response.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(retry) && retry > 0 ? retry * 1000 : null;
    if (response.status === 429) throw new SlackApiError("ratelimited", retryAfterMs ?? 1000);
    const value: unknown = await response.json().catch(() => null);
    if (!isRecord(value)) throw new SlackApiError(`HTTP ${response.status}`);
    if (value.ok !== true) throw new SlackApiError(typeof value.error === "string" ? value.error : "unknown_error", retryAfterMs);
    return value;
  };
}

/** The tokens from the Keychain, else from the environment; null when either is missing or has the wrong prefix. Values are never logged. */
export async function loadSlackTokens(run: Runner = runCommand, env: NodeJS.ProcessEnv = process.env): Promise<SlackTokens | null> {
  const valid = (bot: string | undefined, app: string | undefined) => !!bot?.startsWith("xoxb-") && !!app?.startsWith("xapp-");
  if (process.platform === "darwin") {
    const read = async (account: string) => {
      const result = await run("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], 10_000);
      return result.code === 0 ? result.stdout.trim() : undefined;
    };
    const [bot, app] = await Promise.all([read("bot-token"), read("app-token")]);
    if (valid(bot, app)) return { bot: bot!, app: app!, source: "keychain" };
  }
  const bot = env[BOT_TOKEN_ENV]?.trim(), app = env[APP_TOKEN_ENV]?.trim();
  return valid(bot, app) ? { bot: bot!, app: app!, source: "environment" } : null;
}

/** What Socket Mode tells the bridge: each `hello` (first connect and every reconnect), each Events API payload, and its state. */
export interface SocketListener {
  hello(): void;
  event(payload: Record<string, unknown>): void;
  state(state: "connecting" | "problem", message: string): void;
}
export interface SocketMode { start(listener: SocketListener): void; close(): void }

/**
 * Socket Mode over `ws`: `apps.connections.open` with the app token gives a one-use WSS URL. Every envelope is acked at once, a `disconnect`
 * or a closed socket reconnects with backoff, and a ping every 30 s ends a socket that stopped answering (after the Mac slept).
 */
export class SlackSocket implements SocketMode {
  private ws: WebSocket | null = null;
  private listener: SocketListener | null = null;
  private closed = false;
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly open: () => Promise<string>) {}

  start(listener: SocketListener): void { this.listener = listener; void this.connect(); }

  private async connect(): Promise<void> {
    if (this.closed) return;
    this.listener?.state("connecting", "Connecting to Slack.");
    let url: string;
    try { url = await this.open(); }
    catch (error) { this.reconnect(`Socket Mode did not open: ${errorText(error)}`); return; }
    if (this.closed) return;
    const ws = new WebSocket(url);
    this.ws = ws;
    let alive = true;
    ws.on("pong", () => { alive = true; });
    ws.on("message", data => {
      alive = true;
      let message: unknown;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (!isRecord(message)) return;
      if (typeof message.envelope_id === "string") ws.send(JSON.stringify({ envelope_id: message.envelope_id }));
      if (message.type === "hello") { this.attempt = 0; this.listener?.hello(); }
      else if (message.type === "disconnect") ws.close();
      else if (message.type === "events_api" && isRecord(message.payload)) this.listener?.event(message.payload);
    });
    ws.on("error", () => { /* the close handler reconnects */ });
    ws.on("close", () => { if (this.ws === ws) { this.ws = null; this.stopHeartbeat(); this.reconnect("Slack closed the socket. Reconnecting."); } });
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!alive) { ws.terminate(); return; }
      alive = false;
      ws.ping();
    }, 30_000);
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void { if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null; }

  private reconnect(message: string): void {
    if (this.closed) return;
    const delayMs = Math.min(60_000, 1000 * 2 ** this.attempt++);
    if (this.attempt > 1) this.listener?.state("problem", message);
    this.retry = setTimeout(() => { void this.connect(); }, delayMs);
    this.retry.unref();
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }
}

/** What the bridge needs from the chat service. The service wires it to the backend; tests pass a fake. */
export interface SlackChats {
  /** The session ids that are chats now. */
  ids(): Promise<ReadonlySet<string>>;
  name(id: string): Promise<string | undefined>;
  /** The thread's committed messages as the browser sees them; undefined while the thread is not open. */
  messages(id: string): readonly ThreadMessage[] | undefined;
  subscribe(id: string, listener: (event: ThreadEvent) => void): Promise<() => void>;
  /** A steer, the same call as the browser composer. */
  prompt(id: string, message: string): Promise<void>;
  /** Fires on every catalog change (a chat created, archived or renamed). */
  watch(listener: () => void): () => void;
}

/**
 * A chat the owner synced: its channel (id, name, private or public), the chat name at link time, `since` (older lines are never posted), `seen` (the
 * newest owner message ts handled) and the posted line keys. `archived` is true while the chat is archived: the channel is archived too, and an
 * unarchive opens it again.
 */
export interface SlackLink { channel: string; channelName: string; isPrivate: boolean; name: string; since: number; seen: string; posted: string[]; archived: boolean }
/** `enabled` connects the workspace; `links` holds only the chats the owner synced. `migrations` lists the one-time changes already applied. */
export interface SlackState { enabled: boolean; ownerUserId: string | null; teamId: string | null; teamName: string | null; links: Record<string, SlackLink>; migrations: string[] }

function parseLink(id: string, value: unknown): SlackLink | null {
  if (!isRecord(value) || typeof value.channel !== "string" || typeof value.name !== "string" || typeof value.since !== "number" || typeof value.seen !== "string" ||
    !Array.isArray(value.posted) || !value.posted.every(key => typeof key === "string")) return null;
  // Links written before opt-in carry no channel name or archived flag: the name is the one the bridge gave the channel then. Every channel was private before the setup dialog.
  return { channel: value.channel, channelName: typeof value.channelName === "string" ? value.channelName : channelName(value.name, id), isPrivate: value.isPrivate !== false,
    name: value.name, since: value.since, seen: value.seen, posted: value.posted as string[], archived: value.archived === true };
}
export function slackStateFile(path: string): JsonFile<SlackState> {
  return { path, label: "Slack bridge state", initial: () => ({ enabled: false, ownerUserId: null, teamId: null, teamName: null, links: {}, migrations: [] }), parse(value) {
    const state = isRecord(value) ? value : {};
    const links: Record<string, SlackLink> = {};
    if (isRecord(state.links)) for (const [id, entry] of Object.entries(state.links)) { const link = parseLink(id, entry); if (link) links[id] = link; }
    const text = (key: string) => typeof state[key] === "string" ? state[key] as string : null;
    const migrations = Array.isArray(state.migrations) ? state.migrations.filter((entry): entry is string => typeof entry === "string") : [];
    return { enabled: state.enabled === true, ownerUserId: text("ownerUserId"), teamId: text("teamId"), teamName: text("teamName"), links, migrations };
  } };
}

/** A Slack member id: U or W, then letters and digits. */
export const isMemberId = (value: string): boolean => /^[UW][A-Z0-9]{5,20}$/.test(value);

/** Slack message text back to plain markdown: links, mentions and channel refs unwrapped, then the three HTML escapes. */
export function slackToMarkdown(text: string): string {
  return text
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_match, url: string, label: string) => `[${label}](${url})`)
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_match, id: string, label?: string) => "@" + (label ?? id))
    .replace(/<#(C[A-Z0-9]+|G[A-Z0-9]+)(?:\|([^>]*))?>/g, (_match, id: string, label?: string) => "#" + (label || id))
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** The push-notification fallback: plain text with Slack's control characters escaped, cut at 300 characters. */
export function fallbackText(markdown: string): string {
  const flat = markdown.replace(/\s+/g, " ").trim();
  const cut = flat.length > 300 ? flat.slice(0, 299).trimEnd() + "\u2026" : flat;
  return cut.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Splits at line breaks into pieces of at most `limit` characters; a single longer line is cut. */
export function chunks(text: string, limit = MARKDOWN_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    let rest = line;
    while (rest.length > limit) { if (current) { out.push(current); current = ""; } out.push(rest.slice(0, limit)); rest = rest.slice(limit); }
    const next = current ? current + "\n" + rest : rest;
    if (next.length > limit) { out.push(current); current = rest; } else current = next;
  }
  if (current) out.push(current);
  return out;
}

/**
 * What Slack shows of a chat: the agent lines of `chatLines()` (no streaming), each with a key that survives compaction and re-projection:
 * the message timestamp plus `text` for the reply, or plus the toolCallId for a `tell_owner` call.
 */
export function outboundLines(messages: readonly ThreadMessage[]): { key: string; text: string; at: number }[] {
  const out: { key: string; text: string; at: number }[] = [];
  for (const line of chatLines(messages)) {
    if (line.kind !== "agent" || line.streaming) continue;
    const match = /^m(\d+)(?:-t(\d+))?$/.exec(line.id);
    const message = match ? messages[Number(match[1])] : undefined;
    if (!match || !message) continue;
    let suffix = "text";
    if (match[2] !== undefined) {
      const part = message.role === "assistant" ? message.content[Number(match[2])] : undefined;
      if (part?.type !== "toolCall") continue;
      suffix = part.id;
    }
    out.push({ key: `${message.timestamp}:${suffix}`, text: line.text, at: line.at });
  }
  return out;
}

/** Slack ts order ("1712345678.000100"): seconds, then the 6-digit fraction, compared as numbers. */
export function tsAfter(a: string, b: string): boolean {
  const [as = "0", af = "0"] = a.split("."), [bs = "0", bf = "0"] = b.split(".");
  return Number(as) !== Number(bs) ? Number(as) > Number(bs) : Number(af.padEnd(6, "0")) > Number(bf.padEnd(6, "0"));
}
const nowTs = (now: number): string => (now / 1000).toFixed(6);

/** What the HTTP server needs: the Settings view, the switch and owner id, a token re-check, and a chat's channel (connect, rename, stop, the channel list). */
export type SlackControl = Pick<SlackBridge, "view" | "set" | "check" | "chat" | "channels">;

/**
 * The bridge runs in the main instance only, so a test or extra instance never opens a second Socket Mode connection (Slack would split the
 * events between them). SIEUN_PI_SLACK=1 or 0 overrides that for one process.
 */
export function runsSlack(primary: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.SIEUN_PI_SLACK;
  return flag === "1" ? true : flag === "0" ? false : primary;
}

/** The backend as the bridge sees it. */
export function slackChats(backend: ChatBackend): SlackChats {
  return {
    ids: () => backend.chats.ids(),
    name: async id => (await backend.catalog.summary(id))?.sessionName,
    messages: id => backend.threads.state(id)?.messages,
    subscribe: (id, listener) => backend.threads.subscribe(id, listener, true),
    prompt: (id, message) => backend.threads.prompt(id, { message, images: [], mode: "steer" }),
    watch: listener => backend.catalog.subscribe(() => listener()),
  };
}

type Status = { state: SlackView["state"]; message: string };
/** A channel a chat is about to be linked to, with the chat name at link time. */
type Target = { channel: string; channelName: string; isPrivate: boolean; chatName: string };
type Connection = { api: SlackCall; socket: SocketMode };
export type SlackBridgeOptions = {
  /** `<dataDir>/slack.json`. */
  path: string;
  chats: SlackChats;
  tokens?: () => Promise<SlackTokens | null>;
  /** The Web API client and the socket for a set of tokens. Tests pass fakes. */
  connect?: (tokens: SlackTokens) => Connection;
  log?: (line: string) => void;
  now?: () => number;
  /** The gap between two posts in one channel; Slack allows about one message a second. */
  postGapMs?: number;
  /** The period of the full sync (channels, subscriptions, unsent lines); 0 starts no timer. */
  syncMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const realConnect = (tokens: SlackTokens): Connection => {
  const api = slackCall(tokens.bot);
  const app = slackCall(tokens.app);
  return { api, socket: new SlackSocket(async () => {
    const opened = await app("apps.connections.open");
    if (typeof opened.url !== "string") throw new Error("apps.connections.open returned no url");
    return opened.url;
  }) };
};

export class SlackBridge {
  private state: SlackState | null = null;
  private status: Status = { state: "off", message: "Off." };
  private tokenSource: SlackTokens["source"] | null = null;
  private connection: Connection | null = null;
  private generation = 0;
  private readonly subscriptions = new Map<string, () => void>();
  private readonly queues = new Map<string, Promise<void>>();
  /** Owner messages with the working reaction, per chat, until its turn ends. */
  private readonly working = new Map<string, { channel: string; ts: string }[]>();
  private readonly lastPost = new Map<string, number>();
  /** The work after the last hello: the opt-in migration, then a full sync with catch-up. */
  private greeted: Promise<void> = Promise.resolve();
  /** Synced chats whose feed did not open, with when to try again; see PARK_MIN_MS. */
  private readonly parked = new Map<string, { until: number; gapMs: number }>();
  private unwatch: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly file: JsonFile<SlackState>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  constructor(private readonly options: SlackBridgeOptions) {
    this.file = slackStateFile(options.path);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.log = options.log ?? (() => {});
  }

  /** Reads the state and connects when the bridge is on, the tokens exist and the owner is set. Without tokens nothing else happens. */
  async start(): Promise<void> {
    this.state = await snapshotJsonFile(this.file);
    await this.connect();
  }

  private async connect(): Promise<void> {
    this.disconnect();
    const generation = ++this.generation;
    const state = this.state!;
    if (!state.enabled) { this.status = { state: "off", message: "Off. Chats stay in the browser only." }; return; }
    const tokens = await (this.options.tokens ?? (() => loadSlackTokens()))().catch(() => null);
    if (generation !== this.generation) return;
    this.tokenSource = tokens?.source ?? null;
    if (!tokens) { this.status = { state: "no-tokens", message: `No Slack tokens. Add them to the Keychain service ${KEYCHAIN_SERVICE}, then check again.` }; return; }
    if (!state.ownerUserId) { this.status = { state: "no-owner", message: "Enter your Slack member id." }; return; }
    const connection = (this.options.connect ?? realConnect)(tokens);
    let auth: Record<string, unknown>;
    try { auth = await connection.api("auth.test"); }
    catch (error) { this.status = { state: "problem", message: `The bot token was refused: ${errorText(error)}` }; return; }
    if (generation !== this.generation) return;
    if (typeof auth.team_id !== "string") { this.status = { state: "problem", message: "auth.test returned no team." }; return; }
    await this.save(next => { next.teamId = auth.team_id as string; next.teamName = typeof auth.team === "string" ? auth.team : null; });
    this.connection = connection;
    this.status = { state: "connecting", message: "Connecting to Slack." };
    connection.socket.start({
      hello: () => {
        if (generation !== this.generation) return;
        this.status = { state: "on", message: `On in ${this.state?.teamName ?? "Slack"}.` };
        this.greeted = this.migrate().catch(error => { this.log(`slack: opt-in migration: ${errorText(error)}`); }).then(() => this.sync(true));
      },
      event: payload => { if (generation === this.generation) this.inbound(payload); },
      state: (state, message) => { if (generation === this.generation) this.status = { state, message }; },
    });
    this.unwatch = this.options.chats.watch(() => this.scheduleSync());
    const every = this.options.syncMs ?? 60_000;
    if (every > 0) { this.timer = setInterval(() => { void this.sync(false); }, every); this.timer.unref(); }
  }

  private disconnect(): void {
    this.generation++;
    this.connection?.socket.close();
    this.connection = null;
    this.unwatch?.();
    this.unwatch = null;
    if (this.timer) clearInterval(this.timer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.timer = this.syncTimer = null;
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    this.parked.clear();
    this.working.clear();
  }

  close(): void { this.disconnect(); this.status = { state: "off", message: "Off." }; }

  view(editable: boolean): SlackView {
    const state = this.state;
    const chats = Object.fromEntries(Object.entries(state?.links ?? {}).filter(([, link]) => !link.archived)
      .map(([id, link]): [string, SlackChatLink] => [id, { channel: link.channel, name: link.channelName, isPrivate: link.isPrivate }]));
    return { ...this.status, enabled: state?.enabled ?? false, ownerUserId: state?.ownerUserId ?? null, teamId: state?.teamId ?? null, teamName: state?.teamName ?? null,
      channels: Object.keys(chats).length, chats, tokenSource: this.tokenSource, keychainService: KEYCHAIN_SERVICE, editable };
  }

  /**
   * A chat's Slack control, one call per dialog action, each needing a live connection. Every action runs on the chat's queue, so repeated or
   * concurrent calls run one after another and converge:
   * `connect` is idempotent: a synced chat keeps its channel (the body's name is ignored), an archived link is opened again, and a chat with no link
   * gets one, created with the given name (or reused when the bot is already in a channel of that name) or the `existing` channel the owner picked.
   * `rename` renames the channel; `stop` archives the channel and drops the link.
   * Returns the chat's channel after the action, null once sync is off.
   */
  async chat(id: string, input: SlackChatInput): Promise<SlackChatLink | null> {
    if (!this.connection || this.status.state !== "on") throw new Error("Slack is not connected. Connect it in Settings > Slack.");
    if (input.action !== "stop") {
      const error = input.action === "rename" || input.name !== undefined ? channelNameError(input.name ?? "") : null;
      if (error) throw new Error(error);
    }
    return this.queue(id, async () => {
      const link = this.state!.links[id];
      if (input.action === "stop") { if (link) await this.unlink(id, "sync turned off"); return null; }
      if (input.action === "rename") {
        if (!link || link.archived) throw new Error("This chat is not synced to Slack.");
        await this.rename(id, input.name);
      } else {
        this.parked.delete(id);
        if (!link) await this.link(id, input);
        else if (link.archived) await this.reopen(id);
        await this.watchChat(id);
      }
      const after = this.state!.links[id]!;
      return { channel: after.channel, name: after.channelName, isPrivate: after.isPrivate };
    }, true);
  }

  /** The unarchived channels the bot can see (its private ones, plus public ones when the token has channels:read); null when it cannot list. */
  async channels(): Promise<SlackChannelOption[] | null> {
    const api = this.connection?.api;
    if (!api || this.status.state !== "on") return null;
    const out: SlackChannelOption[] = [];
    for (const types of ["private_channel", "public_channel"]) {
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        let listed: Record<string, unknown>;
        try { listed = await api("conversations.list", { types, exclude_archived: true, limit: 200, cursor }); }
        catch (error) {
          if (error instanceof SlackApiError && error.code === "missing_scope" && types === "public_channel") break;
          if (types === "private_channel" && page === 0) return null;
          throw error;
        }
        for (const channel of Array.isArray(listed.channels) ? listed.channels.filter(isRecord) : []) {
          if (typeof channel.id === "string" && typeof channel.name === "string" && channel.is_member === true) out.push({ id: channel.id, name: channel.name, isPrivate: channel.is_private === true });
        }
        cursor = isRecord(listed.response_metadata) && typeof listed.response_metadata.next_cursor === "string" ? listed.response_metadata.next_cursor : "";
        if (!cursor) break;
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Settings: the switch and the owner id. Any change, and `check`, reads the tokens again and reconnects. */
  async set(input: SlackInput): Promise<void> {
    if (input.ownerUserId !== undefined && input.ownerUserId !== null && !isMemberId(input.ownerUserId)) throw new Error("A Slack member id starts with U or W, like U012ABCDEF.");
    await this.save(next => {
      if (input.enabled !== undefined) next.enabled = input.enabled;
      if (input.ownerUserId !== undefined) next.ownerUserId = input.ownerUserId;
    });
    await this.connect();
  }

  async check(): Promise<void> { this.state ??= await snapshotJsonFile(this.file); await this.connect(); }

  private async save(change: (state: SlackState) => void): Promise<void> {
    this.state = (await transactJsonFile(this.file, change)).state;
  }

  /**
   * Tasks of one key (a chat id) run one after another, so a live event and the catch-up never handle one message twice. A failed task is logged,
   * or with `rethrow` handed to the caller instead.
   */
  private queue<T = void>(key: string, task: () => Promise<T>, rethrow: true): Promise<T>;
  private queue(key: string, task: () => Promise<void>, rethrow?: false): Promise<void>;
  private queue<T>(key: string, task: () => Promise<T>, rethrow = false): Promise<T | void> {
    const run = (this.queues.get(key) ?? Promise.resolve()).then(task);
    const next: Promise<void> = run.then(() => {}, error => { if (!rethrow) this.log(`slack ${key.slice(0, 8)}: ${errorText(error)}`); });
    this.queues.set(key, next);
    void next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); });
    return rethrow ? run : next;
  }

  /** For tests: resolves once the hello work and every queued task finished. */
  async settled(): Promise<void> {
    await this.greeted;
    while (this.queues.size) await Promise.all([...this.queues.values()]);
  }

  private scheduleSync(): void {
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => { this.syncTimer = null; void this.sync(false); }, 2000);
    this.syncTimer.unref();
  }

  /**
   * Converges each synced chat's channel on the chat list: a chat that left the list (archived) gets its channel archived and its link kept,
   * a chat back on the list (unarchived) gets the channel opened again. Each open link gets a feed subscription and every unsent line posted.
   * After a (re)connect it also reads each channel's history since the last handled owner message: Socket Mode does not replay events sent while
   * the Mac slept. Chats nobody synced are never touched.
   */
  async sync(catchUp: boolean): Promise<void> {
    const connection = this.connection;
    if (!connection || !this.state) return;
    let ids: ReadonlySet<string>;
    try { ids = await this.options.chats.ids(); } catch (error) { this.log(`slack: chat list: ${errorText(error)}`); return; }
    await Promise.all(Object.keys(this.state.links).map(id => this.queue(id, async () => {
      const link = this.state!.links[id];
      if (this.connection !== connection || !link) return;
      if (!ids.has(id)) { if (!link.archived) await this.archive(id); return; }
      if (link.archived) await this.reopen(id);
      await this.watchChat(id);
      if (catchUp) await this.catchUp(id);
      await this.flush(id);
    })));
  }

  /** Once per slack.json: the links made before sync was opt-in are dropped and their channels archived, except OPT_IN_KEEP's. */
  private async migrate(): Promise<void> {
    if (!this.state || this.state.migrations.includes(OPT_IN_MIGRATION)) return;
    for (const [id, link] of Object.entries(this.state.links)) {
      if (link.channelName !== OPT_IN_KEEP) await this.queue(id, () => this.unlink(id, "sync is opt-in now"), true);
    }
    await this.save(next => { if (!next.migrations.includes(OPT_IN_MIGRATION)) next.migrations.push(OPT_IN_MIGRATION); });
    this.log(`slack: opt-in migration done, ${Object.keys(this.state.links).length} chat(s) still synced`);
  }

  /**
   * The chat's channel: created with `name` (the chat's `vp-<slug>` by default), private unless asked otherwise, with the owner invited. A taken
   * name is reused when the bot is already in that channel; otherwise the name gets the chat id's first four characters.
   */
  private async createChannel(id: string, setup: { name?: string; isPrivate?: boolean }): Promise<Target> {
    const api = this.connection!.api;
    const chatName = (await this.options.chats.name(id))?.trim() || id.slice(0, 8);
    const base = setup.name ?? channelName(chatName, id);
    const isPrivate = setup.isPrivate ?? true;
    for (const name of [base, `${base.slice(0, 75)}-${id.slice(0, 4)}`]) {
      let created: Record<string, unknown>;
      try { created = await api("conversations.create", { name, is_private: isPrivate }); }
      catch (error) {
        if (!(error instanceof SlackApiError && error.code === "name_taken")) throw error;
        const found = await this.findChannel({ name });
        if (found) { await this.invite(found.id); return { channel: found.id, channelName: found.name, isPrivate: found.isPrivate, chatName }; }
        continue;
      }
      const channel = isRecord(created.channel) ? created.channel : {};
      if (typeof channel.id !== "string") throw new Error("conversations.create returned no channel.");
      await this.invite(channel.id);
      return { channel: channel.id, channelName: typeof channel.name === "string" ? channel.name : name, isPrivate, chatName };
    }
    throw new Error(`No channel name left for ${base}.`);
  }

  /** A channel the bot is in, by id (conversations.info) or by name (the list); null when there is none or the bot cannot see it. */
  private async findChannel(ref: { id: string } | { name: string }): Promise<SlackChannelOption | null> {
    if ("name" in ref) return (await this.channels().catch(() => null))?.find(channel => channel.name === ref.name) ?? null;
    const info = await this.connection!.api("conversations.info", { channel: ref.id }).catch(() => null);
    const channel = info && isRecord(info.channel) ? info.channel : null;
    if (!channel || typeof channel.id !== "string" || typeof channel.name !== "string" || channel.is_member !== true || channel.is_archived === true) return null;
    return { id: channel.id, name: channel.name, isPrivate: channel.is_private === true };
  }

  /** The channel the owner picked in the dialog: an id or `#name` of a channel the bot is already in. */
  private async existingChannel(id: string, existing: string): Promise<Target> {
    const ref = parseChannelRef(existing);
    if (!ref) throw new Error("Enter a channel id or #name.");
    const found = await this.findChannel(ref);
    if (!found) throw new Error(`No channel ${"id" in ref ? ref.id : "#" + ref.name} that the bot is in. Invite the bot to it first, or create a new channel.`);
    await this.invite(found.id);
    const chatName = (await this.options.chats.name(id))?.trim() || id.slice(0, 8);
    return { channel: found.id, channelName: found.name, isPrivate: found.isPrivate, chatName };
  }

  private invite(channel: string): Promise<unknown> {
    return this.connection!.api("conversations.invite", { channel, users: this.state!.ownerUserId! })
      .catch(error => { if (!(error instanceof SlackApiError && error.code === "already_in_channel")) throw error; });
  }

  private async link(id: string, input: { name?: string; isPrivate?: boolean; existing?: string }): Promise<void> {
    const { channel, channelName: name, isPrivate, chatName } = input.existing !== undefined ? await this.existingChannel(id, input.existing) : await this.createChannel(id, input);
    const now = this.now();
    await this.save(next => { next.links[id] = { channel, channelName: name, isPrivate, name: chatName, since: now, seen: nowTs(now), posted: [], archived: false }; });
    await this.post(channel, `Linked to the chat *${chatName}*. What you write here goes to the chat; its replies and pings come back here.`);
    this.log(`slack ${id.slice(0, 8)}: linked to ${channel} #${name}`);
  }

  /** conversations.rename; the same name is a no-op. Slack's answer carries the name it kept. */
  private async rename(id: string, name: string): Promise<void> {
    const link = this.state!.links[id]!;
    if (link.channelName === name) return;
    let renamed: Record<string, unknown>;
    try { renamed = await this.connection!.api("conversations.rename", { channel: link.channel, name }); }
    catch (error) { throw error instanceof SlackApiError && error.code === "name_taken" ? new Error(`#${name} is taken by another channel.`) : error; }
    const channel = isRecord(renamed.channel) ? renamed.channel : {};
    const kept = typeof channel.name === "string" ? channel.name : name;
    await this.save(next => { const entry = next.links[id]; if (entry) entry.channelName = kept; });
    this.log(`slack ${id.slice(0, 8)}: renamed ${link.channel} #${link.channelName} to #${kept}`);
  }

  /** The chat is back from the archive: its channel is unarchived, or replaced by a new one when Slack refuses (the bot left it on archive). */
  private async reopen(id: string): Promise<void> {
    const link = this.state!.links[id]!;
    let target: { channel: string; channelName: string; isPrivate: boolean };
    try {
      await this.connection!.api("conversations.unarchive", { channel: link.channel })
        .catch(error => { if (!(error instanceof SlackApiError && error.code === "not_archived")) throw error; });
      await this.invite(link.channel);
      target = link;
    } catch (error) {
      if (!(error instanceof SlackApiError) || error.code === "ratelimited") throw error;
      target = await this.createChannel(id, { name: link.channelName, isPrivate: link.isPrivate });
    }
    await this.save(next => { const entry = next.links[id]; if (entry) Object.assign(entry, { channel: target.channel, channelName: target.channelName, isPrivate: target.isPrivate, archived: false }); });
    await this.post(target.channel, `The chat *${link.name}* is back from the archive. What you write here goes to the chat again.`);
    this.log(`slack ${id.slice(0, 8)}: chat unarchived, ${target.channel} #${target.channelName} open again`);
  }

  private async archiveChannel(channel: string): Promise<void> {
    await this.connection?.api("conversations.archive", { channel }).catch(error => {
      if (!(error instanceof SlackApiError && (error.code === "already_archived" || error.code === "channel_not_found"))) throw error;
    });
  }

  private dropFeed(id: string): void {
    this.subscriptions.get(id)?.();
    this.subscriptions.delete(id);
    this.parked.delete(id);
  }

  /** The chat was archived: the channel is archived, the link stays (marked archived) so an unarchive opens it again. */
  private async archive(id: string): Promise<void> {
    const link = this.state!.links[id]!;
    this.dropFeed(id);
    await this.archiveChannel(link.channel);
    await this.save(next => { const entry = next.links[id]; if (entry) entry.archived = true; });
    this.log(`slack ${id.slice(0, 8)}: chat archived, archived ${link.channel} #${link.channelName}`);
  }

  /** Sync turned off: the channel is archived and the link dropped. */
  private async unlink(id: string, reason: string): Promise<void> {
    const link = this.state!.links[id];
    if (!link) return;
    this.dropFeed(id);
    if (!link.archived) await this.archiveChannel(link.channel);
    await this.save(next => { delete next.links[id]; });
    this.log(`slack ${id.slice(0, 8)}: ${reason}, archived ${link.channel} #${link.channelName}`);
  }

  /**
   * One feed subscription per synced chat: each committed message and each turn end posts the new lines; a turn end clears the working reactions.
   * A feed that does not open (the session is gone) parks the chat: one log line, then a quiet retry after PARK_MIN_MS, doubling up to PARK_MAX_MS,
   * so a dead session costs no daemon attach on every catalog change.
   */
  private async watchChat(id: string): Promise<void> {
    if (this.subscriptions.has(id)) return;
    const park = this.parked.get(id);
    if (park && this.now() < park.until) return;
    let unsubscribe: () => void;
    try {
      unsubscribe = await this.options.chats.subscribe(id, event => {
        if (event.type === "status" && event.connection === "closed") { this.subscriptions.get(id)?.(); this.subscriptions.delete(id); this.scheduleSync(); return; }
        if (event.type === "snapshot" || (event.type === "event" && event.event.type === "message_end" && event.event.message.role === "assistant")) void this.queue(id, () => this.flush(id));
        if (event.type === "event" && event.event.type === "agent_end") void this.queue(id, async () => { await this.flush(id); await this.idle(id); });
      });
    } catch (error) {
      const gapMs = park ? Math.min(PARK_MAX_MS, park.gapMs * 2) : PARK_MIN_MS;
      this.parked.set(id, { until: this.now() + gapMs, gapMs });
      if (!park) this.log(`slack ${id.slice(0, 8)}: the chat's feed did not open (${errorText(error)}); parked, tried again quietly every ${PARK_MIN_MS / 60_000} to ${PARK_MAX_MS / 60_000} min`);
      return;
    }
    if (park) this.log(`slack ${id.slice(0, 8)}: the chat's feed is open again`);
    this.parked.delete(id);
    this.subscriptions.set(id, unsubscribe);
  }

  private async flush(id: string): Promise<void> {
    const link = this.state?.links[id];
    const messages = this.options.chats.messages(id);
    if (!link || !messages || !this.connection) return;
    const posted = new Set(link.posted);
    for (const line of outboundLines(messages)) {
      if (line.at < link.since || posted.has(line.key)) continue;
      for (const piece of chunks(line.text)) await this.post(link.channel, piece);
      posted.add(line.key);
      await this.save(next => {
        const entry = next.links[id];
        if (!entry) return;
        entry.posted = [...entry.posted.filter(key => key !== line.key), line.key];
        if (entry.posted.length > POSTED_KEEP) {
          entry.posted = entry.posted.slice(-POSTED_KEEP);
          entry.since = Math.max(entry.since, Number(entry.posted[0]!.split(":")[0]));
        }
      });
    }
  }

  /** chat.postMessage as one markdown block plus a plain fallback for the notification, at most one per `postGapMs` per channel, retried on rate limits. */
  private async post(channel: string, markdown: string): Promise<void> {
    const gap = this.options.postGapMs ?? 1100;
    for (let attempt = 0; ; attempt++) {
      const wait = (this.lastPost.get(channel) ?? 0) + gap - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastPost.set(channel, this.now());
      try {
        await this.connection!.api("chat.postMessage", { channel, text: fallbackText(markdown), blocks: [{ type: "markdown", text: markdown }], unfurl_links: false });
        return;
      } catch (error) {
        if (!(error instanceof SlackApiError && error.code === "ratelimited") || attempt >= 3) throw error;
        await this.sleep(error.retryAfterMs ?? 1000);
      }
    }
  }

  private inbound(payload: Record<string, unknown>): void {
    const state = this.state;
    if (!state || payload.type !== "event_callback" || payload.team_id !== state.teamId || !isRecord(payload.event)) return;
    const event = payload.event;
    if (event.type !== "message" || typeof event.channel !== "string") return;
    const id = Object.entries(state.links).find(([, link]) => link.channel === event.channel)?.[0];
    if (id) void this.queue(id, () => this.ownerMessage(id, event));
  }

  /** Reads the channel's messages after `seen` (Slack answers newest first) and handles them oldest first. */
  private async catchUp(id: string): Promise<void> {
    const link = this.state?.links[id];
    if (!link || !this.connection) return;
    const history = await this.connection.api("conversations.history", { channel: link.channel, oldest: link.seen, limit: 200 });
    const messages = Array.isArray(history.messages) ? history.messages.filter(isRecord) : [];
    for (const message of messages.reverse()) await this.ownerMessage(id, { ...message, channel: link.channel });
  }

  /**
   * An owner message in a chat's channel becomes a steer. Only the owner's member id passes (the team was checked on the envelope); bot posts,
   * edits, deletes and joins have a subtype or another user and are dropped. `seen` moves first, so a message is sent at most once; a failed
   * send is answered in the channel.
   */
  private async ownerMessage(id: string, event: Record<string, unknown>): Promise<void> {
    const link = this.state?.links[id];
    const api = this.connection?.api;
    if (!link || !api || typeof event.ts !== "string" || !tsAfter(event.ts, link.seen)) return;
    const ts = event.ts;
    await this.save(next => { const entry = next.links[id]; if (entry && tsAfter(ts, entry.seen)) entry.seen = ts; });
    if (event.user !== this.state!.ownerUserId || event.bot_id !== undefined) return;
    if (event.subtype !== undefined && event.subtype !== "file_share" && event.subtype !== "thread_broadcast") return;
    const text = slackToMarkdown(typeof event.text === "string" ? event.text : "").trim();
    const files = Array.isArray(event.files) ? event.files.length : 0;
    if (!text) {
      if (files) await this.post(link.channel, "Files are not forwarded yet. Send the message as text.");
      return;
    }
    await api("reactions.add", { channel: link.channel, timestamp: ts, name: WORKING_REACTION }).catch(() => {});
    const working = this.working.get(id) ?? [];
    working.push({ channel: link.channel, ts });
    this.working.set(id, working);
    try { await this.options.chats.prompt(id, files ? `${text}\n\n(The owner attached ${files} file(s) in Slack; files are not forwarded yet.)` : text); }
    catch (error) {
      await this.idle(id);
      await this.post(link.channel, `Not sent to the chat: ${errorText(error)}. Send it again.`);
    }
  }

  private async idle(id: string): Promise<void> {
    const working = this.working.get(id);
    this.working.delete(id);
    for (const { channel, ts } of working ?? []) await this.connection?.api("reactions.remove", { channel, timestamp: ts, name: WORKING_REACTION }).catch(() => {});
  }
}
