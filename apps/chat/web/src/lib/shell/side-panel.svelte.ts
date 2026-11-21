import type { Snippet } from "svelte";

/**
 * The one side panel host. A page opens its pane here and the shell draws it at the right of the main panel,
 * 420 px by default, 640 px for a `wide` pane, and resizable. Opening a new pane replaces the old one.
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
  /** `wide` for a page to read, such as a wiki page, which opens at 640 px and keeps its own width when resized. */
  size?: SidePanelSize;
  onclose?: () => void;
};

export type SidePanelSize = "default" | "wide";

const SIZES: Record<SidePanelSize, { key: string; initial: number }> = {
  default: { key: "chat.sidePanelWidth", initial: 420 },
  wide: { key: "chat.sidePanelWideWidth", initial: 640 },
};
export const SIDE_PANEL_MIN = 300;

function savedWidth(size: SidePanelSize): number {
  const { key, initial } = SIZES[size];
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n >= SIDE_PANEL_MIN ? n : initial;
  } catch {
    return initial;
  }
}

class SidePanel {
  content = $state<SidePanelContent | null>(null);
  private widths = $state<Record<SidePanelSize, number>>({ default: savedWidth("default"), wide: savedWidth("wide") });
  private readonly size = $derived<SidePanelSize>(this.content?.size ?? "default");

  /** The width of the open pane's size, which a drag sets live and `setWidth` saves. */
  get width(): number {
    return this.widths[this.size];
  }
  set width(px: number) {
    this.widths[this.size] = px;
  }

  get defaultWidth(): number {
    return SIZES[this.size].initial;
  }

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
      localStorage.setItem(SIZES[this.size].key, String(this.width));
    } catch {}
  }
}

export const sidePanel = new SidePanel();
