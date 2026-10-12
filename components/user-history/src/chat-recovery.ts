import { clockTime, RETRY_BACKOFF_MS } from "./chat-checkin.ts";
import { CHECK_IN_PREFIX, OWNER_RETRY_MARK, serverNote, turnStarter } from "./shared/chat-feed.ts";
import { messageText } from "./shared/turns.ts";
import type { ChatWait, ThreadMessage } from "./shared/types.ts";
import type { CheckInSetting } from "./chat-checkin.ts";

/**
 * Whether a check-in pause is the owner's. The owner's pause also stops failed-turn restarts; a pause by the daemon gate (`daemon`) or by the
 * chat itself (`agent`) stops only its check-ins, and a failed turn still gets its restart.
 */
export const ownerPause = (setting: Pick<CheckInSetting, "pausedBy">): boolean => setting.pausedBy !== "daemon" && setting.pausedBy !== "agent";
/** The queue lane of a chat's check-in: apart from the chat's own lane, where its revive runs, so a check-in that waits never holds a revive. */
export const checkInLane = (id: string): string => `checkin:${id}`;

/** The pool's answer about Claude now: whether any account can serve, and when the first one that cannot frees up (epoch ms, null when unknown). */
export interface ClaudeState { serves: boolean; freeAt: number | null }

/** An owner-started failed turn is restarted after 30 s, then on the usual schedule. A turn something else started waits 5 min first. */
export const OWNER_RETRY_BACKOFF_MS: readonly number[] = [30_000, ...RETRY_BACKOFF_MS];
/** A transient failure (the token command, the connection) is restarted after 30 s, 1 min, 2 min, then on the usual schedule. */
export const TRANSIENT_RETRY_BACKOFF_MS: readonly number[] = [30_000, 60_000, 120_000, ...RETRY_BACKOFF_MS];
/** The scheduler wakes every 30 s; a gap longer than this between two wakes means the Mac slept. */
export const SLEEP_GAP_MS = 90_000;
/** Whether the wake at `now` follows a sleep: more than SLEEP_GAP_MS since the last wake. False at the first wake. */
export const wokeFromSleep = (last: number | null, now: number): boolean => last !== null && now - last > SLEEP_GAP_MS;
const waitOf = (schedule: readonly number[], attempts: number): number => schedule[Math.min(attempts, schedule.length - 1)]!;

/**
 * Why a turn failed: `transient` when the pool's token command failed or timed out (Prime runs it with a 10 s limit;
 * on 10-05 the Mac slept on battery and every turn failed so) or the connection dropped, `account` when no Claude account exists,
 * `rate-limit` for a 429, a 401 or a Consumer Terms 400 (account availability matters only when the pool also has no usable account), `other` for the rest (Stop).
 */
export function failureCause(error: string): "account" | "rate-limit" | "transient" | "other" {
  if (/Failed to resolve API key for provider "[^"]*" from shell command/i.test(error)) return "transient";
  if (/Failed to resolve API key for provider "anthropic"|No Claude account|No API key for (?:provider: )?anthropic/i.test(error)) return "account";
  // A 401 (bad or expired credentials) or a 400 asking to accept new terms is the vended account failing, like a 429: account availability matters only when
  // the pool has no other usable account (10-08: every account went 401 or "accept the updated Consumer Terms" and provider retries continued).
  if (/\b429\b|rate_limit_error|rate limit|\b401\b|authentication_error|Consumer Terms/i.test(error)) return "rate-limit";
  if (/Connection error|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(error)) return "transient";
  return "other";
}

/**
 * Whether a chat on `provider` waits for a Claude account. The provider's no-account error is conclusive; an unreadable pool gives no answer for other failures.
 */
export function claudeDown(error: string, provider: string | null, claude: ClaudeState | null): boolean {
  if (provider !== "anthropic") return false;
  const cause = failureCause(error);
  return cause === "account" || (claude !== null && !claude.serves && (cause === "rate-limit" || cause === "transient"));
}

/** What the server reads of a thread to judge its last turn. `retrying`: a provider retry or wait holds the turn; `queued`: input waiting in its queue. */
export interface TurnView { messages: readonly ThreadMessage[]; running: boolean; retrying: boolean; queued: number; retryError: string | null }
/**
 * A turn that ended in a failure, or one a provider retry holds after a failure. `owner` is the owner's unanswered message when the owner
 * started the turn and it did not end on a Stop; `aborted` is a Stop.
 */
export interface Stall { error: string; at: number; owner: string | null; aborted: boolean; retrying: boolean; queued: number }

const clip = (text: string, max: number): string => text.length > max ? text.slice(0, max - 1) + "…" : text;

type Viewed = { messages: readonly ThreadMessage[]; info?: { retryAttempt?: number; queuedActions?: number }; queue?: { steering: readonly string[]; followUp: readonly string[] }; retry?: { error: string } | null };
/** The view of a thread's state the stall reads; `running` is ThreadHub.running (a turn, a command or a retry runs now). */
export function turnViewOf(state: Viewed, running: boolean): TurnView {
  return { messages: state.messages, running, retrying: (state.info?.retryAttempt ?? 0) > 0,
    queued: (state.queue?.steering.length ?? 0) + (state.queue?.followUp.length ?? 0) + (state.info?.queuedActions ?? 0), retryError: state.retry?.error ?? null };
}

/** The thread's stall, or null when its last turn ended well or one runs now. */
export function turnStall(view: TurnView, now: number): Stall | null {
  if (view.running && !view.retrying) return null;
  let failed: { error: string; at: number; aborted: boolean } | null = null;
  let asked: string | null = null;
  for (let index = view.messages.length - 1; index >= 0; index--) {
    const message = view.messages[index]!;
    if (message.role === "user") {
      if (failed) { const text = messageText(message).trim(); if (!serverNote(text) || text.includes(OWNER_RETRY_MARK)) asked = text; }
      break;
    }
    if (message.role !== "assistant" || failed) continue;
    if (message.stopReason !== "error" && message.stopReason !== "aborted") break;
    failed = { error: (message.errorMessage?.trim() || message.stopReason).replace(/\s+/g, " "), at: message.timestamp, aborted: message.stopReason === "aborted" };
  }
  if (!failed && !view.retrying) return null;
  const error = clip(view.retryError?.replace(/\s+/g, " ") || failed?.error || "retrying", 160);
  const owner = failed && !failed.aborted && turnStarter(view.messages) === "owner" && asked !== null
    ? clip(asked.includes(OWNER_RETRY_MARK) ? asked.slice(asked.indexOf(OWNER_RETRY_MARK) + OWNER_RETRY_MARK.length).replace(/^"|"\. Answer it first\.$/g, "") : asked, 200)
    : null;
  return { error, at: failed?.at ?? now, owner, aborted: failed?.aborted ?? false, retrying: view.retrying, queued: view.queued };
}

/** The new turn the server starts for a stall, with the failure's local time; an owner turn quotes the owner's message so the chat answers it first. */
export function revivalMessage(stall: Pick<Stall, "error" | "at" | "owner">): string {
  const failed = `${CHECK_IN_PREFIX}Your last turn failed at ${clockTime(stall.at)} (${stall.error}).`;
  return stall.owner === null ? `${failed} Re-check the board and continue.` : `${failed} ${OWNER_RETRY_MARK}"${stall.owner}". Answer it first.`;
}

/**
 * What to do about a chat's stall while keeping its selected model. A provider retry with nothing queued is the session's own to
 * finish. Otherwise the restart goes at its time on the schedule (transient failures: 30 s, 1, 2 min first; owner turns: 30 s first); before that
 * the feed shows the wait to the owner. `woke`: the scheduler just woke from a sleep, and a transient stall restarts now.
 */
export function stallAction(input: { stall: Stall; down: boolean; claude: ClaudeState | null; attempts: number; since: number; now: number; woke?: boolean }):
  { kind: "restart"; message: string; abort: boolean } | { kind: "wait"; wait: ChatWait | null } | { kind: "none" } {
  const { stall, attempts, since, now } = input;
  const transient = !stall.aborted && failureCause(stall.error) === "transient";
  const restart = { kind: "restart" as const, message: revivalMessage(stall), abort: stall.retrying };
  if (input.woke && transient) return restart;
  if (stall.retrying && stall.queued === 0 && !input.down) return { kind: "none" };
  const schedule = transient ? TRANSIENT_RETRY_BACKOFF_MS : stall.owner !== null ? OWNER_RETRY_BACKOFF_MS : RETRY_BACKOFF_MS;
  const at = since + waitOf(schedule, attempts);
  if (now >= at) return restart;
  if (stall.owner === null) return { kind: "wait", wait: null };
  return { kind: "wait", wait: input.down ? { kind: "account", until: input.claude?.freeAt && input.claude.freeAt > now ? input.claude.freeAt : at } : { kind: "retry", error: stall.error, at } };
}

/** The wakes sent to a job thread for its run of transient failures: the failure last woken (its time), how many, and when the last went. */
export interface JobWake { failureAt: number; attempts: number; at: number }
/**
 * What to do about a job of a chat (a subagent or a create_session root): `none` when its last turn did not end in a transient failure;
 * otherwise `wake` once per failure on the TRANSIENT_RETRY_BACKOFF_MS schedule, and at once after a sleep (`woke`), queued input or not. A
 * provider retry with nothing queued is the session's own to finish until a sleep.
 */
export function jobWake(input: { stall: Stall | null; last: JobWake | undefined; woke: boolean; now: number }): "wake" | "wait" | "none" {
  const { stall, last } = input;
  if (!stall || stall.aborted || failureCause(stall.error) !== "transient") return "none";
  if (last?.failureAt === stall.at) return "wait";
  if (input.woke) return "wake";
  if (stall.retrying && stall.queued === 0) return "wait";
  return input.now - (last?.at ?? stall.at) >= waitOf(TRANSIENT_RETRY_BACKOFF_MS, last?.attempts ?? 0) ? "wake" : "wait";
}

/** A thread (a step owner, or any thread after a model or account change) whose stalled turn holds queued input gets woken: its input is stranded. */
export const strandedInput = (stall: Stall | null): boolean => stall !== null && stall.queued > 0;
