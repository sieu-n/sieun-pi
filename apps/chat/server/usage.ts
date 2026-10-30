/**
 * Usage and hosts. Usage sums pi-host's `durable_usage` rows; hosts reads the hosts registry and each box's relay. The pool's
 * accounts are server/accounts.ts.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRelayLink, HostsReport, HostView, MachineView, UsageReport, UsageRow } from "../web/src/lib/api/types.ts";
import { MultiHost } from "./host/multi-host.ts";
import type { RelayHost } from "./host/relay-host.ts";
import type { Host, Ping, UsageTotal } from "./host/types.ts";
import { OWNER_ZONE_OFFSET_MS } from "./search.ts";
import { statusOf, type Threads } from "./threads.ts";

/** One row's cost by kind, as pi-host sums it from each answer's own usage. */
export const costOf = (total: UsageTotal): UsageRow["cost"] => ({
  input: total.costInput, output: total.costOutput, cacheRead: total.costCacheRead, cacheWrite: total.costCacheWrite, total: total.cost,
});

const DAY = 86_400_000;
export const localDayStart = (at: number): number => Math.floor((at + OWNER_ZONE_OFFSET_MS) / DAY) * DAY - OWNER_ZONE_OFFSET_MS;

export async function usageReport(host: Host, threads: Threads, box: string, opts: { days: number; thread?: string; host?: string }, now = Date.now()): Promise<UsageReport> {
  const days = Math.min(Math.max(Math.round(opts.days) || 1, 1), 366);
  const until = localDayStart(now) + DAY;
  const since = until - days * DAY;
  const scope = opts.thread ? { threads: [opts.thread] } : {};
  if (opts.host && opts.host !== box) return { at: now, since, until, rows: [], days: [], previous: { cost: 0, complete: true } };
  const totals = await host.usage({ since, until, ...scope });
  const rows: UsageRow[] = totals.map(t => ({
    thread: t.thread, threadName: threads.thread(t.thread)?.name ?? t.thread, host: box, model: t.model, turns: t.turns,
    tokens: { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite }, cost: costOf(t),
  }));
  const perDay = await Promise.all(Array.from({ length: days }, async (_, i) => {
    const start = since + i * DAY;
    const dayRows = await host.usage({ since: start, until: start + DAY, ...scope });
    const byModel: Record<string, number> = {};
    for (const row of dayRows) byModel[row.model] = (byModel[row.model] ?? 0) + row.cost;
    return { start, byModel };
  }));
  const previousRows = await host.usage({ since: since - days * DAY, until: since, ...scope });
  const oldest = Math.min(...threads.threadsList().map(t => t.createdAt), now);
  return { at: now, since, until, rows, days: perDay, previous: { cost: previousRows.reduce((sum, r) => sum + r.cost, 0), complete: oldest <= since - days * DAY } };
}

interface RegistryHost { name: string; address: string; relayPort?: number; token?: string }

/** The relay's bearer token: the registry stores "file:<path>", relative to ~/.config/sieun-pi or absolute. */
function relayToken(host: RegistryHost): string | null {
  if (!host.token?.startsWith("file:")) return null;
  const path = host.token.slice("file:".length);
  try {
    return readFileSync(path.startsWith("/") ? path : join(homedir(), ".config/sieun-pi", path), "utf8").trim();
  } catch {
    return null;
  }
}

/** One box's machine reading from its relay's GET /v1/host. */
async function relayHost(h: RegistryHost): Promise<{ pingMs: number; machine: MachineView | null }> {
  const started = Date.now();
  const token = relayToken(h);
  const response = await fetch(`http://${h.address}:${h.relayPort ?? 7790}/v1/host`, { signal: AbortSignal.timeout(5000), ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
  const body = response.ok ? ((await response.json()) as { machine?: MachineView }) : null;
  return { pingMs: Date.now() - started, machine: body?.machine ?? null };
}

/** What the box's `RelayHost` holds about its link, read from memory with no call to the box. */
export function agentRelayLink(relay: RelayHost): AgentRelayLink {
  const link = relay.state();
  return {
    state: link.state, since: link.since, lastPongAt: relay.lastPongAt ?? null, version: relay.hello?.version ?? null,
    piHost: relay.hello?.piHost ?? null, feedCursor: relay.cursor(),
  };
}

const piHostView = (ping: NonNullable<Ping["boxes"]>[string], socket?: string): HostView["piHost"] =>
  ping.ok ? { state: "answering", version: ping.version, ...(socket ? { socket } : {}) } : { state: "down", error: ping.error };

/**
 * Every box in the hosts registry and every box the chat server routes agents to, this box first. The machine figures come from each box's
 * machine relay; the agent relay link and a remote pi-host come from the `RelayHost` in memory.
 */
export async function hostsReport(host: Host, threads: Threads, box: string, socket: string, hostsFile: string): Promise<HostsReport> {
  let registry: RegistryHost[] = [];
  let registryError: string | null = null;
  try {
    registry = (JSON.parse(readFileSync(hostsFile, "utf8")) as { hosts: RegistryHost[] }).hosts;
  } catch (error) {
    registryError = error instanceof Error ? error.message : String(error);
  }
  const routing = host instanceof MultiHost ? host : undefined;
  const names = [...new Set([box, ...registry.map(h => h.name), ...(routing?.list().map(b => b.box) ?? [])])];
  // The link is read in the same tick as the ping, before the machine relay reads, so a box's pi-host and link state agree.
  const ping = await host.ping();
  const rows = threads.threadsList().filter(t => !t.archived);
  const views = await Promise.all(names.map(async (name): Promise<HostView> => {
    const self = name === box;
    const entry = registry.find(h => h.name === name);
    const relay = routing?.relay(name);
    const agentRelay = relay ? agentRelayLink(relay) : null;
    const boxPing = ping.boxes?.[name] ?? (self ? ping : undefined);
    const piHost: HostView["piHost"] = boxPing ? piHostView(boxPing, self ? socket : undefined) : { state: "absent" };
    let machine: MachineView | null = null;
    let machineRelay: HostView["relay"] = self ? { state: "up", pingMs: 0 } : { state: "unreachable", error: `${name} is not in ${hostsFile}` };
    if (entry) {
      try {
        const read = await relayHost(entry);
        machine = read.machine;
        if (!self) machineRelay = { state: "up", pingMs: read.pingMs };
      } catch (error) {
        if (!self) machineRelay = { state: "unreachable", error: error instanceof Error ? error.message : String(error) };
      }
    }
    return {
      name, address: entry?.address ?? (self ? "127.0.0.1" : "unknown"), self, relay: machineRelay, piHost,
      agentRelay, machine,
      threads: piHost.state === "absent" ? [] : rows.filter(t => (t.box ?? box) === name)
        .map(t => ({ id: t.id, name: t.name, status: statusOf(t.status), model: `${t.provider}/${t.modelId}`, updatedAt: t.updatedAt, children: t.children })),
    };
  }));
  return { checkedAt: Date.now(), registryError, hosts: views };
}
