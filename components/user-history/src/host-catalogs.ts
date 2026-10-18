import { appendFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DaemonClient, type SessionSummary } from "prime-agent";
import { parseSummaries, rosterOverlay } from "./chat-catalog.ts";
import { HostBridge, readHostFile, selfHost, type Host, type HostsRegistry } from "./hosts.ts";

/** Copies of other boxes' session files, refreshed by byte range, so readers that open a session file by path work for every host. */
export const MIRROR_DIR = join(homedir(), ".cache/sieun-pi/hosts");
const RECONNECT_MS = 5000;
const ROSTER_DEBOUNCE_MS = 300;
const LIVE_FIELDS = ["activeSessionId", "rosterStatus", "isStreaming", "isCompacting", "isBashRunning", "isRunningTools", "hasRunningRlmChildren", "isSessionActive"] as const;

type Remote = {
  host: Host;
  client: DaemonClient;
  subscribed: boolean;
  /** The host's rows from its last full list with its roster laid over; empty before the first one. */
  rows: SessionSummary[];
  connecting?: Promise<void> | undefined;
  listing?: Promise<void> | undefined;
  rosterTimer?: ReturnType<typeof setTimeout> | undefined;
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
      const remote: Remote = { host, client: new DaemonClient(bridge.socketPath(host.name)), subscribed: false, rows: [] };
      remote.client.onMessage(message => { if (message.type === "roster_update") this.scheduleRoster(remote); });
      remote.client.onClose(error => {
        remote.subscribed = false;
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

  private scheduleRoster(remote: Remote): void {
    if (this.closed || remote.rosterTimer) return;
    remote.rosterTimer = setTimeout(() => { remote.rosterTimer = undefined; void this.refresh(remote, false).catch(() => {}); }, ROSTER_DEBOUNCE_MS);
  }

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

  /** Lists one host: the roster laid over its last full list, or a full list when the live set changed or `full` asks for one. */
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
        const overlaid = !full && remote.rows.length ? rosterOverlay(remote.rows, await list(false)) : undefined;
        const started = Date.now();
        remote.rows = overlaid ?? await list(true);
        if (!overlaid) this.log(`hosts: ${remote.host.name}: full list answered in ${((Date.now() - started) / 1000).toFixed(1)} s, ${remote.rows.length} rows`);
        this.onChange();
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
    return [...this.remotes.values()].flatMap(remote => remote.subscribed ? remote.rows : remote.rows.map(row => {
      const saved: Record<string, unknown> = { ...row };
      for (const field of LIVE_FIELDS) delete saved[field];
      return saved as unknown as SessionSummary;
    }));
  }

  /** The host whose daemon lists this session id or active session id; null for this box's own sessions and unknown ids. */
  hostOf(id: string): Host | null {
    for (const remote of this.remotes.values()) if (remote.rows.some(row => row.sessionId === id || row.activeSessionId === id)) return remote.host;
    return null;
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
    return [...this.remotes.values()].map(remote => ({ name: remote.host.name, up: remote.subscribed, error: remote.subscribed ? null : remote.error ?? null, rows: remote.rows.length }));
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
      clearTimeout(remote.rosterTimer);
      clearTimeout(remote.reconnectTimer);
      remote.client.close();
    }
  }
}
