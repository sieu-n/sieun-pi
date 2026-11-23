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
  return `${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear(at, now) ? {} : { year: "numeric" }) })} ${time}`;
}

const sameYear = (left: number, right: number): boolean => new Date(left).getFullYear() === new Date(right).getFullYear();

/** A schedule as the duty dialog picks it; `auto` leaves a new duty's daily time to the server's morning band. */
export type ScheduleDraft = { kind: "daily"; at: string } | { kind: "every"; minutes: number } | { kind: "auto" };

/** "Daily at 06:53" or "Every 30 min". */
export const scheduleLabel = (schedule: { kind: "daily"; at: string } | { kind: "every"; minutes: number }): string =>
  schedule.kind === "daily" ? `Daily at ${schedule.at}` : `Every ${schedule.minutes} min`;

/** The schedule in the words of the owner's ask to his agent: "daily at 07:00", "every 30 minutes" or "every morning, at a time you pick". */
export function scheduleWords(draft: ScheduleDraft): string {
  if (draft.kind === "daily") return `daily at ${draft.at}`;
  if (draft.kind === "every") return `every ${draft.minutes} ${draft.minutes === 1 ? "minute" : "minutes"}`;
  return "every morning, at a time you pick";
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

/** The units the check-in's Custom interval dialog takes. */
export const INTERVAL_UNITS = { minutes: MINUTE, hours: 60 * MINUTE, days: DAY } as const;
export type IntervalUnit = keyof typeof INTERVAL_UNITS;

/** An interval as the Custom dialog shows it: the largest unit that divides it whole, so 90 min stays minutes and 48 h reads 2 days. */
export function intervalParts(everyMs: number): { amount: number; unit: IntervalUnit } {
  const minutes = Math.max(1, Math.round(everyMs / MINUTE));
  if (minutes % (24 * 60) === 0) return { amount: minutes / (24 * 60), unit: "days" };
  if (minutes % 60 === 0) return { amount: minutes / 60, unit: "hours" };
  return { amount: minutes, unit: "minutes" };
}

export interface CheckInState {
  everyMs: number;
  planEveryMs?: number;
  paused: boolean;
  pausedUntil: number | "forever" | null;
  nextAt: number | null;
}

/** The intervals the check-in menu offers: today's presets, plus the chat's own interval when it is not one of them. */
export function checkInChoices(presets: readonly number[], everyMs: number): number[] {
  const all = new Set([...presets.map(minutes => minutes * MINUTE), 120 * MINUTE, DAY, everyMs]);
  return [...all].sort((left, right) => left - right);
}

/** "5m", "2h", "daily" or "3d". */
export function everyLabel(everyMs: number): string {
  const minutes = Math.round(everyMs / MINUTE);
  if (minutes === 24 * 60) return "daily";
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

export const pauseNow = (state: CheckInState, now: number): number | "forever" | null =>
  state.pausedUntil === "forever" || (state.pausedUntil !== null && state.pausedUntil > now) ? state.pausedUntil : null;

/**
 * The check-in line: "Check-in every 2 hours, one check-in job each", or its pause. `on` is false while paused and while none is set, as a
 * test agent has none until one is picked (boards.ts checkInState), which the server sends as no pause and no next time.
 */
export function checkInStatus(state: CheckInState | null, now: number): { text: string; on: boolean } {
  if (!state) return { text: "Check-in every 2 hours, one check-in job each", on: true };
  const pause = pauseNow(state, now);
  if (pause === null && state.nextAt === null) return { text: "No check-in set yet", on: false };
  if (pause === null) {
    const every = state.planEveryMs !== undefined
      ? `daily while the plan has no open step, then ${everyWords(state.planEveryMs)}`
      : everyWords(state.everyMs);
    return { text: `Check-in ${every}, one check-in job each`, on: true };
  }
  return { text: pause === "forever" ? "Check-in paused until you resume it" : `Check-in paused until ${whenLabel(pause, now)}`, on: false };
}

/** "every 90 min", "every 6 hours", "daily" or "every 3 days". */
function everyWords(everyMs: number): string {
  const { amount, unit } = intervalParts(everyMs);
  if (unit === "minutes") return `every ${amount} min`;
  if (unit === "hours") return amount === 1 ? "every hour" : `every ${amount} hours`;
  return amount === 1 ? "daily" : `every ${amount} days`;
}

/** The control's short value: "Check-in 2h", "Set check-in", "Paused" or "Paused 45m". */
export function checkInButton(state: CheckInState, now: number): string {
  const pause = pauseNow(state, now);
  if (pause === null && state.nextAt === null) return "Set check-in";
  if (pause === null) return `Check-in ${everyLabel(state.everyMs)}`;
  if (pause === "forever") return "Paused";
  const minutes = Math.max(1, Math.ceil((pause - now) / MINUTE));
  if (minutes >= 7 * 24 * 60) return `Paused until ${new Date(pause).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear(pause, now) ? {} : { year: "numeric" }) })}`;
  return `Paused ${minutes < 60 ? `${minutes}m` : minutes < 24 * 60 ? `${Math.ceil(minutes / 60)}h` : `${Math.ceil(minutes / (24 * 60))}d`}`;
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
