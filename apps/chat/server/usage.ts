/**
 * Usage and hosts. Usage sums pi-host's `durable_usage` rows; hosts reads the hosts registry and each box's relay. The pool's
 * accounts are server/accounts.ts.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostsReport, HostView, MachineView, UsageReport, UsageRow } from "../web/src/lib/api/types.ts";
import type { Host, UsageTotal } from "./host/types.ts";
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

/** The hosts registry (~/.config/sieun-pi/hosts.json), this box first. */
export async function hostsReport(host: Host, threads: Threads, box: string, socket: string): Promise<HostsReport> {
  let registry: RegistryHost[] = [];
  let registryError: string | null = null;
  try {
    registry = (JSON.parse(readFileSync(join(homedir(), ".config/sieun-pi/hosts.json"), "utf8")) as { hosts: RegistryHost[] }).hosts;
  } catch (error) {
    registryError = error instanceof Error ? error.message : String(error);
  }
  const self = registry.find(h => h.name === box) ?? { name: box, address: "127.0.0.1" };
  const others = registry.filter(h => h.name !== box);
  const ping = await host.ping();
  const mine: HostView = {
    name: self.name, address: self.address, self: true, relay: { state: "up", pingMs: 0 },
    piHost: ping.ok ? { state: "answering", version: ping.version, socket } : { state: "down", error: ping.error },
    machine: registry.some(h => h.name === box) ? await relayHost(self).then(r => r.machine).catch(() => null) : null,
    threads: threads.threadsList().filter(t => !t.archived).map(t => ({ id: t.id, name: t.name, status: statusOf(t.status), model: `${t.provider}/${t.modelId}`, updatedAt: t.updatedAt, children: t.children })),
  };
  const views = await Promise.all(others.map(async (h): Promise<HostView> => {
    try {
      const read = await relayHost(h);
      return { name: h.name, address: h.address, self: false, relay: { state: "up", pingMs: read.pingMs }, piHost: { state: "absent" }, machine: read.machine, threads: [] };
    } catch (error) {
      return { name: h.name, address: h.address, self: false, relay: { state: "unreachable", error: error instanceof Error ? error.message : String(error) }, piHost: { state: "absent" }, machine: null, threads: [] };
    }
  }));
  return { checkedAt: Date.now(), registryError, hosts: [mine, ...views] };
}
