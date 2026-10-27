import { connection, sidebar as liveSidebar, type ConversationSummary, type Sidebar as SidebarData } from "$lib/api";

const FILTER_KEY = "chat.sidebarFilter";
const WIDTH_KEY = "chat.sidebarWidth";
export const SIDEBAR_DEFAULT = 260;
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 520;

export type SidebarFilter = "all" | "solo" | "team";

const EMPTY: SidebarData = { solo: [], channels: [], dms: [], forYou: 0 };

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

/** Sidebar view state: the All, Solo and Team filter, width and collapse, over the chat server's live sidebar store. */
class SidebarView {
  filter = $state<SidebarFilter>(parseFilter(read(FILTER_KEY)));
  width = $state(clampWidth(Number(read(WIDTH_KEY)) || SIDEBAR_DEFAULT));
  collapsed = $state(read("chat.sidebarCollapsed") === "1");

  /** Live rows from GET /api/sidebar and the `sidebar` event, empty until the first answer. */
  get data(): SidebarData {
    return liveSidebar.value ?? EMPTY;
  }

  get state(): "loading" | "ready" | "offline" {
    if (liveSidebar.value) return connection.connected ? "ready" : "offline";
    return "loading";
  }

  setFilter(f: SidebarFilter): void {
    this.filter = f;
    write(FILTER_KEY, f);
  }

  /** Opening a conversation of the other kind switches the filter to that kind, unless the filter is All. */
  follow(id: string | null): void {
    if (!id || this.filter === "all") return;
    const row = this.find(id);
    if (!row) return;
    const kind: SidebarFilter = row.kind === "solo" ? "solo" : "team";
    if (kind !== this.filter) this.setFilter(kind);
  }

  find(id: string): ConversationSummary | undefined {
    const d = this.data;
    return d.solo.find((r) => r.id === id) ?? d.channels.find((r) => r.id === id) ?? d.dms.find((r) => r.id === id);
  }

  setWidth(px: number): void {
    this.width = clampWidth(px);
  }
  saveWidth(): void {
    write(WIDTH_KEY, String(this.width));
  }
  toggle(): void {
    this.collapsed = !this.collapsed;
    write("chat.sidebarCollapsed", this.collapsed ? "1" : "0");
  }
}

function parseFilter(v: string | null): SidebarFilter {
  return v === "solo" || v === "team" ? v : "all";
}
function clampWidth(px: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));
}

export const sidebar = new SidebarView();
