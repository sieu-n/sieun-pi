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
const clampWidth = (width: number): number => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));

class Ui {
  viewMode = $state<ViewMode>(stored("chat.viewMode") === "questions" ? "questions" : "default");
  sidebarWidth = $state(clampWidth(Number(stored("chat.sidebarWidth")) || 260));
  setViewMode(mode: ViewMode): void { this.viewMode = mode; store("chat.viewMode", mode); }
  setSidebarWidth(width: number, persist: boolean): void {
    this.sidebarWidth = clampWidth(width);
    if (persist) store("chat.sidebarWidth", String(this.sidebarWidth));
  }
}
export const ui = new Ui();
