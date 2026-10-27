export type ToastTone = "neutral" | "success" | "danger";
export type ToastItem = {
  id: number;
  text: string;
  tone: ToastTone;
  /** Optional one button, for example Undo or Retry. */
  action?: { label: string; run: () => void };
  /** Milliseconds before it hides. 0 keeps it until dismissed. */
  duration: number;
};

class Toasts {
  items = $state<ToastItem[]>([]);
  private next = 1;

  show(text: string, opts: { tone?: ToastTone; action?: ToastItem["action"]; duration?: number } = {}): number {
    const id = this.next++;
    const item: ToastItem = { id, text, tone: opts.tone ?? "neutral", duration: opts.duration ?? (opts.tone === "danger" ? 8000 : 4000) };
    if (opts.action) item.action = opts.action;
    this.items = [...this.items, item].slice(-4);
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
