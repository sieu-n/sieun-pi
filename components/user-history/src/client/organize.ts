import type { Priority, Progress, SessionRow, Tag } from "../shared/types.ts";

export type Bucket = "needs" | "working" | "other";
export type Tab = "threads" | "heartbeats";
export type RowStatus = "needs" | "working" | "idle" | "saved";

export const BUCKETS: readonly Bucket[] = ["needs", "working", "other"];
export const BUCKET_LABEL: Record<Bucket, string> = { needs: "Needs response", working: "Working", other: "Other threads" };
export const STATUS_LABEL: Record<RowStatus, string> = { needs: "Needs response", working: "Working", idle: "Idle", saved: "Saved" };
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

/** Needs response: not running, has messages, and its last activity came after the browser last opened it (the unread marker). */
export const needsResponse = (row: SessionRow): boolean => row.status !== "running" && row.unread;
export const bucketOf = (row: SessionRow): Bucket => row.status === "running" ? "working" : needsResponse(row) ? "needs" : "other";
export const statusOf = (row: SessionRow): RowStatus => row.status === "running" ? "working" : needsResponse(row) ? "needs" : row.status === "idle" ? "idle" : "saved";
export const tabOf = (row: SessionRow): Tab => row.schedule ? "heartbeats" : "threads";
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

export function groupRows(rows: readonly SessionRow[]): { bucket: Bucket; rows: SessionRow[] }[] {
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

export function nextRun(value: string | undefined, now = Date.now()): string {
  const ms = Date.parse(value ?? "");
  if (!Number.isFinite(ms)) return "";
  return ms <= now ? "due now" : "next in " + elapsed(ms - now);
}

export type SortKey = "status" | "name" | "priority" | "progress" | "tags" | "cwd" | "model" | "cost" | "created" | "activity";
export interface AgentFilter {
  query: string; status: RowStatus | "any"; tag: string; priority: Priority | "any"; progress: Progress | "any"; cwd: string; model: string;
  from: string; to: string; kind: Tab | "any"; archived: boolean;
}
export const emptyFilter = (): AgentFilter => ({ query: "", status: "any", tag: "any", priority: "any", progress: "any", cwd: "any", model: "any", from: "", to: "", kind: "any", archived: false });
const PROGRESS_ORDER: Record<Progress, number> = { none: 0, plan: 1, implementation: 2, qa: 3 };

const dayStart = (value: string): number => { const ms = Date.parse(value + "T00:00:00"); return Number.isFinite(ms) ? ms : NaN; };

export function matchesFilter(row: SessionRow, filter: AgentFilter, tags: ReadonlyMap<string, Tag>): boolean {
  if (!filter.archived && row.archived) return false;
  if (filter.status !== "any" && statusOf(row) !== filter.status) return false;
  if (filter.kind !== "any" && tabOf(row) !== filter.kind) return false;
  if (filter.tag === "none" ? row.tags.length > 0 : filter.tag !== "any" && !row.tags.includes(filter.tag)) return false;
  if (filter.priority !== "any" && row.priority !== filter.priority) return false;
  if (filter.progress !== "any" && row.progress !== filter.progress) return false;
  if (filter.cwd !== "any" && row.cwd !== filter.cwd) return false;
  if (filter.model !== "any" && (row.model ?? "") !== filter.model) return false;
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
