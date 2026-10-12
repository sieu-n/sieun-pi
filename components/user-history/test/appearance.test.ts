import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ACCENTS, APPEARANCE_KEY, applyAppearance, DEFAULT_APPEARANCE, DENSITIES, loadAppearance, parseAppearance, saveAppearance, TEXT_SIZES, THEME_COLORS, THEMES } from "../src/client/appearance.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); }, items };
}

test("a missing or broken saved appearance is today's look", () => {
  assert.deepEqual(parseAppearance(null), DEFAULT_APPEARANCE);
  assert.deepEqual(parseAppearance("{not json"), DEFAULT_APPEARANCE);
  assert.deepEqual(parseAppearance("[1,2]"), DEFAULT_APPEARANCE);
  assert.deepEqual(DEFAULT_APPEARANCE, { theme: "system", accent: "ocean", textSize: "normal", density: "comfortable" });
});

test("one bad field falls back alone and keeps the other picks", () => {
  assert.deepEqual(parseAppearance(JSON.stringify({ theme: "dark", accent: "neon", textSize: "large", density: 3 })),
    { theme: "dark", accent: "ocean", textSize: "large", density: "comfortable" });
});

test("a saved pick loads back the same in a new page", () => {
  const storage = memoryStorage();
  const pick = { theme: "light", accent: "violet", textSize: "small", density: "compact" } as const;
  saveAppearance(storage, pick);
  assert.equal(storage.items.get(APPEARANCE_KEY), JSON.stringify(pick));
  assert.deepEqual(loadAppearance(storage), pick);
  assert.deepEqual(loadAppearance(null), DEFAULT_APPEARANCE);
});

test("a storage that throws keeps the default and never breaks the page", () => {
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } };
  assert.deepEqual(loadAppearance(broken), DEFAULT_APPEARANCE);
  assert.doesNotThrow(() => saveAppearance(broken, { ...DEFAULT_APPEARANCE, theme: "dark" }));
});

function fakePage() {
  const metas = [{ name: "theme-color", media: "(prefers-color-scheme: light)", content: THEME_COLORS.light }, { name: "theme-color", media: "(prefers-color-scheme: dark)", content: THEME_COLORS.dark }];
  const viewport = { name: "viewport", media: "", content: "width=device-width" };
  const root = { dataset: {} as Record<string, string | undefined> };
  return { root, metas, viewport, page: { documentElement: root, querySelectorAll: (_selectors: "meta") => [viewport, ...metas] } };
}

test("applying sets a data attribute per changed field and clears it when the field goes back to default", () => {
  const { root, page } = fakePage();
  applyAppearance(page, { theme: "dark", accent: "rose", textSize: "large", density: "compact" });
  assert.deepEqual(root.dataset, { theme: "dark", accent: "rose", textSize: "large", density: "compact" });
  applyAppearance(page, { ...DEFAULT_APPEARANCE, theme: "light" });
  assert.deepEqual(root.dataset, { theme: "light" });
  applyAppearance(page, DEFAULT_APPEARANCE);
  assert.deepEqual(root.dataset, {});
});

test("a forced theme paints the window bar in that theme on either OS scheme, and System gives each scheme its own color back", () => {
  const { metas, viewport, page } = fakePage();
  applyAppearance(page, { ...DEFAULT_APPEARANCE, theme: "dark" });
  assert.deepEqual(metas.map(meta => meta.content), [THEME_COLORS.dark, THEME_COLORS.dark]);
  assert.equal(viewport.content, "width=device-width", "other metas stay as they are");
  applyAppearance(page, { ...DEFAULT_APPEARANCE, theme: "light" });
  assert.deepEqual(metas.map(meta => meta.content), [THEME_COLORS.light, THEME_COLORS.light]);
  applyAppearance(page, DEFAULT_APPEARANCE);
  assert.deepEqual(metas.map(meta => meta.content), [THEME_COLORS.light, THEME_COLORS.dark]);
});

test("app.css styles every non-default value the picker offers", async () => {
  const css = await readFile(new URL("../src/client/app.css", import.meta.url), "utf8");
  const attribute = { theme: "data-theme", accent: "data-accent", textSize: "data-text-size", density: "data-density" } as const;
  const options = { theme: THEMES, accent: ACCENTS, textSize: TEXT_SIZES, density: DENSITIES };
  for (const field of Object.keys(attribute) as (keyof typeof attribute)[]) {
    for (const value of options[field]) {
      if (value === DEFAULT_APPEARANCE[field]) continue;
      assert.ok(css.includes(`:root[${attribute[field]}="${value}"]`), `app.css has no rule for ${attribute[field]}="${value}"`);
    }
  }
  for (const accent of ACCENTS) assert.ok(css.includes(`[data-swatch="${accent}"]`), `the ${accent} swatch has no color`);
  assert.match(css, /:root\[data-theme="dark"\] \{ color-scheme: dark; \}/);
  assert.match(css, /font-size: var\(--chat-text\)/);
});
