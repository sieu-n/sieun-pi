/** The look the person picks in Settings > Appearance, saved per browser and applied as data attributes on <html> that app.css reads. */
export const THEMES = ["system", "light", "dark"] as const;
export const ACCENTS = ["ocean", "violet", "green", "amber", "rose", "graphite"] as const;
export const TEXT_SIZES = ["small", "normal", "large"] as const;
export const DENSITIES = ["comfortable", "compact"] as const;

export type Theme = (typeof THEMES)[number];
export type Accent = (typeof ACCENTS)[number];
export type TextSize = (typeof TEXT_SIZES)[number];
export type Density = (typeof DENSITIES)[number];
export interface Appearance { theme: Theme; accent: Accent; textSize: TextSize; density: Density }

/** Today's look: the OS scheme, the ocean accent, 15 px text, comfortable spacing. */
export const DEFAULT_APPEARANCE: Readonly<Appearance> = { theme: "system", accent: "ocean", textSize: "normal", density: "comfortable" };
export const APPEARANCE_KEY = "chat.appearance";

const pick = <T extends string>(options: readonly T[], value: unknown, fallback: T): T => options.find(option => option === value) ?? fallback;

/** A saved value from any version or tab: each field falls back to the default on its own, so one bad field keeps the rest. */
export function parseAppearance(raw: string | null): Appearance {
  let saved: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (typeof value === "object" && value !== null && !Array.isArray(value)) saved = value as Record<string, unknown>;
  } catch { /* A broken saved value starts from the default. */ }
  return {
    theme: pick(THEMES, saved.theme, DEFAULT_APPEARANCE.theme),
    accent: pick(ACCENTS, saved.accent, DEFAULT_APPEARANCE.accent),
    textSize: pick(TEXT_SIZES, saved.textSize, DEFAULT_APPEARANCE.textSize),
    density: pick(DENSITIES, saved.density, DEFAULT_APPEARANCE.density),
  };
}

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

export function loadAppearance(storage: KeyValueStore | null): Appearance {
  try { return parseAppearance(storage?.getItem(APPEARANCE_KEY) ?? null); } catch { return { ...DEFAULT_APPEARANCE }; }
}

export function saveAppearance(storage: KeyValueStore | null, appearance: Appearance): void {
  try { storage?.setItem(APPEARANCE_KEY, JSON.stringify(appearance)); } catch { /* Private mode keeps the choice for this tab only. */ }
}

/** The window bar color per scheme: `--bg` in app.css, the same colors the shell's two `theme-color` metas start with. */
export const THEME_COLORS = { light: "#f8f9fb", dark: "#17181c" } as const;

/** The parts of `document` the look touches. */
export interface Page {
  documentElement: { dataset: Record<string, string | undefined> };
  querySelectorAll(selectors: "meta"): Iterable<{ name: string; media: string; content: string }>;
}

/**
 * Sets `data-theme`, `data-accent`, `data-text-size` and `data-density` on the root; a default value removes its attribute, so today's CSS
 * applies unchanged. Each `theme-color` meta gets the forced theme's color, or its own media scheme's for System, so the installed app's title
 * bar follows the Theme pick and not only the OS scheme.
 */
export function applyAppearance(page: Page, appearance: Appearance): void {
  const root = page.documentElement;
  for (const field of Object.keys(DEFAULT_APPEARANCE) as (keyof Appearance)[]) {
    if (appearance[field] === DEFAULT_APPEARANCE[field]) delete root.dataset[field];
    else root.dataset[field] = appearance[field];
  }
  for (const meta of page.querySelectorAll("meta")) {
    if (meta.name === "theme-color") meta.content = THEME_COLORS[appearance.theme === "system" ? (meta.media.includes("dark") ? "dark" : "light") : appearance.theme];
  }
}

/** The browser's localStorage, or null where reading it throws (a sandboxed or private page). */
export function browserStorage(): Storage | null {
  try { return localStorage; } catch { return null; }
}
