/**
 * Prime's message limits, kept as soft caps under owner rule c98: a send over a cap goes through and its receipt names the overrun.
 * None of them guards data integrity, security, money, an outside send or a vendor limit, so none stays hard.
 */

import { state } from "./state.ts";

export const MAX_MESSAGE_CHARS = 16_384;
export const MAX_PENDING = 20;
export const RATE_CAPACITY = 3;
export const RATE_REFILL_MS = 1000;

/** Prime's token bucket per sender and target pair: 3 sends, refilled one per second. Returns the wait in ms when the bucket is empty. */
export function consumeRate(key: string, now = Date.now()): number | undefined {
  const buckets = state().buckets;
  const bucket = buckets.get(key) ?? { tokens: RATE_CAPACITY, updatedAt: now };
  const refills = Math.floor(Math.max(0, now - bucket.updatedAt) / RATE_REFILL_MS);
  if (refills > 0) {
    bucket.tokens = Math.min(RATE_CAPACITY, bucket.tokens + refills);
    bucket.updatedAt += refills * RATE_REFILL_MS;
  }
  buckets.set(key, bucket);
  if (bucket.tokens <= 0) return Math.max(1, bucket.updatedAt + RATE_REFILL_MS - now);
  bucket.tokens -= 1;
  return undefined;
}

export function overLimits(input: { chars: number; pending: number; rateKey: string }): string[] {
  const over: string[] = [];
  if (input.chars > MAX_MESSAGE_CHARS) over.push(`message is ${input.chars} chars, the target is ${MAX_MESSAGE_CHARS}`);
  if (input.pending >= MAX_PENDING) over.push(`target has ${input.pending} unfinished messages, the target is ${MAX_PENDING}`);
  const wait = consumeRate(input.rateKey);
  if (wait !== undefined) over.push(`sender is over ${RATE_CAPACITY} messages a second to this target, next token in ${wait}ms`);
  return over;
}
