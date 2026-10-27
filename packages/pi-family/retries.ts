/**
 * Retries the pool takes on itself. A 429 or an account refusal that pi-pool records moves the run to the pool's next account or
 * to the session's slot wait, so it is the pool's routing and no failure of the run. Pi counts every retry against
 * `retry.maxRetries` (3 by default), so before this a run that met four limited accounts in a row ended with the error. Each
 * pool-handled retry now raises the session's budget by one, and other errors keep Pi's own budget. The count lives on
 * globalThis, because Pi loads each extension through its own loader, and pi-pool counts the retries while pi-host and pi-rlm read them.
 */

const KEY: unique symbol = Symbol.for("sieun-pi.pi-stack.pool.retries");
const g = globalThis as typeof globalThis & { [KEY]?: Map<string, number> };
const counts = (g[KEY] ??= new Map());

/** The pool-handled retries of the session's current run. */
export function poolRetries(sessionId: string): number {
  return counts.get(sessionId) ?? 0;
}

/** One more retry the pool took for this session's run. */
export function countPoolRetry(sessionId: string): void {
  counts.set(sessionId, poolRetries(sessionId) + 1);
}

/** A reply that was no error, or the end of the run: Pi starts its own count again too. */
export function clearPoolRetries(sessionId: string): void {
  counts.delete(sessionId);
}

interface RetrySettingsSource { getRetrySettings(): { maxRetries: number } }

/**
 * Makes `settings` answer Pi's retry budget plus the pool-handled retries of `sessionId`. Pi reads `getRetrySettings()` at each
 * retry, so the budget follows the count. pi-host calls this for each session it opens and pi-rlm for each child.
 */
export function withPoolRetries<T extends RetrySettingsSource>(settings: T, sessionId: string): T {
  const own = settings.getRetrySettings.bind(settings);
  settings.getRetrySettings = (() => {
    const base = own();
    return { ...base, maxRetries: base.maxRetries + poolRetries(sessionId) };
  }) as T["getRetrySettings"];
  return settings;
}
