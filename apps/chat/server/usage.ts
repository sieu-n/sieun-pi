/**
 * Usage, the pool and hosts. Usage sums pi-host's `durable_usage` rows; the pool runs the installed pi-pool CLI; hosts reads the
 * hosts registry and each box's relay. The pool parsers are copied from today's chat (legacy/prime/user-history/src/chat-pool.ts).
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountResets, AccountsView, PoolAccount, PoolConfig, PoolProvider, PoolWindow } from "../web/src/lib/api/shared/types.ts";
import type { HostsReport, HostView, MachineView, UsageReport, UsageRow } from "../web/src/lib/api/types.ts";
import type { Host, UsageTotal } from "./host/types.ts";
import { OWNER_ZONE_OFFSET_MS } from "./search.ts";
import { statusOf, type Threads } from "./threads.ts";

export function poolExecutable(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return env.PI_POOL_BIN || join(home, ".local", "bin", "pi-pool");
}
export const pooledProviders = ["anthropic", "openai-codex"] as const;
type PooledProvider = typeof pooledProviders[number];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const percent = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const isPooled = (value: string): value is PooledProvider => (pooledProviders as readonly string[]).includes(value);
const epochMs = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : null;
const text = (value: unknown): string | null => typeof value === "string" && value ? value : null;
const WINDOW_KINDS = new Set<unknown>(["session", "weekly", "model"]);

function parseWindows(value: unknown): PoolWindow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown): PoolWindow[] => {
    if (!isRecord(entry) || !WINDOW_KINDS.has(entry.kind) || typeof entry.label !== "string") return [];
    return [{ kind: entry.kind as PoolWindow["kind"], label: entry.label, pct: percent(entry.pct) ?? 0, resetsAt: epochMs(entry.resets_at) }];
  });
}

const isoMs = (value: unknown): number | null => typeof value === "string" && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : null;

/** The `resets` entry of a Claude row from `pi-pool ls --json`, or null. Grants that do not parse are dropped, never guessed. */
export function parseResets(value: unknown): AccountResets | null {
  if (!isRecord(value)) return null;
  const status = isRecord(value.status) ? value.status : null;
  const grants = status && Array.isArray(status.grants) ? status.grants.flatMap(grant => {
    if (!isRecord(grant) || !text(grant.id) || typeof grant.resets_total !== "number" || typeof grant.resets_left !== "number") return [];
    return [{ id: grant.id as string, label: text(grant.label) ?? "", resetsTotal: grant.resets_total, resetsLeft: grant.resets_left,
      startsAt: isoMs(grant.starts_at), endsAt: isoMs(grant.ends_at), clears: Array.isArray(grant.clears) ? grant.clears.filter((w): w is string => typeof w === "string") : [],
      paused: grant.paused === true, usableNow: grant.usable_now === true, useRequiresLimit: grant.use_requires_limit !== false }];
  }) : [];
  const pending = isRecord(value.pending) && text(value.pending.grant_id) && typeof value.pending.created_at === "number"
    ? { grantId: value.pending.grant_id as string, createdAt: value.pending.created_at * 1000 } : null;
  return { checkedAt: status ? epochMs(value.checked_at) : null, eligible: status && typeof status.eligible === "boolean" ? status.eligible : null,
    ineligibleReason: status ? text(status.ineligible_reason) : null, atLimit: status?.at_limit === true, cooldownUntil: status ? isoMs(status.cooldown_until) : null,
    grants, nextGrantId: status ? text(status.next_grant_id) : null, error: text(value.error), errorAt: epochMs(value.error_at ?? (status ? null : value.checked_at)), pending };
}

export function parsePoolRows(value: unknown, provider: string): PoolAccount[] {
  if (!isRecord(value) || value.provider !== provider || !Array.isArray(value.rows)) throw new Error("pi-pool returned an invalid listing");
  return value.rows.map((row: unknown): PoolAccount => {
    if (!isRecord(row) || typeof row.id !== "string" || !row.id || typeof row.email !== "string" || typeof row.usage !== "string" ||
      !(row.reason === null || typeof row.reason === "string") || typeof row.usable !== "boolean" || typeof row.current !== "boolean" ||
      typeof row.pinned !== "boolean") {
      throw new Error("pi-pool returned an invalid account");
    }
    return { id: row.id, email: row.email, label: text(row.label) ?? row.email, usage: row.usage, reason: row.reason, usable: row.usable, current: row.current, pinned: row.pinned,
      session_pct: percent(row.session_pct), weekly_pct: percent(row.weekly_pct), score: percent(row.score),
      ...(typeof row.plan === "string" ? { plan: row.plan } : {}),
      tier: text(row.tier), windows: parseWindows(row.windows), usageAt: epochMs(row.usage_at), cooldownUntil: epochMs(row.cooldown_until),
      cooldownReason: text(row.cooldown_reason), limitedUntil: epochMs(row.limited_until), disabled: row.disabled === true,
      sessions: typeof row.sessions === "number" && Number.isInteger(row.sessions) && row.sessions > 0 ? row.sessions : 0, ...("resets" in row ? { resets: parseResets(row.resets) } : {}) };
  });
}


/** The numeric entries of `pi-pool config` (a JSON object); other entries (lists, switches) are dropped. Null for anything else. */
export function parsePoolConfig(value: unknown): PoolConfig | null {
  if (!isRecord(value)) return null;
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}

function run(executable: string, args: string[], timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${executable} ${args.join(" ")} failed: ${(String(stderr).trim() || error.message).slice(0, 300)}`));
      else resolve(String(stdout));
    });
  });
}

export async function readPool(executable = poolExecutable()): Promise<AccountsView> {
  const providers: PoolProvider[] = await Promise.all((["anthropic", "openai-codex"] as const).map(async provider => {
    try {
      return { provider, rows: parsePoolRows(JSON.parse(await run(executable, ["ls", "--json", "--provider", provider])), provider), resolution: null };
    } catch (error) {
      return { provider, rows: [], resolution: null, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  const poolConfig = await run(executable, ["config"]).then(out => parsePoolConfig(JSON.parse(out))).catch(() => null);
  return { sessionId: null, checkedAt: new Date().toISOString(), providers, poolConfig };
}

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

export type { PoolConfig, PoolWindow, AccountResets, PoolAccount };
