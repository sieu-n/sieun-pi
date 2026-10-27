import { readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { machineView, type HostStats, type MachineView } from "../../prime-relay/host-stats.ts";
import { type AgentCounts, hostCounts } from "./agent-states.ts";
import { parseAgentQueue } from "./chat-pool.ts";
import { queueRows } from "./chat-agent-queue.ts";
import { hostHealth, hostToken, loadHosts, relayLead, selfHost, type Host, type HostsRegistry } from "./hosts.ts";
import type { AgentQueuePool, HostCard, HostRole, HostsView, NewChatPicks } from "./shared/types.ts";

/** One relay read: GET /v1/host answers in about 0.2 s from the Mac over the tailnet (185 ms ping on 10-18), so 5 s means the box is away. */
const RELAY_TIMEOUT_MS = 5_000;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Writes each box's turn queue lead list from the whole chat list: the chats that run on this box through `local` (`pi-pool lead` here), and
 * each other box's chats through its relay (`relayLead`), so a Mac chat's queued runs start first in the Mac's own queue. A call with `every`
 * writes each box, as a chat list change does; one without writes only a box whose list changed since its last write, so a call on each row
 * change costs nothing until a chat moves box. A box that did not answer logs one line and gets its list again at the next chat list change:
 * retried on each row change, a Mac whose pi-pool had no `lead` yet logged a 500 every 0.7 s on 10-22. Calls run one at a time, in order.
 *
 * A session someone put on a box's list by hand (`pi-pool lead`) stays on it: each write reads the box's list now (`current`) and keeps every
 * id on it that this writer did not write last time (`store` keeps those lists across restarts). Before, each write replaced the list: on
 * 10-22 the metal box owner (01a11d24), added by hand at 14:04:21Z, was dropped by the 14:06:46Z write and waited 28 min at place 15. A box
 * this writer never wrote, or whose list does not read, keeps the hand ids it had at its last read.
 */
export interface LeadStore {
  read(): Promise<Record<string, string[]>>;
  write(lists: Record<string, string[]>): Promise<void>;
}

export function leadWriter(options: { hostOf: (id: string) => string | null; remotes: () => readonly Host[]; local: (ids: readonly string[]) => Promise<void>;
  remote?: (host: Host, ids: readonly string[]) => Promise<void>; current?: (host: Host | null) => Promise<readonly string[]>; store?: LeadStore;
  log: (line: string) => void }): (ids: readonly string[], every?: boolean) => Promise<void> {
  const remote = options.remote ?? relayLead;
  const written = new Map<string | null, string>();
  /** Each box's own ids at its last write, by box name ("" for this box). */
  let ours: Record<string, string[]> | null = null;
  const hand = new Map<string | null, string[]>();
  let tail: Promise<void> = Promise.resolve();
  const write = async (ids: readonly string[], every: boolean) => {
    ours ??= await options.store?.read().catch(() => ({})) ?? {};
    const hosts = options.remotes();
    const boxes = new Map<string | null, string[]>([[null, []], ...hosts.map(host => [host.name, []] as [string, string[]])]);
    for (const id of ids) boxes.get(options.hostOf(id))?.push(id);
    let changed = false;
    await Promise.all([...boxes].map(async ([name, list]) => {
      const key = list.sort().join("\n");
      if (!every && written.get(name) === key) return;
      written.set(name, key);
      const host = hosts.find(candidate => candidate.name === name) ?? null;
      const last = ours![name ?? ""];
      if (options.current && last) {
        const now = await options.current(host).catch(() => null);
        if (now) hand.set(name, now.filter(id => !last.includes(id) && !list.includes(id)));
      }
      const kept = (hand.get(name) ?? []).filter(id => !list.includes(id));
      try {
        await (host ? remote(host, [...list, ...kept]) : options.local([...list, ...kept]));
        ours![name ?? ""] = list;
        changed = true;
        if (kept.length) options.log(`turn queue lead list on ${name ?? "this box"}: kept ${kept.length} added by hand (${kept.map(id => id.slice(0, 8)).join(", ")})`);
      } catch (error) { options.log(`turn queue lead list on ${name ?? "this box"}: ${message(error)}`); }
    }));
    if (changed) await options.store?.write(ours).catch(error => options.log(`turn queue lead list record: ${message(error)}`));
  };
  return (ids, every = false) => (tail = tail.then(() => write(ids, every)));
}

/** `path` as the lead writer's record of the lists it wrote (`LeadStore`), written whole by rename. */
export function leadStore(path: string): LeadStore {
  return {
    async read() {
      const value: unknown = JSON.parse(await readFile(path, "utf8").catch(() => "{}"));
      return isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every(id => typeof id === "string"))) : {};
    },
    async write(lists) {
      await writeFile(`${path}.tmp`, JSON.stringify(lists));
      await rename(`${path}.tmp`, path);
    },
  };
}

/** A box's lead list now: this box's `pi-pool queue --json` through `localQueue`, another box's through its relay's pool reading. */
export async function leadNow(host: Host | null, localQueue: () => Promise<unknown>): Promise<readonly string[]> {
  const queue = host ? (await relayStats(host)).pool : { queue: await localQueue() };
  const lead = "queue" in queue && isRecord(queue.queue) ? queue.queue.lead : undefined;
  if (!Array.isArray(lead) || !lead.every(id => typeof id === "string")) throw new Error(`the turn queue on ${host?.name ?? "this box"} read no lead list`);
  return lead;
}

/** The relay's machine reading, checked at the edge for the numbers the Hosts card draws. */
export function parseMachine(value: unknown): MachineView {
  if (!isRecord(value) || !isRecord(value.cpu) || !isRecord(value.memory) || (value.platform !== "darwin" && value.platform !== "linux")) throw new Error("the relay sent no machine reading");
  const { cpu, memory } = value;
  if (typeof cpu.percent !== "number" || typeof cpu.cores !== "number" || !Array.isArray(cpu.load) || typeof memory.usedBytes !== "number" || typeof memory.totalBytes !== "number")
    throw new Error("the relay sent a machine reading without CPU or memory numbers");
  return value as unknown as MachineView;
}

/** A box's own `pi-pool queue --json` as the Agent queue reads it, rows named by the catalog. */
export function parsePool(value: unknown, title: (id: string) => string | null): AgentQueuePool {
  if (!isRecord(value)) return { state: "unread", error: "the relay sent no pool reading" };
  if (typeof value.error === "string") return { state: "unread", error: value.error };
  try {
    const reading = parseAgentQueue(value.queue);
    return { state: "read", ...reading, rows: queueRows(reading, title) };
  } catch (error) { return { state: "unread", error: message(error) }; }
}

export async function relayStats(host: Host): Promise<HostStats> {
  const response = await fetch(`http://${host.address}:${host.relayPort}/v1/host`, { headers: { authorization: `Bearer ${await hostToken(host)}` }, signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`relay ${host.name} answered ${response.status}`);
  return await response.json() as HostStats;
}

const roleList = (host: Host): HostRole[] => (Object.keys(host.roles) as HostRole[]).sort();

export interface HostsOptions {
  /** This box's turn queue, read in-process (the Agent queue pane's own reading). */
  selfQueue: () => Promise<AgentQueuePool>;
  title: (id: string) => string | null;
  picks: () => Promise<NewChatPicks>;
  /** The daemon rows this service lists for a box, null for this box; none before the catalog's first list. */
  rows: (host: string | null) => readonly unknown[];
  /** This box's hung tool calls' sessions (src/hung-calls.ts), counted as hung instead of working; absent, none. */
  hung?: () => ReadonlySet<string>;
  /** Whether this box's daemon link is up now (chat-catalog.ts `reachable`); absent, it reads up. */
  selfDaemon?: () => boolean;
  load?: () => Promise<HostsRegistry>;
  selfMachine?: () => Promise<MachineView>;
  remote?: (host: Host) => Promise<HostStats>;
}

/** The short hostname of this box, its card's name when hosts.json is absent. */
export const thisBox = (): string => hostname().split(".")[0]!.toLowerCase();

/** Settings > Hosts and the New chat host picker: every box in hosts.json, this one first, each read once per call. */
export function hostsView(options: HostsOptions): () => Promise<HostsView> {
  const { selfQueue, title, picks, rows, load = loadHosts, selfMachine = machineView, remote = relayStats, hung, selfDaemon } = options;
  /** A box's counts from its rows with its turn queue as a floor (agent-states.ts `hostCounts`); null before the first list. */
  const sessions = (host: string | null, queue: AgentQueuePool): AgentCounts | null => {
    const listed = rows(host);
    const pool = queue.state === "read" ? { working: queue.working.length, queued: queue.queued.length } : null;
    return listed.length ? hostCounts(listed, pool, host === null ? hung?.() : undefined) : null;
  };

  async function selfCard(host: Host | null): Promise<HostCard> {
    const [machine, queue] = await Promise.all([selfMachine(), selfQueue()]);
    return { name: host?.name ?? thisBox(), address: host?.address ?? "127.0.0.1", roles: host ? roleList(host) : [], self: true, state: "up",
      daemon: selfDaemon?.() === false ? "down" : "answering", pingMs: null, machine, queue, sessions: sessions(null, queue) };
  }

  async function remoteCard(host: Host): Promise<HostCard> {
    const base = { name: host.name, address: host.address, roles: roleList(host), self: false };
    const started = Date.now();
    try {
      const [stats, health] = await Promise.all([remote(host), hostHealth(host)]);
      const queue = parsePool(stats.pool, title);
      return { ...base, state: "up", daemon: health.ok ? health.daemon : "down", pingMs: Date.now() - started, machine: parseMachine(stats.machine), queue,
        sessions: sessions(host.name, queue) };
    } catch (error) { return { ...base, state: "unreachable", pingMs: Date.now() - started, error: message(error) }; }
  }

  return async () => {
    let registry: HostsRegistry | null = null, registryError: string | null = null;
    try { registry = await load(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") registryError = message(error); }
    const self = registry ? selfHost(registry) : null;
    const others = registry?.hosts.filter(host => host.name !== self?.name) ?? [];
    const [hosts, last] = await Promise.all([Promise.all([selfCard(self), ...others.map(remoteCard)]), picks().catch((): NewChatPicks => ({ lastHost: null, lastWorkspace: {} }))]);
    const listed = (name: string) => hosts.some(host => host.name === name);
    return { hosts, lastHost: last.lastHost && listed(last.lastHost) ? last.lastHost : null,
      lastWorkspace: Object.fromEntries(Object.entries(last.lastWorkspace).filter(([name]) => listed(name))), registryError, checkedAt: Date.now() };
  };
}
