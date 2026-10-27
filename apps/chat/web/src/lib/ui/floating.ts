/** Placement math and a portal action shared by Popover, Menu, Tooltip and Picker. */

export type Side = "top" | "bottom" | "left" | "right";
export type Align = "start" | "center" | "end";
export type Placement = Side | `${Side}-${Exclude<Align, "center">}`;
export type Anchor = HTMLElement | { x: number; y: number };

export function anchorRect(anchor: Anchor): DOMRect {
  if (anchor instanceof HTMLElement) return anchor.getBoundingClientRect();
  return new DOMRect(anchor.x, anchor.y, 0, 0);
}

/** Top-left for a floating box of `size` next to `rect`, flipped and clamped to stay inside the viewport. */
export function place(rect: DOMRect, size: { width: number; height: number }, placement: Placement, gap = 6): { x: number; y: number; side: Side } {
  const [rawSide, rawAlign] = placement.split("-") as [Side, Align | undefined];
  const align: Align = rawAlign ?? "center";
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let side = rawSide;
  if (side === "bottom" && rect.bottom + gap + size.height > vh && rect.top - gap - size.height >= 0) side = "top";
  else if (side === "top" && rect.top - gap - size.height < 0 && rect.bottom + gap + size.height <= vh) side = "bottom";
  else if (side === "right" && rect.right + gap + size.width > vw && rect.left - gap - size.width >= 0) side = "left";
  else if (side === "left" && rect.left - gap - size.width < 0) side = "right";

  let x: number;
  let y: number;
  if (side === "top" || side === "bottom") {
    y = side === "bottom" ? rect.bottom + gap : rect.top - gap - size.height;
    x = align === "start" ? rect.left : align === "end" ? rect.right - size.width : rect.left + rect.width / 2 - size.width / 2;
  } else {
    x = side === "right" ? rect.right + gap : rect.left - gap - size.width;
    y = align === "start" ? rect.top : align === "end" ? rect.bottom - size.height : rect.top + rect.height / 2 - size.height / 2;
  }
  x = Math.min(Math.max(8, x), Math.max(8, vw - size.width - 8));
  y = Math.min(Math.max(8, y), Math.max(8, vh - size.height - 8));
  return { x, y, side };
}

/** Move the node to document.body so no parent's overflow or stacking context clips it. */
export function portal(node: HTMLElement) {
  document.body.appendChild(node);
  return {
    destroy() {
      node.remove();
    },
  };
}

let layer = 1000;
/** A z-index above every floating surface or dialog opened before it, so a menu opened inside a dialog stacks above the dialog. */
export function nextLayer(): number {
  layer += 1;
  return layer;
}
