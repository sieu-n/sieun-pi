import type { Snippet } from "svelte";

/**
 * The one side panel host. A page opens its pane here and the shell draws it at the right of the main panel,
 * 420 px by default and resizable. Opening a new pane replaces the old one.
 *
 *   sidePanel.open({ key: `thread:${jobId}`, title: "Thread", body: threadPane, onclose: () => router.setParams({ thread: null }) });
 *
 * `body` is a Svelte snippet the page defines, so the pane keeps the page's own state and props.
 */
export type SidePanelContent = {
  /** Stable id of what is open, so a page can tell whether its pane is the one showing. */
  key: string;
  title: string;
  /** Icon name from lib/ui Icon, shown before the title. */
  icon?: string;
  body: Snippet;
  /** Trailing header actions, drawn before the close button. */
  actions?: Snippet;
  /** Replace the default PanelHeader. */
  header?: Snippet;
  onclose?: () => void;
};

const WIDTH_KEY = "chat.sidePanelWidth";
export const SIDE_PANEL_DEFAULT = 420;
export const SIDE_PANEL_MIN = 300;

function savedWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(n) && n >= SIDE_PANEL_MIN ? n : SIDE_PANEL_DEFAULT;
  } catch {
    return SIDE_PANEL_DEFAULT;
  }
}

class SidePanel {
  content = $state<SidePanelContent | null>(null);
  width = $state(savedWidth());

  get isOpen(): boolean {
    return this.content !== null;
  }

  open(content: SidePanelContent): void {
    this.content = content;
  }

  /** Close the pane. With a key, close only when that pane is the one open. */
  close(key?: string): void {
    const current = this.content;
    if (!current || (key !== undefined && current.key !== key)) return;
    this.content = null;
    current.onclose?.();
  }

  setWidth(px: number): void {
    this.width = Math.max(SIDE_PANEL_MIN, Math.round(px));
    try {
      localStorage.setItem(WIDTH_KEY, String(this.width));
    } catch {}
  }
}

export const sidePanel = new SidePanel();
