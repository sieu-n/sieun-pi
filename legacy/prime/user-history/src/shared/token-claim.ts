/*
 * A text that counts tokens or prices model calls with no cache split (c157). The owner, 10-22, after a chat told him "99.7% of recorded
 * tokens are input; ... The proposal replaces full history with current task state": "check what a Cached read is." On 10-27 a chat's own
 * sketch priced every input token of a classification run as fresh, and he wrote "note that system prompt (instruction) should be registered
 * as Cache read". tell_owner refuses such a text once and the board flags such a todo or step note; both let it through when sent again (c98).
 */

/** Any word for the prompt cache: a cache read, write or hit, cached input, uncached input. */
const CACHE = /cach(?:e|ed|ing)\b|cache[- ]?(?:reads?|writes?|hits?)|\buncached\b|캐시/iu;
const PERCENT = String.raw`\d+(?:\.\d+)?\s?(?:%|percent\b|퍼센트)`;
/** A share of tokens put on input or the prompt as one bucket: "99.7% of recorded tokens are input", "99.704 percent prompt". */
const INPUT_SHARE = new RegExp(String.raw`${PERCENT}[^.\n]{0,40}?\b(?:input|prompts?|입력)|\b(?:input|prompts?|입력)\b[^.\n]{0,40}?${PERCENT}`, "iu");
const TOKENS = /\btokens?\b|토큰/iu;
/** A cached volume called waste: "the cache reads are waste", "cached history is wasted". */
const CACHED_WASTE = /(?:cache[- ]?reads?|cached\s+(?:reads?|tokens?|input|history|context|prefix|volume))[^.\n]{0,60}?\b(?:waste[ds]?|wasteful|bloat(?:ed)?)\b|\b(?:waste[ds]?|wasteful|bloat(?:ed)?)\b[^.\n]{0,60}?(?:cache[- ]?reads?|cached\s+(?:reads?|tokens?|input|history|context|prefix|volume))/iu;
const DENIES = /\b(?:not|never|no|isn't|aren't|nor)\b|아니/iu;
/** A dollar figure and a per-token rate or a token count: what an estimate of model calls says. */
const DOLLARS = /\$\s?\d/u;
const TOKEN_RATE = /\/\s?1?M\b|\bper\s+(?:1M|1K|M|K|million|thousand)\b|\b(?:input|output)\s+tokens?\b|\btokens?\b|토큰/iu;
/** A measured bill, which is what the vendor charged and no estimate. */
const BILLED = /\b(?:billed|charged|invoiced?)\b/iu;
const MODEL = /\b(?:llms?|model calls?|gpt[- ]?\w*|claude|opus|sonnet|haiku|gemini|deepseek|jev|luna|openrouter|codex)\b/iu;

const sentences = (text: string): string[] => text.split(/(?<=[.!?。])\s+|\n+/u).filter(Boolean);
const clip = (text: string): string => (text.length > 120 ? text.slice(0, 119) + "\u2026" : text).trim();

/**
 * The words of a text that count tokens or price model calls with no cache split, or null: a sentence that puts a share of tokens on input or
 * the prompt and names no cache, a sentence that calls a cached volume waste, or a sentence that prices model calls in dollars from tokens in a
 * text that names no cache anywhere. A Stripe seat price on 10-24 and a measured Jev bill on 10-29 named tokens and a model in other sentences.
 */
export function cacheBlindTokenClaim(text: string): string | null {
  for (const sentence of sentences(text)) {
    if (CACHE.test(sentence)) {
      const waste = CACHED_WASTE.exec(sentence);
      if (waste && !DENIES.test(sentence)) return clip(waste[0]);
      continue;
    }
    const share = INPUT_SHARE.exec(sentence);
    if (share && TOKENS.test(sentence)) return clip(share[0]);
  }
  if (CACHE.test(text)) return null;
  const estimate = sentences(text).find(sentence => DOLLARS.test(sentence) && TOKEN_RATE.test(sentence) && MODEL.test(sentence) && !BILLED.test(sentence));
  return estimate ? clip(estimate) : null;
}

export const CACHE_SPLIT_FIX = "Keep cache reads apart from fresh input, cache writes and output, each with its own count and price (c157). " +
  "Price the shared system prompt and instructions at each model's cache-read rate and fresh input only for each item's own text and images, " +
  "and never call a large cached volume waste or use a raw-token share to argue for shorter warm history; judge a cut by net cache-aware cost " +
  "and measured useful work";
