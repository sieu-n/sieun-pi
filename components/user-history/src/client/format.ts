const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function toMs(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function relativeTime(value: string | number | undefined, now = Date.now()): string {
  const ms = toMs(value);
  if (ms === null) return "";
  const delta = Math.max(0, now - ms);
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return Math.floor(delta / MINUTE) + "m";
  if (delta < DAY) return Math.floor(delta / HOUR) + "h";
  if (delta < 7 * DAY) return Math.floor(delta / DAY) + "d";
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

export function duration(ms: number): string {
  if (ms < 950) return Math.max(1, Math.round(ms / 100)) / 10 + "s";
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return total + "s";
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function bytes(size: number): string {
  if (size < 1024) return size + " B";
  if (size < 1024 * 1024) return (size / 1024).toFixed(size < 10 * 1024 ? 1 : 0) + " KB";
  return (size / (1024 * 1024)).toFixed(1) + " MB";
}

export function compactNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return (value / 1000).toFixed(value < 10_000 ? 1 : 0) + "k";
  return (value / 1_000_000).toFixed(1) + "M";
}

export type DateGroup = "Today" | "Yesterday" | "Previous 7 days" | "Older";
const GROUPS: readonly { label: DateGroup; withinDays: number }[] = [
  { label: "Today", withinDays: 0 },
  { label: "Yesterday", withinDays: 1 },
  { label: "Previous 7 days", withinDays: 7 },
];

export function dateGroup(value: string | number | undefined, now = Date.now()): DateGroup {
  const ms = toMs(value);
  if (ms === null) return "Older";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const daysAgo = Math.floor((startOfToday.getTime() - ms) / DAY) + 1;
  for (const group of GROUPS) if (daysAgo <= group.withinDays) return group.label;
  return "Older";
}

export function clockTime(value: number): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function shortPath(cwd: string): string {
  const home = cwd.replace(/^\/Users\/[^/]+/, "~");
  const parts = home.split("/").filter(Boolean);
  return parts.length > 3 ? "…/" + parts.slice(-2).join("/") : home;
}
