/**
 * Slack-style search operators as typed chips. The field holds free text, and each completed operator moves out of
 * the text into a chip, so the query the server gets is the chips plus the text.
 */

export type DateOperator = { kind: "after" | "before"; date: string };
export type NamedOperator = { kind: "from" | "in"; id: string; label: string };
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

/** Adds an operator, replacing one of the same kind, as a later Slack operator wins. */
export function withOperator(operators: readonly Operator[], next: Operator): Operator[] {
  return [...operators.filter(operator => operator.kind !== next.kind), next];
}

/** Drops the prompt token from the text once its choice became a chip. */
export function withoutPrompt(text: string, at: Prompt): string {
  return text.slice(0, at.start);
}

const COMPLETED_RE = /(?:^|\s)(from|in|after|before):(\S+)(?=\s)/gi;

/** Resolves a typed `from:` or `in:` value, such as a name or an id, to the one principal or conversation it names. */
export type ResolveNamed = (kind: NamedOperator["kind"], value: string) => NamedOperator | undefined;

/**
 * Moves every completed operator (one followed by a space) out of the text into chips: a valid date, or a name that
 * resolves to exactly one choice. A bad date or an unknown name stays in the text, so it still matches as words.
 */
export function absorb(text: string, operators: readonly Operator[], resolve: ResolveNamed): { text: string; operators: Operator[] } {
  let next = [...operators];
  const rest = text.replace(COMPLETED_RE, (whole, kind: string, value: string) => {
    const lower = kind.toLowerCase() as OperatorKind;
    const clean = value.replace(/[.,;!?]+$/, "");
    const operator: Operator | undefined =
      lower === "after" || lower === "before" ? (isDate(clean) ? { kind: lower, date: clean } : undefined) : resolve(lower, clean.replace(/^[@#]/, ""));
    if (!operator) return whole;
    next = withOperator(next, operator);
    return whole.startsWith(" ") || whole.startsWith("\t") ? " " : "";
  });
  return { text: rest.replace(/^\s+/, "").replace(/\s{2,}/g, " "), operators: next };
}

export function chipLabel(operator: Operator): string {
  switch (operator.kind) {
    case "from":
      return `from:@${operator.label}`;
    case "in":
      return `in:#${operator.label}`;
    case "after":
    case "before":
      return `${operator.kind}:${operator.date}`;
  }
}

/** The text of the query once operators are removed, with an unfinished operator prompt left out. */
export function searchText(text: string): string {
  const open = prompt(text);
  return (open ? text.slice(0, open.start) : text).replace(/\s+/g, " ").trim();
}

export type SearchFilters = { q: string; from?: string; in?: string; after?: string; before?: string };

export function filters(text: string, operators: readonly Operator[]): SearchFilters {
  const result: SearchFilters = { q: searchText(text) };
  for (const operator of operators) {
    if ("date" in operator) result[operator.kind] = operator.date;
    else result[operator.kind] = operator.id;
  }
  return result;
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
