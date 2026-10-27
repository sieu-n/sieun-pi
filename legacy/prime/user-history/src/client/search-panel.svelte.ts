/** Whether the message search panel is open and the text it opens with: the sidebar's "Search messages for" row and Cmd+Shift+F open it. */
class SearchPanelState {
  open = $state(false);
  /** The query the panel starts with and runs at once; null keeps the panel's last query and results. */
  seed = $state<string | null>(null);
  show(query: string | null = null): void {
    this.seed = query?.trim() ? query.trim() : null;
    this.open = true;
  }
  close(): void { this.open = false; }
}
export const searchPanel = new SearchPanelState();

/** The shortcut as the page's platform writes it. */
export const SEARCH_SHORTCUT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘⇧F" : "Ctrl+Shift+F";
/** Cmd+Shift+F on the Mac, Ctrl+Shift+F elsewhere; either modifier works on both. */
export const isSearchShortcut = (event: KeyboardEvent): boolean => (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "f";
