/**
 * Remind me, as Slack has it on a message: the preset times the message menu offers, and the labels a Later row shows for its reminder.
 * Times are the browser's local time, which is the owner's (KST on his Mac), so Tomorrow is 9:00 AM where he is.
 */

import type { MenuEntry, MenuSubmenu } from "./ui/menu.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Tomorrow and Next week land at 9:00 AM, Slack's own preset hour. */
const MORNING = 9;

export type RemindPreset = { id: "20m" | "1h" | "3h" | "tomorrow" | "next-week"; label: string; at: number };

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const WEEKDAY_TIME = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
const DATE_TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function morningAfter(now: number, days: number): number {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(MORNING, 0, 0, 0);
  return d.getTime();
}

/** The next Monday after today at 9:00 AM; on a Monday that is a week away, as in Slack. */
export function nextMonday(now: number): number {
  const day = new Date(now).getDay();
  return morningAfter(now, ((8 - day) % 7) || 7);
}

/** The menu's presets in Slack's order, each with the time it lands on. */
export function remindPresets(now = Date.now()): RemindPreset[] {
  return [
    { id: "20m", label: "In 20 minutes", at: now + 20 * MINUTE },
    { id: "1h", label: "In 1 hour", at: now + HOUR },
    { id: "3h", label: "In 3 hours", at: now + 3 * HOUR },
    { id: "tomorrow", label: "Tomorrow", at: morningAfter(now, 1) },
    { id: "next-week", label: "Next week", at: nextMonday(now) },
  ];
}

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** When a reminder fires, in the fewest words: "3:40 PM" today, "Tomorrow at 9:00 AM", "Mon 9:00 AM" within a week, then "Dec 2, 9:00 AM". */
export function whenLabel(at: number, now = Date.now()): string {
  if (sameDay(at, now)) return TIME.format(at);
  if (sameDay(at, morningAfter(now, 1))) return `Tomorrow at ${TIME.format(at)}`;
  if (at > now && at - now < 6 * 24 * HOUR) return WEEKDAY_TIME.format(at);
  return DATE_TIME.format(at);
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "long" });
const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** A time as the end of a sentence: "at 3:40 PM", "tomorrow at 9:00 AM", "on Monday at 9:00 AM", "on Dec 2 at 9:00 AM". */
function whenPhrase(at: number, now: number): string {
  const when = sameDay(at, now) ? "" : sameDay(at, morningAfter(now, 1)) ? "tomorrow " : at > now && at - now < 6 * 24 * HOUR ? `on ${WEEKDAY.format(at)} ` : `on ${DATE.format(at)} `;
  return `${when}at ${TIME.format(at)}`;
}

/**
 * The toast after a pick: "We'll remind you at 3:40 PM", "… tomorrow at 9:00 AM", "… on Monday at 9:00 AM", "… on Dec 2 at 9:00 AM".
 * On a post kept unread the time is when it comes back unread (server/keep-unread.ts), which is no reminder he set.
 */
export function remindedText(at: number, now = Date.now(), kept = false): string {
  return kept ? `It comes back unread ${whenPhrase(at, now)}` : `We'll remind you ${whenPhrase(at, now)}`;
}

/**
 * A Later row's reminder line: "Due 3:40 PM" before the time, "Overdue" once it passed, as Slack's Later list words it. A post kept unread
 * has no due time of his; its line says when it comes back unread, and "Still unread" once it did.
 */
export function dueLabel(at: number, now = Date.now(), kept = false): { text: string; due: boolean } {
  if (kept) return at <= now ? { text: `Still unread · ${whenLabel(at, now)}`, due: true } : { text: `Comes back unread ${whenPhrase(at, now)}`, due: false };
  return at <= now ? { text: `Overdue · ${whenLabel(at, now)}`, due: true } : { text: `Due ${whenLabel(at, now)}`, due: false };
}

/** The `<input type="date">` and `<input type="time">` values of a time, in local time. */
export function pickerValues(at: number): { date: string; time: string } {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

/** The time a date and a time field name, in local time, or null when either is empty or not a real time. */
export function fromPicker(date: string, time: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const at = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2])).getTime();
  return Number.isFinite(at) ? at : null;
}

/**
 * The Remind me submenu of a message or a Later row: the presets, Custom…, and, when a reminder is set, its time and Remove reminder.
 * `label` is "Remind me about this" on a message and "Remind me" on a Later row, as Slack words them. On a post kept unread (`kept`) the
 * time is its morning return, so the menu names that, a pick moves it and the last item stops it.
 */
export function remindMenu(opts: {
  label?: string;
  remindAt?: number;
  kept?: boolean;
  set: (at: number) => void;
  custom: () => void;
  clear: () => void;
  now?: number;
}): MenuSubmenu {
  const now = opts.now ?? Date.now();
  const set = opts.remindAt !== undefined;
  const kept = !!opts.kept && set;
  return {
    type: "submenu",
    id: "remind",
    label: kept ? "Change when it comes back" : opts.label ?? "Remind me about this",
    icon: "clock",
    items: [
      ...(set ? [{ type: "label", label: dueLabel(opts.remindAt!, now, kept).text } satisfies MenuEntry] : []),
      ...remindPresets(now).map((p): MenuEntry => ({ id: `remind-${p.id}`, label: p.label, onselect: () => opts.set(p.at) })),
      { type: "separator" },
      { id: "remind-custom", label: "Custom…", onselect: opts.custom },
      ...(set ? [{ id: "remind-clear", label: kept ? "Don't bring it back" : "Remove reminder", tone: "danger", onselect: opts.clear } satisfies MenuEntry] : []),
    ],
  };
}

/** True when the row's reminder time has come and the row is still open: Slack's Overdue, which the Later badge counts. */
export function isOverdue(row: { state: string; remindAt?: number }, now = Date.now()): boolean {
  return row.state === "open" && row.remindAt !== undefined && row.remindAt <= now;
}

/** In progress with its overdue rows on top, the oldest reminder first, and the rest in the order they came. */
export function dueFirst<T extends { state: string; remindAt?: number }>(rows: readonly T[], now = Date.now()): T[] {
  const due = rows.filter(r => isOverdue(r, now)).sort((a, b) => a.remindAt! - b.remindAt!);
  return [...due, ...rows.filter(r => !isOverdue(r, now))];
}

const LONG_DATE = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });

/** The Custom picker's line under its fields, with the day in words: "Today at 2:44 PM", "Tomorrow at 9:00 AM", "Mon, Nov 23 at 9:00 AM". */
export function pickedLabel(at: number, now = Date.now()): string {
  const day = sameDay(at, now) ? "Today" : sameDay(at, morningAfter(now, 1)) ? "Tomorrow" : LONG_DATE.format(at);
  return `${day} at ${TIME.format(at)}`;
}
