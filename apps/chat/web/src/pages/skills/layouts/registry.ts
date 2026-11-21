/**
 * The Settings > Skills layouts. Each layout lives in its own folder, `layouts/<id>/<Name>Layout.svelte`, whose default export takes
 * `LayoutProps`; the folder name is the id that `#/settings/skills?layout=<id>` picks. Builders add a folder and touch nothing else, since
 * this list finds every folder by its file name. `current` is the page from before the skills DB, kept until the owner picks a layout.
 */
import type { Component } from "svelte";
import type { SkillsView } from "$lib/api/shared/skills";

export type LayoutProps = {
  /** GET /api/skills as last read. */
  view: SkillsView;
  /** Reads GET /api/skills again, for a layout after it sent a change. */
  reload: () => Promise<void>;
};

export type LayoutEntry = { id: string; label: string; component: Component<LayoutProps> };

const found = import.meta.glob<Component<LayoutProps>>("./*/*Layout.svelte", { eager: true, import: "default" });

export const DEFAULT_LAYOUT = "current";

/** Every layout by id, `current` first and the rest by name, with the id as its label in sentence case. */
export const LAYOUTS: readonly LayoutEntry[] = Object.entries(found)
  .map(([path, component]) => {
    const id = path.split("/")[1]!;
    return { id, label: id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, " "), component };
  })
  .sort((a, b) => Number(b.id === DEFAULT_LAYOUT) - Number(a.id === DEFAULT_LAYOUT) || a.id.localeCompare(b.id));

export function layoutOf(id: string | null | undefined): LayoutEntry | undefined {
  return LAYOUTS.find(layout => layout.id === id) ?? LAYOUTS.find(layout => layout.id === DEFAULT_LAYOUT);
}
