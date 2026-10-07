/**
 * Ported from the Virev `dropdown-position.ts`: a fixed panel opens below its anchor, flips above when below is short and above has more room, and clamps its height and left edge to the viewport.
 * `beside` puts the panel to the right of the anchor instead, its top on the anchor's top (its bottom on the anchor's bottom when that fits more), when the room is there; a sidebar row's card must not cover the rows under it.
 */
export interface Placement { top: number | null; bottom: number | null; left: number; width: number; maxHeight: number }
export type Anchor = HTMLElement | { x: number; y: number };

export function place(anchor: Anchor, options: { width: number; maxHeight?: number; gap?: number; margin?: number; align?: "start" | "end"; beside?: boolean }): Placement {
  const { width, maxHeight = 420, gap = 4, margin = 8, align = "start", beside = false } = options;
  const rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  if (beside && rect.right + gap + width + margin <= window.innerWidth) {
    const down = window.innerHeight - rect.top - margin;
    const up = rect.bottom - margin;
    const low = down < maxHeight && up > down;
    return { left: rect.right + gap, width, maxHeight: Math.max(96, Math.min(maxHeight, low ? up : down)), top: low ? null : rect.top, bottom: low ? window.innerHeight - rect.bottom : null };
  }
  const below = window.innerHeight - rect.bottom - gap - margin;
  const above = rect.top - gap - margin;
  const up = below < maxHeight && above > below;
  const height = Math.max(96, Math.min(maxHeight, up ? above : below));
  const wanted = align === "end" ? rect.right - width : rect.left;
  const left = Math.max(margin, Math.min(wanted, window.innerWidth - width - margin));
  return { left, width, maxHeight: height, top: up ? null : rect.bottom + gap, bottom: up ? window.innerHeight - rect.top + gap : null };
}

export function placementStyle(placement: Placement): string {
  const vertical = placement.top !== null ? `top:${placement.top}px` : `bottom:${placement.bottom}px`;
  return `left:${placement.left}px;width:${placement.width}px;${vertical}`;
}

/** Moves the node to <body> so no overflow container or transform clips it. */
export function portal(node: HTMLElement): { destroy: () => void } {
  document.body.appendChild(node);
  return { destroy: () => node.remove() };
}
