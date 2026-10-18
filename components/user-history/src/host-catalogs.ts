import { appendFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DaemonClient, type SessionSummary } from "prime-agent";
import { parseSummaries } from "./chat-catalog.ts";
import { HostBridge, readHostFile, selfHost, type Host, type HostsRegistry } from "./hosts.ts";

/** Copies of other boxes' session files, refreshed by byte range, so readers that open a session file by path work for every host. */
export const MIRROR_DIR = join(homedir(), ".cache/sieun-pi/hosts");
const RECONNECT_MS = 5000;
/** Roster updates come up to 116 a minute (10-12); the catalog lays them into one frame per this wait. */
const CHANGE_DEBOUNCE_MS = 300;
const LIVE_FIELDS = ["activeSessionId", "rosterStatus", "isStreaming", "isCompacting", "isBashRunning", "isRunningTools", "hasRunningRlmChildren", "isSessionActive",
  "workerState", "workerPid"] as const;

/** The key the daemon merges its own `list all` by, so a live roster row replaces the saved row of the same session. */
const rowKey = (row: SessionSummary): string => row.sessionFile ?? `id:${row.sessionId}`;

/** A row as saved: the daemon's passivated form of a session whose worker stopped. */
function saved(row: SessionSummary): SessionSummary {
  const copy: Record<string, unknown> = { ...row, activity: "idle" };
  for (const field of LIVE_FIELDS) delete copy[field];
  return copy as unknown as SessionSummary;
}

/** The rows with a roster list laid over them: its rows replace or join theirs, and a row live before but missing from it is saved now. */
export function rosterMerge(rows: ReadonlyMap<string, SessionSummary>, live: readonly SessionSummary[]): Map<string, SessionSummary> {
  const next = new Map(rows);
  const liveKeys = new Set(live.map(rowKey));
  for (const [key, row] of next) if (row.activeSessionId !== undefined && !liveKeys.has(key)) next.set(key, saved(row));
  for (const row of live) next.set(rowKey(row), { ...next.get(rowKey(row)), ...row });
  return next;
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
    next.set(key, { ...next.get(key), ...row });
    agents.set(entry.agentId, key);
  }
  for (const agentId of update.removed ?? []) {
    const key = agents.get(agentId) ?? (next.has(`id:${agentId}`) ? `id:${agentId}` : [...next.entries()].find(([, row]) => row.sessionId === agentId)?.[0]);
    const row = key === undefined ? undefined : next.get(key);
    if (key === undefined || !row) { unknown = true; continue; }
    next.set(key, saved(row));
    agents.delete(agentId);
  }
  return { rows: next, unknown };
}

type Remote = {
  host: Host;
  client: DaemonClient;
  subscribed: boolean;
  /** The host's rows by rowKey: its full list at connect, with every roster update laid over it since; empty before the first list. */
  rows: Map<string, SessionSummary>;
  /** Each roster agent id the updates named, to the row key it changed. */
  agents: Map<string, string>;
  /** False until the full list of this connection landed; roster updates before it wait for that list. */
  listed: boolean;
  connecting?: Promise<void> | undefined;
  listing?: Promise<void> | undefined;
  changeTimer?: ReturnType<typeof setTimeout> | undefined;
  reconnectTimer?: ReturnType<typeof setTimeout> | undefined;
  error?: string | undefined;
};

/**
 * The daemons of the other hosts in hosts.json, each through its bridge socket: their session lists, tagged by host, and a client per host,
 * so the catalog merges every box into one sidebar and each command goes to the daemon that runs the session. The box this service runs on
 * stays the catalog's own client and is not in here.
 */
export class HostCatalogs {
  private readonly remotes = new Map<string, Remote>();
  private readonly mirrors = new Map<string, Promise<string>>();
  private closed = false;
  /** Called after a host's rows changed or it went down, so the catalog lays them into its next frame. */
  onChange: () => void = () => {};

  constructor(readonly registry: HostsRegistry, private readonly bridge: HostBridge, readonly self: Host | null = selfHost(registry),
    private readonly log: (line: string) => void = () => {}) {
    for (const host of registry.hosts) {
      if (host.name === self?.name) continue;
      const remote: Remote = { host, client: new DaemonClient(bridge.socketPath(host.name)), subscribed: false, rows: new Map(), agents: new Map(), listed: false };
      remote.client.onMessage(message => { if (message.type === "roster_update") this.onRoster(remote, message as RosterUpdate); });
      remote.client.onClose(error => {
        remote.subscribed = false;
        remote.listed = false;
        remote.error = error.message;
        this.onChange();
        this.scheduleReconnect(remote);
      });
      this.remotes.set(host.name, remote);
    }
  }

  /** The name the rows of this box carry; null when this machine is not in hosts.json. */
  get selfName(): string | null { return this.self?.name ?? null; }

  start(): void { for (const remote of this.remotes.values()) void this.refresh(remote, true).catch(() => {}); }

  private scheduleReconnect(remote: Remote): void {
    if (this.closed || remote.reconnectTimer) return;
    remote.reconnectTimer = setTimeout(() => { remote.reconnectTimer = undefined; void this.refresh(remote, true).catch(() => {}); }, RECONNECT_MS);
    remote.reconnectTimer.unref();
  }

  /** Lays a roster update over the host's rows, with no list; an update it cannot place lists the roster (live sessions only) once. */
  private onRoster(remote: Remote, update: RosterUpdate): void {
    if (!remote.listed) return;
    this.counts.updates++;
    const { rows, unknown } = applyRosterUpdate(remote.rows, remote.agents, update);
    remote.rows = rows;
    this.changed(remote);
    if (unknown) void this.refresh(remote, false).catch(() => {});
  }

  private changed(remote: Remote): void {
    this.ids = null;
    if (this.closed || remote.changeTimer) return;
    remote.changeTimer = setTimeout(() => { remote.changeTimer = undefined; this.onChange(); }, CHANGE_DEBOUNCE_MS);
  }

  /** How many full lists, roster lists and roster updates this service took from the other boxes since it started. */
  readonly counts = { full: 0, roster: 0, updates: 0 };

  private async connect(remote: Remote): Promise<void> {
    if (remote.client.isConnected && remote.subscribed) return;
    remote.connecting ??= (async () => {
      try {
        await remote.client.reconnect(5000);
        await remote.client.waitForHello(10_000);
        const response = await remote.client.request({ type: "roster_subscribe" }, 30_000, { recoverable: false });
        if (!response.success) throw new Error(response.error);
        remote.subscribed = true;
        remote.error = undefined;
      } catch (error) {
        remote.client.resetTransportForReconnect();
        throw error;
      } finally { remote.connecting = undefined; }
    })();
    return remote.connecting;
  }

  /**
   * Lists one host: everything at connect and after a reconnect (`full`), else only its live roster laid over the rows it has. A full list of
   * the Mac was 3,307 rows in 6 to 21 s, and the roster overlay that needed one whenever a session started or stopped ran it every 10 to 40 s
   * (10-18 03:03Z to 03:11Z), so between connects the rows follow the roster updates instead.
   */
  private refresh(remote: Remote, full: boolean): Promise<void> {
    if (remote.listing) return remote.listing.then(() => full ? undefined : this.refresh(remote, false));
    remote.listing = (async () => {
      try {
        await this.connect(remote);
        const list = async (all: boolean) => {
          const response = await remote.client.request(all ? { type: "list", all: true } : { type: "list" }, 2 ** 31 - 1, { recoverable: false });
          if (!response.success) throw new Error(response.error);
          return parseSummaries(response.data);
        };
        const started = Date.now();
        if (full || !remote.listed) {
          remote.agents.clear();
          remote.rows = new Map((await list(true)).map(row => [rowKey(row), row]));
          remote.listed = true;
          this.counts.full++;
          this.log(`hosts: ${remote.host.name}: full list answered in ${((Date.now() - started) / 1000).toFixed(1)} s, ${remote.rows.size} rows`);
        } else {
          remote.rows = rosterMerge(remote.rows, await list(false));
          this.counts.roster++;
        }
        this.changed(remote);
      } catch (error) {
        remote.error = error instanceof Error ? error.message : String(error);
        this.log(`hosts: ${remote.host.name}: ${remote.error}`);
        this.onChange();
        this.scheduleReconnect(remote);
        throw error;
      } finally { remote.listing = undefined; }
    })();
    return remote.listing;
  }

  /** Every other host's rows. A host whose daemon is not reachable keeps its last rows as saved ones, since none of its sessions can be reached. */
  rows(): SessionSummary[] {
    return [...this.remotes.values()].flatMap(remote => remote.subscribed ? [...remote.rows.values()] : [...remote.rows.values()].map(saved));
  }

  /** Session ids and active session ids of the other boxes' rows to their host; rebuilt after a change, since a frame asks once per row. */
  private ids: Map<string, Host> | null = null;

  /** The host whose daemon lists this session id or active session id; null for this box's own sessions and unknown ids. */
  hostOf(id: string): Host | null {
    if (!this.ids) {
      this.ids = new Map();
      for (const remote of this.remotes.values()) for (const row of remote.rows.values()) {
        this.ids.set(row.sessionId, remote.host);
        if (row.activeSessionId) this.ids.set(row.activeSessionId, remote.host);
      }
    }
    return this.ids.get(id) ?? null;
  }

  /** The client for a host by name; null for this box (the catalog's own client) and names hosts.json does not list. */
  client(name: string): DaemonClient | null { return this.remotes.get(name)?.client ?? null; }

  /** Connects to the host's daemon first when its bridge dropped, so a command right after a reconnect does not fail. */
  async ready(name: string): Promise<DaemonClient | null> {
    const remote = this.remotes.get(name);
    if (!remote) return null;
    await this.connect(remote);
    return remote.client;
  }

  socketPath(name: string): string { return this.bridge.socketPath(name); }

  /** Every host's state for the Hosts view: up once its daemon answered a roster subscribe on this connection. */
  status(): { name: string; up: boolean; error: string | null; rows: number }[] {
    return [...this.remotes.values()].map(remote => ({ name: remote.host.name, up: remote.subscribed, error: remote.subscribed ? null : remote.error ?? null, rows: remote.rows.size }));
  }

  /**
   * A local copy of a session file on another host, brought up to date from the byte the copy ends at, so a JSONL transcript costs only its new
   * lines. A copy longer than the host's file (rewritten there) is fetched whole again.
   */
  mirror(host: Host, path: string): Promise<string> {
    const key = `${host.name}:${path}`;
    const pending = this.mirrors.get(key);
    if (pending) return pending;
    const local = join(MIRROR_DIR, host.name, path);
    const job = (async () => {
      await mkdir(dirname(local), { recursive: true, mode: 0o700 });
      const have = await stat(local).then(info => info.size, () => 0);
      const read = await readHostFile(host, path, { from: have });
      if (read.size < have) {
        const whole = await readHostFile(host, path);
        await writeFile(`${local}.tmp`, whole.bytes, { mode: 0o600 });
        await rename(`${local}.tmp`, local);
      } else if (read.bytes.length) await appendFile(local, read.bytes, { mode: 0o600 });
      else if (!have) await writeFile(local, "", { mode: 0o600 });
      return local;
    })().finally(() => { this.mirrors.delete(key); });
    this.mirrors.set(key, job);
    return job;
  }

  close(): void {
    this.closed = true;
    for (const remote of this.remotes.values()) {
      clearTimeout(remote.changeTimer);
      clearTimeout(remote.reconnectTimer);
      remote.client.close();
    }
  }
}
