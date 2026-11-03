const DAY = 86_400_000;

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** One formatter each, made once: toLocaleDateString and toLocaleTimeString build a new formatter on every call, which a timeline pays per row. */
const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "long" });
const WEEKDAY_DATE = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" });
const DATE_YEAR = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" });
const SHORT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/** "Today", "Yesterday", a weekday for 2 to 6 days back, "Saturday, June 20" this year, "June 20, 2025" before. */
export function dayLabel(t: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(t);
  if (days > 1 && days < 7) return WEEKDAY.format(d);
  if (d.getFullYear() === new Date(now).getFullYear()) return WEEKDAY_DATE.format(d);
  return DATE_YEAR.format(d);
}

/** "9:41 PM". */
export function timeLabel(t: number): string {
  return TIME.format(t);
}

/** "9:41", for the hover gutter of a follow-up post, as Slack draws it. */
export function clockLabel(t: number): string {
  return timeLabel(t).replace(/\s?[AP]M$/, "");
}

/** "Yesterday at 8:10 PM" or "9:41 PM" for today. */
export function stampLabel(t: number, now = Date.now()): string {
  const day = dayLabel(t, now);
  return day === "Today" ? timeLabel(t) : `${day} at ${timeLabel(t)}`;
}

/** "now", "5m", "3h", "2d", then a short date. */
export function ageLabel(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < DAY / 1000) return `${Math.round(s / 3600)}h`;
  if (s < 7 * DAY / 1000) return `${Math.round(s / 86400)}d`;
  return SHORT_DATE.format(t);
}

/** Milliseconds until the next local midnight, so day labels can refresh then. */
export function msUntilMidnight(now = Date.now()): number {
  return startOfDay(now) + DAY - now;
}
