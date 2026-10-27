/**
 * Focus rings show only after keyboard use: a Tab or arrow key sets html[data-keyboard-navigation],
 * and a pointer press clears it. Call once at startup.
 */
export function trackKeyboardNavigation(): void {
  const root = document.documentElement;
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Tab" || e.key.startsWith("Arrow")) root.dataset.keyboardNavigation = "";
    },
    true,
  );
  window.addEventListener("pointerdown", () => delete root.dataset.keyboardNavigation, true);
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** True for Cmd on a Mac and Ctrl elsewhere. */
export function modKey(e: KeyboardEvent | MouseEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/** Keep Tab and Shift Tab inside `node`. */
export function trapFocus(node: HTMLElement) {
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Tab") return;
    const items = focusables(node);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
  node.addEventListener("keydown", onKeydown);
  return { destroy: () => node.removeEventListener("keydown", onKeydown) };
}
