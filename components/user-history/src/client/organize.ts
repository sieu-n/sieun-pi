import type { Priority, Progress, SessionRow, Tag } from "../shared/types.ts";
import { readPulse, type PulseReading } from "../shared/pulse.ts";

export type Bucket = "needs" | "working" | "idle";
export type Tab = "threads" | "heartbeats";
export type RowStatus = "needs" | "working" | "stalled" | "idle" | "saved";

export const BUCKETS: readonly Bucket[] = ["needs", "working", "idle"];
export const BUCKET_LABEL: Record<Bucket, string> = { needs: "Needs response", working: "Working", idle: "Idle" };
export const STATUS_LABEL: Record<RowStatus, string> = { needs: "Needs response", working: "Working", stalled: "Stalled", idle: "Idle", saved: "Saved" };
export const PRIORITY_LABEL: Record<Priority, string> = { 0: "No priority", 1: "Low", 2: "Medium", 3: "High" };
export const PROGRESS_LABEL: Record<Progress, string> = { none: "No progress", plan: "Plan", implementation: "Implementation", qa: "QA" };

/** A short model name for dense rows: "opus-5.5", "fable-5.1", "astra-6", else the model id without its vendor prefix. */
export function modelShort(model: string | undefined): string {
  if (!model) return "";
  const id = model.slice(model.indexOf("/") + 1).toLowerCase();
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(id);
  if (claude) return claude[1] + "-" + claude[2] + (claude[3] ? "." + claude[3] : "");
  const gpt = /^gpt-([\d.]+)-([a-z]+)$/.exec(id);
  if (gpt && !["mini", "nano", "codex", "pro", "max"].includes(gpt[2]!)) return gpt[2] + "-" + gpt[1];
  return id.replace(/^claude-/, "");
}

/** Session cost for a row: two decimals under $100, whole dollars above, and a dash when the daemon reported no usage. */
export function money(cost: number | undefined): string {
  if (cost === undefined || !Number.isFinite(cost)) return "–";
  return "$" + (cost < 100 ? cost.toFixed(2) : Math.round(cost).toLocaleString("en-US"));
}

/** Working: its own turn or any subagent below it runs. Needs response: not working, and it changed after the browser last left it. Idle: the rest. */
export const needsResponse = (row: SessionRow): boolean => !row.working && row.unread;
export const bucketOf = (row: SessionRow): Bucket => row.working ? "working" : needsResponse(row) ? "needs" : "idle";
/** Freshness of a working row, null when it is not working. */
export const pulseOf = (row: SessionRow, now = Date.now()): PulseReading | null => row.working && row.pulse ? readPulse(row.pulse, now) : null;
/** Stalled covers a working row that is stalled or failed. */
export function statusOf(row: SessionRow, now = Date.now()): RowStatus {
  if (row.working) { const level = pulseOf(row, now)?.level; return level === "stalled" || level === "failed" ? "stalled" : "working"; }
  return needsResponse(row) ? "needs" : row.status === "idle" ? "idle" : "saved";
}
export const tabOf = (row: SessionRow): Tab => row.schedule ? "heartbeats" : "threads";
export type Origin = NonNullable<SessionRow["origin"]>;
export const ORIGIN_LABEL: Record<Origin, string> = { user: "Created by me", agent: "Created by an agent" };
export const originOf = (row: SessionRow): Origin => row.origin ?? "user";
/** What the sidebar lists: archived and agent-created rows stay out until their toggle is on. */
export const inSidebar = (row: SessionRow, show: { archived: boolean; agentCreated: boolean }): boolean =>
  (show.archived || !row.archived) && (show.agentCreated || originOf(row) !== "agent");
export const activityOf = (row: SessionRow): number => Date.parse(row.lastActivityAt ?? row.created ?? "") || 0;
export const createdOf = (row: SessionRow): number => Date.parse(row.created ?? "") || 0;

export function compareRows(left: SessionRow, right: SessionRow): number {
  return BUCKETS.indexOf(bucketOf(left)) - BUCKETS.indexOf(bucketOf(right)) || right.priority - left.priority || activityOf(right) - activityOf(left);
}

export function matchesQuery(row: SessionRow, needle: string, tags: ReadonlyMap<string, Tag>): boolean {
  if (!needle) return true;
  const words = needle.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = [row.name, row.cwd, row.model ?? "", ...row.tags.map(id => tags.get(id)?.name ?? "")].join(" ").toLowerCase();
  return words.every(word => haystack.includes(word));
}

export type SidebarSort = "grouped" | "recent";
export const SIDEBAR_SORT_LABEL: Record<SidebarSort, string> = { grouped: "Needs response, working, idle", recent: "Chronological" };
/** How much a sidebar card shows under its title. Current: age, working time, cost, model, tags, progress and priority. Tags: only the tag chips. */
export type SidebarView = "current" | "tags";
export const SIDEBAR_VIEW_LABEL: Record<SidebarView, string> = { current: "Show details", tags: "Show tags only" };

/** Sidebar sections. Grouped: Needs response, Working, then the rest. Recent: one unlabeled list, most recent activity first. */
export function groupRows(rows: readonly SessionRow[], sort: SidebarSort = "grouped"): { bucket: Bucket | null; rows: SessionRow[] }[] {
  if (sort === "recent") return rows.length ? [{ bucket: null, rows: [...rows].sort((left, right) => activityOf(right) - activityOf(left)) }] : [];
  const sorted = [...rows].sort(compareRows);
  return BUCKETS.flatMap(bucket => { const items = sorted.filter(row => bucketOf(row) === bucket); return items.length ? [{ bucket, rows: items }] : []; });
}

const MINUTE = 60_000;
export function elapsed(ms: number): string {
  if (ms < MINUTE) return "<1m";
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return Math.floor(hours / 24) + "d";
}

export function shortDate(value: string | undefined, now = Date.now()): string {
  const ms = Date.parse(value ?? "");
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

/** Age by calendar day: "" for today, "1d", "12d", then "3mo" and "2y". */
export function createdAge(value: string | undefined, now = Date.now()): string {
  const ms = Date.parse(value ?? "");
  if (!Number.isFinite(ms)) return "";
  const day = (time: number) => { const date = new Date(time); return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000; };
  const days = Math.max(0, Math.round(day(now) - day(ms)));
  if (days === 0) return "";
  if (days < 60) return days + "d";
  if (days < 730) return Math.floor(days / 30) + "mo";
  return Math.floor(days / 365) + "y";
}

export function nextRun(value: string | undefined, now = Date.now()): string {
  const ms = Date.parse(value ?? "");
  if (!Number.isFinite(ms)) return "";
  return ms <= now ? "due now" : "next in " + elapsed(ms - now);
}

export type SortKey = "status" | "name" | "priority" | "progress" | "tags" | "cwd" | "model" | "cost" | "created" | "activity";
/** The label filters the Agents view and the sidebar share. "any" means unset; tag also takes "none" for threads without tags. */
export interface RowFilter { status: RowStatus | "any"; tag: string; priority: Priority | "any"; progress: Progress | "any"; cwd: string; model: string }
export interface AgentFilter extends RowFilter { query: string; from: string; to: string; kind: Tab | "any"; origin: Origin | "any"; archived: boolean }
export const emptyRowFilter = (): RowFilter => ({ status: "any", tag: "any", priority: "any", progress: "any", cwd: "any", model: "any" });
export const emptyFilter = (): AgentFilter => ({ ...emptyRowFilter(), query: "", from: "", to: "", kind: "any", origin: "any", archived: false });
export const ROW_FILTER_KEYS = ["status", "tag", "priority", "progress", "cwd", "model"] as const satisfies readonly (keyof RowFilter)[];
export const activeFilters = (filter: RowFilter): number => ROW_FILTER_KEYS.filter(key => filter[key] !== "any").length;

export function matchesRowFilter(row: SessionRow, filter: RowFilter, now = Date.now()): boolean {
  if (filter.status !== "any" && statusOf(row, now) !== filter.status) return false;
  if (filter.tag === "none" ? row.tags.length > 0 : filter.tag !== "any" && !row.tags.includes(filter.tag)) return false;
  if (filter.priority !== "any" && row.priority !== filter.priority) return false;
  if (filter.progress !== "any" && row.progress !== filter.progress) return false;
  if (filter.cwd !== "any" && row.cwd !== filter.cwd) return false;
  if (filter.model !== "any" && (row.model ?? "") !== filter.model) return false;
  return true;
}
const PROGRESS_ORDER: Record<Progress, number> = { none: 0, plan: 1, implementation: 2, qa: 3 };

const dayStart = (value: string): number => { const ms = Date.parse(value + "T00:00:00"); return Number.isFinite(ms) ? ms : NaN; };

export function matchesFilter(row: SessionRow, filter: AgentFilter, tags: ReadonlyMap<string, Tag>, now = Date.now()): boolean {
  if (!filter.archived && row.archived) return false;
  if (filter.kind !== "any" && tabOf(row) !== filter.kind) return false;
  if (filter.origin !== "any" && originOf(row) !== filter.origin) return false;
  if (!matchesRowFilter(row, filter, now)) return false;
  const created = createdOf(row);
  const from = filter.from ? dayStart(filter.from) : NaN;
  const to = filter.to ? dayStart(filter.to) + 86_400_000 : NaN;
  if (Number.isFinite(from) && created < from) return false;
  if (Number.isFinite(to) && created >= to) return false;
  return matchesQuery(row, filter.query.trim(), tags);
}

export function sortBy(rows: readonly SessionRow[], key: SortKey, descending: boolean, tags: ReadonlyMap<string, Tag>): SessionRow[] {
  const text = (row: SessionRow): string => key === "name" ? row.name : key === "cwd" ? row.cwd : key === "model" ? row.model ?? "" :
    row.tags.map(id => tags.get(id)?.name ?? "").sort().join(",");
  const compare = (left: SessionRow, right: SessionRow): number => {
    switch (key) {
      case "status": return compareRows(left, right);
      case "priority": return left.priority - right.priority || activityOf(left) - activityOf(right);
      case "progress": return PROGRESS_ORDER[left.progress] - PROGRESS_ORDER[right.progress] || activityOf(left) - activityOf(right);
      case "cost": return (left.cost ?? -1) - (right.cost ?? -1);
      case "created": return createdOf(left) - createdOf(right);
      case "activity": return activityOf(left) - activityOf(right);
      default: return text(left).localeCompare(text(right), undefined, { sensitivity: "base" }) || activityOf(right) - activityOf(left);
    }
  };
  const sorted = [...rows].sort(compare);
  return descending ? sorted.reverse() : sorted;
}

/** The browser tab title: tag names, then the thread name, or "New chat" when no thread is open. */
export function pageTitle(tagNames: readonly string[], threadName: string | null): string {
  return [tagNames.join(", "), threadName ?? "New chat"].filter(Boolean).join(" - ");
}
