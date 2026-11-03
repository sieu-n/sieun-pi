/** Placement math and a portal action shared by Popover, Menu, Tooltip, Picker and the reaction card. */

export type Side = "top" | "bottom" | "left" | "right";
export type Align = "start" | "center" | "end";
export type Placement = Side | `${Side}-${Exclude<Align, "center">}`;
export type Anchor = HTMLElement | { x: number; y: number };

export function anchorRect(anchor: Anchor): DOMRect {
  if (anchor instanceof HTMLElement) return anchor.getBoundingClientRect();
  return new DOMRect(anchor.x, anchor.y, 0, 0);
}

/** Where a floating box sits, in its own CSS pixels, and the most height it may take on that side before it leaves the window. */
export type Placed = { x: number; y: number; side: Side; maxHeight: number };

const MARGIN = 8;
let probe: HTMLDivElement | null = null;

/**
 * The window in client pixels, the unit of getBoundingClientRect and clientX, and how many of them one CSS pixel of a box in body
 * takes. The interface size (Cmd + and Cmd -) sets CSS zoom on the root, so at 120% a box's translate of 100px lands 120 client
 * pixels in, and its rect reads 1.2 times its offsetWidth.
 */
function viewport(): { width: number; height: number; scale: number } {
  if (!probe?.isConnected) {
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:fixed;inset:0;visibility:hidden;pointer-events:none;contain:strict";
    document.body.appendChild(probe);
  }
  const rect = probe.getBoundingClientRect();
  return { width: rect.width, height: rect.height, scale: probe.offsetWidth ? rect.width / probe.offsetWidth : 1 };
}

/**
 * Top-left for `floating` next to `rect`, in the floating box's CSS pixels. The box flips to the other side when it does not fit and
 * the other side does, takes the roomier side and a smaller maxHeight when neither fits, and shifts along its side to stay in the window.
 * The size comes from offsetWidth and scrollHeight, which an enter animation's scale does not change.
 */
export function place(rect: DOMRect, floating: HTMLElement, placement: Placement, gap = 6): Placed {
  const [preferred, rawAlign] = placement.split("-") as [Side, Align | undefined];
  const align: Align = rawAlign ?? "center";
  const { width: vw, height: vh, scale } = viewport();
  const m = MARGIN * scale;
  const g = gap * scale;
  const w = floating.offsetWidth * scale;
  const natural = Math.max(floating.offsetHeight, floating.scrollHeight) * scale;
  const room: Record<Side, number> = {
    top: rect.top - g - m,
    bottom: vh - rect.bottom - g - m,
    left: rect.left - g - m,
    right: vw - rect.right - g - m,
  };
  const opposite: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };
  const vertical = preferred === "top" || preferred === "bottom";
  const need = vertical ? natural : w;
  let side = preferred;
  if (room[side] < need) {
    const other = opposite[side];
    if (room[other] >= need || room[other] > room[side]) side = other;
  }

  const fit = vertical ? Math.max(0, room[side]) : vh - 2 * m;
  const h = Math.min(natural, fit);
  let x: number;
  let y: number;
  if (vertical) {
    y = side === "bottom" ? rect.bottom + g : rect.top - g - h;
    x = align === "start" ? rect.left : align === "end" ? rect.right - w : rect.left + rect.width / 2 - w / 2;
  } else {
    x = side === "right" ? rect.right + g : rect.left - g - w;
    y = align === "start" ? rect.top : align === "end" ? rect.bottom - h : rect.top + rect.height / 2 - h / 2;
  }
  x = Math.min(Math.max(m, x), Math.max(m, vw - w - m));
  y = Math.min(Math.max(m, y), Math.max(m, vh - h - m));
  return { x: x / scale, y: y / scale, side, maxHeight: fit / scale };
}

/** A rect in the CSS pixels of a box in body, such as an anchor's width for a popover as wide as its anchor. */
export function cssWidth(rect: DOMRect): number {
  return rect.width / viewport().scale;
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
