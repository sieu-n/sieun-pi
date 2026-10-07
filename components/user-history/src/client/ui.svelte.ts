import { emptyRowFilter, ROW_FILTER_KEYS, type RowFilter, type SidebarSort, type SidebarView } from "./organize.ts";

export type ViewMode = "default" | "questions" | "read";
const VIEW_MODES: readonly ViewMode[] = ["default", "questions", "read"];
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
function storedColumns(key = "chat.agentsColumns"): Record<string, boolean> {
  try {
    const saved: unknown = JSON.parse(stored(key) ?? "null");
    if (typeof saved !== "object" || saved === null) return {};
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch { return {}; }
}
function storedTree(key = "chat.chatTreeOpen"): Record<string, true> {
  try {
    const saved: unknown = JSON.parse(stored(key) ?? "null");
    return Array.isArray(saved) ? Object.fromEntries(saved.filter((id): id is string => typeof id === "string").map(id => [id, true])) : {};
  } catch { return {}; }
}
const clampWidth = (width: number): number => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
/** The Board / Jobs panel beside a chat: dragged from its left edge up to 60% of the window, reset by a double click, or expanded to the whole width. */
export const BOARD_MIN = 280;
export const BOARD_DEFAULT = 320;
export const boardMax = (): number => Math.max(BOARD_MIN, Math.floor((typeof window === "undefined" ? 1200 : window.innerWidth) * 0.6));
export const clampBoardWidth = (width: number): number => Math.round(Math.min(boardMax(), Math.max(BOARD_MIN, width)));

class Ui {
  viewMode = $state<ViewMode>(VIEW_MODES.find(mode => mode === stored("chat.viewMode")) ?? "default");
  sidebarWidth = $state(clampWidth(Number(stored("chat.sidebarWidth")) || 260));
  sidebarFilter = $state<RowFilter>(storedFilter());
  sidebarSort = $state<SidebarSort>(stored("chat.sidebarSort") === "recent" ? "recent" : "grouped");
  sidebarView = $state<SidebarView>(stored("chat.sidebarView") === "tags" ? "tags" : "current");
  agentsOpen = $state(false);
  /** The notepad panel beside the open thread; the choice holds across threads and reloads. */
  notesOpen = $state(stored("chat.notesOpen") === "1");
  /** The Heartbeats section at the top of the sidebar; open unless folded, and the choice holds across reloads. */
  /** Optional Agents view columns the person turned on or off; Status and Title always show. */
  agentsColumns = $state<Record<string, boolean>>(storedColumns());
  setAgentsColumn(key: string, on: boolean): void { this.agentsColumns = { ...this.agentsColumns, [key]: on }; store("chat.agentsColumns", JSON.stringify(this.agentsColumns)); }
  heartbeatsOpen = $state(stored("chat.heartbeatsOpen") !== "0");
  setHeartbeatsOpen(open: boolean): void { this.heartbeatsOpen = open; store("chat.heartbeatsOpen", open ? "1" : "0"); }
  /** Threads an agent started through `rlm.create_session` are out of the sidebar unless this is on; the choice holds across reloads. */
  agentCreatedShown = $state(stored("chat.agentCreatedShown") === "1");
  setAgentCreatedShown(shown: boolean): void { this.agentCreatedShown = shown; store("chat.agentCreatedShown", shown ? "1" : "0"); }
  setNotesOpen(open: boolean): void { this.notesOpen = open; store("chat.notesOpen", open ? "1" : "0"); }
  /** The Board panel beside a chat on a wide window; open unless folded, and the choice holds across chats and reloads. */
  boardOpen = $state(stored("chat.boardOpen") !== "0");
  setBoardOpen(open: boolean): void { this.boardOpen = open; store("chat.boardOpen", open ? "1" : "0"); }
  boardWidth = $state(clampBoardWidth(Number(stored("chat.boardWidth")) || BOARD_DEFAULT));
  setBoardWidth(width: number, persist: boolean): void {
    this.boardWidth = clampBoardWidth(width);
    if (persist) store("chat.boardWidth", String(this.boardWidth));
  }
  /** Expanded: the panel takes the room right of the sidebar and the chat narrows to one column; off again puts the last width back. */
  boardWide = $state(stored("chat.boardWide") === "1");
  setBoardWide(wide: boolean): void { this.boardWide = wide; store("chat.boardWide", wide ? "1" : "0"); }
  /** The Plan and Notes cards of the board, folded or open; the choice holds across chats and reloads. For you decides for itself. */
  boardCards = $state.raw<Record<string, boolean>>(storedColumns("chat.boardCards"));
  setBoardCard(card: string, open: boolean): void { this.boardCards = { ...this.boardCards, [card]: open }; store("chat.boardCards", JSON.stringify(this.boardCards)); }
  /** Plan steps and notes the owner unfolded, keyed `<chat id>/<item id>`; everything with children starts folded. */
  boardItemsOpen = $state.raw<Record<string, true>>(storedTree("chat.boardItemsOpen"));
  setBoardItemOpen(chatId: string, itemId: string, open: boolean): void {
    this.boardItemsOpen = toggled(this.boardItemsOpen, `${chatId}/${itemId}`, open);
    store("chat.boardItemsOpen", JSON.stringify(Object.keys(this.boardItemsOpen)));
  }
  /** Parents (`root` for the top level) whose done and dropped steps the owner shows, keyed `<chat id>/<parent id>`. */
  boardShowDone = $state.raw<Record<string, true>>(storedTree("chat.boardShowDone"));
  setBoardShowDone(chatId: string, parent: string, shown: boolean): void {
    this.boardShowDone = toggled(this.boardShowDone, `${chatId}/${parent}`, shown);
    store("chat.boardShowDone", JSON.stringify(Object.keys(this.boardShowDone)));
  }
  /** Chats whose job list is unfolded in the sidebar. */
  chatTreeOpen = $state.raw<Record<string, true>>(storedTree());
  setChatTreeOpen(id: string, open: boolean): void {
    const { [id]: _was, ...rest } = this.chatTreeOpen;
    this.chatTreeOpen = open ? { ...rest, [id]: true } : rest;
    store("chat.chatTreeOpen", JSON.stringify(Object.keys(this.chatTreeOpen)));
  }
  /** Thread ids in the order the sidebar shows them, so archiving the open thread can move to the next one. */
  sidebarOrder = $state.raw<string[]>([]);
  setSidebarFilter(filter: RowFilter): void { this.sidebarFilter = filter; store("chat.sidebarFilter", JSON.stringify(filter)); }
  setSidebarSort(sort: SidebarSort): void { this.sidebarSort = sort; store("chat.sidebarSort", sort); }
  setSidebarView(view: SidebarView): void { this.sidebarView = view; store("chat.sidebarView", view); }
  setViewMode(mode: ViewMode): void { this.viewMode = mode; store("chat.viewMode", mode); }
  setSidebarWidth(width: number, persist: boolean): void {
    this.sidebarWidth = clampWidth(width);
    if (persist) store("chat.sidebarWidth", String(this.sidebarWidth));
  }
}
function toggled(set: Record<string, true>, key: string, on: boolean): Record<string, true> {
  const { [key]: _was, ...rest } = set;
  return on ? { ...rest, [key]: true } : rest;
}
export const ui = new Ui();
