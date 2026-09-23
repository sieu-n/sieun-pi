import type { Pulse } from "./types.ts";

/**
 * Freshness of a running session from the native summary the sessions stream already carries. A running model call or tool emits events at
 * least every few seconds (the roster pushed about once a second in a probe), so a minute without activity is worth a dim spinner, and five
 * minutes means the run is stuck: frozen at Waiting, or blocked in a tool call that holds a server open.
 */
export const QUIET_AFTER_MS = 60_000;
export const STALLED_AFTER_MS = 5 * 60_000;
export type PulseLevel = "live" | "quiet" | "stalled" | "failed";

/** The daemon summary line of a model loop that keeps failing: a failed request, a usage or rate limit, a retry. */
const FAILURE = /model request failed|request failed|usage limit|rate limit|try again in|retrying|overloaded/i;

const MINUTE = 60_000;
export function span(ms: number): string {
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 1) return Math.max(1, Math.floor(ms / 1000)) + "s";
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return Math.floor(hours / 24) + "d";
}

export interface PulseReading { level: PulseLevel; quietMs: number; text: string }

/**
 * Failed: the worker failed, or the session is streaming while its summary reports a failing model call (a summary on a session that only waits
 * for subagents is often left over from an earlier call, so it does not count). Stalled: the worker went silent, or no activity for five minutes.
 */
export function readPulse(pulse: Pulse, now: number): PulseReading {
  const at = Date.parse(pulse.activityAt ?? "");
  const quietMs = Number.isFinite(at) ? Math.max(0, now - at) : 0;
  const summary = pulse.summary?.trim() ?? "";
  if (pulse.failed) return { level: "failed", quietMs, text: summary || "The worker failed" };
  if (pulse.streaming && FAILURE.test(summary)) return { level: "failed", quietMs, text: summary };
  const silent = Date.parse(pulse.silentSince ?? "");
  if (Number.isFinite(silent)) return { level: "stalled", quietMs, text: "worker silent " + span(Math.max(0, now - silent)) };
  if (quietMs >= STALLED_AFTER_MS) return { level: "stalled", quietMs, text: "no activity " + span(quietMs) };
  if (quietMs >= QUIET_AFTER_MS) return { level: "quiet", quietMs, text: "quiet " + span(quietMs) };
  return { level: "live", quietMs, text: "" };
}
