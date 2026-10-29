const KEY = "chat.sidebarFolds";

function read(): Record<string, boolean> {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!data || typeof data !== "object") return {};
    return Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([, v]) => v === true)) as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** Which SidebarSection blocks of the Agents, Board and Settings sidebars are folded, by `<root>:<section>`, saved in localStorage. */
class Folds {
  private folded = $state<Record<string, boolean>>(read());

  isFolded(key: string): boolean {
    return this.folded[key] === true;
  }

  toggle(key: string): void {
    if (this.folded[key]) delete this.folded[key];
    else this.folded[key] = true;
    try {
      localStorage.setItem(KEY, JSON.stringify($state.snapshot(this.folded)));
    } catch {}
  }
}

export const folds = new Folds();
