/**
 * Message search over every Prime transcript on every box (packages/pi-history, answered here by GET api/search). The shapes are the
 * contract in ~/work/chat-history-search/API.md; this file turns a result into what the search panel draws.
 */
import { get } from "./api.ts";

export type HitKind = "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "agent_message" | "notice" | "summary";
export interface Hit {
  ref: string; box: string; source: "prime" | "durable"; session: string; root: string; parent?: string; depth: number; thread: string; rootName?: string;
  kind: HitKind; tool?: string; toolCallId?: string; author: string; at: number; snippet: string; isError?: boolean;
  /** The relevance rank a box gave the hit with sort=relevant, lower is better; asked for in the contract, absent until the api sends it. */
  score?: number;
}
/** `bytesTotal` is asked for in the contract; the backfill line names the GB only when every reading box sends it. */
export interface BoxState { ok: boolean; error?: string; tookMs: number; newestAt?: number; backfillPct: number; lagP50Ms?: number; lagP99Ms?: number; bytesTotal?: number }
export interface SearchResult { hits: Hit[]; total: number; nextCursor?: string; tookMs: number; boxes: Record<string, BoxState>; scope: "all" | "family" }

export type SearchSort = "newest" | "relevant";
/** The panel's filters beside the query text: `kind` takes the contract's groups, `from` and `to` are local YYYY-MM-DD days, "" for open. */
export interface SearchFilters { sort: SearchSort; kind: string; box: string; chat: string; from: string; to: string }
export const emptySearchFilters = (): SearchFilters => ({ sort: "newest", kind: "any", box: "any", chat: "any", from: "", to: "" });

export const SORT_LABEL: Record<SearchSort, string> = { newest: "Newest first", relevant: "Most relevant" };
export const KIND_FILTERS: readonly { value: string; label: string }[] = [
  { value: "any", label: "Any kind" }, { value: "message", label: "Messages" }, { value: "agent", label: "Agent messages" },
  { value: "tool", label: "Tool calls and results" }, { value: "thinking", label: "Thinking" }, { value: "summary", label: "Summaries" },
];

/** The query string of api/search for the text, the filters, the one box to answer from (`ALL_BOXES` for the merged answer) and a page cursor. */
export function searchQuery(q: string, filters: SearchFilters, box: string = ALL_BOXES, cursor?: string): string {
  const params = new URLSearchParams({ q: q.trim(), sort: filters.sort });
  for (const key of ["kind", "chat"] as const) if (filters[key] !== "any") params.set(key, filters[key]);
  if (box !== ALL_BOXES) params.set("box", box);
  if (filters.from) params.set("since", filters.from);
  if (filters.to) params.set("until", filters.to);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

export const searchMessages = (q: string, filters: SearchFilters, box: string = ALL_BOXES, cursor?: string): Promise<SearchResult> =>
  get<SearchResult>("api/search?" + searchQuery(q, filters, box, cursor));

/**
 * One search asks each box on its own (`box=<name>`), so a slow box never holds the others' hits. `ALL_BOXES` is the one merged ask the
 * panel sends while it knows no box names: a page whose rows carry no host, before any answer named its boxes.
 */
export const ALL_BOXES = "*";
export type Ask = { state: "loading" } | { state: "failed"; error: string } | { state: "done"; result: SearchResult; hits: Hit[]; next?: string };
export type Asks = Record<string, Ask>;

/** The boxes a search asks: the Box filter's one box, else every box known, else the one merged ask. */
export function boxesToAsk(filter: string, known: readonly string[]): string[] {
  if (filter !== "any") return [filter];
  return known.length ? [...new Set(known)].sort() : [ALL_BOXES];
}

/** What the panel draws from the asks so far: the hits to show in order, the summed count and each box's state. */
export interface Merged {
  hits: Hit[]; total: number; tookMs: number; boxes: Record<string, BoxState>;
  /** Boxes still on their way, by name; the merged ask has none to name. */
  loading: string[];
  /** The ask whose next page the list needs before it can show more, or null when no answered ask has one. */
  more: string | null;
  /** The rank of the last hit shown, the `floor` of the next merge. */
  shownTo: number;
  /** True when hits already shown sort after the `more` ask's last loaded hit, so its next page fills a gap above them: fetch it at once. */
  gap: boolean;
  /** Set when no ask answered and at least one failed: the first failure's text. */
  error: string | null;
}

/**
 * Merges each box's answer into one list. Newest first orders by `at`; Most relevant by `score`, or by each box's own rank when the boxes send
 * no score. A box with a next page bounds what shows: a hit sorting after that box's last loaded hit waits, since the box's next page may hold
 * hits that sort before it. A hit shown once stays shown (`floor`, the last merge's `shownTo`), so a slow box's answer never takes rows away.
 */
export function mergeAsks(asks: Asks, sort: SearchSort, floor = -Infinity): Merged {
  const done = Object.entries(asks).flatMap(([box, ask]) => ask.state === "done" ? [{ box, ask }] : []);
  const scored = sort === "relevant" && done.every(({ ask }) => ask.hits.every(hit => typeof hit.score === "number"));
  const rankOf = (hit: Hit, index: number): number => sort === "newest" ? -hit.at : scored ? hit.score! : index;
  const ranked = done.flatMap(({ ask }) => ask.hits.map((hit, index) => ({ hit, rank: rankOf(hit, index) })));
  ranked.sort((a, b) => a.rank - b.rank || b.hit.at - a.hit.at || (a.hit.ref < b.hit.ref ? -1 : a.hit.ref > b.hit.ref ? 1 : 0));
  let bound = Infinity, more: string | null = null;
  for (const { box, ask } of done) {
    if (!ask.next || !ask.hits.length) continue;
    const last = rankOf(ask.hits.at(-1)!, ask.hits.length - 1);
    if (last < bound) { bound = last; more = box; }
  }
  const shown = ranked.filter(item => item.rank <= Math.max(bound, floor));
  const boxes: Record<string, BoxState> = {};
  for (const { ask } of done) Object.assign(boxes, ask.result.boxes);
  for (const [box, ask] of Object.entries(asks)) if (ask.state === "failed" && box !== ALL_BOXES) boxes[box] = { ok: false, error: ask.error, tookMs: 0, backfillPct: 0 };
  const failed = Object.values(asks).find(ask => ask.state === "failed");
  return {
    hits: shown.map(item => item.hit),
    total: done.reduce((sum, { ask }) => sum + ask.result.total, 0),
    tookMs: Math.max(0, ...done.map(({ ask }) => ask.result.tookMs)),
    boxes, loading: Object.entries(asks).flatMap(([box, ask]) => ask.state === "loading" && box !== ALL_BOXES ? [box] : []), more,
    shownTo: Math.max(floor, shown.at(-1)?.rank ?? -Infinity), gap: more !== null && floor > bound,
    error: !done.length && failed?.state === "failed" ? failed.error : null,
  };
}

const BOXES_KEY = "chat.searchBoxes";
/** The box names the last answers named, kept in the browser for a page whose rows carry no host. */
export function rememberedBoxes(): string[] {
  try { const saved: unknown = JSON.parse(localStorage.getItem(BOXES_KEY) ?? "[]"); return Array.isArray(saved) ? saved.filter((box): box is string => typeof box === "string") : []; }
  catch { return []; }
}
export function rememberBoxes(boxes: readonly string[]): void {
  try { localStorage.setItem(BOXES_KEY, JSON.stringify([...new Set(boxes)].sort())); } catch { /* Private mode keeps the names for this page only. */ }
}

/** The line for a box that has not answered yet. */
export const searchingLine = (box: string): string => box === "mac" ? "Searching the Mac…" : `Searching ${box}…`;

/** One thread's hits in result order; the panel shows the first `SHOWN_PER_THREAD` and counts the rest. */
export interface ThreadGroup { key: string; box: string; session: string; thread: string; rootName?: string; depth: number; hits: Hit[] }
export const SHOWN_PER_THREAD = 3;

/** Hits grouped by box and session, each group placed where its first hit falls in the result order. */
export function groupHits(hits: readonly Hit[]): ThreadGroup[] {
  const groups = new Map<string, ThreadGroup>();
  for (const hit of hits) {
    const key = hit.box + ":" + hit.session;
    const group = groups.get(key);
    if (group) group.hits.push(hit);
    else groups.set(key, { key, box: hit.box, session: hit.session, thread: hit.thread, ...(hit.rootName ? { rootName: hit.rootName } : {}), depth: hit.depth, hits: [hit] });
  }
  return [...groups.values()];
}

/** Hits with the same ref once, the first kept: a page after a cursor may repeat the last hit of the page before it. */
export function appendHits(have: readonly Hit[], next: readonly Hit[]): Hit[] {
  const seen = new Set(have.map(hit => hit.ref));
  return [...have, ...next.filter(hit => !seen.has(hit.ref) && seen.add(hit.ref))];
}

/** What each hit row says before its snippet: "tool result (ipython)", "agent message from d9 stuck steps", "you". */
export function kindLabel(hit: Pick<Hit, "kind" | "tool" | "author" | "isError">): string {
  const tool = hit.tool ? ` (${hit.tool})` : "";
  switch (hit.kind) {
    case "user": return "you";
    case "assistant": return "assistant";
    case "thinking": return "thinking";
    case "tool_call": return "tool call" + tool;
    case "tool_result": return (hit.isError ? "tool error" : "tool result") + tool;
    case "agent_message": return hit.author ? "agent message from " + hit.author : "agent message";
    case "notice": return "notice";
    case "summary": return "summary";
  }
}

/** The box as a sentence subject: the Mac, or the box's hosts.json name. */
export const boxName = (box: string): string => box === "mac" ? "The Mac" : box;

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&#x27;": "'" };
/**
 * The snippet as plain text runs, `mark` on the matched words. The server sends HTML-escaped text with `<mark>` around matches; the panel draws
 * the runs as text nodes, so a tag the server failed to escape shows as text and never as markup.
 */
export function snippetParts(snippet: string): { text: string; mark: boolean }[] {
  const parts: { text: string; mark: boolean }[] = [];
  let mark = false;
  for (const piece of snippet.split(/(<\/?mark>)/)) {
    if (piece === "<mark>") { mark = true; continue; }
    if (piece === "</mark>") { mark = false; continue; }
    if (piece) parts.push({ text: piece.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, entity => ENTITIES[entity]!), mark });
  }
  return parts;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (value: number): string => String(value).padStart(2, "0");
/** "Oct 23, 13:20" in the page's time zone, with the year when it is not this year. */
export function hitTime(at: number, now = Date.now()): string {
  const date = new Date(at);
  const year = date.getFullYear() === new Date(now).getFullYear() ? "" : " " + date.getFullYear();
  return `${MONTHS[date.getMonth()]} ${date.getDate()}${year}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "49 results in 14 ms": the exact total the server counted and its time. */
export function countLine(result: Pick<SearchResult, "total" | "tookMs">): string {
  return `${result.total.toLocaleString("en-US")} ${result.total === 1 ? "result" : "results"} in ${Math.round(result.tookMs)} ms`;
}

const gigabytes = (bytes: number): string => (bytes / 1e9).toFixed(1) + " GB";
/**
 * The lines above the hits: each box that did not answer, then one backfill line while any box still reads older history. The backfill
 * percentage is by bytes when every reading box sends `bytesTotal`, else the lowest box's.
 */
export function boxNotices(boxes: Record<string, BoxState>): string[] {
  const lines = Object.entries(boxes).filter(([, state]) => !state.ok).map(([box]) => `${boxName(box)} is offline, so its messages are not in these results.`);
  const reading = Object.values(boxes).filter(state => state.ok && state.backfillPct < 100);
  if (reading.length) {
    const sized = reading.every(state => typeof state.bytesTotal === "number" && state.bytesTotal > 0);
    const all = Object.values(boxes).filter(state => state.ok && typeof state.bytesTotal === "number");
    const total = all.reduce((sum, state) => sum + state.bytesTotal!, 0);
    const pct = sized && total ? all.reduce((sum, state) => sum + state.bytesTotal! * Math.min(100, state.backfillPct), 0) / total : Math.min(...reading.map(state => state.backfillPct));
    lines.push(`Still reading older history: ${Math.floor(pct)}% ${sized && total ? "of " + gigabytes(total) : "done"}. Newer messages are searched already.`);
  }
  return lines;
}

export const emptyLine = (q: string): string => `No messages match “${q.trim()}”. Try fewer words, or remove a filter.`;
export const sidebarSearchLine = (q: string): string => `Search messages for “${q.trim()}”`;
