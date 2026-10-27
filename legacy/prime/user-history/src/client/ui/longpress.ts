/** Calls `fn` with the node after a 500 ms touch or pen press that stays within 8 px, so a phone gets the action a mouse gets on hover. */
export function longpress(node: HTMLElement, fn: (node: HTMLElement) => void) {
  let current = fn;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start = { x: 0, y: 0 };
  const clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  const down = (event: PointerEvent) => {
    if (event.pointerType === "mouse") return;
    clear();
    start = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => { timer = null; current(node); }, 500);
  };
  const move = (event: PointerEvent) => { if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) clear(); };
  const ends = ["pointerup", "pointercancel", "pointerleave"] as const;
  node.addEventListener("pointerdown", down);
  node.addEventListener("pointermove", move);
  for (const name of ends) node.addEventListener(name, clear);
  return {
    update(next: (node: HTMLElement) => void) { current = next; },
    destroy() {
      clear();
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", move);
      for (const name of ends) node.removeEventListener(name, clear);
    },
  };
}
