const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const clockTime = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

/** "23:07", "23:07 yesterday", "23:07 tomorrow" or "Oct 6 23:07", against the local day of `now`. */
export function whenLabel(at: number, now: number): string {
  const day = (ms: number) => {
    const date = new Date(ms);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const days = Math.round((day(now) - day(at)) / DAY);
  const time = clockTime(at);
  if (days === 0) return time;
  if (days === 1) return `${time} yesterday`;
  if (days === -1) return `${time} tomorrow`;
  return `${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

export type Verdict = "met" | "missed" | "error" | "skipped";

/** The owner's words for a verdict (p256): a run short of its numbers is "off target", and "missed" is only a slot that did not run. */
export const VERDICT_WORDS: Record<Verdict, string> = { met: "met", missed: "off target", error: "precheck failed", skipped: "missed" };

export interface DutyLast { verdict: Verdict; at: number; streak: number; afterJob: boolean }

export interface DutyRow {
  id: string;
  name: string;
  paused: boolean;
  running: boolean;
  nextAt: number | null;
  last: DutyLast | null;
  builtin?: "checkin";
}

/** "Running now.", "Paused.", "Due now." or "Next run at 23:07." */
export function nextLabel(duty: Pick<DutyRow, "running" | "nextAt">, now: number): string {
  if (duty.running) return "Running now.";
  if (duty.nextAt === null) return "Paused.";
  return duty.nextAt <= now ? "Due now." : `Next run at ${whenLabel(duty.nextAt, now)}.`;
}

/** "off target 5 runs in a row · 23:07 yesterday", "met after its job · 23:40" or "no run yet". */
export function lastLabel(last: DutyLast | null, now: number): string {
  if (!last) return "no run yet";
  const streak = last.verdict === "missed" && last.streak > 1 ? ` ${last.streak} runs in a row` : "";
  return `${VERDICT_WORDS[last.verdict]}${last.afterJob ? " after its job" : ""}${streak} · ${whenLabel(last.at, now)}`;
}

/** "1 duty" or "2 duties, 1 off target". */
export function dutiesCount(duties: readonly { last: { verdict: string } | null }[]): string {
  if (!duties.length) return "";
  const short = duties.filter(duty => duty.last?.verdict === "missed" || duty.last?.verdict === "error").length;
  return `${duties.length} ${duties.length === 1 ? "duty" : "duties"}${short ? `, ${short} off target` : ""}`;
}

export type CheckInPause = "1h" | "tomorrow" | "forever";

export interface CheckInState {
  everyMs: number;
  planEveryMs?: number;
  paused: boolean;
  pausedUntil: number | "forever" | null;
  nextAt: number | null;
}

/** The intervals the check-in menu offers: today's presets, plus the chat's own interval when it is not one of them. */
export function checkInChoices(presets: readonly number[], everyMs: number): number[] {
  const all = new Set([...presets.map(minutes => minutes * MINUTE), 120 * MINUTE, everyMs]);
  return [...all].sort((left, right) => left - right);
}

/** "5m", "2h" or "daily". */
export function everyLabel(everyMs: number): string {
  const minutes = Math.round(everyMs / MINUTE);
  if (minutes === 24 * 60) return "daily";
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

export const pauseNow = (state: CheckInState, now: number): number | "forever" | null =>
  state.pausedUntil === "forever" || (state.pausedUntil !== null && state.pausedUntil > now) ? state.pausedUntil : null;

/** The check-in line: "Check-in every 120 min, one check-in job each", or its pause. `on` is false while paused. */
export function checkInStatus(state: CheckInState | null, now: number): { text: string; on: boolean } {
  if (!state) return { text: "Check-in every 120 min, one check-in job each", on: true };
  const pause = pauseNow(state, now);
  if (pause === null) {
    const every = state.planEveryMs !== undefined
      ? `daily while the plan has no open step, then every ${Math.round(state.planEveryMs / MINUTE)} min`
      : `every ${Math.round(state.everyMs / MINUTE)} min`;
    return { text: `Check-in ${every}, one check-in job each`, on: true };
  }
  return { text: pause === "forever" ? "Check-in paused until you resume it" : `Check-in paused until ${clockTime(pause)}`, on: false };
}

/** The control's short value: "Check-in 2h", "Paused" or "Paused 45m". */
export function checkInButton(state: CheckInState, now: number): string {
  const pause = pauseNow(state, now);
  if (pause === null) return `Check-in ${everyLabel(state.everyMs)}`;
  if (pause === "forever") return "Paused";
  const minutes = Math.max(1, Math.ceil((pause - now) / MINUTE));
  return `Paused ${minutes < 60 ? `${minutes}m` : `${Math.ceil(minutes / 60)}h`}`;
}

export type When = "overdue" | "today" | "upcoming";
export const WHEN_LABEL: Record<When, string> = { overdue: "Overdue", today: "Today", upcoming: "Upcoming" };

/** Buzz Reminders' groups: past due, due before the end of today, and later. */
export function whenGroup(at: number, now: number): When {
  if (at <= now) return "overdue";
  const end = new Date(now);
  end.setHours(24, 0, 0, 0);
  return at < end.getTime() ? "today" : "upcoming";
}
