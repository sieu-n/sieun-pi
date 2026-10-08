import type { TokenRate } from "../shared/types.ts";

/** Calls in the last minute make a live rate; older ones only the last turn's. */
export const LIVE_WINDOW_MS = 60_000;

/** One model call of a session as the usage store keeps it: when it started and ended, and its output tokens (reasoning included). */
export interface SessionCall { sessionId: string; startedAt: number | null; endedAt: number; output: number }

/**
 * Output tokens per second per session: live when a call ended within LIVE_WINDOW_MS (the window's output over its generation time), else the
 * last call's rate. A call with no `startedAt` has no duration and counts for nothing; a session with no measurable call gets no entry.
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
    list.sort((left, right) => left.endedAt - right.endedAt);
    const live = list.filter(call => now - call.endedAt <= LIVE_WINDOW_MS);
    const measured = live.length ? live : [list.at(-1)!];
    const seconds = measured.reduce((sum, call) => sum + (call.endedAt - call.startedAt!), 0) / 1000;
    const output = measured.reduce((sum, call) => sum + call.output, 0);
    rates[sessionId] = { tps: Math.round(output / seconds * 10) / 10, live: live.length > 0 };
  }
  return rates;
}
