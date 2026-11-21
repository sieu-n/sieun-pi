import type { MenuEntry } from "./menu";

export type ToastTone = "neutral" | "success" | "danger";
/** A toast button: `run` on click, or a `menu` that opens above it, such as a reminder's Snooze times; a pick closes the toast. */
export type ToastAction = { label: string; run: () => void } | { label: string; menu: () => MenuEntry[] };
export type ToastItem = {
  id: number;
  text: string;
  tone: ToastTone;
  /** Its buttons, for example Undo or Retry, or a reminder's View, Mark complete and Snooze. */
  actions: ToastAction[];
  /** Milliseconds before it hides. 0 keeps it until dismissed. */
  duration: number;
};

class Toasts {
  items = $state<ToastItem[]>([]);
  private next = 1;

  /** `action` is one button; `actions` is several, in order. */
  show(text: string, opts: { tone?: ToastTone; action?: ToastAction; actions?: ToastAction[]; duration?: number } = {}): number {
    const id = this.next++;
    const actions = opts.actions ?? (opts.action ? [opts.action] : []);
    const item: ToastItem = { id, text, tone: opts.tone ?? "neutral", actions, duration: opts.duration ?? (opts.tone === "danger" ? 8000 : 4000) };
    // Four show at once. A fifth pushes out the oldest toast that hides by itself, so a toast that waits for him, such as a due reminder,
    // stays until he acts on it.
    const items = [...this.items, item];
    while (items.length > 4) items.splice(Math.max(0, items.findIndex((t) => t.duration > 0)), 1);
    this.items = items;
    if (item.duration > 0) setTimeout(() => this.dismiss(id), item.duration);
    return id;
  }
  success(text: string, opts: Omit<Parameters<Toasts["show"]>[1], "tone"> = {}): number {
    return this.show(text, { ...opts, tone: "success" });
  }
  error(text: string, opts: Omit<Parameters<Toasts["show"]>[1], "tone"> = {}): number {
    return this.show(text, { ...opts, tone: "danger" });
  }
  dismiss(id: number): void {
    this.items = this.items.filter((t) => t.id !== id);
  }
}

/** `toast.show("Copied link")`, `toast.success("Saved")`, `toast.error("Send failed", { action: { label: "Retry", run } })`. */
export const toast = new Toasts();
