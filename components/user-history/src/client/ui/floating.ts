/** Ported from the Virev `dropdown-position.ts`: a fixed panel opens below its anchor, flips above when below is short and above has more room, and clamps its height and left edge to the viewport. */
export interface Placement { top: number | null; bottom: number | null; left: number; width: number; maxHeight: number }
export type Anchor = HTMLElement | { x: number; y: number };

export function place(anchor: Anchor, options: { width: number; maxHeight?: number; gap?: number; margin?: number; align?: "start" | "end" }): Placement {
  const { width, maxHeight = 420, gap = 4, margin = 8, align = "start" } = options;
  const rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
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
