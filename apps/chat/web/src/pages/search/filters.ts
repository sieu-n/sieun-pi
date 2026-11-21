/**
 * The search filters as one state, which the chip bar under the Cmd K box, the typed operators (operators.ts) and the full results
 * page's address all read and write (owner p115, msg mwomrz5y: "search에서 filter 직관적으로 할수 있어야됨 ... 일단 큰 소스 (by which
 * agent/user), in root message, in thread, diggen in some internal tool call"). Where and the In categories became one row of place pills
 * (owner p126, msg mwqfy6v3: "아니 Where하고 이 카테고리하고 합쳐서,dropdown 말고 그냥 아이템들 list되어있는 pill들로"). The server's contract is
 * GET /api/search with `from` and `place` as lists that it ORs (~/work/search-in-category/contract.md).
 */
import type { SearchPlace } from "../../lib/api/types.ts";
import { shortDay, type Hit } from "./hit-view.ts";
import { dayString } from "./operators.ts";

/** The place pills in the order the row shows them; every hit sits in exactly one place (server/search.ts SEARCH_PLACES). */
export const PLACES: readonly { id: SearchPlace; label: string; detail: string; icon: string }[] = [
  { id: "channels", label: "Channels", detail: "Top-level posts in channels", icon: "hash" },
  { id: "dms", label: "DMs", detail: "Top-level posts in agents' DMs", icon: "messages" },
  { id: "solo", label: "Solo", detail: "Solo rooms and your own chats", icon: "chat" },
  { id: "threads", label: "Threads", detail: "Replies inside a thread", icon: "thread" },
  { id: "jobs", label: "Jobs", detail: "What agents did and said inside their work and jobs", icon: "robot" },
  { id: "tools", label: "Tool calls", detail: "Tool output", icon: "terminal" },
];

/**
 * `from` holds `owner`, `agents` (anyone but the owner) or agent ids, OR-ed. `place` holds the lit pills in the row's order, OR-ed, and is
 * empty for every place. `in` is a conversation id; `after` and `before` are YYYY-MM-DD days in KST.
 */
export type Filters = { from: readonly string[]; place: readonly SearchPlace[]; in?: string | undefined; after?: string | undefined; before?: string | undefined };

export const NO_FILTERS: Filters = { from: [], place: [] };

export const hasFilters = (filters: Filters): boolean => !!(filters.from.length || filters.place.length || filters.in || filters.after || filters.before);

const PLACE_ORDER: readonly SearchPlace[] = PLACES.map(place => place.id);
const isPlace = (value: string): value is SearchPlace => (PLACE_ORDER as readonly string[]).includes(value);
/** The places an old `where=` address covers (server/search.ts `WHERE_PLACES`), so links made before the pills still filter. */
const WHERE_PLACES: Readonly<Record<string, readonly SearchPlace[]>> = { root: ["channels", "dms", "solo"], thread: ["threads"], tool: ["jobs", "tools"] };

export function toggleFrom(filters: Filters, id: string): Filters {
  return { ...filters, from: filters.from.includes(id) ? filters.from.filter(one => one !== id) : [...filters.from, id] };
}

export function togglePlace(filters: Filters, place: SearchPlace): Filters {
  const next = filters.place.includes(place) ? filters.place.filter(one => one !== place) : [...filters.place, place];
  return { ...filters, place: PLACE_ORDER.filter(one => next.includes(one)) };
}

/** The place a hit sits in, by the rule the server filters with: a reply is `threads`, a tool's output `tools`, the rest of agents' work `jobs`. */
export function hitPlace(hit: Pick<Hit, "where" | "kind" | "conversation">): SearchPlace {
  if (hit.where === "thread") return "threads";
  if (hit.where === "tool") return hit.kind === "tool" ? "tools" : "jobs";
  return hit.conversation.kind === "channel" ? "channels" : hit.conversation.kind === "dm" ? "dms" : "solo";
}

/** The filter Backspace at the start of an empty field takes back, rightmost first in the bar's order: places, From, In, Date. */
export function withoutLast(filters: Filters): Filters {
  if (filters.after || filters.before) return { ...filters, after: undefined, before: undefined };
  if (filters.in) return { ...filters, in: undefined };
  if (filters.from.length) return { ...filters, from: filters.from.slice(0, -1) };
  if (filters.place.length) return { ...filters, place: filters.place.slice(0, -1) };
  return filters;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const list = (value: string | undefined): string[] => [...new Set((value ?? "").split(",").map(one => one.trim()).filter(Boolean))];

/**
 * The filters an address holds, `from=owner,ag_vent&place=jobs,threads&in=&after=&before=`; an unknown place or a malformed day is
 * dropped. An old `where=` address reads as the places it covers.
 */
export function readFilters(params: Readonly<Record<string, string | undefined>>): Filters {
  const covered = list(params.where).flatMap(one => WHERE_PLACES[one] ?? []);
  const named = params.place !== undefined ? list(params.place).filter(isPlace) : covered.length === PLACE_ORDER.length ? [] : covered;
  return {
    from: list(params.from),
    place: PLACE_ORDER.filter(one => named.includes(one)),
    ...(params.in ? { in: params.in } : {}),
    ...(params.after && DAY.test(params.after) ? { after: params.after } : {}),
    ...(params.before && DAY.test(params.before) ? { before: params.before } : {}),
  };
}

/** The address and request params of the filters, as comma lists, with unset ones left out. */
export function filterParams(filters: Filters): { from?: string; place?: string; in?: string; after?: string; before?: string } {
  return {
    ...(filters.from.length ? { from: filters.from.join(",") } : {}),
    ...(filters.place.length ? { place: filters.place.join(",") } : {}),
    ...(filters.in ? { in: filters.in } : {}),
    ...(filters.after ? { after: filters.after } : {}),
    ...(filters.before ? { before: filters.before } : {}),
  };
}

/** The filters as GET /api/search takes them: lists for `from` and `place`, which the client sends as comma lists. */
export function filterQuery(filters: Filters): { from?: string[]; place?: SearchPlace[]; in?: string; after?: string; before?: string } {
  return {
    ...(filters.from.length ? { from: [...filters.from] } : {}),
    ...(filters.place.length ? { place: [...filters.place] } : {}),
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
  if (filters.place.length && !filters.place.includes(hitPlace(hit))) return false;
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
