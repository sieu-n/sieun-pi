import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeState } from "./chat-recovery.ts";
import { POOL_PRIORITIES, TURN_KINDS, type AccountAction, type AgentQueueReading, type AgentQueueSession, type AgentQueueWorking, type AgentQueuedSession, type AccountLogin, type AccountResets, type AccountsView, type PoolAccount, type PoolConfig, type PoolPriority, type PoolProvider, type PoolSetRecord,
  type PoolResolution, type PoolSelection, type TurnKind, type PoolWait, type PoolWindow, type UsageRefresh, type UsageRefreshAccount } from "./shared/types.ts";

/**
 * The installed pi-pool CLI (`~/.local/bin/pi-pool`, a link into ~/.local/share/pi-pool/current), never the copy in this checkout: the chat
 * must not run uncommitted pool edits (10-08: a half-written vend.py broke every session). PI_POOL_BIN names another one (tests run fakes).
 */
export function poolExecutable(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return env.PI_POOL_BIN || join(home, ".local", "bin", "pi-pool");
}
const executable = poolExecutable();
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

/** A tree's pool class from `pi-pool who --json` or `ls --json`; null when absent or unknown. */
export const parsePoolPriority = (value: unknown): PoolPriority | null => (POOL_PRIORITIES as readonly unknown[]).includes(value) ? value as PoolPriority : null;

/** A tree's wait from `pi-pool who --json` or `ls --json` (`{account, slot_at}` in epoch seconds); null when it does not wait or the entry does not parse. */
export function parsePoolWait(value: unknown): PoolWait | null {
  if (!isRecord(value)) return null;
  const account = text(value.account);
  const slotAt = epochMs(value.slot_at);
  return account && slotAt ? { account, slotAt } : null;
}

export function parsePoolSelection(value: unknown): PoolSelection {
  if (isRecord(value) && value.mode === "auto") return { mode: "auto" };
  if (isRecord(value) && value.mode === "manual" && typeof value.account_id === "string" && value.account_id && !value.account_id.startsWith("-"))
    return { mode: "manual", account_id: value.account_id };
  throw new Error("pi-pool returned an invalid account selection");
}

export function parsePoolResolution(value: unknown, provider: string): PoolResolution | null {
  if (!isRecord(value) || !isRecord(value.providers)) throw new Error("pi-pool returned an invalid resolution");
  const selected = value.providers[provider];
  if (!isRecord(selected)) return null;
  return { account: text(selected.account), email: text(selected.email), reason: text(selected.reason), pinned: selected.pinned === true,
    selection: parsePoolSelection(selected.selection), error: text(selected.error) };
}

/** pi-pool reads the calling session from these variables. The service may have been started inside a session; a thread is always named with --session instead. */
const SESSION_VARIABLES = ["PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID", "PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL"];
const poolEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !SESSION_VARIABLES.includes(name)));

function reportedError(stdout: string): string | null {
  try { const value: unknown = JSON.parse(stdout); return isRecord(value) ? text(value.error) : null; } catch { return null; }
}

function run(args: string[], timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: poolEnv() }, (error, stdout, stderr) => {
      if (error) { reject(new Error("pi-pool failed: " + (String(stderr).trim() || reportedError(String(stdout)) || error.message).slice(0, 300))); return; }
      resolve(stdout);
    });
  });
}

/** For commands that answer in JSON on stdout whatever their exit code (`reset`, `resets`). */
function runJson(args: string[], timeout: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: poolEnv() }, (error, stdout, stderr) => {
      let value: unknown = null;
      try { value = JSON.parse(String(stdout)); } catch { /* reported below */ }
      if (isRecord(value)) { resolve(value); return; }
      reject(new Error("pi-pool failed: " + (String(stderr).trim() || error?.message || "no answer").slice(0, 300)));
    });
  });
}

/** One sentence from `pi-pool resets --json`: how many accounts were read and which were not. */
export function resetsNotice(value: Record<string, unknown>): string {
  const rows = Array.isArray(value.accounts) ? value.accounts.filter(isRecord) : [];
  if (typeof value.error === "string") return value.error;
  const failed = rows.filter(row => typeof row.error === "string");
  const head = rows.length === 1 ? (failed.length ? "" : `Resets read for ${text(rows[0]!.label) ?? text(rows[0]!.email) ?? "the account"}.`) : `Resets read for ${rows.length - failed.length} of ${rows.length} accounts.`;
  return [head, ...failed.map(row => `${text(row.label) ?? text(row.email) ?? "An account"}: ${text(row.error)}.`)].filter(Boolean).join(" ");
}

/** pi-pool's folder: PI_POOL_DIR, else ~/.config/pi-pool. `pi-pool hookd` listens on hook.sock there. */
export const poolDir = (env: Record<string, string | undefined> = process.env, home: string = homedir()): string => env.PI_POOL_DIR || join(home, ".config", "pi-pool");
/** What one pi-pool command printed and its exit code: a part of `pi-pool snapshot --json`, or a hookd answer. */
export interface PoolPart { code: number; out: string; err: string }
/** One thread's parts of a snapshot: `who --json` and `ls --json --provider <p>`, both with the thread's --session and --model. */
export interface ThreadParts { who: PoolPart; ls: Record<PooledProvider, PoolPart> }
/** A thread as the pool reads it; null session or model reads with neither flag, as `ls --json --provider anthropic` alone does. */
export interface PoolThread { session: string | null; model: string | null }
/** `pi-pool snapshot --json`: `queue --json` and `config` once, and each asked thread's parts. */
export interface PoolSnapshot { queue: PoolPart; config: PoolPart; threads: (PoolThread & ThreadParts)[] }
/** What readPoolStatus gives: the newest queue and config parts and the asked threads' parts, each with the epoch ms its read started. */
export interface PoolStatus { at: number; queue: PoolPart; config: PoolPart; threads: ReadonlyMap<string, ThreadParts & { at: number }> }

export const threadKey = (thread: PoolThread): string => (thread.session ?? "") + "|" + (thread.model ?? "");

const isPart = (value: unknown): value is PoolPart => isRecord(value) && Number.isInteger(value.code) && typeof value.out === "string" && typeof value.err === "string";

export function parsePoolSnapshot(value: unknown): PoolSnapshot {
  if (!isRecord(value) || !isPart(value.queue) || !isPart(value.config) || !Array.isArray(value.threads)) throw new Error("pi-pool returned an invalid snapshot");
  return { queue: value.queue, config: value.config, threads: value.threads.map((entry: unknown) => {
    if (!isRecord(entry) || !isPart(entry.who) || !isRecord(entry.ls) || !pooledProviders.every(provider => isPart((entry.ls as Record<string, unknown>)[provider])) ||
      !(entry.session === null || typeof entry.session === "string") || !(entry.model === null || typeof entry.model === "string")) throw new Error("pi-pool returned an invalid snapshot thread");
    return { session: entry.session, model: entry.model, who: entry.who, ls: entry.ls as Record<PooledProvider, PoolPart> };
  }) };
}

/** A part's stdout, or the error `run` gives for the same exit: the command's stderr, else the error its JSON names. */
export function partOut(part: PoolPart): string {
  if (part.code !== 0) throw new Error("pi-pool failed: " + (part.err.trim() || reportedError(part.out) || `exit code ${part.code}`).slice(0, 300));
  return part.out;
}

/** The argv of one `pi-pool snapshot --json` for `threads`; "" stands for no session or no model. */
export const snapshotArgs = (threads: readonly PoolThread[]): string[] =>
  ["snapshot", "--json", ...threads.flatMap(thread => ["--thread", thread.session ?? "", thread.model ?? ""])];

/** How long `pi-pool hookd` may take before the CLI runs instead. */
export const HOOKD_TIMEOUT_MS = 10_000;

/**
 * One command through `pi-pool hookd` on `socket`, the resident server that forks a warm pool per call instead of starting Python: the
 * request is "PPH1\0" and NUL-ended fields ("pipe", this pid, the cwd, the bin's real path, argc, argv, envc, KEY=VALUE), the answer one
 * line, "J <json>" with {code, out, err}, or "F" when the caller must run the CLI (pool/hookd.py). Null for F, a socket that does not
 * connect, an answer that does not parse, or none within `timeoutMs`, so the caller runs the CLI as before.
 */
export function askHookd(socket: string, script: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = HOOKD_TIMEOUT_MS): Promise<PoolPart | null> {
  const entries = Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([name, value]) => `${name}=${value}`);
  const fields = ["pipe", String(process.pid), process.cwd(), script, String(args.length), ...args, String(entries.length), ...entries];
  const request = Buffer.concat([Buffer.from("PPH1\0"), ...fields.map(field => Buffer.from(field + "\0"))]);
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (part: PoolPart | null) => { if (done) return; done = true; clearTimeout(timer); connection.destroy(); resolve(part); };
    const connection = createConnection(socket);
    const timer = setTimeout(() => finish(null), timeoutMs);
    // No half-close: hookd takes a client that goes away before the answer as a cancel and stops the run.
    connection.on("connect", () => connection.write(request));
    connection.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const answer = Buffer.concat(chunks);
      const newline = answer.indexOf(10);
      if (newline < 0) return;
      const line = answer.subarray(0, newline).toString("utf8");
      if (!line.startsWith("J ")) { finish(null); return; }
      try { const value: unknown = JSON.parse(line.slice(2)); finish(isPart(value) ? value : null); } catch { finish(null); }
    });
    connection.on("error", () => finish(null));
    connection.on("close", () => finish(null));
  });
}

/** One pi-pool command as {code, out, err}: through hookd when it answers, else the CLI process, which is all that runs until hookd is installed. */
async function poolPart(args: readonly string[], timeout = 15000): Promise<PoolPart> {
  const env = poolEnv();
  const script = await realpath(executable).catch(() => executable);
  const said = await askHookd(join(poolDir(), "hook.sock"), script, args, env);
  if (said) return said;
  return new Promise(resolve => {
    execFile(executable, [...args], { timeout, maxBuffer: 4 * 1024 * 1024, env }, (error, stdout, stderr) => {
      const code = !error ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, out: String(stdout), err: String(stderr) || (error && typeof error.code !== "number" ? error.message : "") });
    });
  });
}

/** What pi-pool prints for a command it does not know (vend.py USAGE): an installed pool from before `snapshot` (3f47ff8c). */
const UNKNOWN_COMMAND = /^usage: pi-pool \[command\]/;

/**
 * One `pi-pool snapshot --json` for `threads`. A pool installed before the command answers with its usage text, and then the tick runs
 * the separate reads the snapshot stands for (`queue --json`, `config`, and per thread `who --json` and `ls --json` for each provider),
 * so a chat released ahead of the pool keeps working.
 */
export async function readSnapshot(threads: readonly PoolThread[], part: (args: readonly string[]) => Promise<PoolPart> = poolPart): Promise<PoolSnapshot> {
  const said = await part(snapshotArgs(threads));
  if (said.code === 0 || !UNKNOWN_COMMAND.test(said.err.trimStart())) return parsePoolSnapshot(JSON.parse(partOut(said)));
  const flags = (thread: PoolThread) => [...thread.session ? ["--session", thread.session] : [], ...thread.model ? ["--model", thread.model] : []];
  const [queue, config, ...perThread] = await Promise.all([part(["queue", "--json"]), part(["config"]), ...threads.map(async thread => {
    const [who, ...ls] = await Promise.all([part(["who", "--json", ...flags(thread)]),
      ...pooledProviders.map(provider => part(["ls", "--json", "--provider", provider, ...flags(thread)]))]);
    return { ...thread, who: who!, ls: Object.fromEntries(pooledProviders.map((provider, n) => [provider, ls[n]!])) as Record<PooledProvider, PoolPart> };
  })]);
  return { queue: queue as PoolPart, config: config as PoolPart, threads: perThread as PoolSnapshot["threads"] };
}

/**
 * How often the pool is read at most: one `pi-pool snapshot` per 2 s, the fastest poll of a pane that shows pool numbers (Settings > Hosts,
 * which shows each box's queue). Before it each reader ran its own CLI: on 10-18 at 11:44Z the chat on us-metal02 ran `ls`, `who`, `queue`
 * and `config` about 3 times a second at 0.2 CPU s each, 4 processes for each accounts frame of a thread feed.
 */
export const POOL_TICK_MS = 2_000;
/** Thread readings kept for an instant answer: an answer is about 17 KB, so 100, 2.5 times the 40 rows the sidebar showed on 10-18, keep under 2 MB. */
const KEPT_THREADS = 100;

/**
 * How long a session's change mark (`forgetSession`) blocks a read that started before it: past the longest a snapshot runs, hookd's 10 s
 * and the CLI's 15 s timeouts, so no read still out can land that old a reading.
 */
const CHANGE_MARK_MS = 60_000;

/**
 * The pool's status for every reader in this service: one `pi-pool snapshot` at a time, at most one per `tickMs` unless an ask names a thread
 * with no reading, that every ask made while
 * it waits for its turn joins, with the threads those asks name. `current` answers from the last reading when it is at most `maxAgeMs` old
 * and names the asked threads; else it waits for the next read. With `alone`, a thread with no reading is read by itself at once instead of
 * behind the shared read. A read that fails leaves the last good reading in place and answers with it; only an ask that nothing was ever
 * read for fails. `forget` drops every reading after a pool change this service made; `forgetSession` drops one session's readings after
 * a change to that session's record only.
 */
export class PoolStatusReader {
  private base: { at: number; queue: PoolPart; config: PoolPart } | null = null;
  private readonly threads = new Map<string, { at: number; parts: ThreadParts }>();
  private readonly pending = new Map<string, PoolThread>();
  /** The read of one thread by itself (`alone`) in flight, by thread key. */
  private readonly alone = new Map<string, Promise<void>>();
  /** When this service last changed a session's record (`forgetSession`): a reading of the session from a read started before then is old. */
  private readonly changed = new Map<string, number>();
  private next: Promise<void> | null = null;
  private running: Promise<void> = Promise.resolve();
  private lastStart = -Infinity;
  /** Ends the tick's wait early, for an ask that names a thread with no reading. */
  private wake: (() => void) | null = null;
  private generation = 0;
  private error: unknown = null;

  constructor(private readonly read: (threads: readonly PoolThread[]) => Promise<PoolSnapshot> = readSnapshot, private readonly tickMs = POOL_TICK_MS,
    private readonly now: () => number = Date.now, private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {}

  current(threads: readonly PoolThread[] = [], { maxAgeMs = this.tickMs, alone = false }: { maxAgeMs?: number; alone?: boolean } = {}): Promise<PoolStatus> {
    const since = this.now() - maxAgeMs;
    const stale = threads.filter(thread => !((this.threads.get(threadKey(thread))?.at ?? -Infinity) >= since));
    if (this.base && this.base.at >= since && !stale.length) return Promise.resolve(this.status(threads));
    const generation = this.generation;
    const missing = alone ? stale.filter(thread => !this.threads.has(threadKey(thread))) : [];
    if (missing.length) {
      // On 10-26 at 07:26, 07:27 and 07:42Z api/accounts on us-metal02 took 1.7 to 2.1 s waiting behind the shared read after a restart or a job start.
      return Promise.all(missing.map(thread => this.readAlone(thread)))
        .then(() => generation === this.generation ? this.status(threads) : this.current(threads, { maxAgeMs, alone }));
    }
    for (const thread of stale) this.pending.set(threadKey(thread), thread);
    if (stale.some(thread => !this.threads.has(threadKey(thread)))) this.wake?.();
    return this.turn().then(() => generation === this.generation ? this.status(threads) : this.current(threads, { maxAgeMs }));
  }

  /**
   * The queue and config of the last reading however old, with a read started behind it when it is over `maxAgeMs` old, for a pane that polls
   * and must not wait; the next read's answer when nothing was read since the last pool change. At 17:58Z to 18:02Z on 10-27 the Agent queue
   * pane's api/agent-queue read waited 1.4 to 2.3 s a minute for the next `pi-pool snapshot` at 1.6 to 2.8 runnable a core on us-metal02.
   */
  latest(maxAgeMs = this.tickMs): Promise<PoolStatus> {
    if (!this.base) return this.current([], { maxAgeMs });
    if (this.base.at < this.now() - maxAgeMs) void this.current([], { maxAgeMs }).catch(() => {});
    return Promise.resolve(this.status([]));
  }

  /** The last reading of a thread however old, for an answer that must not wait; null when none was read since the last pool change. */
  cached(thread: PoolThread): (ThreadParts & { at: number; config: PoolPart | null }) | null {
    const entry = this.threads.get(threadKey(thread));
    return entry ? { ...entry.parts, at: entry.at, config: this.base?.config ?? null } : null;
  }

  forget(): void {
    this.generation++;
    this.base = null;
    this.threads.clear();
    this.lastStart = -Infinity;
  }

  /**
   * Drops the readings of `session` alone, after a change to its record only, such as the class a job start sets on its tree: every other
   * thread keeps its reading, and a read that started before the change lands nothing for `session`. On 10-26 at 07:26 and 07:42Z a job start's
   * class set dropped every reading on us-metal02, and api/accounts then waited 1.7 to 2.1 s for a new one.
   */
  forgetSession(session: string): void {
    this.changed.set(session, this.now());
    for (const key of [...this.threads.keys()]) if (key.startsWith(session + "|")) this.threads.delete(key);
  }

  private status(threads: readonly PoolThread[]): PoolStatus {
    const found = new Map(threads.map(thread => { const entry = this.threads.get(threadKey(thread)); return [threadKey(thread), entry && { ...entry.parts, at: entry.at }] as const; }));
    if (!this.base || [...found.values()].some(parts => !parts)) throw this.error instanceof Error ? this.error : new Error("pi-pool gave no reading");
    return { at: this.base.at, queue: this.base.queue, config: this.base.config, threads: found as Map<string, ThreadParts & { at: number }> };
  }

  /** Keeps a snapshot that a read started at `at` gave, unless a pool change came since, or a newer reading is already kept. */
  private land(generation: number, at: number, snapshot: PoolSnapshot): void {
    if (generation !== this.generation) return;
    this.error = null;
    if (!this.base || at >= this.base.at) this.base = { at, queue: snapshot.queue, config: snapshot.config };
    for (const { session, model, who, ls } of snapshot.threads) {
      const key = threadKey({ session, model });
      if (session !== null && at <= (this.changed.get(session) ?? -Infinity)) continue;
      if ((this.threads.get(key)?.at ?? -Infinity) > at) continue;
      this.threads.delete(key);
      this.threads.set(key, { at, parts: { who, ls } });
    }
    for (const [session, when] of this.changed) if (when < at - CHANGE_MARK_MS) this.changed.delete(session);
    while (this.threads.size > KEPT_THREADS) this.threads.delete(this.threads.keys().next().value!);
  }

  private readAlone(thread: PoolThread): Promise<void> {
    const key = threadKey(thread);
    let reading = this.alone.get(key);
    if (!reading) {
      const generation = this.generation, at = this.now();
      reading = this.read([thread]).then(snapshot => this.land(generation, at, snapshot), error => { if (generation === this.generation) this.error = error; })
        .finally(() => this.alone.delete(key));
      this.alone.set(key, reading);
    }
    return reading;
  }

  private turn(): Promise<void> {
    this.next ??= (async () => {
      await this.running;
      // A thread with no reading yet skips the tick: api/accounts for a thread the chat had not shown waited 1.9 to 2.8 s on us-metal02 on 10-18 at 16:39Z.
      const wait = [...this.pending.keys()].some(key => !this.threads.has(key)) ? 0 : this.lastStart + this.tickMs - this.now();
      if (wait > 0) await Promise.race([this.sleep(wait), new Promise<void>(resolve => { this.wake = resolve; })]);
      this.wake = null;
      this.next = null;
      const asked = [...this.pending.values()];
      this.pending.clear();
      const generation = this.generation, at = this.lastStart = this.now();
      this.running = this.read(asked).then(snapshot => this.land(generation, at, snapshot), error => { this.error = error; });
      await this.running;
    })();
    return this.next;
  }
}

const poolStatus = new PoolStatusReader();

/**
 * The one read of the pool's status in this service: `pi-pool queue --json`, `config`, and per thread `who --json` and `ls --json` for each
 * provider, from one shared `pi-pool snapshot` per tick (PoolStatusReader). Every reader calls it: the accounts frame and api/accounts
 * (listAccounts), the Agent queue pane and Settings > Hosts (readAgentQueue), the board's queue places, the check-ins and
 * the duties (chat-turn-queue.ts), and the Claude watch (claudeReader).
 */
export function readPoolStatus(threads: readonly PoolThread[] = [], options: { maxAgeMs?: number } = {}): Promise<PoolStatus> {
  return poolStatus.current(threads, options);
}

/** A pool change this service makes (an account action, a key, a login, a usage refresh) drops every reading, so the next ask waits for a new one. */
export function forgetAccountReadings(): void { poolStatus.forget(); }

/** The accounts view of one thread from its snapshot parts, as `who`, `config` and `ls` for each provider gave it at `parts.at`. */
export function accountsView(sessionId: string | null, parts: ThreadParts & { at: number }, config: PoolPart | null): AccountsView {
  const json = (part: PoolPart | null): unknown => { try { return part ? JSON.parse(partOut(part)) : null; } catch { return null; } };
  let resolution: unknown = null;
  try { resolution = JSON.parse(parts.who.out); } catch {}
  const whoError = parts.who.code !== 0 ? parts.who.err.trim() || reportedError(parts.who.out) || `pi-pool who exited ${parts.who.code}` : null;
  const poolConfig = parsePoolConfig(json(config));
  const providers = pooledProviders.map((provider): PoolProvider => {
    try {
      const listing: unknown = JSON.parse(partOut(parts.ls[provider]));
      const poolPin = isRecord(listing) && isRecord(listing.pin) ? text(listing.pin.id) : null;
      const said = isRecord(resolution) && isRecord(resolution.providers) && isRecord(resolution.providers[provider]) ? resolution.providers[provider] : null;
      const selection = parsePoolSelection(said?.selection ?? (isRecord(listing) ? listing.selection : undefined));
      const resolved = resolution && isRecord(resolution) && isRecord(resolution.providers) ? parsePoolResolution(resolution, provider) : null;
      const reading: PoolResolution = { account: null, email: null, reason: null, pinned: false, ...resolved, selection, error: resolved?.error ?? whoError };
      if (isRecord(listing) && typeof listing.error === "string") return { provider, rows: [], resolution: reading, error: listing.error };
      const wait = parsePoolWait(isRecord(listing) && "wait" in listing ? listing.wait : said?.wait);
      return { provider, rows: parsePoolRows(listing, provider), resolution: reading, wait, poolPin };
    } catch (error) { return { provider, rows: [], resolution: null, error: error instanceof Error ? error.message : String(error) }; }
  });
  const priority = sessionId && isRecord(resolution) ? parsePoolPriority(resolution.priority) : null;
  return { sessionId, checkedAt: new Date(parts.at).toISOString(), providers, poolConfig, priority };
}

/**
 * `model` names the model the chat runs, so a spent per-model cap (Fable) only marks an account depleted for that model. With a reading for
 * the thread and model it answers at once with it, and asks for the thread in the next shared read; the accounts frame of a thread feed thus
 * starts no pi-pool process of its own. Without one it reads the thread by itself at once, not behind the shared read; with `fresh` and a
 * reading it waits for the next shared read.
 */
export function listAccounts(sessionId: string | null, model: string | null = null, { fresh = false, status = poolStatus }: { fresh?: boolean; status?: PoolStatusReader } = {}): Promise<AccountsView> {
  const thread = { session: sessionId, model };
  const next = status.current([thread], { alone: true, ...fresh ? { maxAgeMs: 0 } : {} }).then(read => accountsView(sessionId, read.threads.get(threadKey(thread))!, read.config));
  const cached = fresh ? null : status.cached(thread);
  if (!cached) return next;
  next.catch(() => {});
  return Promise.resolve(accountsView(sessionId, cached, cached.config));
}

/**
 * Claude as the pool sees it: whether an account can serve now, and the earliest time one that cannot frees up (its 429 limit or cooldown
 * end, else the reset of a spent window); null when nothing says. Off accounts do not count.
 */
export function claudeStateOf(rows: readonly PoolAccount[], now: number): ClaudeState {
  const live = rows.filter(row => !row.disabled);
  const frees = live.flatMap(row => {
    const blocked = [row.limitedUntil, row.cooldownUntil].filter((at): at is number => at !== null && at > now);
    if (blocked.length) return [Math.max(...blocked)];
    const spent = row.windows.filter(window => window.pct >= 100 && window.resetsAt !== null && window.resetsAt > now).map(window => window.resetsAt!);
    return spent.length ? [Math.max(...spent)] : [];
  });
  return { serves: live.some(row => row.usable), freeAt: frees.length ? Math.min(...frees) : null };
}

/** A resolved manual account bypasses Auto eligibility; resolution errors and future admission slots still hold the thread. */
export function poolAdmitsNow(parts: Pick<ThreadParts, "who" | "ls">, provider: string, now: number): boolean {
  if (!isPooled(provider)) return false;
  try {
    const who: unknown = JSON.parse(partOut(parts.who));
    const said = isRecord(who) && isRecord(who.providers) ? who.providers[provider] : null;
    if (!isRecord(said) || text(said.error)) return false;
    const selection = parsePoolSelection(said.selection);
    const wait = isRecord(said.wait) ? said.wait : null;
    if (wait && typeof wait.slot_at === "number" && wait.slot_at * 1000 > now) return false;
    const account = text(said.account);
    if (!account) return false;
    const listing: unknown = JSON.parse(partOut(parts.ls[provider]));
    const rows = isRecord(listing) && Array.isArray(listing.rows) ? listing.rows : [];
    return rows.some(row => isRecord(row) && row.id === account &&
      (selection.mode === "manual" ? account === selection.account_id : row.usable === true));
  } catch { return false; }
}

/**
 * When the pool next gives the tree of `parts` (read with `--session <tree root>`) a `provider` account, in epoch ms: `now` when it would now
 * (`poolAdmitsNow`), the slot of a wait `who` holds the tree in, the end of the limit or cooldown of the account `who` names, or with no account
 * named the earliest time any account frees up (`claudeStateOf`). Null when the pool does not say or a part fails to read.
 */
export function poolFreeAt(parts: Pick<ThreadParts, "who" | "ls">, provider: string, now: number): number | null {
  if (!isPooled(provider)) return null;
  try {
    if (poolAdmitsNow(parts, provider, now)) return now;
    const who: unknown = JSON.parse(partOut(parts.who));
    const said = isRecord(who) && isRecord(who.providers) ? who.providers[provider] : null;
    if (!isRecord(said)) return null;
    const slotAt = epochMs(isRecord(said.wait) ? said.wait.slot_at : null);
    if (slotAt !== null && slotAt > now) return slotAt;
    const rows = parsePoolRows(JSON.parse(partOut(parts.ls[provider])), provider);
    const account = text(said.account);
    if (!account) return parsePoolSelection(said.selection).mode === "manual" ? null : claudeStateOf(rows, now).freeAt;
    const row = rows.find(entry => entry.id === account);
    const ends = [row?.limitedUntil, row?.cooldownUntil].filter((at): at is number => typeof at === "number" && at > now);
    return ends.length ? Math.max(...ends) : null;
  } catch { return null; }
}

/** The slot of the account wait `who` holds a tree in for `provider` (`{account, slot_at}`), in epoch ms; null when it holds none or `who` fails. */
export function accountSlot(parts: Pick<ThreadParts, "who">, provider: string): number | null {
  if (!isPooled(provider)) return null;
  try {
    const who: unknown = JSON.parse(partOut(parts.who));
    const said = isRecord(who) && isRecord(who.providers) ? who.providers[provider] : null;
    return isRecord(said) ? parsePoolWait(said.wait)?.slotAt ?? null : null;
  } catch { return null; }
}

/**
 * The sessions of `asks` whose tree pi-pool holds in an account wait past `now`, with the wait's slot (epoch ms). It answers at once from the
 * shared reader's last reading of each tree, and asks for the trees in the reader's next tick, so a later call has them; it starts no read
 * of its own beside that tick.
 */
export function treeAccountWaits(asks: readonly { session: string; tree: string; provider: string }[], now: number, status: PoolStatusReader = poolStatus): Map<string, number> {
  const trees = [...new Set(asks.map(ask => ask.tree))].map((session): PoolThread => ({ session, model: null }));
  if (trees.length) status.current(trees).catch(() => {});
  const waits = new Map<string, number>();
  for (const ask of asks) {
    const parts = status.cached({ session: ask.tree, model: null });
    const until = parts ? accountSlot(parts, ask.provider) : null;
    if (until !== null && until > now) waits.set(ask.session, until);
  }
  return waits;
}

/** `poolFreeAt` for the tree rooted at `tree`, from a fresh shared read; null when the pool cannot be read. */
export async function treeFreeAt(tree: string, provider: string, read: typeof readPoolStatus = readPoolStatus, now: () => number = Date.now): Promise<number | null> {
  const thread = { session: tree, model: null };
  try {
    const parts = (await read([thread], { maxAgeMs: 0 })).threads.get(threadKey(thread));
    return parts ? poolFreeAt(parts, provider, now()) : null;
  } catch { return null; }
}

/** `poolAdmitsNow` for the tree rooted at `tree`, from a fresh shared read; false when the pool cannot be read. */
export async function poolAdmits(tree: string, provider: string, read: typeof readPoolStatus = readPoolStatus, now: () => number = Date.now): Promise<boolean> {
  const thread = { session: tree, model: null };
  try {
    const parts = (await read([thread], { maxAgeMs: 0 })).threads.get(threadKey(thread));
    return parts ? poolAdmitsNow(parts, provider, now()) : false;
  } catch { return false; }
}

const ANY_THREAD: PoolThread = { session: null, model: null };
/** A reader of `claudeStateOf` over `pi-pool ls --json --provider anthropic` from the shared read, at most `ttlMs` old; null when the pool cannot be read. */
export function claudeReader(ttlMs = 60_000, now: () => number = Date.now,
  read: () => Promise<string> = async () => partOut((await readPoolStatus([ANY_THREAD], { maxAgeMs: ttlMs })).threads.get(threadKey(ANY_THREAD))!.ls.anthropic)): () => Promise<ClaudeState | null> {
  return () => read().then(stdout => claudeStateOf(parsePoolRows(JSON.parse(stdout), "anthropic"), now()), () => null);
}

/** The pi-pool command lines this service runs for account changes. A CLI contract change is a one-line fix here. */
export const poolCommand = {
  disable: (provider: string, account: string) => ["off", account, "--provider", provider],
  enable: (provider: string, account: string) => ["on", account, "--provider", provider],
  remove: (provider: string, account: string) => ["rm", account, "--provider", provider],
  refresh: (provider: string, account: string | null) => ["refresh", ...(account ? [account] : []), "--provider", provider, "--stream"],
  login: (provider: string, account: string | null, seconds: number, off = false) => ["login", ...(account ? [account] : []), "--provider", provider, "--timeout", String(seconds), ...(off ? ["--off"] : [])],
  priority: (sessionId: string, priority: PoolPriority) => ["priority", priority, "--session", sessionId],
  set: (key: string, value: number) => ["set", key, String(value), "--by", "the Settings pane"],
  ownerTurn: (sessionId: string) => ["owner-turn", sessionId],
  lead: (sessionIds: readonly string[]) => ["lead", ...sessionIds],
};

/** `pi-pool queue --json`, parsed at the boundary: the Mac-wide turn queue. Throws on a shape that does not match, so the pane says the pool did not answer. */
const count = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;

function queueSession(value: unknown): AgentQueueSession {
  const since = isRecord(value) ? epochMs(value.since) : null;
  if (!isRecord(value) || !text(value.session) || !text(value.tree) || since === null) throw new Error("pi-pool returned an invalid queue entry");
  return { session: value.session as string, tree: value.tree as string, since };
}

const isTurnKind = (value: unknown): value is TurnKind => TURN_KINDS.some(kind => kind === value);
/** A working turn; a kind pi-pool no longer gives (a borrow or prod turn from before 10-20) reads as a slot. */
function workingSession(value: unknown): AgentQueueWorking {
  const kind = isRecord(value) ? value.kind : null;
  return { ...queueSession(value), kind: isTurnKind(kind) ? kind : "slot" };
}

export function parseAgentQueue(value: unknown): AgentQueueReading {
  if (!isRecord(value) || typeof value.enabled !== "boolean" || !Array.isArray(value.working) || !Array.isArray(value.queued)) throw new Error("pi-pool returned an invalid queue");
  const workingMax = count(value.working_max), treeWorkingMax = count(value.tree_working_max);
  if (workingMax === null || treeWorkingMax === null) throw new Error("pi-pool returned invalid queue limits");
  const queued = value.queued.map((entry: unknown): AgentQueuedSession => {
    const session = queueSession(entry);
    const row = entry as Record<string, unknown>;
    const position = count(row.position), total = count(row.total);
    const wait = typeof row.wait_s === "number" && Number.isFinite(row.wait_s) && row.wait_s >= 0 ? row.wait_s : null;
    if (position === null || total === null || wait === null) throw new Error("pi-pool returned an invalid queue entry");
    return { ...session, position, total, waitMs: wait * 1000, ...row.parked === true ? { parked: true as const } : {} };
  }).sort((a, b) => a.position - b.position);
  return { enabled: value.enabled, workingMax, workingMaxSet: setRecord(value.working_max_set), treeWorkingMax, working: value.working.map(workingSession), queued };
}

function setRecord(value: unknown): PoolSetRecord | null {
  if (value === null || value === undefined) return null;
  const at = isRecord(value) ? epochMs(value.at) : null;
  if (!isRecord(value) || at === null || (value.by !== null && !text(value.by))) throw new Error("pi-pool returned an invalid working_max_set");
  return { by: value.by as string | null, at };
}

/** `pi-pool queue --json` from the shared read, at most `maxAgeMs` old (the tick by default). */
export async function readAgentQueue(maxAgeMs?: number): Promise<AgentQueueReading> {
  return parseAgentQueue(JSON.parse(partOut((await readPoolStatus([], maxAgeMs === undefined ? {} : { maxAgeMs })).queue)));
}

/** The Agent queue pane's read: the last queue reading at once, refreshed behind it (`PoolStatusReader.latest`). */
export async function latestAgentQueue(): Promise<AgentQueueReading> {
  return parseAgentQueue(JSON.parse(partOut((await poolStatus.latest()).queue)));
}

export type AgentQueueKey = "agent_queue_on" | "working_max" | "tree_working_max";
export async function setPoolKey(key: AgentQueueKey, value: number): Promise<void> {
  try { await run(poolCommand.set(key, value)); } finally { forgetAccountReadings(); }
}

/**
 * Marks the owner's next prompt to a session as an owner turn, so the pool runs it at once and counts it in the total (`pi-pool owner-turn`).
 * One pi-pool call took 0.16 to 0.20 s at load 20 on 10-14, so it adds no wait the owner sees.
 */
export async function markOwnerTurn(sessionId: string): Promise<void> {
  await run(poolCommand.ownerTurn(sessionId));
}

/** This box's `pi-pool queue --json` read now, unparsed, for the lead writer's read of the list (`leadNow`). */
export async function poolQueueNow(): Promise<unknown> {
  return JSON.parse(await run(["queue", "--json"]));
}

/** Puts the queued runs of these sessions ahead of every other queued run in this box's turn queue (`pi-pool lead`); the list replaces the last one. */
export async function leadSessions(sessionIds: readonly string[]): Promise<void> {
  await run(poolCommand.lead(sessionIds));
}

/** The class a tree's pool record holds as the pool reads it, and its sidebar label; null priority for a tree with no record yet. */
export interface PoolTreeClass { priority: PoolPriority | null; label: PoolPriority | null }

/**
 * Each tree's record as `pi-pool snapshot --json --tree <id>...` reads it, by session id, for the roots a sync has not set yet. Null when
 * the pool does not answer it, such as an installed pi-pool from before --tree; a tree whose entry does not parse is left out.
 */
export async function readPoolClasses(sessionIds: readonly string[], part: (args: readonly string[]) => Promise<PoolPart> = poolPart): Promise<Map<string, PoolTreeClass> | null> {
  const said = await part(["snapshot", "--json", ...sessionIds.flatMap(id => ["--tree", id])]);
  if (said.code !== 0) return null;
  const value: unknown = JSON.parse(said.out);
  if (!isRecord(value) || !Array.isArray(value.trees)) return null;
  return new Map(value.trees.flatMap((entry: unknown): [string, PoolTreeClass][] => {
    if (!isRecord(entry) || !text(entry.session)) return [];
    const priority = parsePoolPriority(entry.priority), label = parsePoolPriority(entry.label);
    if ((entry.priority !== null && !priority) || (entry.label !== null && !label)) return [];
    return [[entry.session as string, { priority, label }]];
  }));
}

/**
 * Sets a root session's pool class through hookd when it answers (poolPart); the pool keeps it on the tree record, so every subagent of the root
 * shares it. It drops the root's own readings only; a subagent's reading takes the new class at its next shared read.
 */
export async function setPoolPriority(sessionId: string, priority: PoolPriority): Promise<void> {
  if (!sessionId || sessionId.startsWith("-")) throw new Error("Choose a thread.");
  try { partOut(await poolPart(poolCommand.priority(sessionId, priority))); } finally { poolStatus.forgetSession(sessionId); }
}

const accountArgument = (account: string | undefined): string => {
  if (!account || account.startsWith("-")) throw new Error("Choose an account.");
  return account;
};

/** Runs one pool action. Returns a sentence to show when the action reports something beyond the new pool state. */
export async function runAccountAction(action: AccountAction): Promise<string | null> {
  try { return await accountAction(action); } finally { forgetAccountReadings(); }
}

async function accountAction(action: AccountAction): Promise<string | null> {
  if (!isPooled(action.provider)) throw new Error("Choose a pooled provider.");
  const provider = ["--provider", action.provider];
  switch (action.action) {
    case "use": {
      if (!action.account || action.account.startsWith("-") || !action.id) throw new Error("Choose an account and a thread.");
      await run(["use", action.account, ...provider, "--session", action.id, ...(action.newSession ? ["--new-session"] : [])]); return null;
    }
    case "follow": {
      if (!action.id) throw new Error("Choose a thread.");
      await run(["use", "--follow", ...provider, "--session", action.id]); return null;
    }
    case "pin": await run(["pin", accountArgument(action.account), ...provider]); return null;
    case "unpin": await run(["unpin", ...provider]); return null;
    case "switch": await run(["switch", ...provider]); return null;
    case "disable": await run(poolCommand.disable(action.provider, accountArgument(action.account))); return null;
    case "enable": await run(poolCommand.enable(action.provider, accountArgument(action.account))); return null;
    case "remove": await run(poolCommand.remove(action.provider, accountArgument(action.account)), 75000); return null;
    case "resets": {
      if (action.provider !== "anthropic") throw new Error("Only Claude accounts have resets.");
      return resetsNotice(await runJson(["resets", "--json", ...(action.account ? [accountArgument(action.account)] : [])], 60000));
    }
    case "reset": {
      if (action.provider !== "anthropic") throw new Error("Only Claude accounts have resets.");
      if (action.grant !== undefined && !/^[a-z0-9_-]{1,40}$/.test(action.grant)) throw new Error("Choose a reset.");
      const answer = await runJson(["reset", accountArgument(action.account), "--json", ...(action.grant ? ["--grant", action.grant] : [])], 90000);
      return text(answer.message) ?? "pi-pool reset gave no answer.";
    }
    case "recheck": {
      if (action.provider !== "anthropic") throw new Error("Only Claude accounts can be checked for a refusal.");
      const found = (await run(["probe", "--force"], 30000)).trim();
      return found ? found.replaceAll("; ", ". ") + "." : "No refusals found.";
    }
  }
}

export class PoolError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** One stdout line of `pi-pool login`, parsed at the boundary. Links that are not https are dropped, so the page only ever links to a provider. */
export type LoginEvent = { event: "url"; url: string | null; manualUrl: string | null; code: string | null; paste: boolean }
  | { event: "retry"; message: string } | { event: "done"; ok: boolean; message: string };

const httpsUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try { return new URL(value).protocol === "https:" ? value : null; } catch { return null; }
};

export function parseLoginEvent(line: string): LoginEvent | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!isRecord(value)) return null;
  switch (value.event) {
    case "url": return { event: "url", url: httpsUrl(value.url), manualUrl: httpsUrl(value.manual_url), code: text(value.code), paste: value.paste === true };
    case "retry": return { event: "retry", message: text(value.message) ?? "That URL or code was not accepted. Paste the matching callback URL or code and try again." };
    case "done": return { event: "done", ok: value.ok === true, message: text(value.message) ?? (value.ok === true ? "Signed in." : "The sign-in failed.") };
    default: return null;
  }
}

const TERMINAL = new Set<AccountLogin["status"]>(["done", "failed", "cancelled"]);
export const loginRunning = (login: AccountLogin | null): boolean => login !== null && !TERMINAL.has(login.status);

/**
 * Runs one `pi-pool login` at a time for the browser: add an account, or sign one in again.
 * The child gets `--timeout` and this class still kills it at its own deadline. Closing its stdin cancels, SIGTERM stops it,
 * SIGKILL follows after a grace period. The last login stays readable after it ends, so a page opened later sees the result.
 */
export class AccountLogins {
  private login: AccountLogin | null = null;
  private child: ChildProcess | null = null;
  private stopping: "cancel" | "deadline" | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readonly listeners = new Set<(login: AccountLogin | null) => void>();
  private readonly executable: string;
  private readonly deadlineMs: number;
  private readonly graceMs: number;

  constructor(options: { executable?: string; deadlineMs?: number; graceMs?: number } = {}) {
    this.executable = options.executable ?? executable;
    this.deadlineMs = options.deadlineMs ?? 10 * 60_000;
    this.graceMs = options.graceMs ?? 10_000;
  }

  current(): AccountLogin | null { return this.login; }

  subscribe(listener: (login: AccountLogin | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.login);
    return () => { this.listeners.delete(listener); };
  }

  start(provider: string, account: string | null, off = false): AccountLogin {
    if (!isPooled(provider)) throw new PoolError(400, "Choose a pooled provider.");
    if (account !== null && (!account || account.startsWith("-") || account.length > 256)) throw new PoolError(400, "Choose an account.");
    if (loginRunning(this.login)) throw new PoolError(409, "Another sign-in is still running. Finish or cancel it first.");
    const seconds = Math.max(1, Math.floor(this.deadlineMs / 1000));
    const child = spawn(this.executable, poolCommand.login(provider, account, seconds, off), { env: poolEnv(), stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.stopping = null;
    this.update({ id: randomUUID(), provider, account, status: "starting", url: null, manualUrl: null, code: null, paste: false, message: null });
    let stdout = "";
    let stderr = "";
    let finished: LoginEvent & { event: "done" } | null = null;
    child.stdin!.on("error", () => {});
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      let newline: number;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const event = parseLoginEvent(stdout.slice(0, newline));
        stdout = stdout.slice(newline + 1);
        if (event?.event === "done") finished = event;
        else if (event) this.apply(child, event);
      }
    });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
    child.once("error", error => { stderr = error.message; });
    child.once("close", code => {
      forgetAccountReadings();
      if (this.child !== child) return;
      this.child = null;
      for (const timer of this.timers) clearTimeout(timer);
      this.timers = [];
      const done: LoginEvent & { event: "done" } | null = finished;
      const said = stderr.trim().split("\n").at(-1)?.slice(0, 300);
      const next: Pick<AccountLogin, "status" | "message"> =
        this.stopping === "deadline" ? { status: "failed", message: `The sign-in did not finish in ${Math.round(this.deadlineMs / 60_000) || 1} min.` }
        : this.stopping === "cancel" && !done?.ok ? { status: "cancelled", message: null }
        : done ? { status: done.ok ? "done" : "failed", message: done.message }
        : { status: "failed", message: said || `pi-pool login stopped with exit code ${code ?? "none"}.` };
      if (this.login) this.update({ ...this.login, ...next, paste: false });
    });
    this.timers.push(setTimeout(() => this.stop(child, "deadline"), this.deadlineMs + this.graceMs));
    return this.login!;
  }

  paste(id: string, code: string): AccountLogin {
    const login = this.running(id);
    const line = code.trim();
    if (!line || line.length > 4096 || /[\r\n]/.test(line)) throw new PoolError(400, "Paste the callback URL or sign-in code as one line.");
    if (!login.paste) throw new PoolError(409, "This sign-in does not take a pasted URL or code.");
    this.child?.stdin?.write(line + "\n");
    return this.update({ ...login, status: "finishing", message: null });
  }

  cancel(id: string): AccountLogin {
    const login = this.running(id);
    if (this.child) this.stop(this.child, "cancel");
    return login;
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
    this.stop(child, "cancel");
    await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, this.graceMs * 2 + 1000))]);
  }

  private running(id: string): AccountLogin {
    if (!this.login || this.login.id !== id || !loginRunning(this.login)) throw new PoolError(404, "This sign-in has ended.");
    return this.login;
  }

  /** Close stdin (pi-pool's cancel), then SIGTERM after the grace period, then SIGKILL. Idempotent: a second call only upgrades a cancel to a deadline. */
  private stop(child: ChildProcess, why: "cancel" | "deadline"): void {
    if (this.child !== child) return;
    const first = this.stopping === null;
    if (why === "deadline" || first) this.stopping = why;
    if (!first) return;
    child.stdin?.end();
    this.timers.push(setTimeout(() => child.kill("SIGTERM"), why === "deadline" ? 0 : this.graceMs));
    this.timers.push(setTimeout(() => child.kill("SIGKILL"), this.graceMs * 2));
  }

  private apply(child: ChildProcess, event: LoginEvent): void {
    if (this.child !== child || !this.login || this.stopping) return;
    if (event.event === "url") this.update({ ...this.login, status: "waiting", url: event.url ?? event.manualUrl, manualUrl: event.manualUrl, code: event.code, paste: event.paste, message: null });
    else if (event.event === "retry") this.update({ ...this.login, status: "waiting", message: event.message });
  }

  private update(login: AccountLogin): AccountLogin {
    this.login = login;
    for (const listener of this.listeners) listener(login);
    return login;
  }
}

/** One stdout line of `pi-pool refresh --stream`, parsed at the boundary. Times arrive in epoch seconds and leave in epoch ms. */
export type RefreshEvent = { event: "accounts"; accounts: { id: string; email: string | null; label: string | null }[] } | { event: "reading"; id: string }
  | { event: "read"; id: string; ok: boolean; reason: string | null; usageAt: number | null; retryAt: number | null }
  | { event: "error"; message: string } | { event: "end" };

export function parseRefreshEvent(line: string): RefreshEvent | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!isRecord(value)) return null;
  const id = text(value.id);
  switch (value.event) {
    case "accounts": return Array.isArray(value.accounts)
      ? { event: "accounts", accounts: value.accounts.flatMap(entry => isRecord(entry) && text(entry.id) ? [{ id: entry.id as string, email: text(entry.email), label: text(entry.label) ?? text(entry.email) }] : []) } : null;
    case "reading": return id ? { event: "reading", id } : null;
    case "read": return id ? { event: "read", id, ok: value.ok === true, reason: text(value.reason), usageAt: epochMs(value.usage_at), retryAt: epochMs(value.retry_at) } : null;
    case "error": return { event: "error", message: text(value.message) ?? "pi-pool refresh failed." };
    case "end": return { event: "end" };
    default: return null;
  }
}

/**
 * Runs `pi-pool refresh --stream` for the browser, one run per provider at a time: every account, or one.
 * Each event updates the run and goes to every subscriber, so the page shows which account is being read and how each read ended.
 * The last run per provider stays readable after it ends, so a page opened later sees the result.
 */
export class UsageRefreshes {
  private readonly runs = new Map<string, UsageRefresh>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly listeners = new Set<(refresh: UsageRefresh) => void>();
  private readonly executable: string;
  private readonly deadlineMs: number;

  constructor(options: { executable?: string; deadlineMs?: number } = {}) {
    this.executable = options.executable ?? executable;
    this.deadlineMs = options.deadlineMs ?? 200_000;
  }

  current(): UsageRefresh[] { return [...this.runs.values()]; }

  subscribe(listener: (refresh: UsageRefresh) => void): () => void {
    this.listeners.add(listener);
    for (const run of this.runs.values()) listener(run);
    return () => { this.listeners.delete(listener); };
  }

  start(provider: string, account: string | null): UsageRefresh {
    if (!isPooled(provider)) throw new PoolError(400, "Choose a pooled provider.");
    if (account !== null && (!account || account.startsWith("-") || account.length > 256)) throw new PoolError(400, "Choose an account.");
    if (this.runs.get(provider)?.status === "running") throw new PoolError(409, "A usage refresh is still running for these accounts. Wait for it to finish.");
    const child = spawn(this.executable, poolCommand.refresh(provider, account), { env: poolEnv(), stdio: ["ignore", "pipe", "pipe"] });
    this.children.set(provider, child);
    const id = randomUUID();
    this.update({ id, provider, account, status: "running", accounts: [], message: null, startedAt: Date.now(), endedAt: null });
    const edit = (change: (run: UsageRefresh) => UsageRefresh): void => {
      const run = this.runs.get(provider);
      if (run?.id === id) this.update(change(run));
    };
    const setAccount = (accountId: string, change: Partial<UsageRefreshAccount>): void =>
      edit(run => ({ ...run, accounts: run.accounts.map(entry => entry.id === accountId ? { ...entry, ...change } : entry) }));
    let stdout = "";
    let stderr = "";
    let stopped = false;
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      let newline: number;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const event = parseRefreshEvent(stdout.slice(0, newline));
        stdout = stdout.slice(newline + 1);
        if (!event) continue;
        if (event.event === "accounts") edit(run => ({ ...run, accounts: event.accounts.map(entry => ({ ...entry, state: "queued", reason: null, usageAt: null, retryAt: null })) }));
        else if (event.event === "reading") setAccount(event.id, { state: "reading" });
        else if (event.event === "read") { forgetAccountReadings(); setAccount(event.id, { state: event.ok ? "read" : "failed", reason: event.ok ? null : event.reason ?? "Not read.", usageAt: event.usageAt, retryAt: event.retryAt }); }
        else if (event.event === "error") edit(run => ({ ...run, message: event.message }));
      }
    });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
    child.once("error", error => { stderr = error.message; });
    const deadline = setTimeout(() => { stopped = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000).unref(); }, this.deadlineMs);
    child.once("close", code => {
      clearTimeout(deadline);
      forgetAccountReadings();
      if (this.children.get(provider) === child) this.children.delete(provider);
      const said = stderr.trim().split("\n").at(-1)?.slice(0, 300);
      edit(run => {
        const message = stopped ? `The refresh did not finish in ${Math.round(this.deadlineMs / 1000)} s.`
          : run.message ?? (code !== 0 && !run.accounts.length ? said || `pi-pool refresh stopped with exit code ${code ?? "none"}.` : null);
        const accounts = run.accounts.map(entry => entry.state === "queued" || entry.state === "reading"
          ? { ...entry, state: "failed" as const, reason: "The refresh stopped before this account was read." } : entry);
        return { ...run, accounts, message, status: message && !accounts.some(entry => entry.state === "read") ? "failed" : "done", endedAt: Date.now() };
      });
    });
    return this.runs.get(provider)!;
  }

  async close(): Promise<void> {
    for (const child of this.children.values()) child.kill("SIGTERM");
    this.children.clear();
  }

  private update(run: UsageRefresh): void {
    this.runs.set(run.provider, run);
    for (const listener of this.listeners) listener(run);
  }
}
