import { hostname } from "node:os";
import { machineView, type HostStats, type MachineView } from "../../prime-relay/host-stats.ts";
import { agentCounts, type AgentCounts } from "./agent-states.ts";
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
 * each other box's chats through its relay (`relayLead`), so a Mac chat's queued runs start first in the Mac's own queue. A box whose list did
 * not change since its last write gets none, so a call on each row change costs nothing until a chat moves box; a box that did not answer
 * logs one line and gets its list again at the next call. Calls run one at a time, in order.
 */
export function leadWriter(options: { hostOf: (id: string) => string | null; remotes: () => readonly Host[]; local: (ids: readonly string[]) => Promise<void>;
  remote?: (host: Host, ids: readonly string[]) => Promise<void>; log: (line: string) => void }): (ids: readonly string[]) => Promise<void> {
  const remote = options.remote ?? relayLead;
  const written = new Map<string | null, string>();
  let tail: Promise<void> = Promise.resolve();
  const write = async (ids: readonly string[]) => {
    const hosts = options.remotes();
    const boxes = new Map<string | null, string[]>([[null, []], ...hosts.map(host => [host.name, []] as [string, string[]])]);
    for (const id of ids) boxes.get(options.hostOf(id))?.push(id);
    await Promise.all([...boxes].map(async ([name, list]) => {
      const key = list.sort().join("\n");
      if (written.get(name) === key) return;
      written.delete(name);
      try {
        const host = hosts.find(candidate => candidate.name === name);
        await (host ? remote(host, list) : options.local(list));
        written.set(name, key);
      } catch (error) { options.log(`turn queue lead list on ${name ?? "this box"}: ${message(error)}`); }
    }));
  };
  return ids => (tail = tail.then(() => write(ids)));
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
  load?: () => Promise<HostsRegistry>;
  selfMachine?: () => Promise<MachineView>;
  remote?: (host: Host) => Promise<HostStats>;
}

/** The short hostname of this box, its card's name when hosts.json is absent. */
export const thisBox = (): string => hostname().split(".")[0]!.toLowerCase();

/** Settings > Hosts and the New chat host picker: every box in hosts.json, this one first, each read once per call. */
export function hostsView(options: HostsOptions): () => Promise<HostsView> {
  const { selfQueue, title, picks, rows, load = loadHosts, selfMachine = machineView, remote = relayStats, hung } = options;
  const sessions = (host: string | null): AgentCounts | null => {
    const listed = rows(host);
    return listed.length ? agentCounts(listed, host === null ? hung?.() : undefined) : null;
  };

  async function selfCard(host: Host | null): Promise<HostCard> {
    const [machine, queue] = await Promise.all([selfMachine(), selfQueue()]);
    return { name: host?.name ?? thisBox(), address: host?.address ?? "127.0.0.1", roles: host ? roleList(host) : [], self: true, state: "up", daemon: "answering", pingMs: null, machine, queue,
      sessions: sessions(null) };
  }

  async function remoteCard(host: Host): Promise<HostCard> {
    const base = { name: host.name, address: host.address, roles: roleList(host), self: false };
    const started = Date.now();
    try {
      const [stats, health] = await Promise.all([remote(host), hostHealth(host)]);
      return { ...base, state: "up", daemon: health.ok ? health.daemon : "down", pingMs: Date.now() - started, machine: parseMachine(stats.machine), queue: parsePool(stats.pool, title),
        sessions: sessions(host.name) };
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
