/**
 * Usage and hosts. Usage sums the model calls of every host and chat client from the usage store (server/usage-store.ts); hosts reads the
 * hosts registry and each box's relay. The pool's accounts are server/accounts.ts.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BUCKET_MS, bucketFor, isRange, RANGE_MS, USAGE_CHART_SERIES } from "../web/src/lib/api/shared/usage-range.ts";
import type { AgentRelayLink, HostsReport, HostThread, HostThreadFilter, HostView, MachineView, RunCounts, RunStatus, UsageBucket, UsageBucketSum, UsageLive, UsageRange, UsageReport, UsageRow, UsageSeries, UsageSplit } from "../web/src/lib/api/types.ts";
import { MultiHost } from "./host/multi-host.ts";
import type { RelayHost } from "./host/relay-host.ts";
import type { Host, Ping } from "./host/types.ts";
import { OWNER_ZONE_OFFSET_MS } from "./search.ts";
import { addSums, LIVE_SPAN_MS, LIVE_TICK_MS, type UsageSums, type UsageTotal } from "./usage-store.ts";
import type { Store } from "./store.ts";
import { statusOf, type Threads } from "./threads.ts";

/** One row's cost by kind, as the store keeps each call's own cost of each kind. */
export const costOf = (total: UsageTotal): UsageRow["cost"] => ({
  input: total.costInput, output: total.costOutput, cacheRead: total.costCacheRead, cacheWrite: total.costCacheWrite, total: total.cost,
});

const DAY = 86_400_000;
export const localDayStart = (at: number): number => Math.floor((at + OWNER_ZONE_OFFSET_MS) / DAY) * DAY - OWNER_ZONE_OFFSET_MS;

type UsageFold = { buckets: UsageBucketSum[]; series: UsageSeries[] };
/** Rounds a dollar sum to the page's grid of a billionth (web/src/pages/usage/format.ts), which also cuts float noise from the answer. */
const grid = (usd: number): number => Math.round(usd * 1e9) / 1e9;

/** The range's totals per host, client, agent, thread and model, and each bucket's sums. */
function fold(rows: readonly UsageTotal[], since: number, step: number, count: number, split: UsageSplit): UsageFold {
  const buckets: UsageBucketSum[] = Array.from({ length: count }, (_, i) => ({
    start: since + i * step, turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, unpriced: 0,
  }));
  const lines = new Map<string, UsageSeries>();
  for (const row of rows) {
    const at = Math.round((row.bucket - since) / step);
    const sum = buckets[at];
    if (!sum) continue;
    sum.turns += row.turns;
    sum.tokens.input += row.input;
    sum.tokens.output += row.output;
    sum.tokens.cacheRead += row.cacheRead;
    sum.tokens.cacheWrite += row.cacheWrite;
    sum.cost.input += row.costInput;
    sum.cost.output += row.costOutput;
    sum.cost.cacheRead += row.costCacheRead;
    sum.cost.cacheWrite += row.costCacheWrite;
    sum.cost.total += row.cost;
    sum.unpriced += row.unpriced;
    const name = split === "model" ? row.model : split === "host" ? (row.host || "unknown") : row.client;
    let line = lines.get(name);
    if (!line) lines.set(name, line = { key: name, cost: new Array<number>(count).fill(0), tokens: new Array<number>(count).fill(0), output: new Array<number>(count).fill(0) });
    line.cost[at]! += row.cost;
    line.tokens[at]! += row.input + row.output + row.cacheRead + row.cacheWrite;
    line.output[at]! += row.output;
  }
  for (const sum of buckets) for (const kind of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) sum.cost[kind] = grid(sum.cost[kind]);
  const total = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
  const sorted = [...lines.values()].sort((a, b) => total(b.cost) - total(a.cost) || total(b.tokens) - total(a.tokens));
  // The chart draws USAGE_CHART_SERIES colors, so the rest go as one Other: 32 models' columns were 45 KB of a 30-day report by hour.
  const series = sorted.length > USAGE_CHART_SERIES ? sorted.slice(0, USAGE_CHART_SERIES - 1) : sorted;
  const rest = sorted.slice(series.length);
  if (rest.length) {
    const sum = (pick: (line: UsageSeries) => number[]) => Array.from({ length: count }, (_, i) => rest.reduce((all, line) => all + pick(line)[i]!, 0));
    series.push({ key: "Other", others: rest.length, cost: sum(line => line.cost), tokens: sum(line => line.tokens), output: sum(line => line.output) });
  }
  for (const line of series) line.cost = line.cost.map(grid);
  return { buckets, series };
}

/** The chats a report names one by one, costliest first; the rest fold into one row per host, client and model (`otherChats`). */
export const REPORT_CHATS = 50;

/**
 * Keeps the `REPORT_CHATS` costliest chats as they are and folds every other chat's rows into one row per host, client and model, with no
 * thread or agent, so every total stays exact (c191). With every client's sessions in the store a 90-day report held 14,482 rows, 891 KB
 * over the Korea rig, and api/usage took 5.1 s there at p50. Prime names about 10,700 agents in 90 days, so a fold that kept the agent still
 * sent 11,026 rows (~/work/usage-one-source/usage-read-path/report.md).
 */
function foldChats(totals: readonly UsageTotal[], toRow: (total: UsageTotal) => UsageRow): { rows: UsageRow[]; otherChats: number } {
  // Rows are built only for what the answer sends: building every total's row first took most of a 30-day report's 150 to 200 ms on the rig.
  const chats = totals.map(t => t.chat);
  const costs = new Map<string, number>();
  totals.forEach((t, i) => costs.set(chats[i]!, (costs.get(chats[i]!) ?? 0) + t.cost));
  if (costs.size <= REPORT_CHATS) return { rows: totals.map(toRow), otherChats: 0 };
  // The costliest chats by one pass that keeps a sorted top list, as a stable sort would order them: a 90-day report has about 15,000 chats.
  const top: [string, number][] = [];
  for (const entry of costs) {
    if (top.length === REPORT_CHATS && entry[1] <= top[top.length - 1]![1]) continue;
    let at = top.length;
    while (at > 0 && top[at - 1]![1] < entry[1]) at--;
    top.splice(at, 0, entry);
    if (top.length > REPORT_CHATS) top.pop();
  }
  const kept = new Set(top.map(([chat]) => chat));
  const out: UsageRow[] = [];
  const rest = new Map<string, UsageTotal>();
  totals.forEach((t, i) => {
    if (kept.has(chats[i]!)) {
      out.push(toRow(t));
      return;
    }
    const key = `${t.host ?? ""}\u0000${t.client ?? ""}\u0000${t.model}`;
    const other = rest.get(key);
    if (!other) rest.set(key, { ...t, thread: "", threadName: "", agent: "" });
    else addSums(other, t);
  });
  return { rows: [...out, ...[...rest.values()].map(toRow)], otherChats: costs.size - REPORT_CHATS };
}

/** The first moment of the bucket that holds `at`: a clock minute or hour, or the owner's local midnight. */
export const bucketStart = (bucket: UsageBucket, at: number): number => (bucket === "day" ? localDayStart(at) : Math.floor(at / BUCKET_MS[bucket]) * BUCKET_MS[bucket]);

/**
 * The range as whole buckets that end with the one holding now, as Prime's chat Usage page draws it: 24 hours for 24h by hour, 1,440 minutes
 * for 24h by minute. A range or bucket the page does not offer reads as 24h and the range's default bucket. `host` keeps one host's rows.
 */
/** What GET /api/usage asks for, as its query gives it. */
export type UsageReportOptions = { range?: string; bucket?: string; thread?: string; host?: string; client?: string; split?: string };

export async function usageReport(sums: UsageSums, threads: Threads, opts: UsageReportOptions, now = Date.now()): Promise<UsageReport> {
  const split: UsageSplit = opts.split === "client" || opts.split === "host" ? opts.split : "model";
  const range: UsageRange = isRange(opts.range) ? opts.range : "24h";
  const bucket = bucketFor(range, opts.bucket);
  const step = BUCKET_MS[bucket];
  const count = RANGE_MS[range] / step;
  const until = bucketStart(bucket, now) + step;
  const since = until - count * step;
  const scope = opts.thread ? { threads: [opts.thread] } : {};
  const keep = (row: UsageTotal): boolean => (!opts.host || row.host === opts.host) && (!opts.client || row.client === opts.client);
  const answer = (await sums.usage({ since, until, bucketMs: step, ...scope })).filter(keep);
  const { buckets, series } = fold(answer, since, step, count, split);
  // The chat table's sums come from one bucket over the whole range, which the store sums from its day sums (usage-store.ts): summing the
  // hourly rows here took most of a 30-day report by hour, 140 to 200 ms at box load 150 on 11-24. The same chat on two hosts or from two
  // clients is two rows.
  const totals = new Map<string, UsageTotal>();
  for (const row of (await sums.usage({ since, until, bucketMs: until - since, ...scope })).filter(keep)) {
    const key = row.series;
    const total = totals.get(key);
    // The store answers each chat and model once, in rows of its own; a second row for one key is summed into a copy, never into the first.
    if (!total) totals.set(key, row);
    else {
      const sum = { ...total };
      addSums(sum, row);
      totals.set(key, sum);
    }
  }
  const toRow = (t: UsageTotal): UsageRow => ({
    thread: t.thread, threadName: threads.thread(t.thread)?.name ?? (t.threadName || t.thread), host: t.host, client: t.client, agent: t.agent, model: t.model, turns: t.turns, unpriced: t.unpriced,
    tokens: { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite }, cost: costOf(t),
  });
  const staleSince = sums.staleSince?.();
  return { at: now, since, until, range, bucket, ...foldChats([...totals.values()], toRow), buckets, split, series, ...(staleSince === undefined ? {} : { staleSince }) };
}

/**
 * Prime's per-second card: the tokens of the last 60 s over 60, for output and for all four kinds, and that
 * same rate every 10 s over the last 10 min, 61 points ending with the live one. The minute ends on the 10 s tick before now, as Prime's
 * 10 s OTLP export does, so the kept 10 s sums answer it with no call to the store.
 */
export async function usageLive(sums: UsageSums, opts: { thread?: string; host?: string; client?: string }, now = Date.now()): Promise<UsageLive> {
  const at = Math.floor(now / LIVE_TICK_MS) * LIVE_TICK_MS;
  const window = BUCKET_MS.minute / LIVE_TICK_MS;
  const points = LIVE_SPAN_MS / LIVE_TICK_MS + 1;
  const count = points - 1 + window;
  const since = at - count * LIVE_TICK_MS;
  const rows = (await sums.usage({ since, until: at, bucketMs: LIVE_TICK_MS, ...(opts.thread ? { threads: [opts.thread] } : {}) })).filter(row => (!opts.host || row.host === opts.host) && (!opts.client || row.client === opts.client));
  const ticks = { output: new Array<number>(count).fill(0), total: new Array<number>(count).fill(0) };
  for (const row of rows) {
    const index = Math.round((row.bucket - since) / LIVE_TICK_MS);
    if (index < 0 || index >= count) continue;
    ticks.output[index]! += row.output;
    ticks.total[index]! += row.input + row.output + row.cacheRead + row.cacheWrite;
  }
  const seconds = BUCKET_MS.minute / 1000;
  const rate = (values: number[]) => Array.from({ length: points }, (_, i) => values.slice(i, i + window).reduce((sum, value) => sum + value, 0) / seconds);
  const spark = { output: rate(ticks.output), total: rate(ticks.total) };
  const staleSince = sums.staleSince?.();
  return { at, perSecond: { output: spark.output[points - 1]!, total: spark.total[points - 1]! }, spark, ...(staleSince === undefined ? {} : { staleSince }) };
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

/** Where the last machine readings stay across restarts (store.ts `cache`), so the first api/hosts after a start has them. */
const MACHINE_CACHE = "machine-reads";
type MachineStore = Pick<Store, "cache" | "saveCache">;

/**
 * Each box's last machine reading, answered at once, with one read started behind it once it is a tick old. A box with no reading yet
 * answers null at once, and its first read runs behind. On 11-03 GET /v1/host took 0.5 to 1.2 s on both boxes, since each read starts
 * `pi-pool queue` and `config` there, and api/hosts waited for every box's read on each 2 s poll of the Hosts page. Until 11-23 a box never
 * read still held api/hosts for its first read: the Mac's machine relay times out at 5 s, so the first call after each apps/chat release
 * took 5,218 ms in the p155 sweeps full1 and full3. The readings are kept on disk, so a restart starts from the last ones.
 */
export class MachineReads {
  private readonly last: Map<string, MachineAnswer>;
  private readonly out = new Map<string, Promise<MachineAnswer>>();

  constructor(private readonly read: (h: RegistryHost) => Promise<MachineRead> = relayHost, private readonly now: () => number = Date.now, private readonly store?: MachineStore) {
    this.last = new Map(Object.entries(store?.cache<Record<string, MachineAnswer>>(MACHINE_CACHE, {}) ?? {}));
  }

  get(h: RegistryHost): MachineAnswer | null {
    const key = `${h.name} ${h.address}:${h.relayPort ?? 7790}`;
    const last = this.last.get(key) ?? null;
    if (!last || this.now() - last.at >= MACHINE_TICK_MS) this.out.get(key) ?? this.start(key, h);
    return last;
  }

  /** Resolves once every read on its way has landed. */
  settled(): Promise<unknown> {
    return Promise.all(this.out.values());
  }

  private start(key: string, h: RegistryHost): Promise<MachineAnswer> {
    const at = this.now();
    const reading = this.read(h).then((read): MachineAnswer => ({ at, read }), (error: unknown): MachineAnswer => ({ at, error: error instanceof Error ? error.message : String(error) }))
      .then(answer => {
        this.last.set(key, answer);
        this.out.delete(key);
        this.store?.saveCache(MACHINE_CACHE, Object.fromEntries(this.last));
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

/** The box whose threads the Hosts page lists, which of them, and whether walks' test threads count in (`GET /api/hosts?box=&threads=&tests=1`). */
export interface HostsQuery { box?: string; threads?: HostThreadFilter; tests?: boolean }

const RUN_STATUSES: readonly RunStatus[] = ["working", "idle", "sleeping", "failed"];
const noRuns = (): RunCounts => ({ working: 0, idle: 0, sleeping: 0, failed: 0 });

export function hostsQuery(params: URLSearchParams): HostsQuery {
  const threads = params.get("threads");
  return {
    ...(params.get("box") ? { box: params.get("box")! } : {}),
    ...(threads === "all" || RUN_STATUSES.includes(threads as RunStatus) ? { threads: threads as HostThreadFilter } : {}),
    ...(params.get("tests") === "1" ? { tests: true } : {}),
  };
}

/**
 * Every box in the hosts registry and every box the chat server routes agents to, this box first. The machine figures come from each box's
 * machine relay; the agent relay link and a remote pi-host come from the `RelayHost` in memory. Each box counts its threads, and only the
 * box `query` picks lists the threads its filter shows.
 */
export async function hostsReport(host: Host, threads: Threads, box: string, socket: string, hostsFile: string, query: HostsQuery = {}): Promise<HostsReport> {
  let reads = machineReads.get(host);
  if (!reads) machineReads.set(host, reads = new MachineReads(relayHost, Date.now, threads.store));
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
  const listed = query.box && names.includes(query.box) ? query.box : box;
  const filter = query.threads ?? "working";
  const views = names.map((name): HostView => {
    const self = name === box;
    const entry = registry.find(h => h.name === name);
    const relay = routing?.relay(name);
    const agentRelay = relay ? agentRelayLink(relay) : null;
    const boxPing = ping.boxes?.[name] ?? (self ? ping : undefined);
    const piHost: HostView["piHost"] = boxPing ? piHostView(boxPing, self ? socket : undefined) : { state: "absent" };
    let machine: MachineView | null = null;
    let machineRelay: HostView["relay"] = self ? { state: "up", pingMs: 0 } : { state: "unreachable", error: `${name} is not in ${hostsFile}` };
    if (entry) {
      const answer = reads.get(entry);
      if (!answer) machineRelay = { state: "reading" };
      else if ("read" in answer) {
        machine = answer.read.machine;
        if (!self) machineRelay = { state: "up", pingMs: answer.read.pingMs };
      } else if (!self) machineRelay = { state: "unreachable", error: answer.error };
    }
    const counts = { real: noRuns(), test: noRuns() };
    const shown: HostThread[] = [];
    if (piHost.state !== "absent") {
      for (const t of rows) {
        if ((t.box ?? box) !== name) continue;
        const status = statusOf(t.status);
        const test = threads.agentRecords?.store.isTest(t.id) ?? false;
        counts[test ? "test" : "real"][status] += 1;
        if (name !== listed || (test && !query.tests) || (filter !== "all" && filter !== status)) continue;
        shown.push({ id: t.id, name: t.name, status, model: `${t.provider}/${t.modelId}`, updatedAt: t.updatedAt, children: t.children, ...(test ? { test: true as const } : {}) });
      }
    }
    return {
      name, address: entry?.address ?? (self ? "127.0.0.1" : "unknown"), self, relay: machineRelay, piHost,
      agentRelay, machine, counts, threads: shown.sort((a, b) => b.updatedAt - a.updatedAt),
    };
  });
  return { checkedAt: Date.now(), registryError, hosts: views };
}
