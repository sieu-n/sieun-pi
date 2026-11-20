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

/** The toast after a pick: "We'll remind you at 3:40 PM", "… tomorrow at 9:00 AM", "… on Monday at 9:00 AM", "… on Dec 2 at 9:00 AM". */
export function remindedText(at: number, now = Date.now()): string {
  const when = sameDay(at, now) ? "" : sameDay(at, morningAfter(now, 1)) ? "tomorrow " : at - now < 6 * 24 * HOUR ? `on ${WEEKDAY.format(at)} ` : `on ${DATE.format(at)} `;
  return `We'll remind you ${when}at ${TIME.format(at)}`;
}

/** A Later row's reminder line: "Due 3:40 PM" before the time, "Overdue" once it passed, as Slack's Later list words it. */
export function dueLabel(at: number, now = Date.now()): { text: string; due: boolean } {
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
 * `label` is "Remind me about this" on a message and "Remind me" on a Later row, as Slack words them.
 */
export function remindMenu(opts: {
  label?: string;
  remindAt?: number;
  set: (at: number) => void;
  custom: () => void;
  clear: () => void;
  now?: number;
}): MenuSubmenu {
  const now = opts.now ?? Date.now();
  const set: MenuEntry[] = opts.remindAt !== undefined
    ? [{ type: "label", label: dueLabel(opts.remindAt, now).text }, { id: "remind-clear", label: "Remove reminder", icon: "close", onselect: opts.clear }, { type: "separator" }]
    : [];
  return {
    type: "submenu",
    id: "remind",
    label: opts.label ?? "Remind me about this",
    icon: "clock",
    items: [
      ...set,
      ...remindPresets(now).map((p): MenuEntry => ({ id: `remind-${p.id}`, label: p.label, onselect: () => opts.set(p.at) })),
      { type: "separator" },
      { id: "remind-custom", label: "Custom…", onselect: opts.custom },
    ],
  };
}
