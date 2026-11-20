/**
 * Slack-style search operators typed in the field. Each completed operator moves out of the text into the filter chips under the field
 * (filters.ts), so typing `from:vent` and picking Vent in the From chip land in the same state.
 */
import type { Filters } from "./filters.ts";

export type DateOperator = { kind: "after" | "before"; date: string };
export type NamedOperator = { kind: "from" | "in"; id: string };
/** One typed filter, which lands in the one filter state that the chips show (filters.ts). */
export type Operator = DateOperator | NamedOperator;
export type OperatorKind = Operator["kind"];

/** The operator token being typed at the end of the text, such as `from:an`. */
export type Prompt = { kind: OperatorKind; needle: string; start: number };

const PROMPT_RE = /(?:^|\s)(from|in|after|before):(\S*)$/i;
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

/** Applies a typed operator: `from:` adds a person to the ones already picked, and `in:`, `after:` and `before:` replace their value. */
export function withOperator(filters: Filters, operator: Operator): Filters {
  switch (operator.kind) {
    case "from":
      return filters.from.includes(operator.id) ? filters : { ...filters, from: [...filters.from, operator.id] };
    case "in":
      return { ...filters, in: operator.id };
    case "after":
    case "before":
      return { ...filters, [operator.kind]: operator.date };
  }
}

/** Drops the prompt token from the text once its choice became a chip. */
export function withoutPrompt(text: string, at: Prompt): string {
  return text.slice(0, at.start);
}

const COMPLETED_RE = /(?:^|\s)(from|in|after|before):(\S+)(?=\s)/gi;

/** Resolves a typed `from:` or `in:` value, such as a name or an id, to the id of the one principal or conversation it names. */
export type ResolveNamed = (kind: NamedOperator["kind"], value: string) => string | undefined;

/**
 * Moves every completed operator (one followed by a space) out of the text into the filters: a valid date, or a name that resolves to
 * exactly one choice. A bad date or an unknown name stays in the text, so it still matches as words.
 */
export function absorb(text: string, filters: Filters, resolve: ResolveNamed): { text: string; filters: Filters } {
  let next = filters;
  const rest = text.replace(COMPLETED_RE, (whole, kind: string, value: string) => {
    const lower = kind.toLowerCase() as OperatorKind;
    const clean = value.replace(/[.,;!?]+$/, "");
    let operator: Operator | undefined;
    if (lower === "after" || lower === "before") operator = isDate(clean) ? { kind: lower, date: clean } : undefined;
    else {
      const id = resolve(lower, clean.replace(/^[@#]/, ""));
      operator = id ? { kind: lower, id } : undefined;
    }
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
