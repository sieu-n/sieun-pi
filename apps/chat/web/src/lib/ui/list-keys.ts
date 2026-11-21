/**
 * The keys of a list a person works through, such as an agent's For list and For you: j or ArrowDown moves to the next row, k or ArrowUp
 * to the one above, e marks the focused row done and again opens it, Esc closes the open row, and Shift+Esc marks the whole list done, as
 * Slack's mark-all-read.
 */
export type ListKey = "next" | "prev" | "toggle" | "all" | "close";

/** True when the key goes to a text field, so a list key must not take it. */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/** The list action a keydown asks for, or null when it asks for none or a text field has it. */
export function listKey(e: KeyboardEvent): ListKey | null {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return null;
  if (e.key === "Escape") return e.shiftKey ? "all" : "close";
  if (e.shiftKey) return null;
  switch (e.key) {
    case "j":
    case "ArrowDown":
      return "next";
    case "k":
    case "ArrowUp":
      return "prev";
    case "e":
      return "toggle";
    default:
      return null;
  }
}

/**
 * Moves focus to the next or previous element `selector` names inside `root`, from the one that holds focus, and answers it. With none
 * focused, next goes to the first and prev to the last.
 */
export function moveListFocus(root: HTMLElement, selector: string, step: "next" | "prev"): HTMLElement | null {
  const rows = [...root.querySelectorAll<HTMLElement>(selector)];
  if (!rows.length) return null;
  const at = rows.findIndex((row) => row === document.activeElement || row.contains(document.activeElement));
  const next = at < 0 ? (step === "next" ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + (step === "next" ? 1 : -1)));
  const row = rows[next]!;
  row.focus();
  row.scrollIntoView({ block: "nearest" });
  return row;
}
