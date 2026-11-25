import { api, type BuiltinSection, type ConversationSummary, type CustomSection, type SectionId, type SectionKey, type SectionSort, type SidebarLayout } from "$lib/api";
import { emptyLayout, isSectionId, parseLayout, sameSectionName } from "$lib/api/shared/sidebar-layout";
import { toast } from "$lib/ui/toast.svelte";
import { sidebar } from "./sidebar.svelte";

export type { BuiltinSection, CustomSection, SectionId, SectionKey, SectionSort };

/** Where a browser kept its sections before the server held them; the first browser to load uploads its copy once. */
const OLD_KEY = "chat.sidebarSections";

/** Each custom section with its rows, then the rows left for Channels and Direct messages, each sorted by its section's sort. */
export interface SidebarGroups {
  sections: { section: CustomSection; rows: ConversationSummary[] }[];
  channels: ConversationSummary[];
  dms: ConversationSummary[];
}

/** The section dialog's job: name a new section, optionally moving a room into it, rename one, or confirm deleting one that holds rooms. */
export type SectionDialogTarget = { kind: "new"; roomId?: string } | { kind: "rename"; id: SectionId } | { kind: "delete"; id: SectionId };

const byName = (a: ConversationSummary, b: ConversationSummary): number => a.name.localeCompare(b.name);

/** A section's rows in its sort: by name, newest activity first, or the dragged `order` with rooms missing from it after, by name. */
export function sortRows(rows: readonly ConversationSummary[], sort: SectionSort, order: readonly string[] = []): ConversationSummary[] {
  if (sort === "name") return [...rows].sort(byName);
  if (sort === "recent") return [...rows].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...rows].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || byName(a, b));
}

/** Splits the server's channel and DM rows over the custom sections, sorting each section as the owner set it. */
export function groupRows(channels: readonly ConversationSummary[], dms: readonly ConversationSummary[], layout: SidebarLayout): SidebarGroups {
  const sections = layout.sections.map((section) => ({ section, rows: [] as ConversationSummary[] }));
  const home = { channels: [] as ConversationSummary[], dms: [] as ConversationSummary[] };
  const place = (row: ConversationSummary, rest: ConversationSummary[]) => {
    const id = layout.placement[row.id];
    (sections.find((s) => s.section.id === id)?.rows ?? rest).push(row);
  };
  for (const row of channels) place(row, home.channels);
  for (const row of dms) place(row, home.dms);
  return {
    sections: sections.map(({ section, rows }) => ({ section, rows: sortRows(rows, section.sort, layout.order[section.id]) })),
    channels: sortRows(home.channels, layout.sort.channels, layout.order.channels),
    dms: sortRows(home.dms, layout.sort.dms, layout.order.dms),
  };
}

/** The rows a section shows: all of them, or only the ones `keep` names while it is folded, such as the open and the unread conversations. */
export function visibleRows<T>(rows: readonly T[], collapsed: boolean, keep: (row: T) => boolean): T[] {
  return collapsed ? rows.filter(keep) : [...rows];
}

/** The ids `ids` hold after `id` moves to just before `before`, or to the end when `before` is null or missing. */
export function reordered<T extends string>(ids: readonly T[], id: T, before: T | null): T[] {
  const rest = ids.filter((x) => x !== id);
  const at = before === null ? -1 : rest.indexOf(before);
  return at === -1 ? [...rest, id] : [...rest.slice(0, at), id, ...rest.slice(at)];
}

const copy = (layout: SidebarLayout): SidebarLayout => JSON.parse(JSON.stringify(layout)) as SidebarLayout;

/**
 * The owner's sections, placements, sorts and folds, kept by the server (PUT /api/sidebar/layout) so every browser and the desktop app
 * show one sidebar. An edit shows at once and goes out in order; until the server answers, this browser's copy wins over an older `rev`.
 */
class SidebarSections {
  private mine = $state.raw<{ layout: SidebarLayout; rev: number } | null>(null);
  private pending = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private migrated = false;
  dialog = $state<SectionDialogTarget | null>(null);

  get model(): SidebarLayout {
    const saved = sidebar.data.layout;
    if (this.mine && !(saved && saved.rev >= this.mine.rev)) return this.mine.layout;
    return saved ?? EMPTY;
  }

  get sections(): CustomSection[] {
    return this.model.sections;
  }

  section(id: SectionId): CustomSection | undefined {
    return this.model.sections.find((s) => s.id === id);
  }

  sectionOf(roomId: string): SectionId | null {
    return this.model.placement[roomId] ?? null;
  }

  isFolded(id: BuiltinSection | SectionId): boolean {
    return isSectionId(id) ? (this.section(id)?.collapsed ?? false) : this.model.collapsed[id];
  }

  sortOf(key: SectionKey): SectionSort {
    return isSectionId(key) ? (this.section(key)?.sort ?? "name") : this.model.sort[key];
  }

  toggle(id: BuiltinSection | SectionId): void {
    this.change((l) => {
      const section = l.sections.find((s) => s.id === id);
      if (section) section.collapsed = !section.collapsed;
      else if (!isSectionId(id)) l.collapsed[id] = !l.collapsed[id];
    });
  }

  /** Why a name cannot be used, or null when it can: blank, or another section already has it. */
  nameError(name: string, except?: SectionId): string | null {
    if (!name.trim()) return "Give the section a name";
    if (this.model.sections.some((s) => s.id !== except && sameSectionName(s.name, name))) return "A section with this name already exists";
    return null;
  }

  create(name: string, roomId?: string): SectionId {
    const id: SectionId = `sec_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.change((l) => {
      l.sections.push({ id, name: name.trim(), collapsed: false, sort: "name" });
      if (roomId) l.placement[roomId] = id;
    });
    return id;
  }

  rename(id: SectionId, name: string): void {
    this.change((l) => {
      const section = l.sections.find((s) => s.id === id);
      if (section) section.name = name.trim();
    });
  }

  /** Sets the emoji before a section's name, or takes it off with null. */
  setEmoji(id: SectionId, emoji: string | null): void {
    this.change((l) => {
      const section = l.sections.find((s) => s.id === id);
      if (!section) return;
      if (emoji) section.emoji = emoji;
      else delete section.emoji;
    });
  }

  /** Deletes a section, sending its rooms back to Channels and Direct messages, with Undo in the toast. */
  remove(id: SectionId): void {
    const before = copy(this.model);
    const name = this.section(id)?.name ?? "section";
    this.change((l) => {
      l.sections = l.sections.filter((s) => s.id !== id);
      for (const [room, section] of Object.entries(l.placement)) if (section === id) delete l.placement[room];
      delete l.order[id];
    });
    toast.show(`Deleted ${name}`, { action: { label: "Undo", run: () => this.change((l) => Object.assign(l, copy(before))) } });
  }

  /** Moves a channel or DM into a custom section, or back to Channels or Direct messages with null. */
  move(roomId: string, to: SectionId | null): void {
    if (to && !this.section(to)) return;
    this.change((l) => {
      if (to) l.placement[roomId] = to;
      else delete l.placement[roomId];
    });
  }

  /**
   * Drops a room into section `to` just before `before`, or at its end with null; `ids` are the section's rows as drawn. The section's
   * sort turns to custom, so the row stays where it was dropped, as Slack's drag does.
   */
  place(roomId: string, to: SectionKey, ids: readonly string[], before: string | null): void {
    this.change((l) => {
      if (isSectionId(to)) l.placement[roomId] = to;
      else delete l.placement[roomId];
      l.order[to] = reordered(ids, roomId, before);
      setSort(l, to, "custom");
    });
  }

  setSort(key: SectionKey, sort: SectionSort): void {
    this.change((l) => setSort(l, key, sort));
  }

  /** Moves a custom section to just before `before`, or below the others with null. */
  moveSection(id: SectionId, before: SectionId | null): void {
    this.change((l) => {
      const order = reordered(
        l.sections.map((s) => s.id),
        id,
        before,
      );
      l.sections = order.map((sid) => l.sections.find((s) => s.id === sid)!);
    });
  }

  /**
   * Uploads this browser's old localStorage sections once, while the server holds no sections yet, so the owner keeps what he set up.
   * A copy that comes too late, after another browser uploaded its own, stays in localStorage untouched.
   */
  migrate(): void {
    if (this.migrated || sidebar.state !== "ready") return;
    this.migrated = true;
    const old = read();
    if (!old) return;
    let data: unknown = null;
    try {
      data = JSON.parse(old);
    } catch {}
    const layout = parseLayout(data);
    if (layout.sections.length && this.model.sections.length) return;
    if (layout.sections.length) this.change((l) => Object.assign(l, layout));
    try {
      localStorage.removeItem(OLD_KEY);
    } catch {}
  }

  private change(edit: (layout: SidebarLayout) => void): void {
    const next = copy(this.model);
    edit(next);
    this.mine = { layout: next, rev: Infinity };
    this.pending += 1;
    this.queue = this.queue.then(() =>
      api.saveSidebarLayout(next).then(
        (saved) => {
          this.pending -= 1;
          if (!this.pending && this.mine) this.mine = { layout: this.mine.layout, rev: saved.rev };
        },
        () => {
          this.pending -= 1;
          if (!this.pending) this.mine = null;
          toast.error("Could not save your sidebar sections");
        },
      ),
    );
  }
}

const EMPTY = emptyLayout();

function setSort(layout: SidebarLayout, key: SectionKey, sort: SectionSort): void {
  if (!isSectionId(key)) layout.sort[key] = sort;
  else {
    const section = layout.sections.find((s) => s.id === key);
    if (section) section.sort = sort;
  }
}

function read(): string | null {
  try {
    return localStorage.getItem(OLD_KEY);
  } catch {
    return null;
  }
}

/** What a sidebar drag holds: a channel row, a DM row or a custom section by its heading. */
export type DragType = "channel" | "dm" | "section";
export const SECTION_DRAG_TYPE: DragType = "section";
/** The drag types a section takes: a custom section takes channels and DMs, Channels only channels and Direct messages only DMs. */
export const roomTypes = (key: SectionKey): DragType[] => (key === "channels" ? ["channel"] : key === "dms" ? ["dm"] : ["channel", "dm"]);

/** What a drop zone takes and does: `types` it accepts, the ones dropped `before` or after it by pointer height, and the handler. */
export interface DropOptions {
  types: readonly DragType[];
  /** Types that land before or after this element, marked `data-drop="before"` or `"after"`; the rest mark plain `data-drop`. */
  edges?: readonly DragType[];
  ondrop: (drop: { type: DragType; id: string; after: boolean }) => void;
}

/** What a drag source holds; `handle` is the part a drag must start on, such as a section's heading, so its rows keep their own drags. */
export interface DragSource {
  type: DragType;
  id: string;
  handle?: string;
}

const zones = new Map<HTMLElement, DropOptions>();
/** Pixels a press moves before it turns into a drag, so a click still opens the row. */
const SLOP = 4;
/** The band at the top and bottom of the sidebar's scroll box where a held drag scrolls it, and its fastest step per frame. */
const EDGE = 48;
const STEP = 16;

/** The innermost zone under the point that takes `type`, so a row's slot wins over its section. */
function zoneAt(x: number, y: number, type: DragType): HTMLElement | null {
  for (let n = document.elementFromPoint(x, y); n; n = n.parentElement) if (n instanceof HTMLElement && zones.get(n)?.types.includes(type)) return n;
  return null;
}

const below = (zone: HTMLElement, y: number): boolean => {
  const box = zone.getBoundingClientRect();
  return y > box.top + box.height / 2;
};

function scrollBox(node: HTMLElement): HTMLElement | null {
  for (let n = node.parentElement; n; n = n.parentElement) {
    const { overflowY } = getComputedStyle(n);
    if ((overflowY === "auto" || overflowY === "scroll") && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

/** Eats the click a released drag sends to the row it started on, so dropping a channel does not also open it. */
function swallowClick(): void {
  const stop = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, true), 0);
}

/** Follows one press on `node`: past SLOP it lifts the node under the pointer, marks the zone it would land in and drops there on release. */
function follow(node: HTMLElement, source: DragSource, down: PointerEvent): void {
  const root = document.documentElement;
  const box = scrollBox(node);
  const top0 = box?.scrollTop ?? 0;
  const [x0, y0] = [down.clientX, down.clientY];
  let [x, y] = [x0, y0];
  let live = false;
  let zone: HTMLElement | null = null;
  let frame = 0;
  let restore = "";
  const lift = () => {
    node.style.translate = `${x - x0}px ${y - y0 + (box ? box.scrollTop - top0 : 0)}px`;
  };
  const aim = () => {
    const next = zoneAt(x, y, source.type);
    if (zone && zone !== next) delete zone.dataset.drop;
    zone = next;
    if (zone) zone.dataset.drop = zones.get(zone)?.edges?.includes(source.type) ? (below(zone, y) ? "after" : "before") : "";
  };
  const scroll = () => {
    frame = requestAnimationFrame(scroll);
    if (!box) return;
    const { top, bottom } = box.getBoundingClientRect();
    const into = y < top + EDGE ? y - (top + EDGE) : y > bottom - EDGE ? y - (bottom - EDGE) : 0;
    if (!into) return;
    box.scrollTop += Math.max(-STEP, Math.min(STEP, into / 3));
    lift();
    aim();
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== down.pointerId) return;
    [x, y] = [e.clientX, e.clientY];
    if (!live) {
      if (Math.hypot(x - x0, y - y0) < SLOP) return;
      live = true;
      restore = node.style.cssText;
      Object.assign(node.style, { position: "relative", zIndex: "10", pointerEvents: "none", opacity: "0.92", boxShadow: "var(--shadow-float)", borderRadius: "var(--radius-row)", background: "var(--surface-panel)" });
      root.style.cursor = "grabbing";
      root.style.userSelect = "none";
      root.style.webkitUserSelect = "none";
      getSelection()?.removeAllRanges();
      try {
        node.setPointerCapture(down.pointerId);
      } catch {}
      frame = requestAnimationFrame(scroll);
    }
    lift();
    aim();
  };
  const end = (drop: boolean) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    if (!live) return;
    cancelAnimationFrame(frame);
    node.style.cssText = restore;
    root.style.cursor = root.style.userSelect = root.style.webkitUserSelect = "";
    swallowClick();
    const at = zone;
    if (at) delete at.dataset.drop;
    if (drop && at) zones.get(at)?.ondrop({ type: source.type, id: source.id, after: below(at, y) });
  };
  const up = (e: PointerEvent) => e.pointerId === down.pointerId && end(true);
  const cancel = (e: PointerEvent) => e.pointerId === down.pointerId && end(false);
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !live) return;
    e.preventDefault();
    e.stopPropagation();
    end(false);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
}

/**
 * Lets a channel or DM row, or a section by its heading, be dragged onto a `dropZone`. The sidebar moves its own drags with pointer events,
 * because HTML5 drag and drop never reaches the page in the Mac app: Tauri's file-drop handler takes every native drag over the window.
 */
export function dragSource(node: HTMLElement, source: DragSource) {
  let src = source;
  const press = (e: PointerEvent) => {
    if (e.button !== 0 || !e.isPrimary || e.pointerType === "touch") return;
    if (src.handle && !(e.target instanceof Element && e.target.closest(src.handle))) return;
    follow(node, src, e);
  };
  const native = (e: DragEvent) => e.preventDefault();
  node.addEventListener("pointerdown", press);
  node.addEventListener("dragstart", native);
  return {
    update(next: DragSource) {
      src = next;
    },
    destroy() {
      node.removeEventListener("pointerdown", press);
      node.removeEventListener("dragstart", native);
    },
  };
}

/** Makes an element a drop target for dragged rows or sections; it carries `data-drop` while a drag would land in it. */
export function dropZone(node: HTMLElement, options: DropOptions) {
  zones.set(node, options);
  return {
    update(next: DropOptions) {
      zones.set(node, next);
    },
    destroy() {
      zones.delete(node);
    },
  };
}

export const sidebarSections = new SidebarSections();
