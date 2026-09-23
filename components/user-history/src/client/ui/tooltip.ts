/**
 * Ported from the Virev `actions/tooltip.ts`: an inverted ink bubble with a tail, fixed to <body>, shown on hover and keyboard focus.
 * Use it only on controls without a visible label; the control still carries its own aria-label.
 */
const TAIL = 8;
const GAP = 8;

export function tooltip(node: HTMLElement, text: string | null | undefined): { update: (next: string | null | undefined) => void; destroy: () => void } {
  let bubble: HTMLDivElement | null = null;
  let label: HTMLSpanElement | null = null;
  let current = text ?? "";
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
    document.body.appendChild(bubble);
    const rect = node.getBoundingClientRect();
    const tip = bubble.getBoundingClientRect();
    const left = Math.max(4, Math.min(rect.left + rect.width / 2 - tip.width / 2, window.innerWidth - tip.width - 4));
    const above = rect.top - tip.height - GAP >= 4;
    bubble.style.left = `${Math.round(left)}px`;
    bubble.style.top = `${Math.round(above ? rect.top - tip.height - GAP : rect.bottom + GAP)}px`;
    const tailX = Math.max(8, Math.min(rect.left + rect.width / 2 - left - TAIL / 2, tip.width - 8 - TAIL));
    tail.style.left = `${Math.round(tailX)}px`;
    tail.style[above ? "bottom" : "top"] = `-${TAIL / 2}px`;
    bubble.animate([{ opacity: 0, transform: `translateY(${above ? 2 : -2}px)` }, { opacity: 1, transform: "none" }], { duration: 120, easing: "ease-out" });
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
    update(next) { current = next ?? ""; if (label) label.textContent = current; if (!current) hide(); },
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
