import { homedir } from "node:os";
import { join } from "node:path";
import { DaemonClient, type SessionSummary } from "prime-agent";
import { mirrorFile } from "./host-mirror.ts";
import { HostBridge, selfHost, type Host, type HostsRegistry } from "./hosts.ts";
import { SessionPeer } from "./session-peer.ts";

/** Copies of other boxes' session files, refreshed by byte range, so readers that open a session file by path work for every host. */
export const MIRROR_DIR = join(homedir(), ".cache/sieun-pi/hosts");
const RECONNECT_MS = 5000;
/**
 * Another box's copy lists its roster (live sessions only) this often instead of following its roster_update stream. On 10-18 the Mac's stream
 * through the relay sent 199.7 MB in 9 min to the box's chat service (release-30de70f): the daemon marks a client backpressured on any write
 * over the socket's buffer and, on each drain, resends the whole roster (204 entries, 651 KB, inactive agents too) if anything changed meanwhile,
 * so over a 185 ms link the resends never stopped. The roster list was 79 rows, 215 KB and 0.3 to 1.0 s, so this costs about 860 KB a minute.
 * Owner, 10-18 15:18 KST: "그냥 종종 싱크 맞춰" (just sync now and then).
 */
export const REMOTE_POLL_MS = 15_000;
/** Roster updates come up to 116 a minute (10-12); the catalog lays them into one frame per this wait. */
const CHANGE_DEBOUNCE_MS = 300;
/** A copy brought up to date this recently is used as it is; a check-in tick asks for the same chat's file several times in a row. */
const MIRROR_FRESH_MS = 2000;
/** Where this box keeps its copy of another box's file. */
export const mirrorPath = (host: Pick<Host, "name">, path: string): string => join(MIRROR_DIR, host.name, path);

/** The other box's path of a file named by its copy's path (`mirrorPath`); a path outside the copies comes back as it is. */
export function remotePath(host: Pick<Host, "name">, path: string): string {
  const prefix = join(MIRROR_DIR, host.name);
  return path.startsWith(prefix + "/") ? path.slice(prefix.length) : path;
}

type Remote = { host: Host; client: DaemonClient; peer: SessionPeer };

/** Where this box keeps its copy of a box's session list (`SessionPeer`) across restarts. */
export const copyPath = (name: string): string => join(MIRROR_DIR, `${name}.sessions.json`);

/**
 * Each other box's row with its session file named by its local copy's path (`mirrorPath`), kept while that box's copy holds the same row
 * object, since a roster update replaces only the rows it changed. On 10-18 copying all 3,063 Mac rows and joining each path on every list
 * took 7.7% of the box chat's main thread.
 */
export class MirroredRows {
  private readonly copies = new WeakMap<SessionSummary, SessionSummary>();
  row(host: Host, row: SessionSummary): SessionSummary {
    if (!row.sessionFile) return row;
    let copy = this.copies.get(row);
    if (!copy) { copy = { ...row, sessionFile: mirrorPath(host, row.sessionFile) }; this.copies.set(row, copy); }
    return copy;
  }
}

/**
 * The daemons of the other hosts in hosts.json, each through its bridge socket: their session lists, tagged by host, and a client per host,
 * so the catalog merges every box into one sidebar and each command goes to the daemon that runs the session. The box this service runs on
 * stays the catalog's own client and is not in here. Each box's rows are a `SessionPeer` copy, which the catalog keeps for this box too.
 */
export class HostCatalogs {
  private readonly remotes = new Map<string, Remote>();
  private readonly mirrors = new Map<string, Promise<string>>();
  private readonly mirroredAt = new Map<string, number>();
  /** Called after a host's rows changed or it went down, so the catalog lays them into its next frame. */
  onChange: () => void = () => {};

  /** `copies` keeps each box's copy on disk (`copyPath`) so a restart lists nothing; tests leave it off. */
  constructor(readonly registry: HostsRegistry, private readonly bridge: HostBridge, readonly self: Host | null = selfHost(registry),
    private readonly log: (line: string) => void = () => {}, copies = false) {
    for (const host of registry.hosts) {
      if (host.name === self?.name) continue;
      const client = new DaemonClient(bridge.socketPath(host.name));
      const peer = new SessionPeer({ name: host.name, client, file: copies ? copyPath(host.name) : null, deadlines: { socketMs: 5000, helloMs: 10_000, subscribeMs: 30_000 },
        changeMs: CHANGE_DEBOUNCE_MS, reconnectMs: RECONNECT_MS, pollMs: REMOTE_POLL_MS, log: line => this.log(`hosts: ${line}`), onChange: () => this.onChange() });
      this.remotes.set(host.name, { host, client, peer });
    }
  }

  /** True once every other box's copy holds a full list, this run's or the disk copy's; before that a session missing from the rows may be on one. */
  allListed(): boolean { return [...this.remotes.values()].every(remote => remote.peer.listed); }

  /** True once every other box answered a full list or roster list since this service started; a disk copy alone may be 30 min old. */
  allSynced(): boolean { return [...this.remotes.values()].every(remote => remote.peer.synced); }

  /** Resolves once every other box's disk copy is read; after it `allListed` reads true for each box whose copy the last run saved. */
  async loaded(): Promise<void> { await Promise.all([...this.remotes.values()].map(remote => remote.peer.loaded())); }

  /** The name the rows of this box carry; null when this machine is not in hosts.json. */
  get selfName(): string | null { return this.self?.name ?? null; }

  start(): void { for (const remote of this.remotes.values()) void remote.peer.sync().catch(() => {}); }

  /** How many full lists, roster lists and roster updates this service took from the other boxes since it started. */
  get counts(): { full: number; roster: number; updates: number } {
    const total = { full: 0, roster: 0, updates: 0 };
    for (const { peer } of this.remotes.values()) { total.full += peer.counts.full; total.roster += peer.counts.roster; total.updates += peer.counts.updates; }
    return total;
  }

  /**
   * Every other host's rows, each session file named by its local copy's path (`mirrorPath`), so no reader on this box opens the other box's
   * path here: on the Mac a /home path makes automountd look it up (1.5 lookups a second from 03:13Z on 10-18), and on the box a /Users path
   * resolves through the /Users/sieunpark link into the box's own sessions. A host whose daemon is not reachable keeps its last rows as saved.
   */
  rows(): readonly SessionSummary[] {
    const version = [...this.remotes.values()].map(remote => remote.peer.version).join(",");
    if (this.listed?.version !== version) {
      this.listed = { version, rows: [...this.remotes.values()].flatMap(remote => remote.peer.list().map(row => this.mirroredRows.row(remote.host, row))) };
    }
    return this.listed.rows;
  }

  /** The last `rows` answer and the box copies' versions it was built from: a box that is down lists fresh saved copies on every call. */
  private listed: { version: string; rows: SessionSummary[] } | null = null;
  private readonly mirroredRows = new MirroredRows();

  /** Each other host with its rows as `rows` gives them, for the watch's per-host numbers. */
  hostRows(): { host: Host; rows: SessionSummary[] }[] {
    return [...this.remotes.values()].map(remote => ({ host: remote.host, rows: remote.peer.list() }));
  }

  /** True when the host's daemon lists the session with a worker now. */
  isActive(id: string): boolean {
    for (const remote of this.remotes.values()) if (remote.peer.isActive(id)) return true;
    return false;
  }

  /** Changes another box's row of a session this server changed itself; false when no box lists it. */
  patch(sessionId: string, fields: Partial<SessionSummary>): boolean {
    let found = false;
    for (const remote of this.remotes.values()) if (remote.peer.patch(sessionId, fields)) found = true;
    return found;
  }

  /** Session ids and active session ids of the other boxes' rows to their host; rebuilt after a change, since a frame asks once per row. */
  private ids: Map<string, Host> | null = null;
  private idsVersion = "";

  /** The host whose daemon lists this session id or active session id; null for this box's own sessions and unknown ids. */
  hostOf(id: string): Host | null {
    const version = [...this.remotes.values()].map(remote => remote.peer.version).join(",");
    if (!this.ids || this.idsVersion !== version) {
      this.ids = new Map();
      this.idsVersion = version;
      for (const remote of this.remotes.values()) for (const row of remote.peer.list()) {
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
    await remote.peer.connect();
    return remote.client;
  }

  socketPath(name: string): string { return this.bridge.socketPath(name); }

  /** Every host's state for the Hosts view: up once its daemon answered a roster subscribe on this connection, stale while it does not. */
  status(): { name: string; up: boolean; error: string | null; rows: number }[] {
    return [...this.remotes.values()].map(({ host, peer }) => ({ name: host.name, up: peer.subscribed, error: peer.subscribed ? null : peer.error ?? null, rows: peer.list().length }));
  }

  /**
   * A local copy of a session file on another host, brought up to date by `mirrorFile`, which the `hosts transcript` and `hosts read` commands
   * share, so a file this service copied costs them only its new bytes.
   */
  mirror(host: Host, path: string): Promise<string> {
    const key = `${host.name}:${path}`;
    const pending = this.mirrors.get(key);
    if (pending) return pending;
    if (Date.now() - (this.mirroredAt.get(key) ?? 0) < MIRROR_FRESH_MS) return Promise.resolve(mirrorPath(host, path));
    const local = mirrorPath(host, path);
    const job = (async () => {
      await mirrorFile(host, path, local);
      this.mirroredAt.set(key, Date.now());
      return local;
    })().finally(() => { this.mirrors.delete(key); });
    this.mirrors.set(key, job);
    return job;
  }

  close(): void {
    for (const remote of this.remotes.values()) {
      remote.peer.close();
      remote.client.close();
    }
  }
}
