import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DaemonClient, SessionSummary } from "prime-agent";
import { parseSummaries } from "./chat-catalog.ts";

const LIVE_FIELDS = ["activeSessionId", "rosterStatus", "isStreaming", "isCompacting", "isBashRunning", "isRunningTools", "hasRunningRlmChildren", "isSessionActive",
  "workerState", "workerPid"] as const;

/** The key the daemon merges its own `list all` by, so a live roster row replaces the saved row of the same session. */
export const rowKey = (row: SessionSummary): string => row.sessionFile ?? `id:${row.sessionId}`;

/** A row as saved: the daemon's passivated form of a session whose worker stopped. */
export function saved(row: SessionSummary): SessionSummary {
  const copy: Record<string, unknown> = { ...row, activity: "idle" };
  for (const field of LIVE_FIELDS) delete copy[field];
  return copy as unknown as SessionSummary;
}

/** The rows with a roster list laid over them: its rows replace or join theirs, and a row live before but missing from it is saved now. */
export function rosterMerge(rows: ReadonlyMap<string, SessionSummary>, live: readonly SessionSummary[]): Map<string, SessionSummary> {
  const next = new Map(rows);
  const liveKeys = new Set(live.map(rowKey));
  for (const [key, row] of next) if (row.activeSessionId !== undefined && !liveKeys.has(key)) next.set(key, saved(row));
  for (const row of live) { dropStarting(next, row); next.set(rowKey(row), merged(next.get(rowKey(row)), row)); }
  return next;
}

/**
 * A subagent's roster entry before its session file exists names its child id as its session id and has no file, so it sits under key
 * `id:<child id>`. Its real row comes under its file's key and takes its place. On 10-18 on us-metal02 the starting row stayed beside the
 * real one until the next full list, so the chat listed the job twice under one key and the page threw each_key_duplicate about every 3 s.
 */
function dropStarting(rows: Map<string, SessionSummary>, row: SessionSummary): void {
  if (!row.sessionFile || !row.rlmChildId) return;
  const key = `id:${row.rlmChildId}`;
  const starting = rows.get(key);
  if (starting && !starting.sessionFile && starting.rlmChildId === row.rlmChildId && starting.parentSessionId === row.parentSessionId) rows.delete(key);
}

/**
 * A row laid over the copy's row of the same session. A row with no active session is saved, so it drops the old row's live fields: the
 * roster lists inactive agents too (233 of 336 entries on the box on 10-18), and a spread alone kept the stopped worker's active session id.
 */
function merged(old: SessionSummary | undefined, row: SessionSummary): SessionSummary {
  const next = { ...old, ...row };
  return row.activeSessionId === undefined ? saved(next) : next;
}

/**
 * The roster's agent id for a row, as the daemon forms it (rosterAgentIdForSummary): a subagent is its parent's session path and child id, any
 * other session its session id. The daemon canonicalizes the parent path; the listed path is the same string on both boxes today.
 */
export function agentIdOf(row: Pick<SessionSummary, "runtimeKind" | "rlmChildId" | "sessionId" | "parentSessionPath" | "parentActiveSessionId">): string {
  if (row.runtimeKind === "subagent" && row.rlmChildId) {
    const parent = row.parentSessionPath ?? row.parentActiveSessionId;
    return parent ? `${parent}#${row.rlmChildId}` : row.rlmChildId;
  }
  return row.sessionId;
}

/** Every live row's agent id to its row key, so a later removal finds its row. */
export function liveAgents(rows: ReadonlyMap<string, SessionSummary>): Map<string, string> {
  const agents = new Map<string, string>();
  for (const [key, row] of rows) if (row.activeSessionId !== undefined) agents.set(agentIdOf(row), key);
  return agents;
}

/** One `roster_update`: the agents whose summary changed, and the agent ids that left the roster. */
export type RosterUpdate = { changed?: { agentId: string; status?: string; summary: Partial<SessionSummary> & { sessionId: string } }[]; removed?: string[]; resync?: true };

/**
 * A roster_update laid over the rows: a changed agent's summary replaces or joins its row, and a removed one's row is saved. `unknown` is true
 * when the update names an agent the rows cannot place, so the caller lists the roster to catch up.
 */
export function applyRosterUpdate(rows: ReadonlyMap<string, SessionSummary>, agents: Map<string, string>, update: RosterUpdate): { rows: Map<string, SessionSummary>; unknown: boolean } {
  const next = new Map(rows);
  let unknown = update.resync === true;
  for (const entry of update.changed ?? []) {
    const row = { ...entry.summary, ...(entry.status ? { rosterStatus: entry.status } : {}) } as SessionSummary;
    const key = rowKey(row);
    dropStarting(next, row);
    next.set(key, merged(next.get(key), row));
    agents.set(entry.agentId, key);
  }
  for (const agentId of update.removed ?? []) {
    const key = agents.get(agentId) ?? [...next.entries()].find(([, row]) => agentIdOf(row) === agentId)?.[0];
    const row = key === undefined ? undefined : next.get(key);
    if (key === undefined || !row) { unknown = true; continue; }
    next.set(key, saved(row));
    agents.delete(agentId);
  }
  return { rows: next, unknown };
}

/**
 * How old a box's last full list may get before its copy runs one again in the background. Owner, 10-18 15:18 KST: "그냥 종종 싱크 맞춰"
 * (just sync now and then); the roster stream keeps live rows current between. The Mac's full list was 3,051 rows, 38 MB and 11.0 s on 10-18.
 */
export const RESYNC_MS = 30 * 60_000;
/** A full list writes the copy to disk at once, and other changes at most this often, since the Mac's copy is about 38 MB of JSON to write. */
const SAVE_MS = 5 * 60_000;
/** Updates the rows cannot place within this wait share one roster list. */
const CATCH_UP_MS = 1000;

/** connecting: no answer yet on this link (start, or the link just closed); up: subscribed to the roster; down: the last connect failed. */
export type PeerState = "connecting" | "up" | "down";

/** The copy on disk: the rows, and when their last full list ran. */
type SavedCopy = { version: 1; fullAt: number; rows: SessionSummary[] };

export type PeerOptions = {
  /** The box's hosts.json name, for logs and errors. */
  name: string;
  client: DaemonClient;
  /** Where the copy is kept across restarts; null keeps it in memory only. */
  file: string | null;
  /** Deadlines of the socket connect, the daemon hello and roster_subscribe on this link. */
  deadlines: { socketMs: number; helloMs: number; subscribeMs?: number };
  /** Roster updates are laid into one change per this wait. */
  changeMs: number;
  /** The wait before a closed or failed link connects again. */
  reconnectMs: number;
  /**
   * Set: the link never subscribes to the roster, and the copy lists the roster (live sessions only) every this many ms instead. Unset: the
   * copy follows the roster_update stream.
   */
  pollMs?: number;
  log: (line: string) => void;
  /** The rows or the state changed. */
  onChange: () => void;
  onHello?: (hello: { appVersion?: string; supervisorGeneration?: string }) => void;
};

/**
 * One box's sessions, kept here so every page and list reads them from memory. The copy starts from the disk copy of the last run, a
 * connect lays the box's roster list (live sessions only) over it, roster_update messages keep it current, and a full list runs only when
 * there is no copy or the last one is RESYNC_MS old, in the background. Every box, this one included, goes through the same copy.
 */
export class SessionPeer {
  /** The rows by rowKey. */
  private rows = new Map<string, SessionSummary>();
  /** Each roster agent id the updates named, to the row key it changed. */
  private agents = new Map<string, string>();
  /** True once the copy holds rows from a full list, this run's or the disk copy's. */
  listed = false;
  /** When the copy's last full list answered, in epoch ms. */
  fullAt = 0;
  state: PeerState = "connecting";
  subscribed = false;
  error: string | undefined;
  /** How many full lists, roster lists and roster updates this copy took since the service started. */
  readonly counts = { full: 0, roster: 0, updates: 0 };
  /** Goes up on every change of the rows or the state, so a reader's index of them knows when to rebuild. */
  version = 0;
  private readonly loading: Promise<void>;
  private connecting: Promise<void> | undefined;
  private syncing: Promise<void> | undefined;
  private syncNext: Promise<void> | undefined;
  private fullList: Promise<void> | undefined;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  private catchUpTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private resyncTimer: ReturnType<typeof setTimeout> | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly options: PeerOptions) {
    options.client.onMessage(message => { if (message.type === "roster_update") this.onRoster(message as RosterUpdate); });
    options.client.onClose(error => {
      this.subscribed = false;
      this.error = error.message;
      this.setState("connecting");
      this.scheduleReconnect();
    });
    this.loading = this.load();
  }

  get name(): string { return this.options.name; }

  /** Resolves once the disk copy of the last run is read (or found missing), so a caller right after a start sees what it saved. */
  loaded(): Promise<void> { return this.loading; }

  /** The rows as the box's daemon gave them; every live row reads as saved while the box is down. */
  list(): SessionSummary[] {
    const rows = [...this.rows.values()];
    return this.state === "down" ? rows.map(saved) : rows;
  }

  /** True when the box's daemon runs the session (a session id or active session id) now. */
  isActive(id: string): boolean {
    if (this.state === "down") return false;
    for (const row of this.rows.values()) if ((row.sessionId === id || row.activeSessionId === id) && row.activeSessionId !== undefined) return true;
    return false;
  }

  /** Changes the copy's row of a session this server changed itself, such as a saved session's new name. */
  patch(sessionId: string, fields: Partial<SessionSummary>): boolean {
    let found = false;
    for (const [key, row] of this.rows) if (row.sessionId === sessionId) { this.rows.set(key, { ...row, ...fields }); found = true; }
    if (found) this.changed();
    return found;
  }

  /** A connected client subscribed to the box's roster. */
  async connect(): Promise<void> {
    const { client, deadlines } = this.options;
    if (client.isConnected && this.subscribed) return;
    this.connecting ??= (async () => {
      try {
        await client.reconnect(deadlines.socketMs);
        const hello = await client.waitForHello(deadlines.helloMs);
        this.options.onHello?.(hello);
        if (this.options.pollMs === undefined) {
          const response = await client.request({ type: "roster_subscribe" }, deadlines.subscribeMs, { recoverable: false });
          if (!response.success) throw new Error(response.error);
        }
        this.subscribed = true;
        this.error = undefined;
        this.setState("up");
      } catch (error) {
        client.resetTransportForReconnect();
        this.error = error instanceof Error ? error.message : String(error);
        this.setState("down");
        this.scheduleReconnect();
        throw error;
      } finally { this.connecting = undefined; }
    })();
    return this.connecting;
  }

  /**
   * Brings the copy up to date with the box: a full list when the copy is empty, else the roster list laid over it. A sync asked for while one
   * runs shares one run after it, so its caller sees what changed before it asked. `connect` is the owner's own connect, which reports a failure.
   */
  sync(connect: () => Promise<void> = () => this.connect()): Promise<void> {
    if (this.syncing) return this.syncNext ??= this.syncing.catch(() => {}).then(() => { this.syncNext = undefined; return this.sync(connect); });
    this.syncing = (async () => {
      await this.loading;
      await connect();
      if (!this.listed) await this.full();
      else await this.roster();
      this.scheduleResync();
    })().catch(error => {
      if (!this.closed) this.options.log(`copy ${this.name}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }).finally(() => { this.syncing = undefined; this.schedulePoll(); });
    return this.syncing;
  }

  private async request(all: boolean): Promise<SessionSummary[]> {
    // No deadline: the list keeps running until the box answers or the link closes, and a slow one only delays the copy.
    const response = await this.options.client.request(all ? { type: "list", all: true } : { type: "list" }, 2 ** 31 - 1, { recoverable: false });
    if (!response.success) throw new Error(response.error);
    return parseSummaries(response.data);
  }

  private async roster(): Promise<void> {
    const live = await this.request(false);
    this.rows = rosterMerge(this.rows, live);
    this.agents = liveAgents(this.rows);
    this.counts.roster++;
    this.changed();
  }

  /** The one full list in flight, then the roster laid over it for the updates it may have missed while it ran. */
  private full(): Promise<void> {
    this.fullList ??= (async () => {
      const started = Date.now();
      const rows = await this.request(true);
      this.rows = new Map(rows.map(row => [rowKey(row), row]));
      this.agents = liveAgents(this.rows);
      this.listed = true;
      this.fullAt = Date.now();
      this.counts.full++;
      this.options.log(`copy ${this.name}: full list answered in ${((Date.now() - started) / 1000).toFixed(1)} s, ${rows.length} rows`);
      this.changed();
      this.save();
    })().finally(() => { this.fullList = undefined; });
    return this.fullList;
  }

  /** The background full list, once the last one is RESYNC_MS old. */
  private scheduleResync(): void {
    if (this.closed || this.resyncTimer) return;
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = undefined;
      void this.connect().then(() => this.full()).then(() => this.roster()).catch(error => {
        if (!this.closed) this.options.log(`copy ${this.name}: background full list: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => this.scheduleResync());
    }, Math.max(0, this.fullAt + RESYNC_MS - Date.now()));
    this.resyncTimer.unref?.();
  }

  private onRoster(update: RosterUpdate): void {
    if (!this.listed) return;
    this.counts.updates++;
    const { rows, unknown } = applyRosterUpdate(this.rows, this.agents, update);
    this.rows = rows;
    this.changed();
    if (unknown) this.catchUp();
  }

  /** One roster list for the updates of the next second that the rows could not place. */
  private catchUp(): void {
    if (this.closed || this.catchUpTimer) return;
    this.catchUpTimer = setTimeout(() => { this.catchUpTimer = undefined; void this.sync().catch(() => {}); }, CATCH_UP_MS);
  }

  /** The next roster list of a polled link, after each sync whether it answered or failed. */
  private schedulePoll(): void {
    const pollMs = this.options.pollMs;
    if (pollMs === undefined || this.closed || this.pollTimer) return;
    this.pollTimer = setTimeout(() => { this.pollTimer = undefined; void this.sync().catch(() => {}); }, pollMs);
    this.pollTimer.unref?.();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.sync().catch(() => {}); }, this.options.reconnectMs);
    this.reconnectTimer.unref?.();
  }

  private setState(state: PeerState): void {
    const changed = this.state !== state;
    this.state = state;
    if (changed) this.version++;
    if (changed && !this.closed) this.options.onChange();
  }

  private changed(): void {
    this.version++;
    if (this.closed) return;
    if (!this.saveTimer && this.options.file) {
      this.saveTimer = setTimeout(() => { this.saveTimer = undefined; this.save(); }, SAVE_MS);
      this.saveTimer.unref?.();
    }
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => { this.changeTimer = undefined; if (!this.closed) this.options.onChange(); }, this.options.changeMs);
  }

  private async load(): Promise<void> {
    const file = this.options.file;
    if (!file) return;
    try {
      const copy = JSON.parse(await readFile(file, "utf8")) as Partial<SavedCopy>;
      if (copy.version !== 1 || !Array.isArray(copy.rows) || !copy.rows.length || this.listed) return;
      const rows = parseSummaries({ sessions: copy.rows });
      this.rows = new Map(rows.map(row => [rowKey(row), row]));
      this.agents = liveAgents(this.rows);
      this.listed = true;
      this.fullAt = typeof copy.fullAt === "number" ? copy.fullAt : 0;
      this.version++;
      this.options.log(`copy ${this.name}: ${rows.length} rows from ${file}, full list ${Math.round((Date.now() - this.fullAt) / 60_000)} min old`);
      this.options.onChange();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.options.log(`copy ${this.name}: ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private saving: Promise<void> | undefined;
  private save(): void {
    const file = this.options.file;
    if (!file || !this.listed || this.closed) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const copy: SavedCopy = { version: 1, fullAt: this.fullAt, rows: [...this.rows.values()] };
    const run = async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(`${file}.tmp`, JSON.stringify(copy), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    };
    this.saving = (this.saving ?? Promise.resolve()).then(run).catch(error => {
      this.options.log(`copy ${this.name}: save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Resolves once the last save asked for is on disk. */
  flushed(): Promise<void> { return this.saving ?? Promise.resolve(); }

  close(): void {
    this.closed = true;
    for (const timer of [this.changeTimer, this.catchUpTimer, this.reconnectTimer, this.resyncTimer, this.saveTimer, this.pollTimer]) clearTimeout(timer);
  }
}
