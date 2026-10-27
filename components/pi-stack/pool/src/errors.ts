import type { AssistantMessage } from "@earendil-works/pi-ai";

export type Selection = { mode: "auto" } | { mode: "manual"; account_id: string };

export function isSelection(value: unknown): value is Selection {
  if (!value || typeof value !== "object" || !("mode" in value)) return false;
  const v = value as { mode: unknown; account_id?: unknown };
  return v.mode === "auto" || (v.mode === "manual" && typeof v.account_id === "string" && v.account_id.length > 0);
}

export function selectionName(selection: Selection, label?: string): string {
  return selection.mode === "auto" ? `Auto${label ? ` ${label}` : ""}` : `Manual ${label ?? selection.account_id}`;
}

/** A pool CLI run as the extension sees it. */
export type PoolCall = (args: string[]) => Promise<{ ok: boolean; out: string }>;

/**
 * A failed request as Pi 1.4.0 reports it. Pi keeps no status field on the message, so the status comes from the
 * SDK's error text, `<status> {json}`, which may follow pi-ai's "Server requested <n>s retry delay (max: 60s). " lead.
 */
export interface Failure {
  status: number | undefined;
  /** The provider's reset in ms, from that lead, when the server sent one. */
  resetMs: number | undefined;
  text: string;
}

export function readFailure(text: string): Failure {
  const lead = /^Server requested (\d+)s retry delay \(max: \d+s\)\.\s*/.exec(text);
  const rest = lead ? text.slice(lead[0].length) : text;
  const status = /^(\d{3})\s/.exec(rest)?.[1];
  const limited = /rate.?limit|usage.?limit|too many requests/i.test(rest);
  return { status: status ? Number(status) : limited ? 429 : undefined, resetMs: lead ? Number(lead[1]) * 1000 : undefined, text: rest };
}

/** pi-ai's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN (utils/retry.js:4). Text that matches it ends the turn, so a swap leaves it out. */
const FINAL = /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing_usage_limit_exceeded|subscription_sharing_workplace_individual_usage_limit_exceeded/i;
/** pi-ai's retry pattern keys on this text, so every rewrite that should retry names it. */
const RETRY_WORDS = "rate limit";
/** Prime's reset phrases; a reset left in the text reads as a long wait that the pool no longer means. */
const RESET_PHRASE = /(?:try again|resets?|available)[^.]{0,80}?(?:~\s*)?\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b\.?/gi;

function retryable(status: number | undefined, original: string, said: string): string {
  const kept = FINAL.test(original) ? "" : original.replace(RESET_PHRASE, "").trim();
  return [status ? `${status} ${RETRY_WORDS}.` : `${RETRY_WORDS}.`, kept, said].filter(Boolean).join(" ");
}

function iso(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

interface LimitedReply { selection: Selection; account: string | null; until: number; next: string | null; retry_at?: number | null; stale?: boolean }
interface RefusedReply { selection: Selection; account?: string; reason: string | null; next?: string | null; retry_at?: number | null }

async function poolJson<T extends { selection: Selection }>(pool: PoolCall, args: string[]): Promise<T | undefined> {
  const res = await pool(args);
  if (!res.ok) return undefined;
  try {
    const reply = JSON.parse(res.out) as T;
    return isSelection(reply.selection) ? reply : undefined;
  } catch {
    return undefined;
  }
}

/** A 429 with no reset time still marks the account, for this long. */
const DEFAULT_RESET_MS = 5 * 60_000;

/**
 * The message_end rewrite for one failed request on a pooled provider, or undefined to leave it.
 *
 * A 429 reports the account to the pool (`pi-pool limited`) and becomes a retryable rate-limit error, so Pi's own
 * retry runs and its header hook vends the next account, or waits there for the session's slot. A 400 or 403 that
 * the pool reads as an account-level refusal (`pi-pool refused`) takes the account out and moves on the same way.
 * `hookFailure` is the reason the header hook gave no token for this request, which also retries.
 */
export async function rewriteFailure(message: AssistantMessage, pool: PoolCall, hookFailure: string | undefined, now: () => number = Date.now): Promise<AssistantMessage | undefined> {
  if (message.stopReason !== "error") return undefined;
  const original = message.errorMessage ?? "";
  if (hookFailure) {
    return { ...message, errorMessage: `pi-pool: the token hook gave no token (${hookFailure}); the service is temporarily unavailable and the retry runs the hook again. ${original}`.trim() };
  }
  const failure = readFailure(original);
  if (failure.status === 429) {
    const until = (now() + (failure.resetMs ?? DEFAULT_RESET_MS)) / 1000;
    const reply = await poolJson<LimitedReply>(pool, ["limited", "--provider", message.provider, "--until", String(until), "--since", String(message.timestamp / 1000)]);
    if (!reply) return { ...message, errorMessage: retryable(429, failure.text, "pi-pool did not record this 429; the retry reports it again.") };
    if (reply.selection.mode === "manual") return { ...message, errorMessage: retryable(429, failure.text, `pi-pool: ${selectionName(reply.selection)} remains selected.`) };
    if (!reply.next) {
      const slot = typeof reply.retry_at === "number" ? `; this session waits for its slot at ${iso(reply.retry_at)}` : "";
      return { ...message, errorMessage: retryable(429, failure.text, `pi-pool: ${reply.account} is limited until ${iso(reply.until)}${slot}.`) };
    }
    const said = reply.stale ? "pi-pool: this 429 came from the account the session already left" : `pi-pool: ${reply.account} is limited until ${iso(reply.until)}`;
    return { ...message, errorMessage: retryable(429, failure.text, `${said}; the retry uses ${reply.next}.`) };
  }
  if (failure.status === 400 || failure.status === 403) {
    const reply = await poolJson<RefusedReply>(pool, ["refused", "--provider", message.provider, original]);
    if (!reply || !reply.reason) return undefined;
    if (reply.selection.mode === "manual") return undefined;
    const next = reply.next ? `the retry uses ${reply.next}` : typeof reply.retry_at === "number" ? `this session waits for its slot at ${iso(reply.retry_at)}` : "the retry asks the pool again";
    return { ...message, errorMessage: retryable(failure.status, failure.text, `pi-pool: ${reply.account} is out of the pool (${reply.reason}), which pi-pool treats as a rate limit; ${next}.`) };
  }
  return undefined;
}
