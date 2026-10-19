import { clockTime } from "./checkin-settings.ts";
import { poolSlot } from "./shared/chat-feed.ts";

/** Each kind of failed model call, by the first pattern its error text matches. */
const KINDS: readonly (readonly [RegExp, (status: string | undefined) => string])[] = [
  [/from shell command: \S*pi-pool-token|token hook gave no token/i, () => "no account token from pi-pool"],
  [/usage limit/i, () => "usage limit"],
  [/rate.?limit|\b429\b/i, () => "rate limit 429"],
  [/overloaded|\b529\b/i, () => "provider overloaded 529"],
  [/\b50[0234]\b|internal server error/i, status => `provider server error${status ? ` ${status}` : ""}`],
  [/connection error|fetch failed|econnreset|econnrefused|enotfound|etimedout|eai_again|socket hang up|network|other side closed|timed? ?out|websocket closed/i,
    () => "connection error"],
  [/\b401\b|\b403\b|authentication|unauthori[sz]ed|invalid.*api key/i, status => `sign-in refused${status ? ` ${status}` : ""}`],
  [/\b400\b|invalid_request/i, () => "request refused 400"],
];
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
