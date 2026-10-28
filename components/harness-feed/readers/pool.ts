import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import type { Context, Sample } from "../otlp.ts";
import { poolCaps, poolSummary } from "../../../legacy/prime/user-history/src/client/pool-meter.ts";
import { turnHistory } from "../../../legacy/prime/user-history/src/turn-history.ts";
import { TURN_KINDS, type PoolAccount, type PoolConfig, type PoolProvider, type PoolWindow, type TurnHour } from "../../../legacy/prime/user-history/src/shared/types.ts";

/**
 * The account pool and the agent turn queue, from one `pi-pool snapshot --json` a round (queue --json, config, and ls --json per provider with
 * no session), the same read the chat's PoolStatusReader makes every 2 s, plus pi-pool.log by hour as the Agent queue chart reads it. Read only:
 * snapshot writes nothing (pool/snapshot.py), and the reader runs no other pi-pool command (c93).
 */

const PROVIDERS = ["anthropic", "openai-codex"] as const;
type Provider = typeof PROVIDERS[number];

/** pi-pool's folder: PI_POOL_DIR, else ~/.config/pi-pool (chat-pool.ts poolDir). */
const poolDir = (ctx: Context): string => process.env.PI_POOL_DIR || join(ctx.home, ".config", "pi-pool");
/** The installed CLI, never a checkout copy (chat-pool.ts poolExecutable). */
const poolBin = (ctx: Context): string => process.env.PI_POOL_BIN || join(ctx.home, ".local", "bin", "pi-pool");
/** What host-stats.ts poolReading gives the CLI, and chat-pool.ts HOOKD_TIMEOUT_MS gives hookd before it runs the CLI instead. */
const CLI_TIMEOUT_MS = 15_000;
const HOOKD_TIMEOUT_MS = 10_000;
/** pi-pool reads the calling session from these; the feed asks with no session, as `ls --json --provider <p>` alone does (chat-pool.ts poolEnv). */
const SESSION_VARIABLES = ["PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID", "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL"];
const poolEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !SESSION_VARIABLES.includes(name)));

export interface PoolPart { code: number; out: string; err: string }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isPart = (value: unknown): value is PoolPart => isRecord(value) && Number.isInteger(value.code) && typeof value.out === "string" && typeof value.err === "string";

/** One command through `pi-pool hookd` on `socket`, the protocol of chat-pool.ts askHookd: null for an F answer, no socket or no answer in time. */
export function askHookd(socket: string, script: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = HOOKD_TIMEOUT_MS): Promise<{ part: PoolPart | null; answered: boolean }> {
  const entries = Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([name, value]) => `${name}=${value}`);
  const fields = ["pipe", String(process.pid), process.cwd(), script, String(args.length), ...args, String(entries.length), ...entries];
  const request = Buffer.concat([Buffer.from("PPH1\0"), ...fields.map(field => Buffer.from(field + "\0"))]);
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let done = false;
    let answered = false;
    const finish = (part: PoolPart | null) => { if (done) return; done = true; clearTimeout(timer); connection.destroy(); resolve({ part, answered }); };
    const connection = createConnection(socket);
    const timer = setTimeout(() => finish(null), timeoutMs);
    connection.on("connect", () => connection.write(request));
    connection.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const answer = Buffer.concat(chunks);
      const newline = answer.indexOf(10);
      if (newline < 0) return;
      answered = true;
      const line = answer.subarray(0, newline).toString("utf8");
      if (!line.startsWith("J ")) { finish(null); return; }
      try { const value: unknown = JSON.parse(line.slice(2)); finish(isPart(value) ? value : null); } catch { finish(null); }
    });
    connection.on("error", () => finish(null));
    connection.on("close", () => finish(null));
  });
}

function runCli(bin: string, args: readonly string[]): Promise<PoolPart> {
  return new Promise(resolve => {
    execFile(bin, [...args], { timeout: CLI_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: poolEnv() }, (error, stdout, stderr) => {
      const code = !error ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, out: String(stdout), err: String(stderr) || (error && typeof error.code !== "number" ? error.message : "") });
    });
  });
}

/** What pi-pool prints for a command it does not know (vend.py USAGE), as chat-pool.ts readSnapshot checks it. */
const UNKNOWN_COMMAND = /^usage: pi-pool \[command\]/;

export interface Snapshot { queue: PoolPart; config: PoolPart; who: PoolPart | null; ls: Partial<Record<Provider, PoolPart>> }
export interface Read { snapshot: Snapshot; hookd: boolean | null; seconds: number }

/**
 * One snapshot: through hookd when its socket is there (it forks a warm pool, so no Python starts), else the CLI. `accounts` false asks for the
 * queue and config alone, for a box whose accounts live on another box (remote.json): there `ls` goes over the network to that box.
 * `hookd` is true when hookd answered, false when its socket is there and it did not, null with no socket.
 */
export async function readPool(dir: string, bin: string, accounts: boolean, run: (args: readonly string[]) => Promise<PoolPart> = args => runCli(bin, args)): Promise<Read> {
  const started = performance.now();
  const args = ["snapshot", "--json", ...accounts ? ["--thread", "", ""] : []];
  const socket = join(dir, "hook.sock");
  let hookd: boolean | null = null;
  let part: PoolPart | null = null;
  if (existsSync(socket)) {
    let script = bin;
    try { script = realpathSync(bin); } catch {}
    const said = await askHookd(socket, script, args, poolEnv());
    hookd = said.answered;
    part = said.part;
  }
  part ??= await run(args);
  let snapshot: Snapshot;
  if (part.code === 0) {
    const value: unknown = JSON.parse(part.out);
    if (!isRecord(value) || !isPart(value.queue) || !isPart(value.config) || !Array.isArray(value.threads)) throw new Error("pi-pool returned an invalid snapshot");
    const thread = value.threads[0];
    const ls = isRecord(thread) && isRecord(thread.ls) ? thread.ls : {};
    snapshot = { queue: value.queue, config: value.config, who: isRecord(thread) && isPart(thread.who) ? thread.who : null, ls: Object.fromEntries(PROVIDERS.flatMap(provider => isPart(ls[provider]) ? [[provider, ls[provider]]] : [])) };
  } else if (UNKNOWN_COMMAND.test(part.err.trimStart())) {
    const [queue, config, who, ...ls] = await Promise.all([run(["queue", "--json"]), run(["config"]), accounts ? run(["who", "--json"]) : null,
      ...accounts ? PROVIDERS.map(provider => run(["ls", "--json", "--provider", provider])) : []]);
    snapshot = { queue: queue!, config: config!, who: who ?? null, ls: Object.fromEntries(ls.map((entry, n) => [PROVIDERS[n]!, entry!])) };
  } else throw new Error("pi-pool snapshot failed: " + (part.err.trim() || `exit code ${part.code}`).slice(0, 300));
  return { snapshot, hookd, seconds: (performance.now() - started) / 1000 };
}

/** 1 when a TCP connection to host:port opens, 0 when it fails or takes longer than hookd's own wait. */
export function tcpUp(host: string, port: number, timeoutMs = HOOKD_TIMEOUT_MS): Promise<number> {
  return new Promise(resolve => {
    let socket: Socket | null = null;
    const finish = (up: number) => { clearTimeout(timer); socket?.destroy(); resolve(up); };
    const timer = setTimeout(() => finish(0), timeoutMs);
    socket = createConnection({ host, port }, () => finish(1));
    socket.on("error", () => finish(0));
  });
}

const json = (part: PoolPart | undefined): unknown => { if (!part || part.code !== 0) return null; try { return JSON.parse(part.out); } catch { return null; } };
const percent = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const epochMs = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : null;
const text = (value: unknown): string | null => typeof value === "string" && value ? value : null;
const WINDOW_KINDS = new Set<unknown>(["session", "weekly", "model"]);

/** chat-pool.ts parsePoolRows and parseWindows, less the resets parse: an account row of `ls --json` as the app holds it. */
export function poolRows(value: unknown, provider: Provider): PoolAccount[] {
  if (!isRecord(value) || value.provider !== provider || !Array.isArray(value.rows)) throw new Error(`pi-pool ls gave no ${provider} listing`);
  return value.rows.flatMap((row: unknown): PoolAccount[] => {
    if (!isRecord(row) || typeof row.id !== "string" || typeof row.email !== "string" || typeof row.usable !== "boolean") return [];
    const windows = Array.isArray(row.windows) ? row.windows.flatMap((entry: unknown): PoolWindow[] =>
      isRecord(entry) && WINDOW_KINDS.has(entry.kind) && typeof entry.label === "string"
        ? [{ kind: entry.kind as PoolWindow["kind"], label: entry.label, pct: percent(entry.pct) ?? 0, resetsAt: epochMs(entry.resets_at) }] : []) : [];
    return [{ id: row.id, email: row.email, label: text(row.label) ?? row.email, usage: String(row.usage ?? ""), reason: typeof row.reason === "string" ? row.reason : null,
      usable: row.usable, current: row.current === true, pinned: row.pinned === true, session_pct: percent(row.session_pct), weekly_pct: percent(row.weekly_pct),
      score: percent(row.score), tier: text(row.tier), windows, usageAt: epochMs(row.usage_at), cooldownUntil: epochMs(row.cooldown_until),
      cooldownReason: text(row.cooldown_reason), limitedUntil: epochMs(row.limited_until), disabled: row.disabled === true,
      sessions: typeof row.sessions === "number" && Number.isInteger(row.sessions) && row.sessions > 0 ? row.sessions : 0 }];
  });
}

/** The trees `ls` says the pool holds parked on each account (status_view.build_rows `waiting`, book.parked), by account id. */
const heldTrees = (value: unknown): Map<string, number> => new Map(isRecord(value) && Array.isArray(value.rows)
  ? value.rows.flatMap(row => isRecord(row) && typeof row.id === "string" && typeof row.waiting === "number" ? [[row.id, row.waiting] as const] : []) : []);

/** Banked resets left per Claude account, the sum resetNote in AccountsSettings.svelte shows; absent when they were never read. */
const resetsLeft = (value: unknown): Map<string, number> => new Map(isRecord(value) && Array.isArray(value.rows) ? value.rows.flatMap(row => {
  if (!isRecord(row) || typeof row.id !== "string" || !isRecord(row.resets) || !isRecord(row.resets.status) || !Array.isArray(row.resets.status.grants)) return [];
  return [[row.id, row.resets.status.grants.reduce((sum: number, grant: unknown) => sum + (isRecord(grant) && typeof grant.resets_left === "number" ? grant.resets_left : 0), 0)] as const];
}) : []);

/** The badge an Accounts row shows, accounts.ts accountState (that file imports the browser api, so it is copied), with "ready" for none. */
export const ACCOUNT_STATES = ["off", "needs-login", "needs-terms", "refused", "cooldown", "limited", "depleted", "pinned", "ready"] as const;
export function accountState(row: PoolAccount): typeof ACCOUNT_STATES[number] {
  if (row.disabled) return "off";
  if (row.reason === "needs-reauth") return "needs-login";
  if (row.reason?.startsWith("cooldown")) return row.cooldownReason === "needs terms" ? "needs-terms" : row.cooldownReason ? "refused" : "cooldown";
  if (row.reason?.startsWith("limited")) return "limited";
  if (row.reason === "depleted") return "depleted";
  if (row.pinned) return "pinned";
  return "ready";
}

/** The numeric entries of `pi-pool config` (chat-pool.ts parsePoolConfig). */
const poolConfig = (value: unknown): PoolConfig | null => isRecord(value)
  ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))) : null;

/**
 * The account `who --json` with no session resolves for `provider`, the row the Accounts table marks "Next request" (AccountsSettings.svelte
 * `inUse` with no thread, from chat-pool.ts parsePoolResolution): its id, or null when no account takes a new thread now and the pool waits.
 */
export function nextRequestAccount(who: unknown, provider: Provider): string | null | undefined {
  if (!isRecord(who) || !isRecord(who.providers)) return undefined;
  const said = who.providers[provider];
  if (!isRecord(said) || typeof said.error === "string") return undefined;
  return text(said.account);
}

export function accountSamples(provider: Provider, listing: unknown, config: PoolConfig | null, now: number, who: unknown = null): Sample[] {
  const rows = poolRows(listing, provider);
  const held = heldTrees(listing), resets = resetsLeft(listing);
  const out: Sample[] = [];
  for (const [index, row] of rows.entries()) {
    const labels = { account: row.label, provider };
    out.push({ name: "harness.pool.account_public", kind: "gauge",
      help: "1 per account, labelled with its number in pi-pool's add order (accounts/<provider>.json, which signin.py appends to) and its plan, so a public page can name the account without its email.",
      value: 1, labels: { ...labels, number: String(index + 1), plan: row.tier ?? "" } });
    for (const window of row.windows) {
      out.push({ name: "harness.pool.account_window_used", kind: "gauge", unit: "1", help: "Share of an account's usage window spent, as the Accounts table shows it (5h, week, 30d or a model cap).",
        value: window.pct / 100, labels: { ...labels, window: window.label } });
      if (window.resetsAt !== null && window.resetsAt > now) out.push({ name: "harness.pool.account_window_resets", kind: "gauge", unit: "s",
        help: "Time until the account's usage window resets, the Accounts table's \"resets in\"; absent when pi-pool has no reset time for it.",
        value: (window.resetsAt - now) / 1000, labels: { ...labels, window: window.label } });
    }
    const blockedUntil = Math.max(row.limitedUntil ?? 0, row.cooldownUntil ?? 0);
    out.push(
      { name: "harness.pool.account_usable", kind: "gauge", help: "1 when the account takes a new normal-priority thread now.", value: row.usable ? 1 : 0, labels },
      { name: "harness.pool.account_state", kind: "gauge", help: "1 for the badge the Accounts table shows on the account: off, needs-login, needs-terms, refused, cooldown, limited, depleted, pinned or ready.",
        value: 1, labels: { ...labels, state: accountState(row) } },
      { name: "harness.pool.account_blocked", kind: "gauge", unit: "s", help: "Time until the account's 429 limit or cooldown ends; 0 when neither is on.",
        value: Math.max(0, blockedUntil - now) / 1000, labels },
      { name: "harness.pool.account_threads", kind: "gauge", help: "Threads (each with its jobs) that sent a request through the account within active_session_sec.", value: row.sessions, labels },
      { name: "harness.pool.account_held_trees", kind: "gauge", help: "Thread trees the pool holds waiting for this account.", value: held.get(row.id) ?? 0, labels },
    );
    if (row.usageAt !== null) out.push({ name: "harness.pool.account_usage_age", kind: "gauge", unit: "s", help: "Age of the account's last usage reading.", value: Math.max(0, now - row.usageAt) / 1000, labels });
    const left = resets.get(row.id);
    if (left !== undefined) out.push({ name: "harness.pool.account_resets_left", kind: "gauge", help: "Banked usage-limit resets left on the Claude account, at its last read.", value: left, labels });
  }
  const next = nextRequestAccount(who, provider);
  if (next !== undefined) out.push({ name: "harness.pool.next_request_account", kind: "gauge",
    help: "1 on the account a new chat's first request goes to, the Accounts table's \"Next request\" badge; account \"none\" when no account takes it now and it waits.",
    value: 1, labels: { account: next === null ? "none" : rows.find(row => row.id === next)?.label ?? next, provider } });
  const summary = poolSummary({ provider, rows, resolution: null }, poolCaps(config, null), now);
  for (const meter of summary.meters) {
    out.push({ name: "harness.pool.provider_used", kind: "gauge", unit: "1", help: "The sidebar pool meter: mean share spent over accounts not turned off, blocked accounts counted full.",
      value: meter.pct / 100, labels: { provider, window: meter.key } });
  }
  out.push(
    { name: "harness.pool.provider_usable_accounts", kind: "gauge", help: "Accounts that take a new thread now, the sidebar's first figure.", value: summary.usable, labels: { provider } },
    { name: "harness.pool.provider_accounts", kind: "gauge", help: "Accounts not turned off, the sidebar's second figure.", value: summary.total, labels: { provider } },
  );
  if (summary.nextFree !== null) out.push({ name: "harness.pool.provider_next_free", kind: "gauge", unit: "s", help: "Time until the first blocked account can serve again.",
    value: Math.max(0, summary.nextFree - now) / 1000, labels: { provider } });
  return out;
}

/** `pi-pool queue --json`: what works, by kind, and what waits, against the two limits (chat-pool.ts parseAgentQueue reads the same fields). */
export function queueSamples(value: unknown, now: number): Sample[] {
  if (!isRecord(value) || typeof value.enabled !== "boolean" || !Array.isArray(value.working) || !Array.isArray(value.queued)) throw new Error("pi-pool returned an invalid queue");
  const working = value.working.filter(isRecord), queued = value.queued.filter(isRecord);
  const out: Sample[] = [
    { name: "harness.pool.queue_on", kind: "gauge", help: "1 when the agent turn queue is on (agent_queue_on).", value: value.enabled ? 1 : 0 },
    { name: "harness.pool.slots_used", kind: "gauge", help: "Working turns, each of which holds a slot.", value: working.length },
  ];
  if (typeof value.working_max === "number") out.push({ name: "harness.pool.working_max", kind: "gauge", help: "The box's limit on working turns (working_max).", value: value.working_max });
  if (typeof value.tree_working_max === "number") out.push({ name: "harness.pool.tree_working_max", kind: "gauge", help: "The limit on working turns in one chat tree (tree_working_max).", value: value.tree_working_max });
  for (const kind of TURN_KINDS) {
    out.push({ name: "harness.pool.turns_working", kind: "gauge", help: "Admitted turns now, by how they got the slot.",
      value: working.filter(entry => entry.kind === kind).length, labels: { kind } });
  }
  out.push({ name: "harness.pool.turns_waiting", kind: "gauge", help: "Turns waiting in the queue now.", value: queued.length });
  const perTree = new Map<string, number>();
  for (const entry of working) if (typeof entry.tree === "string") perTree.set(entry.tree, (perTree.get(entry.tree) ?? 0) + 1);
  out.push({ name: "harness.pool.tree_working_most", kind: "gauge", help: "Working turns in the busiest chat tree, against tree_working_max.", value: Math.max(0, ...perTree.values()) },
    { name: "harness.pool.trees_working", kind: "gauge", help: "Chat trees with a working turn.", value: perTree.size });
  const waits = queued.map(entry => entry.wait_s).filter((wait): wait is number => typeof wait === "number" && Number.isFinite(wait));
  out.push({ name: "harness.pool.queue_wait_longest", kind: "gauge", unit: "s", help: "How long the longest-waiting queued turn has waited so far.", value: Math.max(0, ...waits) });
  const since = working.map(entry => entry.since).filter((at): at is number => typeof at === "number");
  out.push({ name: "harness.pool.turn_working_longest", kind: "gauge", unit: "s", help: "How long the oldest working turn has held its slot.", value: since.length ? Math.max(0, now / 1000 - Math.min(...since)) : 0 });
  return out;
}

/** The Agent queue chart's hour now in progress (turn-history.ts, the app's own reader of pi-pool.log); none when the log has no hour yet. */
export function hourSamples(hours: TurnHour[]): Sample[] {
  const hour = hours.at(-1);
  if (!hour) return [];
  const out: Sample[] = [{ name: "harness.pool.turns_finished_hour", kind: "gauge", help: "Turns finished so far in this local clock hour (turn_released lines in pi-pool.log).", value: hour.finished }];
  if (hour.medianWaitS !== null) out.push({ name: "harness.pool.queue_wait_median_hour", kind: "gauge", unit: "s",
    help: "Median wait of queued turns admitted so far this local hour; owner turns never wait and are left out.", value: hour.medianWaitS });
  return out;
}

/**
 * The end lines of usage reads in pi-pool.log: `usage_refresh`, which `pi-pool refresh` writes when a Settings > Accounts refresh ends
 * (commands.py cmd_refresh, the run UsageRefreshes in chat-pool.ts streams), and `usage_sample`, which the minute timer's `pi-pool sample`
 * writes (usage.py cmd_sample). `failed` lists the labels of the accounts whose read failed. The log's `ts` is local time in the writer's zone,
 * and on us-metal02 it mixes UTC and KST, so the 30 min window counts lines by when this reader first saw them, never by `ts`.
 */
export interface UsageRead { accounts: number; failed: string[] }
export interface UsageLog { offset: number; rest: string; decoder: StringDecoder; refresh: UsageRead | null; sample: UsageRead | null;
  /** Samples and refreshes this reader saw appended, with the epoch ms it saw them; the first scan of the file adds none. */
  seen: { at: number; kind: "refresh" | "sample"; read: UsageRead }[] }
const RECENT_MS = 30 * 60_000;

export const usageLog = (): UsageLog => ({ offset: 0, rest: "", decoder: new StringDecoder("utf8"), refresh: null, sample: null, seen: [] });

export function addUsageLine(log: UsageLog, line: string, seenAt: number | null): void {
  const kind = line.includes('"usage_refresh"') ? "refresh" : line.includes('"usage_sample"') ? "sample" : null;
  if (!kind) return;
  let row: unknown;
  try { row = JSON.parse(line); } catch { return; }
  if (!isRecord(row) || row.event !== `usage_${kind}` || typeof row.accounts !== "number") return;
  const read = { accounts: row.accounts, failed: Array.isArray(row.failed) ? row.failed.filter((label): label is string => typeof label === "string") : [] };
  log[kind] = read;
  if (seenAt !== null) log.seen.push({ at: seenAt, kind, read });
}

/** Reads the bytes added to `path` since the last call; a file that shrank is read again from the start. The first call's lines set only the last reads. */
export async function catchUpUsage(log: UsageLog, path: string, now: number): Promise<void> {
  const size = (await stat(path)).size;
  const first = log.offset === 0;
  if (size < log.offset) Object.assign(log, usageLog(), { seen: log.seen });
  if (size > log.offset) {
    const file = await open(path, "r");
    try {
      const chunk = Buffer.alloc(Math.min(size - log.offset, 8 << 20));
      while (log.offset < size) {
        const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, size - log.offset), log.offset);
        if (!bytesRead) break;
        log.offset += bytesRead;
        const lines = (log.rest + log.decoder.write(chunk.subarray(0, bytesRead))).split("\n");
        log.rest = lines.pop() ?? "";
        for (const line of lines) addUsageLine(log, line, first ? null : now);
      }
    } finally { await file.close(); }
  }
  log.seen = log.seen.filter(entry => now - entry.at <= RECENT_MS);
}

export function usageSamples(log: UsageLog): Sample[] {
  const out: Sample[] = [];
  for (const kind of ["refresh", "sample"] as const) {
    const read = log[kind];
    if (!read) continue;
    const labels = { run: kind };
    out.push({ name: "harness.pool.usage_read_accounts", kind: "gauge", help: "Accounts the last usage read asked for: a Settings > Accounts refresh (run refresh) or the minute timer (run sample).",
      value: read.accounts, labels },
      { name: "harness.pool.usage_read_failed", kind: "gauge", help: "Accounts whose usage read failed in the last refresh or timer sample.", value: read.failed.length, labels });
    const recent = log.seen.filter(entry => entry.kind === kind);
    out.push({ name: "harness.pool.usage_reads_recent", kind: "gauge", help: "Usage reads of this kind that ended in the last 30 min.", value: recent.length, labels },
      { name: "harness.pool.usage_read_failed_recent", kind: "gauge", help: "Failed account reads in usage reads of this kind that ended in the last 30 min.",
        value: recent.reduce((sum, entry) => sum + entry.read.failed.length, 0), labels });
  }
  for (const account of new Set(log.refresh?.failed ?? [])) {
    out.push({ name: "harness.pool.usage_refresh_failed_account", kind: "gauge", help: "1 for each account whose read failed in the last Settings > Accounts usage refresh.", value: 1, labels: { account } });
  }
  return out;
}

const HISTORY = "pool.history";
const USAGE = "pool.usage";

export async function read(ctx: Context): Promise<Sample[]> {
  const dir = poolDir(ctx);
  if (!existsSync(dir)) return [];
  const remote = (() => { try { return JSON.parse(readFileSync(join(dir, "remote.json"), "utf8")) as unknown; } catch { return null; } })();
  const serve = (() => { try { return JSON.parse(readFileSync(join(dir, "serve.json"), "utf8")) as unknown; } catch { return null; } })();
  let history = ctx.state.get(HISTORY) as ((now?: number) => Promise<TurnHour[]>) | undefined;
  if (!history) { history = turnHistory(join(dir, "pi-pool.log")); ctx.state.set(HISTORY, history); }
  const remoteUrl = isRecord(remote) && typeof remote.url === "string" ? (() => { try { return new URL(remote.url as string); } catch { return null; } })() : null;
  let usage = ctx.state.get(USAGE) as UsageLog | undefined;
  if (!usage) { usage = usageLog(); ctx.state.set(USAGE, usage); }
  const log = usage;
  // A box with remote.json reads usage on the box that holds the accounts, so its own log has only old lines.
  const [reading, hours, serveUp, remoteUp, usageRead] = await Promise.all([
    readPool(dir, poolBin(ctx), remote === null).then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error })),
    history(ctx.now),
    isRecord(serve) && typeof serve.host === "string" && typeof serve.port === "number" ? tcpUp(serve.host, serve.port) : null,
    remoteUrl ? tcpUp(remoteUrl.hostname, Number(remoteUrl.port || (remoteUrl.protocol === "https:" ? 443 : 80))) : null,
    remote === null ? catchUpUsage(log, join(dir, "pi-pool.log"), ctx.now).then(() => true, () => false) : false,
  ]);
  const out: Sample[] = [...hourSamples(hours), ...usageRead ? usageSamples(log) : []];
  const up = (service: string, value: number) => out.push({ name: "harness.pool.service_up", kind: "gauge", help: "1 when the pool's resident service answers: hookd on hook.sock, serve on its port, or the remote pool this box uses.",
    value, labels: { service } });
  if (serveUp !== null) up("serve", serveUp);
  if (remoteUp !== null) up("remote", remoteUp);
  if (reading.value?.hookd !== null && reading.value?.hookd !== undefined) up("hookd", reading.value.hookd ? 1 : 0);
  out.push({ name: "harness.pool.read_ok", kind: "gauge", help: "1 when this round's pi-pool snapshot read and parsed.", value: reading.value ? 1 : 0 });
  if (!reading.value) {
    if (existsSync(join(dir, "hook.sock"))) up("hookd", 0);
    return out;
  }
  const { snapshot, seconds } = reading.value;
  out.push({ name: "harness.pool.read_duration", kind: "gauge", unit: "s", help: "Wall time of this round's pi-pool snapshot.", value: seconds });
  const config = poolConfig(json(snapshot.config));
  out.push(...queueSamples(json(snapshot.queue), ctx.now));
  for (const provider of PROVIDERS) {
    const listing = json(snapshot.ls[provider]);
    if (listing !== null) out.push(...accountSamples(provider, listing, config, ctx.now, json(snapshot.who ?? undefined)));
  }
  return out;
}
