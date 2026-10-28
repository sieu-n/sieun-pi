import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type SessionSummary } from "prime-agent";
import { DaemonClient } from "./daemon-sdk.ts";
import { waitedOnHost } from "./chat-latency.ts";
import { mirrorFile, pruneMirror } from "./host-mirror.ts";
import { HostReach, seenAgo } from "./host-reach.ts";
import { HostBridge, selfHost, type Host, type HostsRegistry } from "./hosts.ts";
import { SessionPeer } from "./session-peer.ts";

/**
 * Copies of other boxes' session files, refreshed by byte range, so readers that open a session file by path work for every host. HOME is read
 * at each call: on 10-25 at 07:45Z a one-process run of the whole test suite loaded this module before mac-offline-first-frame.test.ts pointed
 * HOME at a temp folder, and that test wrote its 2 fixture rows over the real Mac copy, so d9 could no longer place 5 held steps on the Mac.
 */
export const mirrorDir = (): string => join(homedir(), ".cache/sieun-pi/hosts");
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
export const mirrorPath = (host: Pick<Host, "name">, path: string): string => join(mirrorDir(), host.name, path);

/** The other box's path of a file named by its copy's path (`mirrorPath`); a path outside the copies comes back as it is. */
export function remotePath(host: Pick<Host, "name">, path: string): string {
  const prefix = join(mirrorDir(), host.name);
  return path.startsWith(prefix + "/") ? path.slice(prefix.length) : path;
}

type Remote = { host: Host; client: DaemonClient; peer: SessionPeer };

/** Where this box keeps its copy of a box's session list (`SessionPeer`) across restarts. */
export const copyPath = (name: string): string => join(mirrorDir(), `${name}.sessions.json`);

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

  /** Each box Tailscale read offline at its last read, with why, from the reads before each connect of its copy (`away`). */
  private readonly offline = new Map<string, string>();
  /** Each box whose last relay read of a session file got no answer, with the error, until a read answers. */
  private readonly unanswered = new Map<string, string>();

  /**
   * `copies` keeps each box's copy on disk (`copyPath`) so a restart lists nothing; tests leave it off. `reach` reads which boxes are offline
   * (src/host-reach.ts); the watch and the outbox share it, so one Tailscale read serves them all.
   */
  /** A new client for each full list of a box (`PeerOptions.fullClient`); a test that fakes a box's client points this at it. */
  fullListClient: (host: Host) => DaemonClient = host => new DaemonClient(this.bridge.socketPath(host.name));

  constructor(readonly registry: HostsRegistry, private readonly bridge: HostBridge, readonly self: Host | null = selfHost(registry),
    private readonly log: (line: string) => void = () => {}, copies = false,
    readonly reach: HostReach = new HostReach({ addressOf: name => registry.hosts.find(host => host.name === name)?.address, log })) {
    for (const host of registry.hosts) {
      if (host.name === self?.name) continue;
      const client = new DaemonClient(bridge.socketPath(host.name));
      const peer = new SessionPeer({ name: host.name, client, fullClient: () => this.fullListClient(host), file: copies ? copyPath(host.name) : null, deadlines: { socketMs: 5000, helloMs: 10_000, subscribeMs: 30_000 },
        changeMs: CHANGE_DEBOUNCE_MS, reconnectMs: RECONNECT_MS, pollMs: REMOTE_POLL_MS, reach: () => this.away(host), log: line => this.log(`hosts: ${line}`),
        onChange: () => { if (copies) this.pruneCopies(host.name); this.onChange(); } });
      this.remotes.set(host.name, { host, client, peer });
    }
  }

  /**
   * Why the box is offline by Tailscale's word, null when it reads online. On 10-18 the MacBook Pro was offline from 13:10Z with its lid closed,
   * and each connect of its copy waited out the tunnel's 10 s every 15 s, while a page that opened a Mac thread waited 15 s per relay read of its
   * file, twice, before the sidebar's first frame went out.
   */
  private async away(host: Host): Promise<string | null> {
    const reach = await this.reach.reach(host.name);
    if (reach.online) { this.offline.delete(host.name); return null; }
    const why = `${host.name} is offline (Tailscale last seen ${seenAgo(Date.now(), reach.lastSeen)})`;
    this.offline.set(host.name, why);
    return why;
  }

  /** True once every other box's copy holds a full list, this run's or the disk copy's; before that a session missing from the rows may be on one. */
  allListed(): boolean { return [...this.remotes.values()].every(remote => remote.peer.listed); }

  /** True once every other box answered a full list or roster list since this service started; a disk copy alone may be 30 min old. */
  allSynced(): boolean { return [...this.remotes.values()].every(remote => remote.peer.synced); }

  /** Resolves once every other box's disk copy is read; after it `allListed` reads true for each box whose copy the last run saved. */
  async loaded(): Promise<void> { await Promise.all([...this.remotes.values()].map(remote => remote.peer.loaded())); }

  /** The name the rows of this box carry; null when this machine is not in hosts.json. */
  get selfName(): string | null { return this.self?.name ?? null; }

  /** Each copy's sync, and a Tailscale read at once, since a copy reads its disk copy before its first connect asks. */
  start(): void {
    for (const remote of this.remotes.values()) {
      void this.away(remote.host).catch(() => {});
      void remote.peer.sync().catch(() => {});
    }
  }

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
  hostRows(): { host: Host; rows: readonly SessionSummary[] }[] {
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
  /** The sum of the copies' versions the index was built at: each version only goes up, so a change of any copy changes the sum. */
  private idsVersion = -1;

  /** The host whose daemon lists this session id or active session id; null for this box's own sessions and unknown ids. */
  hostOf(id: string): Host | null {
    let version = 0;
    for (const remote of this.remotes.values()) version += remote.peer.version;
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
   * share, so a file this service copied costs them only its new bytes. A box Tailscale reads offline is not dialed, and one whose last read or
   * daemon connect got no answer is read again behind the caller: both give the copy this box has at once, or fail at once without one.
   */
  mirror(host: Host, path: string): Promise<string> {
    const key = `${host.name}:${path}`;
    const local = mirrorPath(host, path);
    const offline = this.offline.get(host.name);
    const pending = this.mirrors.get(key) ?? (offline || Date.now() - (this.mirroredAt.get(key) ?? 0) < MIRROR_FRESH_MS ? undefined : this.read(host, path, key, local));
    const peer = this.remotes.get(host.name)?.peer;
    const down = offline ?? this.unanswered.get(host.name) ?? (peer?.state === "down" ? peer.error ?? `${host.name} did not answer` : undefined);
    if (pending && !down) waitedOnHost();
    if (!down) return pending ?? Promise.resolve(local);
    pending?.catch(() => {});
    // A read that got no answer leaves an empty file where the copy goes (mirrorFile opens it first), so only bytes count as a copy.
    if ((statSync(local, { throwIfNoEntry: false })?.size ?? 0) > 0) return Promise.resolve(local);
    return Promise.reject(new Error(`${down}; this box has no copy of ${path}`));
  }

  private read(host: Host, path: string, key: string, local: string): Promise<string> {
    const job = (async () => {
      try { await mirrorFile(host, path, local); } catch (error) {
        // A refusal with a status (404: the file left that box) is an answer; a timeout or a refused connection is not.
        if ((error as { status?: unknown }).status === undefined) this.unanswered.set(host.name, error instanceof Error ? error.message : String(error));
        else this.unanswered.delete(host.name);
        throw error;
      }
      this.unanswered.delete(host.name);
      this.mirroredAt.set(key, Date.now());
      return local;
    })().finally(() => { this.mirrors.delete(key); });
    this.mirrors.set(key, job);
    return job;
  }

  /** The full list each host's copies were last pruned against. */
  private readonly prunedAt = new Map<string, number>();

  /**
   * After each full list of a host, deletes this box's copies of that host's files that no row names. On 10-18 the Mac's copy folder kept 92
   * copies (0.81 GB) of chats that had moved from the Mac to us-metal02, and no reader opens a copy without a row.
   */
  private pruneCopies(name: string): void {
    const remote = this.remotes.get(name);
    const full = remote?.peer.counts.full ?? 0;
    if (!remote || !full || this.prunedAt.get(name) === full) return;
    this.prunedAt.set(name, full);
    const keep = new Set(remote.peer.list().flatMap(row => (row.sessionFile ? [mirrorPath(remote.host, row.sessionFile)] : [])));
    void pruneMirror(join(mirrorDir(), name), keep).then(gone => { if (gone.length) this.log(`hosts: removed ${gone.length} copies of ${name} files no row names`); },
      error => this.log(`hosts: prune ${name} copies: ${error instanceof Error ? error.message : String(error)}`));
  }

  close(): void {
    for (const remote of this.remotes.values()) {
      remote.peer.close();
      remote.client.close();
    }
  }
}
