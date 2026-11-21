/**
 * Usage and hosts. Usage sums pi-host's `durable_usage` rows; hosts reads the hosts registry and each box's relay. The pool's
 * accounts are server/accounts.ts.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BUCKET_MS, bucketFor, isRange, RANGE_MS } from "../web/src/lib/api/shared/usage-range.ts";
import type { AgentRelayLink, HostsReport, HostView, MachineView, UsageBucket, UsageBucketSum, UsageRange, UsageReport, UsageRow } from "../web/src/lib/api/types.ts";
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

type UsageFold = { totals: UsageTotal[]; buckets: UsageBucketSum[] };
const SUMS = ["turns", "input", "output", "cacheRead", "cacheWrite", "cost", "costInput", "costOutput", "costCacheRead", "costCacheWrite"] as const;

/** The range's totals per thread and model, and each bucket's sums, from one bucketed answer whose every row names its bucket. */
function fold(rows: readonly UsageTotal[], since: number, step: number, count: number): UsageFold {
  // The same thread and model on two boxes are two rows, each under its own box.
  const totals = new Map<string, UsageTotal>();
  const buckets: UsageBucketSum[] = Array.from({ length: count }, (_, i) => ({
    start: since + i * step, turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, byModel: {},
  }));
  for (const row of rows) {
    const sum = buckets[Math.round((row.bucket! - since) / step)];
    if (!sum) continue;
    sum.turns += row.turns;
    sum.tokens.input += row.input;
    sum.tokens.output += row.output;
    sum.tokens.cacheRead += row.cacheRead;
    sum.tokens.cacheWrite += row.cacheWrite;
    const cost = costOf(row);
    for (const kind of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) sum.cost[kind] += cost[kind];
    sum.byModel[row.model] = (sum.byModel[row.model] ?? 0) + row.cost;
    const key = `${row.host ?? ""}\u0000${row.thread}\u0000${row.model}`;
    const { bucket: _bucket, ...rest } = row;
    const total = totals.get(key);
    if (!total) totals.set(key, { ...rest });
    else for (const name of SUMS) total[name] += row[name];
  }
  return { totals: [...totals.values()], buckets };
}

/** For a pi-host without `bucketMs`: one call per bucket, sent in one round, each answer named with its bucket and folded the same way. */
async function byCalls(host: Host, since: number, step: number, count: number, scope: { threads?: string[] }, keep: (row: UsageTotal) => boolean): Promise<UsageTotal[]> {
  const answers = await Promise.all(Array.from({ length: count }, async (_, i) => {
    const start = since + i * step;
    return (await host.usage({ since: start, until: start + step, ...scope })).filter(keep).map(row => ({ ...row, bucket: start }));
  }));
  return answers.flat();
}

/** The first moment of the bucket that holds `at`: a clock minute or hour, or the owner's local midnight. */
export const bucketStart = (bucket: UsageBucket, at: number): number => (bucket === "day" ? localDayStart(at) : Math.floor(at / BUCKET_MS[bucket]) * BUCKET_MS[bucket]);

/**
 * The range as whole buckets that end with the one holding now, as Prime's chat Usage page draws it: 24 hours for 24h by hour, 1,440 minutes
 * for 24h by minute. A range or bucket the page does not offer reads as 24h and the range's default bucket.
 */
export async function usageReport(host: Host, threads: Threads, box: string, opts: { range?: string; bucket?: string; thread?: string; host?: string }, now = Date.now()): Promise<UsageReport> {
  const range: UsageRange = isRange(opts.range) ? opts.range : "24h";
  const bucket = bucketFor(range, opts.bucket);
  const step = BUCKET_MS[bucket];
  const count = RANGE_MS[range] / step;
  const until = bucketStart(bucket, now) + step;
  const since = until - count * step;
  const scope = opts.thread ? { threads: [opts.thread] } : {};
  // Each row names the box that answered it (MultiHost), and a single host's rows are this box's; the host filter keeps one box's rows.
  const hostOf = (row: UsageTotal): string => row.host ?? box;
  const keep = (row: UsageTotal): boolean => !opts.host || hostOf(row) === opts.host;
  // One call with a bucket each: on 11-03 the 30-day page asked pi-host 32 times, and api/usage took 380 to 400 ms on us-metal02.
  const answer = (await host.usage({ since, until, bucketMs: step, ...scope })).filter(keep);
  const rowsByBucket = answer.every(row => row.bucket !== undefined) ? answer : await byCalls(host, since, step, count, scope, keep);
  const { totals, buckets } = fold(rowsByBucket, since, step, count);
  const rows: UsageRow[] = totals.map(t => ({
    thread: t.thread, threadName: threads.thread(t.thread)?.name ?? t.thread, host: hostOf(t), model: t.model, turns: t.turns,
    tokens: { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite }, cost: costOf(t),
  }));
  return { at: now, since, until, range, bucket, rows, buckets };
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
        .map(t => ({
          id: t.id, name: t.name, status: statusOf(t.status), model: `${t.provider}/${t.modelId}`, updatedAt: t.updatedAt, children: t.children,
          ...(threads.agentRecords?.store.isTest(t.id) ? { test: true as const } : {}),
        })),
    };
  }));
  return { checkedAt: Date.now(), registryError, hosts: views };
}
