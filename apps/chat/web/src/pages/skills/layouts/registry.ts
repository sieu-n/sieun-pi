/**
 * The Settings > Skills layouts. Each layout lives in its own folder, `layouts/<id>/<Name>Layout.svelte`, whose default export takes
 * `LayoutProps`; the folder name is the id that `#/settings/skills?layout=<id>` picks. Builders add a folder and touch nothing else, since
 * this list finds every folder by its file name. The owner picked `tree` to open with no `?layout=` on 11-23 (For you todo t5, msgs mwtcvfr9
 * then mwtcwn3p). `current` is the page from before the skills DB, which draws the scanner's inventory instead of the view; it stays as the
 * last view, because only it shows a skill's SKILL.md text, its last uses linked into their threads and its last commit.
 */
import type { Component } from "svelte";
import type { SkillsView } from "$lib/api/shared/skills";

export type LayoutProps = {
  /** GET /api/skills as last read. */
  view: SkillsView;
  /** Reads GET /api/skills again, for a layout after it sent a change. */
  reload: () => Promise<void>;
};

/** How wide the page column is for a layout, as Page's `measure` takes it. */
export type LayoutMeasure = "default" | "wide" | "full";

/** `text` says the layout shows skill descriptions, which come in GET /api/skills/text apart from the view, so it draws once they did too. */
export type LayoutEntry = { id: string; label: string; measure: LayoutMeasure; text: boolean; component: Component<LayoutProps> };

/** The layouts that need more than the wide column: the kinds matrix has 11 kind columns beside the skill, about 1,250 px. */
const MEASURES: Readonly<Record<string, LayoutMeasure>> = { kinds: "full" };

/**
 * The layouts that draw before the descriptions come: the tree shows one only in a skill's detail, which fills it in when it comes. Kinds
 * and problem search descriptions, show them in rows and count their tokens, so they wait for both reads.
 */
const NO_TEXT: ReadonlySet<string> = new Set(["tree", "current"]);

const found = import.meta.glob<Component<LayoutProps>>("./*/*Layout.svelte", { eager: true, import: "default" });

/** The layout that opens when the address names none. */
export const DEFAULT_LAYOUT = "tree";
/** The one layout that draws GET /api/skills/inventory; every other layout draws GET /api/skills. */
export const INVENTORY_LAYOUT = "current";

/** Labels that differ from the id: `current` stopped being the current page once the owner picked `tree`. */
const LABELS: Readonly<Record<string, string>> = { [INVENTORY_LAYOUT]: "Inventory" };

const rank = (id: string): number => (id === DEFAULT_LAYOUT ? 0 : id === INVENTORY_LAYOUT ? 2 : 1);

/** Every layout by id: the default first, the inventory last, and the rest by name, each with its id as its label in sentence case. */
export const LAYOUTS: readonly LayoutEntry[] = Object.entries(found)
  .map(([path, component]) => {
    const id = path.split("/")[1]!;
    return { id, label: LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, " "), measure: MEASURES[id] ?? "wide", text: !NO_TEXT.has(id), component };
  })
  .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));

export function layoutOf(id: string | null | undefined): LayoutEntry | undefined {
  return LAYOUTS.find(layout => layout.id === id) ?? LAYOUTS.find(layout => layout.id === DEFAULT_LAYOUT);
}
