/**
 * Usage and hosts. Usage sums the usage store's model calls (server/usage-store.ts) when one is configured, else pi-host's `durable_usage`
 * rows; hosts reads the hosts registry and each box's relay. The pool's accounts are server/accounts.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { openIndexReadOnly, readUsageRows, type UsageRead, type UsageRow as IndexUsageRow } from "../../../packages/pi-host/src/durable/index-db.ts";
import { BUCKET_MS, bucketFor, isRange, RANGE_MS } from "../web/src/lib/api/shared/usage-range.ts";
import type { AgentRelayLink, HostsReport, HostThread, HostThreadFilter, HostView, MachineView, RunCounts, RunStatus, UsageBucket, UsageBucketSum, UsageLive, UsageRange, UsageReport, UsageRow } from "../web/src/lib/api/types.ts";
import { MultiHost } from "./host/multi-host.ts";
import type { RelayHost } from "./host/relay-host.ts";
import type { Host, Ping, UsageRange as HostUsageRange, UsageTotal } from "./host/types.ts";
import { OWNER_ZONE_OFFSET_MS } from "./search.ts";
import { addSums, HOURS_KEPT_MS, LIVE_SPAN_MS, LIVE_TICK_MS, MINUTES_KEPT_MS, TICKS_KEPT_MS, USAGE_PULL_MS } from "./usage-store.ts";
import type { Store } from "./store.ts";
import { statusOf, type Threads } from "./threads.ts";

/** One row's cost by kind, as pi-host sums it from each answer's own usage. */
export const costOf = (total: UsageTotal): UsageRow["cost"] => ({
  input: total.costInput, output: total.costOutput, cacheRead: total.costCacheRead, cacheWrite: total.costCacheWrite, total: total.cost,
});

const DAY = 86_400_000;
export const localDayStart = (at: number): number => Math.floor((at + OWNER_ZONE_OFFSET_MS) / DAY) * DAY - OWNER_ZONE_OFFSET_MS;

type UsageFold = { totals: UsageTotal[]; buckets: UsageBucketSum[] };
const ROW_SUMS = ["input", "output", "cacheRead", "cacheWrite", "cost", "costInput", "costOutput", "costCacheRead", "costCacheWrite"] as const;
const SUMS = ["turns", ...ROW_SUMS] as const;

/** The range's totals per thread and model, and each bucket's sums, from one bucketed answer whose every row names its bucket. */
function fold(rows: readonly UsageTotal[], since: number, step: number, count: number): UsageFold {
  // The same thread and model on two boxes, or from two clients, are two rows.
  const totals = new Map<string, UsageTotal>();
  const buckets: UsageBucketSum[] = Array.from({ length: count }, (_, i) => ({
    start: since + i * step, turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, unpriced: 0, byModel: {}, tokensByModel: {}, byClient: {}, tokensByClient: {},
  }));
  for (const row of rows) {
    const sum = buckets[Math.round((row.bucket! - since) / step)];
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
    sum.byModel[row.model] = (sum.byModel[row.model] ?? 0) + row.cost;
    const tokens = sum.tokensByModel[row.model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    tokens.input += row.input;
    tokens.output += row.output;
    tokens.cacheRead += row.cacheRead;
    tokens.cacheWrite += row.cacheWrite;
    const client = row.client ?? "pi-host";
    sum.unpriced += row.unpriced ?? 0;
    sum.byClient[client] = (sum.byClient[client] ?? 0) + row.cost;
    const clientTokens = sum.tokensByClient[client] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    clientTokens.input += row.input;
    clientTokens.output += row.output;
    clientTokens.cacheRead += row.cacheRead;
    clientTokens.cacheWrite += row.cacheWrite;
    const key = row.series ?? `${row.host ?? ""}\u0000${row.client ?? ""}\u0000${row.agent ?? ""}\u0000${row.thread}\u0000${row.model}`;
    const total = totals.get(key);
    if (!total) totals.set(key, { ...row });
    else addSums(total, row);
  }
  return { totals: [...totals.values()], buckets };
}

/** For a pi-host without `bucketMs`: one call per bucket, sent in one round, each answer named with its bucket and folded the same way. */
async function byCalls(host: Pick<Host, "usage">, since: number, step: number, count: number, scope: { threads?: string[] }, keep: (row: UsageTotal) => boolean): Promise<UsageTotal[]> {
  const answers = await Promise.all(Array.from({ length: count }, async (_, i) => {
    const start = since + i * step;
    return (await host.usage({ since: start, until: start + step, ...scope })).filter(keep).map(row => ({ ...row, bucket: start }));
  }));
  return answers.flat();
}

/** The chats a report names one by one, costliest first; the rest fold into one row per host, client, agent and model (`otherChats`). */
export const REPORT_CHATS = 50;

/**
 * Keeps the `REPORT_CHATS` costliest chats as they are and folds every other chat's rows into one row per host, client, agent and model, with
 * no thread, so every total stays exact (c191). With every client's sessions in the store a 90-day report held 14,482 rows, 891 KB over the
 * Korea rig, and api/usage took 5.1 s there at p50 (~/work/usage-one-source/usage-read-path/report.md).
 */
function foldChats(rows: UsageRow[]): { rows: UsageRow[]; otherChats: number } {
  const chatOf = (row: UsageRow) => `${row.host}\u0000${row.client}\u0000${row.agent}\u0000${row.thread}`;
  const costs = new Map<string, number>();
  for (const row of rows) costs.set(chatOf(row), (costs.get(chatOf(row)) ?? 0) + row.cost.total);
  if (costs.size <= REPORT_CHATS) return { rows, otherChats: 0 };
  const kept = new Set([...costs].sort((a, b) => b[1] - a[1]).slice(0, REPORT_CHATS).map(([chat]) => chat));
  const out: UsageRow[] = [];
  const rest = new Map<string, UsageRow>();
  for (const row of rows) {
    if (kept.has(chatOf(row))) {
      out.push(row);
      continue;
    }
    const key = `${row.host}\u0000${row.client}\u0000${row.agent}\u0000${row.model}`;
    const other = rest.get(key);
    if (!other) {
      rest.set(key, { ...row, thread: "", threadName: "", tokens: { ...row.tokens }, cost: { ...row.cost } });
      continue;
    }
    other.turns += row.turns;
    other.unpriced += row.unpriced;
    for (const kind of ["input", "output", "cacheRead", "cacheWrite"] as const) other.tokens[kind] += row.tokens[kind];
    for (const kind of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) other.cost[kind] += row.cost[kind];
  }
  return { rows: [...out, ...rest.values()], otherChats: costs.size - REPORT_CHATS };
}

/** The first moment of the bucket that holds `at`: a clock minute or hour, or the owner's local midnight. */
export const bucketStart = (bucket: UsageBucket, at: number): number => (bucket === "day" ? localDayStart(at) : Math.floor(at / BUCKET_MS[bucket]) * BUCKET_MS[bucket]);

/**
 * The range as whole buckets that end with the one holding now, as Prime's chat Usage page draws it: 24 hours for 24h by hour, 1,440 minutes
 * for 24h by minute. A range or bucket the page does not offer reads as 24h and the range's default bucket.
 */
export async function usageReport(host: Pick<Host, "usage">, threads: Threads, box: string, opts: { range?: string; bucket?: string; thread?: string; host?: string; client?: string }, now = Date.now()): Promise<UsageReport> {
  const range: UsageRange = isRange(opts.range) ? opts.range : "24h";
  const bucket = bucketFor(range, opts.bucket);
  const step = BUCKET_MS[bucket];
  const count = RANGE_MS[range] / step;
  const until = bucketStart(bucket, now) + step;
  const since = until - count * step;
  const scope = opts.thread ? { threads: [opts.thread] } : {};
  // Each row names the box that answered it (MultiHost), and a single host's rows are this box's; the host filter keeps one box's rows.
  const hostOf = (row: UsageTotal): string => row.host ?? box;
  const keep = (row: UsageTotal): boolean => (!opts.host || hostOf(row) === opts.host) && (!opts.client || (row.client ?? "pi-host") === opts.client);
  // One call with a bucket each: on 11-03 the 30-day page asked pi-host 32 times, and api/usage took 380 to 400 ms on us-metal02.
  const answer = (await host.usage({ since, until, bucketMs: step, ...scope })).filter(keep);
  const rowsByBucket = answer.every(row => row.bucket !== undefined) ? answer : await byCalls(host, since, step, count, scope, keep);
  const { totals, buckets } = fold(rowsByBucket, since, step, count);
  const rows: UsageRow[] = totals.map(t => ({
    thread: t.thread, threadName: threads.thread(t.thread)?.name ?? (t.threadName || t.thread), host: hostOf(t), client: t.client ?? "pi-host", agent: t.agent ?? "", model: t.model, turns: t.turns, unpriced: t.unpriced ?? 0,
    tokens: { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite }, cost: costOf(t),
  }));
  return { at: now, since, until, range, bucket, ...foldChats(rows), buckets };
}

/** One box's usage rows: this box's index.sqlite on a read-only connection, or another box's through its relay's `durable_usage_read`. */
export interface UsageSource {
  box: string;
  up(): boolean;
  read(cursor: string | undefined, since: number): UsageRead | Promise<UsageRead>;
}

/**
 * Rows a read of this box's index takes at once; the pull yields between pages. On 11-22 under load 140 on us-metal02 the first read of
 * 129k rows took 4.2 s, so a 20,000-row page held the chat's event loop about 650 ms and a 1,000-row page about 33 ms.
 */
const SQLITE_PAGE_ROWS = 1_000;

/** This box's pi-host index.sqlite, read as pi-host's `durable_usage_read` reads it. */
export class SqliteUsage implements UsageSource {
  private db?: DatabaseSync;
  constructor(readonly box: string, private readonly path: string) {}
  up(): boolean {
    return true;
  }
  read(cursor: string | undefined, since: number): UsageRead {
    if (!this.db && !existsSync(this.path)) return { rows: [], cursor: cursor ?? "0:0", more: false, restart: cursor === undefined };
    this.db ??= openIndexReadOnly(this.path);
    return readUsageRows(this.db, cursor, since, SQLITE_PAGE_ROWS);
  }
  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}

const HOUR_MS = BUCKET_MS.hour;

type Sum = UsageTotal & { start: number };
type BoxUsage = { cursor?: string; read: boolean; hours: Map<string, Sum>; minutes: Map<string, Sum>; ticks: Map<string, Sum> };
type Grain = { ms: number; kept: number; sums: (box: BoxUsage) => Map<string, Sum> };
/** The kept sums by grain, coarsest first: a range reads the coarsest one its bounds and buckets fall on whole steps of. */
const GRAINS: readonly Grain[] = [
  { ms: HOUR_MS, kept: HOURS_KEPT_MS, sums: box => box.hours },
  { ms: BUCKET_MS.minute, kept: MINUTES_KEPT_MS, sums: box => box.minutes },
  { ms: LIVE_TICK_MS, kept: TICKS_KEPT_MS, sums: box => box.ticks },
];

function addTo(sums: Map<string, Sum>, start: number, row: IndexUsageRow): void {
  const key = `${start}\u0000${row.thread}\u0000${row.model}`;
  let sum = sums.get(key);
  if (!sum) sums.set(key, sum = { start, thread: row.thread, model: row.model, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costInput: 0,
    costOutput: 0, costCacheRead: 0, costCacheWrite: 0 });
  sum.turns += 1;
  for (const name of ROW_SUMS) sum[name] += row[name];
}

/**
 * Every box's usage, summed by hour and by minute in memory, so api/usage answers with no call to any box. Each pull reads only the rows
 * after the last cursor. On 11-21 api/usage took 205 to 220 ms a call, since every call waited for the Mac's pi-host across the relay.
 * Until every box whose link is up has been read through once, a range reads the boxes as before (`fallback`).
 */
export class KeptUsage implements Pick<Host, "usage"> {
  private readonly boxes = new Map<string, BoxUsage>();
  private pulling?: Promise<void>;
  private timer?: NodeJS.Timeout;

  constructor(private readonly sources: () => UsageSource[], private readonly fallback: Pick<Host, "usage">, private readonly log: (line: string) => void = () => {},
    private readonly now: () => number = Date.now) {}

  start(ms = USAGE_PULL_MS): void {
    void this.pull();
    this.timer = setInterval(() => void this.pull(), ms);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Reads each box's new rows; a pull while one runs waits for that one. */
  pull(): Promise<void> {
    this.pulling ??= this.pullAll().finally(() => { this.pulling = undefined; });
    return this.pulling;
  }

  private async pullAll(): Promise<void> {
    const now = this.now();
    for (const source of this.sources()) {
      if (!source.up()) continue;
      let box = this.boxes.get(source.box);
      if (!box) this.boxes.set(source.box, box = { read: false, hours: new Map(), minutes: new Map(), ticks: new Map() });
      try {
        for (;;) {
          const page = await source.read(box.cursor, now - HOURS_KEPT_MS);
          if (page.restart) {
            box.hours.clear();
            box.minutes.clear();
            box.ticks.clear();
          }
          for (const row of page.rows) {
            addTo(box.hours, Math.floor(row.at / HOUR_MS) * HOUR_MS, row);
            if (row.at >= now - MINUTES_KEPT_MS) addTo(box.minutes, Math.floor(row.at / BUCKET_MS.minute) * BUCKET_MS.minute, row);
            if (row.at >= now - TICKS_KEPT_MS) addTo(box.ticks, Math.floor(row.at / LIVE_TICK_MS) * LIVE_TICK_MS, row);
          }
          box.cursor = page.cursor;
          if (!page.more) break;
          await new Promise(resolve => setImmediate(resolve));
        }
        box.read = true;
      } catch (error) {
        this.log(`usage: reading ${source.box} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const [key, sum] of box.hours) if (sum.start < now - HOURS_KEPT_MS) box.hours.delete(key);
      for (const [key, sum] of box.minutes) if (sum.start < now - MINUTES_KEPT_MS) box.minutes.delete(key);
      for (const [key, sum] of box.ticks) if (sum.start < now - TICKS_KEPT_MS) box.ticks.delete(key);
    }
  }

  /**
   * The range's sums per bucket, thread and model, each row naming its box, as `durable_usage` gives them, from the coarsest kept sums whose
   * steps the range's bounds and buckets fall on. A range off every grain reads the boxes, since a kept sum would land whole in one bucket.
   */
  async usage(range: HostUsageRange): Promise<UsageTotal[]> {
    const { since, until, bucketMs } = range;
    const grain = since === undefined || until === undefined || !bucketMs ? undefined : GRAINS.find(g => since % g.ms === 0 && until % g.ms === 0 && bucketMs % g.ms === 0);
    const ready = (): boolean => this.sources().every(source => !source.up() || this.boxes.get(source.box)?.read);
    // Until each box's first read lands, a call waits for that read rather than asking every box: on 11-22 after a restart at 07:04:30Z
    // four calls that asked the boxes took 31 to 40 s and ended together at 07:05:36, while calls from 07:05:08 on answered from the kept
    // sums in 16 to 67 ms (requests/2026-11-22.jsonl).
    if (!ready() && this.pulling) await this.pulling;
    if (!ready() || !grain || since === undefined || until === undefined || !bucketMs || since < this.now() - grain.kept) return this.fallback.usage(range);
    const only = range.threads?.length ? new Set(range.threads) : undefined;
    const out: UsageTotal[] = [];
    for (const [name, box] of this.boxes) {
      const rows = new Map<string, UsageTotal>();
      for (const sum of grain.sums(box).values()) {
        if (sum.start < since || sum.start >= until || (only && !only.has(sum.thread))) continue;
        const bucket = since + Math.floor((sum.start - since) / bucketMs) * bucketMs;
        const key = `${bucket}\u0000${sum.thread}\u0000${sum.model}`;
        const row = rows.get(key);
        if (!row) {
          rows.set(key, {
            bucket, host: name, thread: sum.thread, model: sum.model, turns: sum.turns, input: sum.input, output: sum.output, cacheRead: sum.cacheRead,
            cacheWrite: sum.cacheWrite, cost: sum.cost, costInput: sum.costInput, costOutput: sum.costOutput, costCacheRead: sum.costCacheRead, costCacheWrite: sum.costCacheWrite,
          });
        } else for (const field of SUMS) row[field] += sum[field];
      }
      out.push(...[...rows.values()].sort((a, b) => a.bucket! - b.bucket! || a.thread.localeCompare(b.thread) || a.model.localeCompare(b.model)));
    }
    return out;
  }
}

/**
 * Prime's per-second card (user-history lgtm.ts `summary`): the tokens of the last 60 s over 60, for output and for all four kinds, and that
 * same rate every 10 s over the last 10 min, 61 points ending with the live one. The minute ends on the 10 s tick before now, as LGTM's
 * 10 s export does, so the kept 10 s sums answer it with no call to any box.
 */
export async function usageLive(host: Pick<Host, "usage">, box: string, opts: { thread?: string; host?: string; client?: string }, now = Date.now()): Promise<UsageLive> {
  const at = Math.floor(now / LIVE_TICK_MS) * LIVE_TICK_MS;
  const window = BUCKET_MS.minute / LIVE_TICK_MS;
  const points = LIVE_SPAN_MS / LIVE_TICK_MS + 1;
  const count = points - 1 + window;
  const since = at - count * LIVE_TICK_MS;
  const scope = opts.thread ? { threads: [opts.thread] } : {};
  const keep = (row: UsageTotal): boolean => (!opts.host || (row.host ?? box) === opts.host) && (!opts.client || (row.client ?? "pi-host") === opts.client);
  const answer = (await host.usage({ since, until: at, bucketMs: LIVE_TICK_MS, ...scope })).filter(keep);
  const rows = answer.every(row => row.bucket !== undefined) ? answer : await byCalls(host, since, LIVE_TICK_MS, count, scope, keep);
  const ticks = { output: new Array<number>(count).fill(0), total: new Array<number>(count).fill(0) };
  for (const row of rows) {
    const index = Math.round((row.bucket! - since) / LIVE_TICK_MS);
    if (index < 0 || index >= count) continue;
    ticks.output[index]! += row.output;
    ticks.total[index]! += row.input + row.output + row.cacheRead + row.cacheWrite;
  }
  const seconds = BUCKET_MS.minute / 1000;
  const rate = (values: number[]) => Array.from({ length: points }, (_, i) => values.slice(i, i + window).reduce((sum, value) => sum + value, 0) / seconds);
  const spark = { output: rate(ticks.output), total: rate(ticks.total) };
  return { at, perSecond: { output: spark.output[points - 1]!, total: spark.total[points - 1]! }, spark };
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
