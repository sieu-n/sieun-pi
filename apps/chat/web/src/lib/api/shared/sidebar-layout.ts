import type { BuiltinSection, CustomSection, SectionId, SectionSort, SidebarLayout } from "../types.ts";

/** The layout before the owner sets anything: no sections, nothing folded, channels by name and DMs newest first, as the server sends them. */
export const emptyLayout = (): SidebarLayout => ({
  sections: [],
  placement: {},
  collapsed: { starred: false, solo: false, channels: false, dms: false },
  sort: { channels: "name", dms: "recent" },
  order: {},
});

const BUILTIN: readonly BuiltinSection[] = ["starred", "solo", "channels", "dms"];
const SORTS: readonly SectionSort[] = ["name", "recent", "custom"];

export const isSectionId = (v: unknown): v is SectionId => typeof v === "string" && /^sec_[\w-]+$/.test(v);
const isSort = (v: unknown): v is SectionSort => SORTS.includes(v as SectionSort);
const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export const sameSectionName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Reads a layout from PUT /api/sidebar/layout or from a browser's old `chat.sidebarSections` copy, keeping only well-formed sections, the
 * placements and orders that name one of them, and known folds and sorts. A layout from before sorts existed keeps its custom sections
 * by name, the order they showed in.
 */
export function parseLayout(data: unknown): SidebarLayout {
  const layout = emptyLayout();
  const raw = record(data);
  if (!raw) return layout;
  if (Array.isArray(raw.sections)) {
    for (const item of raw.sections) {
      const s = record(item);
      if (!s || !isSectionId(s.id) || typeof s.name !== "string" || !s.name.trim()) continue;
      const { id, name } = s;
      if (layout.sections.some((x) => x.id === id || sameSectionName(x.name, name))) continue;
      const section: CustomSection = { id, name: name.trim(), collapsed: s.collapsed === true, sort: isSort(s.sort) ? s.sort : "name" };
      layout.sections.push(section);
    }
  }
  const known = (id: unknown): id is SectionId => isSectionId(id) && layout.sections.some((s) => s.id === id);
  for (const [room, section] of Object.entries(record(raw.placement) ?? {})) if (known(section)) layout.placement[room] = section;
  const collapsed = record(raw.collapsed) ?? {};
  for (const key of BUILTIN) layout.collapsed[key] = collapsed[key] === true;
  const sort = record(raw.sort) ?? {};
  if (isSort(sort.channels)) layout.sort.channels = sort.channels;
  if (isSort(sort.dms)) layout.sort.dms = sort.dms;
  for (const [key, ids] of Object.entries(record(raw.order) ?? {})) {
    if (!(key === "channels" || key === "dms" || known(key)) || !Array.isArray(ids)) continue;
    layout.order[key] = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  }
  return layout;
}
