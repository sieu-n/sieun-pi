import { get, post } from "./api.ts";
import { clockTime } from "./format.ts";
import type { CheckInPause, CheckInState, CheckInView } from "../shared/types.ts";

const MINUTE = 60_000;
const route = (id: string) => "api/threads/" + encodeURIComponent(id) + "/check-in";

export const checkInApi = {
  view: (id: string) => get<CheckInView>(route(id)),
  set: (id: string, change: { everyMs?: number; pause?: CheckInPause | null }) => post<CheckInView>(route(id), change),
};

/** "5m", "1h", "90m". */
export function everyLabel(everyMs: number): string {
  const minutes = Math.round(everyMs / MINUTE);
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/** Time left until `at`, rounded up: "45m", "2h". */
function left(at: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((at - now) / MINUTE));
  return minutes < 60 ? `${minutes}m` : `${Math.ceil(minutes / 60)}h`;
}

/** The pause in force at `now`: one whose end has passed reads as none, so the label does not wait for the next sessions frame. */
export const pauseNow = (state: CheckInState, now: number): number | "forever" | null =>
  state.pausedUntil === "forever" || (state.pausedUntil !== null && state.pausedUntil > now) ? state.pausedUntil : null;

/** The header button: "Check-in 5m", "Paused", "Paused 45m". `word` is the part a narrow header drops. */
export function checkInButton(state: CheckInState, now: number): { word: string; value: string } {
  const pause = pauseNow(state, now);
  if (pause === null) return { word: "Check-in ", value: everyLabel(state.everyMs) };
  return pause === "forever" ? { word: "", value: "Paused" } : { word: "", value: `Paused ${left(pause, now)}` };
}

/** The board panel line, the same facts in a sentence; `on` is false while paused. Without a state (an older server) it is the default. */
export function checkInStatus(state: CheckInState | undefined, now: number): { text: string; on: boolean } {
  if (!state) return { text: "Check-in every 15 min, on changes only", on: true };
  const pause = pauseNow(state, now);
  if (pause === null) return { text: `Check-in every ${Math.round(state.everyMs / MINUTE)} min, on changes only`, on: true };
  return { text: pause === "forever" ? "Check-in paused until you resume it" : `Check-in paused until ${clockTime(pause)}`, on: false };
}

/** The next 09:00 local, what "until tomorrow" means on the server. */
export function nextNine(now: number): number {
  const nine = new Date(now);
  nine.setHours(9, 0, 0, 0);
  if (nine.getTime() <= now) nine.setDate(nine.getDate() + 1);
  return nine.getTime();
}

/** What the control shows before the server answers a change. */
export function previewCheckIn(state: CheckInState, change: { everyMs?: number; pause?: CheckInPause | null }, now: number): CheckInState {
  const everyMs = change.everyMs ?? state.everyMs;
  const lastAt = (state.nextAt ?? now) - state.everyMs;
  const pausedUntil = change.pause === undefined ? pauseNow(state, now) : change.pause === null ? null
    : change.pause === "forever" ? "forever" : change.pause === "1h" ? now + 60 * MINUTE : nextNine(now);
  const nextAt = pausedUntil === "forever" ? null : Math.max(now, lastAt + everyMs, pausedUntil ?? 0);
  return { everyMs, paused: pausedUntil !== null, pausedUntil, nextAt };
}
