/**
 * The pi-pool shapes the chat server parses and the Accounts pages show: accounts, their usage windows and resets, a thread's resolution,
 * logins, usage refreshes and the turn queue. It imports nothing, so a server that reads the pool through chat-pool.ts needs only these two files.
 */

/** The pool's answer about Claude now: whether any account can serve, and when the first one that cannot frees up (epoch ms, null when unknown). */
export interface ClaudeState { serves: boolean; freeAt: number | null }

export interface PoolWindow { kind: "session" | "weekly" | "model"; label: string; pct: number; resetsAt: number | null }
export interface PoolAccount {
  /** `label` is what to show: the email, plus the organization when two pooled accounts share the email. */
  id: string; email: string; label: string; plan?: string; usage: string; session_pct: number | null; weekly_pct: number | null;
  usable: boolean; reason: string | null; current: boolean; pinned: boolean; score: number | null;
  tier: string | null; windows: PoolWindow[]; usageAt: number | null; cooldownUntil: number | null; cooldownReason: string | null; disabled: boolean;
  /** Epoch ms until which the provider answered 429 for this account (`pi-pool limited`); null when no limit is on file. */
  limitedUntil: number | null;
  /** Threads on this account: root sessions (each with its jobs) whose last request through the pool was within `active_session_sec`. */
  sessions: number;
  /** Claude only: the last read of the account's banked usage-limit resets; null when never read. */
  resets?: AccountResets | null;
}
/** One banked reset grant. Times are epoch ms. */
export interface ResetGrant {
  id: string; label: string; resetsTotal: number; resetsLeft: number; startsAt: number | null; endsAt: number | null;
  clears: string[]; paused: boolean; usableNow: boolean; useRequiresLimit: boolean;
}
/** `pi-pool resets` for one account. `grants` is the last good read; `error` is a later read that failed. */
export interface AccountResets {
  checkedAt: number | null; eligible: boolean | null; ineligibleReason: string | null; atLimit: boolean; cooldownUntil: number | null;
  grants: ResetGrant[]; nextGrantId: string | null; error: string | null; errorAt: number | null;
  /** A claim whose outcome is unknown; using the reset again retries it with the same request id. */
  pending: { grantId: string; createdAt: number } | null;
}
export type PoolSelection = { mode: "auto" } | { mode: "manual"; account_id: string };
export interface PoolResolution { account: string | null; email: string | null; reason: string | null; pinned: boolean; selection: PoolSelection; error: string | null }
/** A thread's class in the pool (`pi-pool priority`): high trees get admission slots first, low ones wait for the emptiest accounts. */
export type PoolPriority = "high" | "normal" | "low";
export const POOL_PRIORITIES: readonly PoolPriority[] = ["high", "normal", "low"];
/** The pool holds the thread until `account` admits it at `slotAt` (epoch ms): its 429 ends, its 5h window resets, or a slot frees. */
export interface PoolWait { account: string; slotAt: number }
/** `wait` is null when the thread does not wait on this provider. */
export interface PoolProvider { provider: "anthropic" | "openai-codex"; rows: PoolAccount[]; resolution: PoolResolution | null; wait?: PoolWait | null; poolPin?: string | null; error?: string }
/** The numeric settings of `pi-pool config` (pool/base.py DEFAULTS merged with ~/.config/pi-pool/config.json), by key. */
export type PoolConfig = Readonly<Record<string, number>>;
/** `poolConfig` is null when `pi-pool config` could not be read; the client then shows pi-pool's defaults. */
/** `priority` is the thread's pool class, null with no thread or when the pool does not say. */
export interface AccountsView { sessionId: string | null; checkedAt: string; providers: PoolProvider[]; poolConfig: PoolConfig | null; priority?: PoolPriority | null; notice?: string }
export type AccountAction = { action: "use"; provider: string; account: string; id: string; newSession?: boolean } | { action: "follow"; provider: string; id: string }
  | { action: "pin"; provider: string; account: string } | { action: "unpin"; provider: string } | { action: "switch"; provider: string }
  | { action: "recheck"; provider: string } | { action: "resets"; provider: string; account?: string } | { action: "reset"; provider: string; account: string; grant?: string }
  | { action: "disable"; provider: string; account: string } | { action: "enable"; provider: string; account: string } | { action: "remove"; provider: string; account: string };
/** One account inside a usage refresh. `usageAt` and `retryAt` are epoch ms. */
export interface UsageRefreshAccount {
  id: string; email: string | null; label: string | null; state: "queued" | "reading" | "read" | "failed"; reason: string | null; usageAt: number | null; retryAt: number | null;
}
/** One `pi-pool refresh --stream` run: every account of a provider, or one account. The last run per provider stays readable after it ends. */
export interface UsageRefresh {
  id: string; provider: "anthropic" | "openai-codex"; account: string | null; status: "running" | "done" | "failed";
  accounts: UsageRefreshAccount[]; message: string | null; startedAt: number; endedAt: number | null;
}
/** One browser-driven `pi-pool login`: add an account, or sign one in again when `account` is set. */
export interface AccountLogin {
  id: string; provider: "anthropic" | "openai-codex"; account: string | null;
  status: "starting" | "waiting" | "finishing" | "done" | "failed" | "cancelled";
  url: string | null; manualUrl: string | null; code: string | null; paste: boolean; message: string | null;
}

/** One session in `pi-pool queue --json`. Times leave the server in epoch ms. */
export interface AgentQueueSession { session: string; tree: string; since: number }
/** How a working turn got its slot (pi-pool turns.py): a free slot in line, the owner's message, or an agent run ahead of the owner's message. */
export const TURN_KINDS = ["slot", "owner", "ahead"] as const;
export type TurnKind = (typeof TURN_KINDS)[number];
export interface AgentQueueWorking extends AgentQueueSession { kind: TurnKind }
/**
 * `parked`: the run gave up its process (pi-pool `park`) and its session waits in Prime's credential wait, so pi-pool starts it by a wake and
 * its own ask, never on a poll of its own.
 */
export interface AgentQueuedSession extends AgentQueueSession { position: number; total: number; waitMs: number; parked?: true }
/** Who last ran `pi-pool set` on a key and when, in epoch ms. `by` is null for a value written before pi-pool recorded writers; `at` is then config.json's file time. */
export interface PoolSetRecord { by: string | null; at: number }
/**
 * `pi-pool queue --json` as parsed. `enabled` is the `agent_queue_on` switch; the two limits keep their numbers while it is off.
 * `workingMaxSet` is null while the Mac limit holds pi-pool's default.
 */
export interface AgentQueueReading { enabled: boolean; workingMax: number; workingMaxSet: PoolSetRecord | null; treeWorkingMax: number; working: AgentQueueWorking[]; queued: AgentQueuedSession[] }
