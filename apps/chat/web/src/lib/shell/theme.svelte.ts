export type ColorMode = "light" | "dark" | "system";

const KEY = "chat.colorMode";

class Theme {
  mode = $state<ColorMode>(read());

  constructor() {
    if (typeof window === "undefined") return;
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.apply());
    this.apply();
  }

  set(mode: ColorMode): void {
    this.mode = mode;
    try {
      if (mode === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, mode);
    } catch {}
    this.apply();
  }

  private apply(): void {
    const dark = this.mode === "dark" || (this.mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.colorMode = dark ? "dark" : "light";
  }
}

function read(): ColorMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export const theme = new Theme();
