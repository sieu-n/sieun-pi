import type { TokenRate } from "../shared/types.ts";

/** Calls in the last minute make a live rate; with none, the rate is the average over every call. */
export const LIVE_WINDOW_MS = 60_000;
/** Less generation time than this makes no rate: a few tokens over a few milliseconds is no speed. */
export const MIN_RATE_MS = 5_000;

/** One model call of a session as the usage store keeps it: when it started and ended, and its output tokens (reasoning included). */
export interface SessionCall { sessionId: string; startedAt: number | null; endedAt: number; output: number }

/**
 * Output tokens per second per session, output over generation time: live from the calls that ended within LIVE_WINDOW_MS, else the average over
 * every call given. A call with no `startedAt` has no duration and counts for nothing; a session with less than MIN_RATE_MS measured gets no entry.
 */
export function sessionRates(calls: readonly SessionCall[], now: number): Record<string, TokenRate> {
  const bySession = new Map<string, SessionCall[]>();
  for (const call of calls) {
    if (call.startedAt === null || call.endedAt <= call.startedAt) continue;
    const list = bySession.get(call.sessionId) ?? [];
    list.push(call);
    bySession.set(call.sessionId, list);
  }
  const rates: Record<string, TokenRate> = {};
  for (const [sessionId, list] of bySession) {
    const live = list.filter(call => now - call.endedAt <= LIVE_WINDOW_MS);
    const measured = live.length ? live : list;
    const ms = measured.reduce((sum, call) => sum + (call.endedAt - call.startedAt!), 0);
    if (ms < MIN_RATE_MS) continue;
    const output = measured.reduce((sum, call) => sum + call.output, 0);
    rates[sessionId] = { tps: Math.round(output / ms * 10_000) / 10, live: live.length > 0 };
  }
  return rates;
}
