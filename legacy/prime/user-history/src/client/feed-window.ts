import { tick } from "svelte";

/**
 * The window of a long feed that is drawn: the items from `top` to the newest. A switch draws only the newest `first` items; scrolling near
 * the top draws `more` earlier ones, and at the start of the loaded items asks for the older page. Keys, not indices, name the top, so new
 * items at the bottom and older pages in front leave the drawn items as they are.
 */
/**
 * The feed draws its newest FIRST_ITEMS items first (Chat.svelte, and the shell's still view in prepaint-lines.ts). On 10-18 a switch back to
 * AI harness drew all of its 122 items and showed them 45 to 77 ms after the click; 30 items fill more than two screens of bubbles on the
 * owner's 1440x900 window.
 */
export const FIRST_ITEMS = 30;

/** An item of the feed as the window sees it: its key and the time it starts at. */
export interface WindowItem { key: string; at: number }

/**
 * Where the drawn items start: at the `top` item, else at the newest `first`. An older page can fold the top item into an earlier one, as a
 * run of updates that goes on across the page edge, and give it a new key. Then the window starts one item before the first item from the
 * top's time on, the one that took in the top's lines, so the view keeps its place and does not jump back to the newest items.
 */
export function windowStart(items: readonly WindowItem[], top: WindowItem | null, first: number): number {
  if (top) {
    const at = items.findIndex(item => item.key === top.key);
    if (at >= 0) return at;
    const after = items.findIndex(item => item.at >= top.at);
    if (after >= 0) return Math.max(0, after - 1);
  }
  return Math.max(0, items.length - first);
}

/** The top item after drawing `more` items above `start`, down to `floor`, or null when nothing drawable is above it. */
export function earlierTop(items: readonly WindowItem[], start: number, more: number, floor = 0): WindowItem | null {
  return start > floor ? items[Math.max(floor, start - more)] ?? null : null;
}

/**
 * The first item a window may draw while older pages are still unloaded: the first owner message. The lines before it belong to a turn that
 * started on the older page, so they can turn from bubbles into quiet lines and fold into a row of the older page when it loads. On 10-22
 * such a change took 1564 px out above a view 604 px from the top of the AI harness feed, more than any scroll could make up for.
 */
export function settledFrom(kinds: readonly string[], older: boolean): number {
  return older ? Math.max(0, kinds.indexOf("user")) : 0;
}

/** Where the drawn items end: after the `bottom` item (or the last one at or before its time, if a fold took it in), or at the newest for null. */
export function windowEnd(items: readonly WindowItem[], bottom: WindowItem | null): number {
  if (!bottom) return items.length;
  const at = items.findIndex(item => item.key === bottom.key);
  if (at >= 0) return at + 1;
  const after = items.findIndex(item => item.at > bottom.at);
  return after >= 0 ? Math.max(1, after) : items.length;
}

/** The bottom item after drawing `more` items below `end`, or null when that reaches the newest, which then stay drawn as they land. */
export function laterBottom(items: readonly WindowItem[], end: number, more: number): WindowItem | null {
  return end + more >= items.length ? null : items[end + more - 1] ?? null;
}

/** Scroll distance from the top under which the next earlier items are drawn: one screen, so they are in place before the owner reaches them. */
export const nearTop = (scroller: HTMLElement): boolean => scroller.scrollTop < scroller.clientHeight;

/** Runs `grow`, which adds content above the view, and moves the scroll by the height it added, so what the owner reads stays where it is. */
export async function keepPlace(scroller: HTMLElement, grow: () => void | Promise<void>): Promise<void> {
  const before = scroller.scrollHeight - scroller.scrollTop;
  await grow();
  await tick();
  scroller.scrollTop = scroller.scrollHeight - before;
}

/**
 * Holds a chat feed's place before each frame paints whenever its rows change size: at the bottom while the view is there and the drawn rows
 * reach the newest (`atNewest`), else on the row in the middle of the view. So rows drawn above or below, an older page, or a picture or
 * diagram that loads late never move what the owner reads.
 * - `scrolled` goes on the scroll event and notes that row and whether the view is at the bottom. While the column's height differs from the
 *   one the observer last saw, that layout never painted, so it only moves the noted rows by the owner's scroll, and the view counts as at
 *   the bottom if it is there in the old layout or the new one.
 * - `hold` goes after a change the page makes itself, because rows drawn on one end and taken off the other can leave the height, and so the
 *   observer, as it was. It sets the scroll from where the row stood in the view, not by how far the row moved, because the browser may
 *   already have clamped the scroll when rows above went out and the content got shorter.
 * The rows are the children of `column`, the scroller's only child and the offset parent of its rows.
 */
export function holdPlace(scroller: HTMLElement, column: HTMLElement, atNewest: () => boolean, onPinned: (pinned: boolean) => void): FeedPlace {
  let pinned = true;
  /**
   * The middle row and a few after it, each with its top in the view and its height when noted. Hold uses the first that is still there
   * with the same height: a time stamp or a fold row can be drawn anew, and a reply can grow a quote of an older message when its page loads.
   */
  let held: { row: HTMLElement; top: number; height: number }[] = [];
  let seen = 0;
  let height = -1;
  const setPinned = (next: boolean): void => { if (next !== pinned) { pinned = next; onPinned(next); } };
  const note = (): void => {
    setPinned(atNewest() && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48);
    seen = scroller.scrollTop;
    held = [];
    for (let row = middleRow(column.children as HTMLCollectionOf<HTMLElement>, seen + scroller.clientHeight / 2); row && held.length < 4; row = row.nextElementSibling as HTMLElement | null) {
      held.push({ row, top: row.offsetTop - seen, height: row.offsetHeight });
    }
  };
  const hold = (): void => {
    const kept = held.find(({ row, height }) => row.isConnected && row.offsetHeight === height) ?? held.find(({ row }) => row.isConnected);
    if (pinned) scroller.scrollTop = scroller.scrollHeight;
    else if (kept) scroller.scrollTop = kept.row.offsetTop - kept.top;
    height = column.offsetHeight;
    note();
  };
  const observer = new ResizeObserver(hold);
  observer.observe(column);
  observer.observe(scroller);
  return {
    hold,
    scrolled: () => {
      if (column.offsetHeight === height) { note(); return; }
      for (const entry of held) entry.top -= scroller.scrollTop - seen;
      seen = scroller.scrollTop;
      const gap = Math.min(scroller.scrollHeight, Math.max(height, scroller.clientHeight)) - seen - scroller.clientHeight;
      setPinned(atNewest() && gap < 48);
    },
    pin: () => { setPinned(true); scroller.scrollTop = scroller.scrollHeight; },
    unpin: () => setPinned(false),
    stop: () => observer.disconnect(),
  };
}
export interface FeedPlace { hold: () => void; scrolled: () => void; pin: () => void; unpin: () => void; stop: () => void }

/** The last row that starts at or above `y` (a distance from the column's top), by binary search, since rows sit in order. */
export function middleRow<Row extends { offsetTop: number }>(rows: ArrayLike<Row>, y: number): Row | null {
  let low = 0;
  let high = rows.length - 1;
  let found: Row | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const node = rows[mid]!;
    if (node.offsetTop <= y) { found = node; low = mid + 1; } else high = mid - 1;
  }
  return found;
}
