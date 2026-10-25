import { clockTime } from "./checkin-settings.ts";
import { poolSlot } from "./shared/chat-feed.ts";

/** Each kind of failed model call, by the first pattern its error text matches, and whether it is transient (`transientTurnError`). */
const KINDS: readonly (readonly [RegExp, (status: string | undefined) => string, boolean])[] = [
  [/from shell command: \S*pi-pool-token|token hook gave no token/i, () => "no account token from pi-pool", true],
  [/usage limit/i, () => "usage limit", true],
  [/rate.?limit|\b429\b/i, () => "rate limit 429", true],
  [/overloaded|\b529\b/i, () => "provider overloaded 529", true],
  [/\b50[0234]\b|internal server error/i, status => `provider server error${status ? ` ${status}` : ""}`, true],
  [/connection error|fetch failed|econnreset|econnrefused|enotfound|etimedout|eai_again|socket hang up|network|other side closed|timed? ?out|websocket closed/i,
    () => "connection error", true],
  [/\b401\b|\b403\b|authentication|unauthori[sz]ed|invalid.*api key/i, status => `sign-in refused${status ? ` ${status}` : ""}`, false],
  [/\b400\b|invalid_request/i, () => "request refused 400", false],
];
/** Prime's credential wait marker: 'API key for provider "anthropic" is temporarily unavailable until <time>: waiting for an account slot'. */
const CREDENTIAL_WAIT = /waiting for an account slot|\bpi-pool:/i;

/**
 * Whether a failed model call's error goes away on its own: pi-pool's token hook or wait, a limit, an overloaded or failing provider, or a lost
 * connection. A refusal, a sign-in refusal, a 400 or an error of no known kind is not. On 10-25 from about 21:43Z to 21:58Z us-metal02 had no
 * outside DNS or TCP, and its duty jobs ended on "the token hook gave no token" and "Request timed out." until it came back.
 */
export function transientTurnError(error: string): boolean {
  const text = error.replace(/\s+/g, " ");
  return CREDENTIAL_WAIT.test(text) || poolSlot(text) !== null || (KINDS.find(([pattern]) => pattern.test(text))?.[2] ?? false);
}
/** pi-pool's note on a limited account: "pi-pool: claude18@slack.green is limited until 2026-10-19T21:10:00.000Z". */
const LIMITED = /pi-pool: (\S+?)@\S+ is limited until (\d{4}-\d\d-\d\dT[\d:.]+Z)/;

/**
 * A failed model turn's error message as a few plain words a parent can act on: the kind with its status, the pool account and its limit, and
 * when the turn retries (pi-pool's slot). Request ids, tokens and the provider's prose are dropped; an error of no known kind keeps only its first
 * sentence, with ids and key-like strings removed. On 10-19 five chat-057a jobs ended at 18:00Z to 18:40Z on a 429 whose first 120 characters,
 * all the [job] notice and the agents panel showed, held no account and no retry time.
 */
export function turnErrorCause(error: string | undefined): string {
  const text = (error ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "the model returned an error with no message";
  const status = /\b([45]\d\d)\b/.exec(text)?.[1];
  const kind = KINDS.find(([pattern]) => pattern.test(text))?.[1](status) ?? firstSentence(text);
  const limited = LIMITED.exec(text);
  const limit = limited ? `, ${limited[1]} limited until ${clockTime(Date.parse(limited[2]!))}` : "";
  const slot = poolSlot(text);
  return `${kind}${limit}${slot === null ? "" : `, retries at ${clockTime(slot)}`}`;
}

/** The first sentence of an unknown error, at most 120 characters, with request ids and long key-like strings cut out. */
function firstSentence(text: string): string {
  const clean = text.replace(/\[?request[_ ]id:? ?\S+\]?/gi, "").replace(/\b(?:sk|req|msg|key|tok)[-_][A-Za-z0-9_-]{8,}/g, "<id>")
    .replace(/[A-Za-z0-9_-]{32,}/g, "<id>").trim();
  const sentence = /^.*?[.!?](?:\s|$)/.exec(clean)?.[0].trim() ?? clean;
  return sentence.length > 120 ? `${sentence.slice(0, 119)}…` : sentence;
}
