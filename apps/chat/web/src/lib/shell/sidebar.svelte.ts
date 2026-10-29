import { connection, isSoloRoom, sidebar as liveSidebar, type ConversationSummary, type Sidebar as SidebarData } from "$lib/api";

const WIDTH_KEY = "chat.sidebarWidth";
export const SIDEBAR_DEFAULT = 260;
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 520;

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

/** The Solo group's three parts: open Solo rooms, closed ones under "Done", then the untitled root chats no agent holds. */
export type SoloGroups = { open: ConversationSummary[]; done: ConversationSummary[]; chats: ConversationSummary[] };

/** Splits the server's Solo rows, keeping its order inside each part. */
export function soloGroups(rows: readonly ConversationSummary[]): SoloGroups {
  const groups: SoloGroups = { open: [], done: [], chats: [] };
  for (const row of rows) (isSoloRoom(row.id) ? (row.closedAt ? groups.done : groups.open) : groups.chats).push(row);
  return groups;
}

/** Sidebar view state shared by every root: width and collapse, plus the Messages rows from the chat server's live sidebar store. */
class SidebarView {
  width = $state(clampWidth(Number(read(WIDTH_KEY)) || SIDEBAR_DEFAULT));
  collapsed = $state(read("chat.sidebarCollapsed") === "1");
  /** Below 650 px the sidebar is a 220 px drawer over the main panel. The shell sets this from the window width. */
  narrow = $state(false);
  drawerOpen = $state(false);
  /** The Solo group's "Done" fold of closed Solo rooms; folded on each load. */
  doneOpen = $state(false);

  /** Live rows from GET /api/sidebar and the `sidebar` event, empty until the first answer. */
  get data(): SidebarData {
    return liveSidebar.value ?? EMPTY;
  }

  get solo(): SoloGroups {
    return soloGroups(this.data.solo);
  }

  get state(): "loading" | "ready" | "offline" {
    if (liveSidebar.value) return connection.connected ? "ready" : "offline";
    return "loading";
  }

  setWidth(px: number): void {
    this.width = clampWidth(px);
  }
  saveWidth(): void {
    write(WIDTH_KEY, String(this.width));
  }
  toggle(): void {
    if (this.narrow) {
      this.drawerOpen = !this.drawerOpen;
      return;
    }
    this.collapsed = !this.collapsed;
    write("chat.sidebarCollapsed", this.collapsed ? "1" : "0");
  }
}

function clampWidth(px: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));
}

export const sidebar = new SidebarView();
