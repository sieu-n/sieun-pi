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

type UsageFold = { totals: UsageTotal[]; perDay: UsageReport["days"]; previousCost: number };
const SUMS = ["turns", "input", "output", "cacheRead", "cacheWrite", "cost", "costInput", "costOutput", "costCacheRead", "costCacheWrite"] as const;

/** The period's totals per thread and model, each day's cost per model and the cost of the period before, from one bucketed answer. */
function byBucket(buckets: readonly UsageTotal[], since: number, days: number): UsageFold {
  const totals = new Map<string, UsageTotal>();
  const perDay = Array.from({ length: days }, (_, i) => ({ start: since + i * DAY, byModel: {} as Record<string, number> }));
  let previousCost = 0;
  for (const row of buckets) {
    if (row.bucket! < since) {
      previousCost += row.cost;
      continue;
    }
    const day = perDay[Math.round((row.bucket! - since) / DAY)];
    if (day) day.byModel[row.model] = (day.byModel[row.model] ?? 0) + row.cost;
    const key = `${row.thread}\u0000${row.model}`;
    const { bucket: _bucket, ...rest } = row;
    const sum = totals.get(key);
    if (!sum) totals.set(key, { ...rest });
    else for (const name of SUMS) sum[name] += row[name];
  }
  return { totals: [...totals.values()], perDay, previousCost };
}

/** The same fold from one call per range, sent in one round, for a pi-host without `bucketMs`. */
async function byRange(host: Host, since: number, until: number, days: number, scope: { threads?: string[] }): Promise<UsageFold> {
  const [totals, perDay, previousRows] = await Promise.all([
    host.usage({ since, until, ...scope }),
    Promise.all(Array.from({ length: days }, async (_, i) => {
      const start = since + i * DAY;
      const byModel: Record<string, number> = {};
      for (const row of await host.usage({ since: start, until: start + DAY, ...scope })) byModel[row.model] = (byModel[row.model] ?? 0) + row.cost;
      return { start, byModel };
    })),
    host.usage({ since: since - days * DAY, until: since, ...scope }),
  ]);
  return { totals, perDay, previousCost: previousRows.reduce((sum, r) => sum + r.cost, 0) };
}

export async function usageReport(host: Host, threads: Threads, box: string, opts: { days: number; thread?: string; host?: string }, now = Date.now()): Promise<UsageReport> {
  const days = Math.min(Math.max(Math.round(opts.days) || 1, 1), 366);
  const until = localDayStart(now) + DAY;
  const since = until - days * DAY;
  const scope = opts.thread ? { threads: [opts.thread] } : {};
  if (opts.host && opts.host !== box) return { at: now, since, until, rows: [], days: [], previous: { cost: 0, complete: true } };
  // One call with a bucket per day: on 11-03 the 30-day default asked pi-host 32 times, and api/usage took 380 to 400 ms on us-metal02.
  const buckets = await host.usage({ since: since - days * DAY, until, bucketMs: DAY, ...scope });
  // A box whose pi-host predates `bucketMs` answers without buckets; that box's report takes the one round of calls per range.
  const { totals, perDay, previousCost } = buckets.every(row => row.bucket !== undefined) ? byBucket(buckets, since, days) : await byRange(host, since, until, days, scope);
  const rows: UsageRow[] = totals.map(t => ({
    thread: t.thread, threadName: threads.thread(t.thread)?.name ?? t.thread, host: box, model: t.model, turns: t.turns,
    tokens: { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite }, cost: costOf(t),
  }));
  const oldest = Math.min(...threads.threadsList().map(t => t.createdAt), now);
  return { at: now, since, until, rows, days: perDay, previous: { cost: previousCost, complete: oldest <= since - days * DAY } };
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

type MachineRead = { pingMs: number; machine: MachineView | null };

/** One box's machine reading from its relay's GET /v1/host. */
async function relayHost(h: RegistryHost): Promise<MachineRead> {
  const started = Date.now();
  const token = relayToken(h);
  const response = await fetch(`http://${h.address}:${h.relayPort ?? 7790}/v1/host`, { signal: AbortSignal.timeout(5000), ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
  const body = response.ok ? ((await response.json()) as { machine?: MachineView }) : null;
  return { pingMs: Date.now() - started, machine: body?.machine ?? null };
}

/** How old a box's machine reading may be before a read starts behind it: the Hosts page polls every 2 s (HostsPage.svelte POLL_MS). */
export const MACHINE_TICK_MS = 2_000;

/** A machine relay read as it ended: the reading, or why the relay did not answer, with the epoch ms the read started. */
export type MachineAnswer = { at: number } & ({ read: MachineRead } | { error: string });

/**
 * Each box's last machine reading, answered at once, with one read started behind it once it is a tick old; only a box never read waits.
 * On 11-03 GET /v1/host took 0.5 to 1.2 s on both boxes, since each read starts `pi-pool queue` and `config` there, and api/hosts waited for
 * every box's read on each 2 s poll of the Hosts page.
 */
export class MachineReads {
  private readonly last = new Map<string, MachineAnswer>();
  private readonly out = new Map<string, Promise<MachineAnswer>>();

  constructor(private readonly read: (h: RegistryHost) => Promise<MachineRead> = relayHost, private readonly now: () => number = Date.now) {}

  get(h: RegistryHost): Promise<MachineAnswer> {
    const key = `${h.name} ${h.address}:${h.relayPort ?? 7790}`;
    const last = this.last.get(key);
    if (last && this.now() - last.at < MACHINE_TICK_MS) return Promise.resolve(last);
    const reading = this.out.get(key) ?? this.start(key, h);
    return last ? Promise.resolve(last) : reading;
  }

  private start(key: string, h: RegistryHost): Promise<MachineAnswer> {
    const at = this.now();
    const reading = this.read(h).then((read): MachineAnswer => ({ at, read }), (error: unknown): MachineAnswer => ({ at, error: error instanceof Error ? error.message : String(error) }))
      .then(answer => {
        this.last.set(key, answer);
        this.out.delete(key);
        return answer;
      });
    this.out.set(key, reading);
    return reading;
  }
}

const machineReads = new WeakMap<Host, MachineReads>();

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
  let reads = machineReads.get(host);
  if (!reads) machineReads.set(host, reads = new MachineReads());
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
      const answer = await reads.get(entry);
      if ("read" in answer) {
        machine = answer.read.machine;
        if (!self) machineRelay = { state: "up", pingMs: answer.read.pingMs };
      } else if (!self) machineRelay = { state: "unreachable", error: answer.error };
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
