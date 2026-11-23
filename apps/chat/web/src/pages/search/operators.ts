/**
 * Slack-style search operators typed in the field. Each completed operator moves out of the text into the filter chips under the field
 * (filters.ts), so typing `from:vent` and picking Vent in the From chip land in the same state.
 */
import type { SearchHas } from "../../lib/api/types.ts";
import type { Filters } from "./filters.ts";

/** `on:` is one day, as `after:` that day and `before:` the next. */
export type DateOperator = { kind: "after" | "before" | "on"; date: string };
/** `during:` is a span, such as a month or this week: `after` its first day and `before` the day after its last. */
export type RangeOperator = { kind: "during"; after: string; before: string };
/** `to:` and `with:` name an agent by its DM's id: `with:` is its DM, `to:` what you wrote there. */
export type NamedOperator = { kind: "from" | "in" | "to" | "with"; id: string };
/** `has:link`, `has:reaction`, `has:pin` and `is:saved` are marks; `is:thread` is the Threads place. */
export type MarkOperator = { kind: "has"; has: SearchHas } | { kind: "is"; is: "thread" };
/** One typed filter, which lands in the one filter state that the chips show (filters.ts). */
export type Operator = DateOperator | RangeOperator | NamedOperator | MarkOperator;
export type OperatorKind = Operator["kind"];

/** The operator token being typed at the end of the text, such as `from:an`. */
export type Prompt = { kind: OperatorKind; needle: string; start: number };

const PROMPT_RE = /(?:^|\s)(from|in|to|with|after|before|on|during|has|is):(\S*)$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function prompt(text: string): Prompt | undefined {
  const match = PROMPT_RE.exec(text);
  if (!match) return undefined;
  const start = match.index + (match[0].length - match[0].trimStart().length);
  return { kind: match[1]!.toLowerCase() as OperatorKind, needle: match[2] ?? "", start };
}

export function isDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

const addOne = <T>(list: readonly T[], one: T): readonly T[] => (list.includes(one) ? list : [...list, one]);

/**
 * Applies a typed operator: `from:` and `has:` add to the ones already picked, `to:` adds you as the author, and `in:`, `with:`, the
 * dates and `is:thread` replace their value.
 */
export function withOperator(filters: Filters, operator: Operator): Filters {
  switch (operator.kind) {
    case "from":
      return { ...filters, from: addOne(filters.from, operator.id) };
    case "in":
    case "with":
      return { ...filters, in: operator.id };
    case "to":
      return { ...filters, in: operator.id, from: addOne(filters.from, "owner") };
    case "after":
    case "before":
      return { ...filters, [operator.kind]: operator.date };
    case "on":
      return { ...filters, after: operator.date, before: nextDay(operator.date) };
    case "during":
      return { ...filters, after: operator.after, before: operator.before };
    case "has":
      return { ...filters, has: (["link", "reaction", "pin", "saved"] as const).filter(one => one === operator.has || filters.has.includes(one)) };
    case "is":
      return { ...filters, place: ["threads"] };
  }
}

/** The values `has:` and `is:` read, plural forms included; `is:thread` is a place and the rest are marks. */
const MARK_WORDS: Readonly<Record<string, MarkOperator>> = {
  "has:link": { kind: "has", has: "link" }, "has:links": { kind: "has", has: "link" },
  "has:reaction": { kind: "has", has: "reaction" }, "has:reactions": { kind: "has", has: "reaction" },
  "has:pin": { kind: "has", has: "pin" }, "has:pins": { kind: "has", has: "pin" }, "is:pinned": { kind: "has", has: "pin" },
  "is:saved": { kind: "has", has: "saved" }, "has:saved": { kind: "has", has: "saved" },
  "is:thread": { kind: "is", is: "thread" },
};

/** The choices a `has:` or `is:` prompt lists, as the value typed and what it keeps. */
export const MARK_CHOICES: Readonly<Record<"has" | "is", readonly { value: string; detail: string }[]>> = {
  has: [
    { value: "link", detail: "Messages with a link" },
    { value: "reaction", detail: "Messages with a reaction" },
    { value: "pin", detail: "Pinned messages" },
  ],
  is: [
    { value: "thread", detail: "Replies in threads" },
    { value: "saved", detail: "Saved messages" },
  ],
};

export function markOperator(kind: "has" | "is", value: string): MarkOperator | undefined {
  return MARK_WORDS[`${kind}:${value.toLowerCase()}`];
}

export const nextDay = (day: string): string => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return dayString(new Date(year, month - 1, date + 1));
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/**
 * The span a `during:` value names, as Slack reads it: today, yesterday, week, month and year (this one, or `last-` before them), a
 * month by name (its latest start, this year or last), `YYYY-MM` and `YYYY`. Weeks start on Monday.
 */
export function duringRange(value: string, now: Date): RangeOperator | undefined {
  const word = value.toLowerCase().replace(/[_\s]+/g, "-");
  const day = (y: number, m: number, d: number) => dayString(new Date(y, m, d));
  const [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
  const monday = d - ((now.getDay() + 6) % 7);
  const range = (after: string, before: string): RangeOperator => ({ kind: "during", after, before });
  switch (word) {
    case "today": return range(day(y, m, d), day(y, m, d + 1));
    case "yesterday": return range(day(y, m, d - 1), day(y, m, d));
    case "week": case "this-week": return range(day(y, m, monday), day(y, m, monday + 7));
    case "last-week": return range(day(y, m, monday - 7), day(y, m, monday));
    case "month": case "this-month": return range(day(y, m, 1), day(y, m + 1, 1));
    case "last-month": return range(day(y, m - 1, 1), day(y, m, 1));
    case "year": case "this-year": return range(day(y, 0, 1), day(y + 1, 0, 1));
    case "last-year": return range(day(y - 1, 0, 1), day(y, 0, 1));
  }
  const named = MONTHS.findIndex(month => word.length >= 3 && month.startsWith(word));
  if (named >= 0) {
    const year = named <= m ? y : y - 1;
    return range(day(year, named, 1), day(year, named + 1, 1));
  }
  const ym = /^(\d{4})-(\d{2})$/.exec(word);
  if (ym && Number(ym[2]) >= 1 && Number(ym[2]) <= 12) return range(day(Number(ym[1]), Number(ym[2]) - 1, 1), day(Number(ym[1]), Number(ym[2]), 1));
  const year = /^(\d{4})$/.exec(word);
  if (year) return range(day(Number(year[1]), 0, 1), day(Number(year[1]) + 1, 0, 1));
  return undefined;
}

/** The spans a `during:` prompt lists, as the value typed and what it reads as. */
export const DURING_CHOICES: readonly { value: string; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "week", label: "This week" },
  { value: "last-week", label: "Last week" },
  { value: "month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "year", label: "This year" },
];

/** Drops the prompt token from the text once its choice became a chip. */
export function withoutPrompt(text: string, at: Prompt): string {
  return text.slice(0, at.start);
}

const COMPLETED_RE = /(?:^|\s)(from|in|to|with|after|before|on|during|has|is):(\S+)(?=\s)/gi;

/**
 * Resolves a typed `from:` or `in:` value, such as a name or an id, to the id of the one principal or conversation it names; `to:` and
 * `with:` resolve an agent's name to its DM's id.
 */
export type ResolveNamed = (kind: NamedOperator["kind"], value: string) => string | undefined;

/** The operator a completed token stands for, or undefined when its value names nothing, such as a bad date or an unknown name. */
function operatorOf(kind: OperatorKind, value: string, resolve: ResolveNamed, now: Date): Operator | undefined {
  switch (kind) {
    case "after":
    case "before":
      return isDate(value) ? { kind, date: value } : undefined;
    case "on": {
      const day = /^(today|yesterday)$/i.test(value) ? duringRange(value, now)?.after : value;
      return day && isDate(day) ? { kind, date: day } : undefined;
    }
    case "during":
      return duringRange(value, now);
    case "has":
    case "is":
      return markOperator(kind, value);
    default: {
      const id = resolve(kind, value.replace(/^[@#]/, ""));
      return id ? { kind, id } : undefined;
    }
  }
}

/**
 * Moves every completed operator (one followed by a space) out of the text into the filters: a valid date or span, a known mark, or a name
 * that resolves to exactly one choice. A bad date or an unknown name stays in the text, so it still matches as words.
 */
export function absorb(text: string, filters: Filters, resolve: ResolveNamed, now = new Date()): { text: string; filters: Filters } {
  let next = filters;
  const rest = text.replace(COMPLETED_RE, (whole, kind: string, value: string) => {
    const operator = operatorOf(kind.toLowerCase() as OperatorKind, value.replace(/[.,;!?]+$/, ""), resolve, now);
    if (!operator) return whole;
    next = withOperator(next, operator);
    return whole.startsWith(" ") || whole.startsWith("\t") ? " " : "";
  });
  return { text: rest.replace(/^\s+/, "").replace(/\s{2,}/g, " "), filters: next };
}

/** The text of the query once operators are removed, with an unfinished operator prompt left out. */
export function searchText(text: string): string {
  const open = prompt(text);
  return (open ? text.slice(0, open.start) : text).replace(/\s+/g, " ").trim();
}

const pad = (value: number) => String(value).padStart(2, "0");
export const dayString = (day: Date) => `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;

export type DatePreset = { label: string; date: string };

/** Today, Yesterday, This week, Last week and This month, as the first day each one starts on. Weeks start on Monday. */
export function datePresets(now: Date): DatePreset[] {
  const start = () => {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    return day;
  };
  const yesterday = start();
  yesterday.setDate(yesterday.getDate() - 1);
  const week = start();
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
  const lastWeek = new Date(week);
  lastWeek.setDate(lastWeek.getDate() - 7);
  const month = start();
  month.setDate(1);
  return [
    { label: "Today", date: dayString(start()) },
    { label: "Yesterday", date: dayString(yesterday) },
    { label: "This week", date: dayString(week) },
    { label: "Last week", date: dayString(lastWeek) },
    { label: "This month", date: dayString(month) },
  ];
}
