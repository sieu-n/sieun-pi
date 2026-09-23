import { emptyRowFilter, ROW_FILTER_KEYS, type RowFilter, type SidebarSort } from "./organize.ts";

export type ViewMode = "default" | "questions";
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 480;
/** Dragging the sidebar edge narrower than this collapses the sidebar. */
export const SIDEBAR_SNAP = 120;

function stored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function store(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Private mode keeps the choice for this tab only. */ }
}
function storedFilter(): RowFilter {
  const filter = emptyRowFilter();
  try {
    const saved: unknown = JSON.parse(stored("chat.sidebarFilter") ?? "null");
    if (typeof saved !== "object" || saved === null) return filter;
    for (const key of ROW_FILTER_KEYS) {
      const value = (saved as Record<string, unknown>)[key];
      if (key === "priority" ? [0, 1, 2, 3, "any"].includes(value as number) : typeof value === "string") Object.assign(filter, { [key]: value });
    }
  } catch { /* A broken saved filter starts empty. */ }
  return filter;
}
const clampWidth = (width: number): number => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));

class Ui {
  viewMode = $state<ViewMode>(stored("chat.viewMode") === "questions" ? "questions" : "default");
  sidebarWidth = $state(clampWidth(Number(stored("chat.sidebarWidth")) || 260));
  sidebarFilter = $state<RowFilter>(storedFilter());
  sidebarSort = $state<SidebarSort>(stored("chat.sidebarSort") === "recent" ? "recent" : "grouped");
  agentsOpen = $state(false);
  setSidebarFilter(filter: RowFilter): void { this.sidebarFilter = filter; store("chat.sidebarFilter", JSON.stringify(filter)); }
  setSidebarSort(sort: SidebarSort): void { this.sidebarSort = sort; store("chat.sidebarSort", sort); }
  setViewMode(mode: ViewMode): void { this.viewMode = mode; store("chat.viewMode", mode); }
  setSidebarWidth(width: number, persist: boolean): void {
    this.sidebarWidth = clampWidth(width);
    if (persist) store("chat.sidebarWidth", String(this.sidebarWidth));
  }
}
export const ui = new Ui();
