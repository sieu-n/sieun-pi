import { place, type Placement } from "./floating";

export type TooltipOptions = { text: string; shortcut?: string | undefined; placement?: Placement; delay?: number } | string | null | undefined;

let tip: HTMLDivElement | null = null;

function element(): HTMLDivElement {
  if (tip) return tip;
  tip = document.createElement("div");
  tip.className = "ui-tooltip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  return tip;
}

/**
 * `use:tooltip={"Close"}` or `use:tooltip={{ text: "Search", shortcut: "⌘K", placement: "bottom" }}`.
 * One shared tooltip element shows after a short hover or on keyboard focus.
 */
export function tooltip(node: HTMLElement, options: TooltipOptions) {
  let opts = normalize(options);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function show() {
    if (!opts) return;
    const current = opts;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!node.isConnected) return;
      const el = element();
      el.textContent = current.text;
      if (current.shortcut) {
        const kbd = document.createElement("kbd");
        kbd.textContent = current.shortcut;
        el.appendChild(kbd);
      }
      el.dataset.open = "";
      const size = el.getBoundingClientRect();
      const pos = place(node.getBoundingClientRect(), size, current.placement ?? "bottom", 6);
      el.style.transform = `translate(${Math.round(pos.x)}px, ${Math.round(pos.y)}px)`;
    }, current.delay ?? 450);
  }
  function hide() {
    clearTimeout(timer);
    if (tip) delete tip.dataset.open;
  }
  node.addEventListener("pointerenter", show);
  node.addEventListener("pointerleave", hide);
  node.addEventListener("pointerdown", hide);
  node.addEventListener("focusin", onFocus);
  node.addEventListener("focusout", hide);
  function onFocus() {
    if (document.documentElement.dataset.keyboardNavigation !== undefined) show();
  }
  return {
    update(next: TooltipOptions) {
      opts = normalize(next);
    },
    destroy() {
      hide();
      node.removeEventListener("pointerenter", show);
      node.removeEventListener("pointerleave", hide);
      node.removeEventListener("pointerdown", hide);
      node.removeEventListener("focusin", onFocus);
      node.removeEventListener("focusout", hide);
    },
  };
}

function normalize(o: TooltipOptions) {
  if (!o) return null;
  return typeof o === "string" ? { text: o } : o;
}
