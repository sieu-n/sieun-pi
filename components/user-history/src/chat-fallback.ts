import { RETRY_BACKOFF_MS } from "./chat-checkin.ts";
import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { CHECK_IN_PREFIX, OWNER_RETRY_MARK, serverNote, turnStarter } from "./shared/chat-feed.ts";
import { messageText } from "./shared/turns.ts";
import type { ChatWait, ModelCatalog, ThinkingLevel, ThreadMessage } from "./shared/types.ts";

/** The model a chat moves to when Claude cannot serve it. When the catalog lacks it, the closest Codex model stands in (`fallbackModel`). */
export const FALLBACK_MODEL = { provider: "openai-codex", id: "gpt-6-sol" } as const;
export type ModelRef = { provider: string; id: string };
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
 * Why a turn failed, as far as Claude goes: `transient` when the pool's token command failed or timed out (Prime runs it with a 10 s limit;
 * on 10-05 the Mac slept on battery and every turn failed so) or the connection dropped, `account` when no Claude account exists,
 * `rate-limit` for a 429, a 401 or a Consumer Terms 400 (Claude is down only when the pool also has no usable account), `other` for the rest (Stop).
 */
export function failureCause(error: string): "account" | "rate-limit" | "transient" | "other" {
  if (/Failed to resolve API key for provider "[^"]*" from shell command/i.test(error)) return "transient";
  if (/Failed to resolve API key for provider "anthropic"|No Claude account|No API key for (?:provider: )?anthropic/i.test(error)) return "account";
  // A 401 (bad or expired credentials) or a 400 asking to accept new terms is the vended account failing, like a 429: Claude is down only when
  // the pool has no other usable account (10-08: every account went 401 or "accept the updated Consumer Terms" and no chat switched).
  if (/\b429\b|rate_limit_error|rate limit|\b401\b|authentication_error|Consumer Terms/i.test(error)) return "rate-limit";
  if (/Connection error|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(error)) return "transient";
  return "other";
}

/**
 * Whether a chat on `provider` failed because Claude cannot serve: always when no account exists; for a 429 or a transient failure only when the
 * pool is read and no account serves. An unreadable pool (null) means retry: a failed token command does not prove Claude is down.
 */
export function claudeDown(error: string, provider: string | null, claude: ClaudeState | null): boolean {
  if (provider !== "anthropic") return false;
  const cause = failureCause(error);
  return cause === "account" || ((cause === "rate-limit" || cause === "transient") && claude !== null && !claude.serves);
}

/** The fallback model in the catalog, else the configured Codex model whose id shares the longest start with it (the newest on a tie); null when none. */
export function fallbackModel(catalog: Pick<ModelCatalog, "models" | "configuredProviders">): (ModelRef & { name: string }) | null {
  if (!catalog.configuredProviders.includes(FALLBACK_MODEL.provider)) return null;
  const codex = catalog.models.filter(model => model.provider === FALLBACK_MODEL.provider);
  const shared = (id: string): number => { let n = 0; while (n < id.length && id[n] === FALLBACK_MODEL.id[n]) n++; return n; };
  const best = [...codex].sort((a, b) => shared(b.id) - shared(a.id) || b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
  return best ? { provider: best.provider, id: best.id, name: best.name } : null;
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

/** The new turn the server starts for a stall; an owner turn quotes the owner's message so the chat answers it first. */
export function revivalMessage(error: string, owner: string | null = null): string {
  return owner === null ? `${CHECK_IN_PREFIX}Your last turn failed (${error}). Re-check the board and continue.`
    : `${CHECK_IN_PREFIX}Your last turn failed (${error}). ${OWNER_RETRY_MARK}"${owner}". Answer it first.`;
}

/**
 * What to do about a chat's stall now that a switch to the fallback is ruled out. A provider retry with nothing queued is the session's own to
 * finish. Otherwise the restart goes at its time on the schedule (transient failures: 30 s, 1, 2 min first; owner turns: 30 s first); before that
 * the feed shows the wait to the owner. `woke`: the scheduler just woke from a sleep, and a transient stall restarts now.
 */
export function stallAction(input: { stall: Stall; down: boolean; claude: ClaudeState | null; attempts: number; since: number; now: number; woke?: boolean }):
  { kind: "restart"; message: string; abort: boolean } | { kind: "wait"; wait: ChatWait | null } | { kind: "none" } {
  const { stall, attempts, since, now } = input;
  const transient = !stall.aborted && failureCause(stall.error) === "transient";
  const restart = { kind: "restart" as const, message: revivalMessage(stall.error, stall.owner), abort: stall.retrying };
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

/** The chat's model before the server moved it to the fallback, and the fallback it moved to. */
export interface FallbackEntry { original: ModelRef & { thinkingLevel: ThinkingLevel | null }; fallback: ModelRef; at: number }
export interface FallbackRecord {
  get(id: string): Promise<FallbackEntry | undefined>;
  set(id: string, entry: FallbackEntry): Promise<void>;
  forget(id: string): Promise<void>;
  ids(): Promise<string[]>;
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isRef = (value: unknown): value is ModelRef => isRecord(value) && typeof value.provider === "string" && typeof value.id === "string";
/** `<data dir>/chat-fallbacks.json`: `{ chats: { [sessionId]: FallbackEntry } }` through locked-json. */
export function fallbackRecord(path: string): FallbackRecord {
  const file: JsonFile<{ chats: Record<string, FallbackEntry> }> = { path, label: "Chat fallback record", initial: () => ({ chats: {} }), parse(value: unknown) {
    const chats = isRecord(value) && isRecord(value.chats) ? value.chats : {};
    return { chats: Object.fromEntries(Object.entries(chats).filter((entry): entry is [string, FallbackEntry] => {
      const item = entry[1];
      return isRecord(item) && isRef(item.original) && isRef(item.fallback) && typeof item.at === "number";
    })) };
  } };
  return {
    async get(id) { return (await snapshotJsonFile(file)).chats[id]; },
    async set(id, entry) { await transactJsonFile(file, state => { state.chats[id] = entry; }); },
    async forget(id) { await transactJsonFile(file, state => { delete state.chats[id]; }); },
    async ids() { return Object.keys((await snapshotJsonFile(file)).chats); },
  };
}

/**
 * Between turns, a chat the server moved to the fallback goes back once Claude serves again. A chat whose model is no longer the fallback was
 * changed by the owner: the record is dropped and the model stays.
 */
export function switchBack(entry: FallbackEntry, current: ModelRef | null, busy: boolean, claude: ClaudeState | null): "back" | "forget" | "keep" {
  if (!current || current.provider !== entry.fallback.provider || current.id !== entry.fallback.id) return "forget";
  return !busy && claude?.serves === true ? "back" : "keep";
}

export const switchedNotice = (name: string): string => `Claude has no free account; switched to ${name}. I switch back when one frees up.`;
export const switchedBackNotice = (name: string): string => `A Claude account is free again; switched back to ${name}.`;
