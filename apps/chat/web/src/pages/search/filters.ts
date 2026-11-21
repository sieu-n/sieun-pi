/**
 * The search filters as one state, which the chip bar under the Cmd K box, the typed operators (operators.ts) and the full results
 * page's address all read and write (owner p115, msg mwomrz5y: "search에서 filter 직관적으로 할수 있어야됨 ... 일단 큰 소스 (by which
 * agent/user), in root message, in thread, diggen in some internal tool call"). The server's contract is GET /api/search with `from` and
 * `where` as lists that it ORs (~/work/search-filters/contract.md).
 */
import { shortDay, type Hit } from "./hit-view.ts";
import { dayString } from "./operators.ts";

/** Where a hit sits: a top-level post or root-chat message, a thread reply, or inside an agent's work (a tool call, its output, a job's entry). */
export type Where = "root" | "thread" | "tool";

export const WHERES: readonly { id: Where; label: string; detail: string; icon: string }[] = [
  { id: "root", label: "Root messages", detail: "Top-level posts and chat messages", icon: "chat" },
  { id: "thread", label: "Thread replies", detail: "Replies inside a thread", icon: "thread" },
  { id: "tool", label: "Inside work", detail: "Tool calls, tool output and jobs", icon: "terminal" },
];

/**
 * `from` holds `owner`, `agents` (anyone but the owner) or agent ids, OR-ed. `where` is empty for all three places, so picking every place
 * reads the same as picking none. `in` is a conversation id; `after` and `before` are YYYY-MM-DD days in KST.
 */
export type Filters = { from: readonly string[]; where: readonly Where[]; in?: string | undefined; after?: string | undefined; before?: string | undefined };

export const NO_FILTERS: Filters = { from: [], where: [] };

export const hasFilters = (filters: Filters): boolean => !!(filters.from.length || filters.where.length || filters.in || filters.after || filters.before);

const WHERE_ORDER: readonly Where[] = WHERES.map(where => where.id);
const isWhere = (value: string): value is Where => (WHERE_ORDER as readonly string[]).includes(value);

export function toggleFrom(filters: Filters, id: string): Filters {
  return { ...filters, from: filters.from.includes(id) ? filters.from.filter(one => one !== id) : [...filters.from, id] };
}

export function toggleWhere(filters: Filters, where: Where): Filters {
  const next = filters.where.includes(where) ? filters.where.filter(one => one !== where) : [...filters.where, where];
  return { ...filters, where: next.length === WHERE_ORDER.length ? [] : WHERE_ORDER.filter(one => next.includes(one)) };
}

/** The filter Backspace at the start of an empty field takes back: the rightmost chip's, in the bar's order From, In, Where, Date. */
export function withoutLast(filters: Filters): Filters {
  if (filters.after || filters.before) return { ...filters, after: undefined, before: undefined };
  if (filters.where.length) return { ...filters, where: [] };
  if (filters.in) return { ...filters, in: undefined };
  if (filters.from.length) return { ...filters, from: filters.from.slice(0, -1) };
  return filters;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const list = (value: string | undefined): string[] => [...new Set((value ?? "").split(",").map(one => one.trim()).filter(Boolean))];

/** The filters an address holds, `from=owner,ag_vent&where=tool&in=&after=&before=`; an unknown place or a malformed day is dropped. */
export function readFilters(params: Readonly<Record<string, string | undefined>>): Filters {
  const where = list(params.where).filter(isWhere);
  return {
    from: list(params.from),
    where: where.length === WHERE_ORDER.length ? [] : WHERE_ORDER.filter(one => where.includes(one)),
    ...(params.in ? { in: params.in } : {}),
    ...(params.after && DAY.test(params.after) ? { after: params.after } : {}),
    ...(params.before && DAY.test(params.before) ? { before: params.before } : {}),
  };
}

/** The address and request params of the filters, as comma lists, with unset ones left out. */
export function filterParams(filters: Filters): { from?: string; where?: string; in?: string; after?: string; before?: string } {
  return {
    ...(filters.from.length ? { from: filters.from.join(",") } : {}),
    ...(filters.where.length ? { where: filters.where.join(",") } : {}),
    ...(filters.in ? { in: filters.in } : {}),
    ...(filters.after ? { after: filters.after } : {}),
    ...(filters.before ? { before: filters.before } : {}),
  };
}

/** The filters as GET /api/search takes them: lists for `from` and `where`, which the client sends as comma lists. */
export function filterQuery(filters: Filters): { from?: string[]; where?: Where[]; in?: string; after?: string; before?: string } {
  return {
    ...(filters.from.length ? { from: [...filters.from] } : {}),
    ...(filters.where.length ? { where: [...filters.where] } : {}),
    ...(filters.in ? { in: filters.in } : {}),
    ...(filters.after ? { after: filters.after } : {}),
    ...(filters.before ? { before: filters.before } : {}),
  };
}

const KST_MS = 9 * 3_600_000;
/** The start of a KST day in ms, as the server reads `after` and `before` (server/search.ts `dayStart`). */
const kstDayStart = (day: string): number => Date.parse(`${day}T00:00:00Z`) - KST_MS;

/**
 * Whether the page can tell for itself that a hit passes the filters, so the Cmd K keystroke rows (local-index.ts) show only hits the
 * server's answer could hold. It cannot tell for an agent in `from`, whose work the server matches through its threads too
 * (server/search.ts), so such a hit reads as not passing and the server's answer brings it.
 */
export function passes(hit: Hit, filters: Filters): boolean {
  if (filters.in && hit.conversation.id !== filters.in) return false;
  if (filters.after && hit.at < kstDayStart(filters.after)) return false;
  if (filters.before && hit.at >= kstDayStart(filters.before)) return false;
  if (filters.where.length && !filters.where.includes(hit.where)) return false;
  if (!filters.from.length) return true;
  const owner = hit.author.kind === "owner";
  return filters.from.some(one => (one === "owner" && owner) || (one === "agents" && !owner));
}

export type DateRange = { id: string; label: string; after?: string; before?: string };

/** The Date chip's presets, as after/before days: Any time, Today, Yesterday, Last 7 days, Last 30 days and Last 12 months. */
export function dateRanges(now: Date): DateRange[] {
  const day = (back: number) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - back);
    return dayString(d);
  };
  return [
    { id: "any", label: "Any time" },
    { id: "today", label: "Today", after: day(0) },
    { id: "yesterday", label: "Yesterday", after: day(1), before: day(0) },
    { id: "7d", label: "Last 7 days", after: day(6) },
    { id: "30d", label: "Last 30 days", after: day(29) },
    { id: "12m", label: "Last 12 months", after: day(364) },
  ];
}

const dayOf = (day: string, now: Date): string => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return shortDay(new Date(year, month - 1, date), now);
};

/** The Date chip's label: a preset's name, or the days themselves, such as "Oct 1 to Oct 5", "On or after Oct 1" and "Before Oct 5". */
export function dateLabel({ after, before }: Pick<Filters, "after" | "before">, now: Date): string | undefined {
  const preset = dateRanges(now).find(range => range.id !== "any" && range.after === after && range.before === before);
  if (preset) return preset.label;
  if (after && before) return `${dayOf(after, now)} to ${dayOf(before, now)}`;
  if (after) return `On or after ${dayOf(after, now)}`;
  return before ? `Before ${dayOf(before, now)}` : undefined;
}
