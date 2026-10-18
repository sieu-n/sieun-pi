/**
 * Ported from the Virev `actions/tooltip.ts`: an inverted ink bubble with a tail, fixed to <body>, shown on hover and keyboard focus.
 * Use it only on controls without a visible label; the control still carries its own aria-label.
 */
const TAIL = 8;
const GAP = 8;

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
export type TooltipSide = "above" | "right";
/** A tooltip's text, or the text and the side it prefers: `right` for a control in a vertical list, such as the Settings nav. */
export type TooltipParam = string | null | undefined | { text: string | null | undefined; side: TooltipSide };

/** Where the bubble goes, in viewport px: above the control (below when there is no room), or right of it (left when there is no room). */
export function placeTooltip(rect: Box, tip: { width: number; height: number }, viewport: { width: number; height: number }, side: TooltipSide):
  { left: number; top: number; tail: { side: "top" | "bottom" | "left" | "right"; offset: number } } {
  if (side === "right") {
    const right = rect.right + GAP + tip.width <= viewport.width - 4;
    const left = right ? rect.right + GAP : Math.max(4, rect.left - GAP - tip.width);
    const top = Math.max(4, Math.min(rect.top + rect.height / 2 - tip.height / 2, viewport.height - tip.height - 4));
    const offset = Math.max(6, Math.min(rect.top + rect.height / 2 - top - TAIL / 2, tip.height - 6 - TAIL));
    return { left: Math.round(left), top: Math.round(top), tail: { side: right ? "left" : "right", offset: Math.round(offset) } };
  }
  const left = Math.max(4, Math.min(rect.left + rect.width / 2 - tip.width / 2, viewport.width - tip.width - 4));
  const above = rect.top - tip.height - GAP >= 4;
  const offset = Math.max(8, Math.min(rect.left + rect.width / 2 - left - TAIL / 2, tip.width - 8 - TAIL));
  return { left: Math.round(left), top: Math.round(above ? rect.top - tip.height - GAP : rect.bottom + GAP), tail: { side: above ? "bottom" : "top", offset: Math.round(offset) } };
}

/**
 * The element the bubble joins: the open modal dialog around the control, else <body>. A modal dialog sits in the browser's top layer, above
 * everything in <body> whatever its z-index, so a bubble in <body> would draw behind the dialog.
 */
export function tooltipHost(node: Pick<Element, "closest">, body: HTMLElement): HTMLElement {
  return (node.closest("dialog[open]") as HTMLElement | null) ?? body;
}

const textOf = (param: TooltipParam): string => (typeof param === "object" && param !== null ? param.text : param) ?? "";
const sideOf = (param: TooltipParam): TooltipSide => typeof param === "object" && param !== null ? param.side : "above";

export function tooltip(node: HTMLElement, param: TooltipParam): { update: (next: TooltipParam) => void; destroy: () => void } {
  let bubble: HTMLDivElement | null = null;
  let label: HTMLSpanElement | null = null;
  let current = textOf(param);
  let side = sideOf(param);
  let pressed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function show(): void {
    if (!current || pressed || !node.isConnected) return;
    hide();
    bubble = document.createElement("div");
    bubble.setAttribute("role", "tooltip");
    bubble.className = "ui-tooltip";
    label = document.createElement("span");
    label.textContent = current;
    bubble.appendChild(label);
    const tail = document.createElement("div");
    tail.className = "ui-tooltip-tail";
    bubble.appendChild(tail);
    tooltipHost(node, document.body).appendChild(bubble);
    const place = placeTooltip(node.getBoundingClientRect(), bubble.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, side);
    bubble.style.left = `${place.left}px`;
    bubble.style.top = `${place.top}px`;
    const along = place.tail.side === "top" || place.tail.side === "bottom" ? "left" : "top";
    tail.style[along] = `${place.tail.offset}px`;
    tail.style[place.tail.side] = `-${TAIL / 2}px`;
    const from = { top: "translateY(-2px)", bottom: "translateY(2px)", left: "translateX(-2px)", right: "translateX(2px)" }[place.tail.side];
    bubble.animate([{ opacity: 0, transform: from }, { opacity: 1, transform: "none" }], { duration: 120, easing: "ease-out" });
  }
  function hide(): void {
    clearTimeout(timer);
    bubble?.remove();
    bubble = null;
    label = null;
  }
  const enter = () => { clearTimeout(timer); timer = setTimeout(show, 350); };
  const focus = () => { if (node.matches(":focus-visible")) show(); };
  const press = () => { pressed = true; hide(); };
  const leave = () => { pressed = false; hide(); };

  node.addEventListener("mouseenter", enter);
  node.addEventListener("mouseleave", leave);
  node.addEventListener("pointerdown", press);
  node.addEventListener("focus", focus);
  node.addEventListener("blur", hide);
  return {
    update(next) { current = textOf(next); side = sideOf(next); if (label) label.textContent = current; if (!current) hide(); },
    destroy() {
      hide();
      node.removeEventListener("mouseenter", enter);
      node.removeEventListener("mouseleave", leave);
      node.removeEventListener("pointerdown", press);
      node.removeEventListener("focus", focus);
      node.removeEventListener("blur", hide);
    },
  };
}
