import { SIDEBAR_FIXTURE } from "./fixture";
import type { SidebarData, SidebarFilter, SidebarRow } from "./sidebar-types";

const FILTER_KEY = "chat.sidebarFilter";
const WIDTH_KEY = "chat.sidebarWidth";
export const SIDEBAR_DEFAULT = 260;
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 520;

type LoadState = "loading" | "ready" | "error";

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

/** Fixture mode is on with `?fixture` in the page URL or VITE_CHAT_FIXTURE=1 at build time. */
export function fixtureMode(): boolean {
  if (import.meta.env.VITE_CHAT_FIXTURE === "1") return true;
  return typeof location !== "undefined" && new URLSearchParams(location.search).has("fixture");
}

class Sidebar {
  data = $state<SidebarData>({ solo: [], channels: [], dms: [] });
  state = $state<LoadState>("loading");
  filter = $state<SidebarFilter>(parseFilter(read(FILTER_KEY)));
  width = $state(clampWidth(Number(read(WIDTH_KEY)) || SIDEBAR_DEFAULT));
  collapsed = $state(read("chat.sidebarCollapsed") === "1");

  async load(): Promise<void> {
    if (fixtureMode()) {
      this.data = SIDEBAR_FIXTURE;
      this.state = "ready";
      return;
    }
    try {
      const res = await fetch("/api/sidebar", { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`GET /api/sidebar ${res.status}`);
      this.data = (await res.json()) as SidebarData;
      this.state = "ready";
    } catch {
      this.state = "error";
    }
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

  find(id: string): SidebarRow | undefined {
    return this.data.solo.find((r) => r.id === id) ?? this.data.channels.find((r) => r.id === id) ?? this.data.dms.find((r) => r.id === id);
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

export const sidebar = new Sidebar();
