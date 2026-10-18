import { tick } from "svelte";

/**
 * The window of a long feed that is drawn: the items from `top` (an item key) to the newest. A switch draws only the newest `first` items;
 * scrolling near the top draws `more` earlier ones, and at the start of the loaded items asks for the older page. Keys, not indices, name the
 * top, so new items at the bottom and older pages in front leave the drawn items as they are.
 */
/**
 * The feed draws its newest FIRST_ITEMS items first (Chat.svelte, and the shell's still view in prepaint-lines.ts). On 10-18 a switch back to
 * AI harness drew all of its 122 items and showed them 45 to 77 ms after the click; 30 items fill more than two screens of bubbles on the
 * owner's 1440x900 window.
 */
export const FIRST_ITEMS = 30;

export function windowStart(keys: readonly string[], top: string | null, first: number): number {
  const at = top === null ? -1 : keys.indexOf(top);
  return at >= 0 ? at : Math.max(0, keys.length - first);
}

/** The top key after drawing `more` items above `start`, or null when nothing loaded is above it. */
export function earlierTop(keys: readonly string[], start: number, more: number): string | null {
  return start > 0 ? keys[Math.max(0, start - more)] ?? null : null;
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
