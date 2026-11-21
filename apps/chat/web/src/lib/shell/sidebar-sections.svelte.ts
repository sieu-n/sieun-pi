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

  /** Uploads this browser's old localStorage sections once, when the server holds no layout yet, so the owner keeps what he set up. */
  migrate(): void {
    if (this.migrated || sidebar.state !== "ready") return;
    this.migrated = true;
    const old = read();
    if (!old) return;
    if (!sidebar.data.layout) {
      let data: unknown = null;
      try {
        data = JSON.parse(old);
      } catch {}
      const layout = parseLayout(data);
      if (layout.sections.length || Object.values(layout.collapsed).some(Boolean)) this.change((l) => Object.assign(l, layout));
    }
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

const ROOM_TYPES = { channel: "application/x-chat-channel", dm: "application/x-chat-dm" } as const;
export const SECTION_DRAG_TYPE = "application/x-chat-section";
/** The drag types a section takes: a custom section takes channels and DMs, Channels only channels and Direct messages only DMs. */
export const roomTypes = (key: SectionKey): string[] => (key === "channels" ? [ROOM_TYPES.channel] : key === "dms" ? [ROOM_TYPES.dm] : Object.values(ROOM_TYPES));

/** Starts dragging a channel or DM row, for moving it between sections or within one. */
export function dragRoom(e: DragEvent, row: ConversationSummary): void {
  if (!e.dataTransfer || (row.kind !== "channel" && row.kind !== "dm")) return;
  e.dataTransfer.setData(ROOM_TYPES[row.kind], row.id);
  e.dataTransfer.effectAllowed = "move";
}

/** Starts dragging a custom section by its heading; a drag that starts on one of its rows is the row's. */
export function dragSection(e: DragEvent, id: SectionId): void {
  if (!e.dataTransfer || e.target !== e.currentTarget) return;
  e.dataTransfer.setData(SECTION_DRAG_TYPE, id);
  e.dataTransfer.effectAllowed = "move";
}

/** What a drop zone takes and does: `types` it accepts, the ones dropped `before` or after it by pointer height, and the handler. */
export interface DropOptions {
  types: readonly string[];
  /** Types that land before or after this element, marked `data-drop="before"` or `"after"`; the rest mark plain `data-drop`. */
  edges?: readonly string[];
  /** A zone inside another one keeps its drags from reaching the outer zone, as a row inside its section does. */
  inner?: boolean;
  ondrop: (drop: { type: string; id: string; after: boolean }) => void;
}

/** Makes an element a drop target for dragged rows or sections, marking it while one is over it. */
export function dropZone(node: HTMLElement, options: DropOptions) {
  let opts = options;
  let depth = 0;
  const typeOf = (e: DragEvent) => opts.types.find((t) => e.dataTransfer?.types.includes(t));
  const after = (e: DragEvent) => {
    const box = node.getBoundingClientRect();
    return e.clientY > box.top + box.height / 2;
  };
  const mark = (e: DragEvent | null, type?: string) => {
    if (!e || !type) delete node.dataset.drop;
    else node.dataset.drop = opts.edges?.includes(type) ? (after(e) ? "after" : "before") : "";
  };
  const claim = (e: DragEvent) => {
    const type = typeOf(e);
    if (type && opts.inner) e.stopPropagation();
    return type;
  };
  const enter = (e: DragEvent) => {
    const type = claim(e);
    if (!type) return;
    depth += 1;
    mark(e, type);
  };
  const over = (e: DragEvent) => {
    const type = claim(e);
    if (!type) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    mark(e, type);
  };
  const leave = (e: DragEvent) => {
    if (!claim(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) mark(null);
  };
  const drop = (e: DragEvent) => {
    const type = claim(e);
    depth = 0;
    mark(null);
    const id = type ? e.dataTransfer?.getData(type) : "";
    if (!type || !id) return;
    e.preventDefault();
    opts.ondrop({ type, id, after: after(e) });
  };
  node.addEventListener("dragenter", enter);
  node.addEventListener("dragover", over);
  node.addEventListener("dragleave", leave);
  node.addEventListener("drop", drop);
  return {
    update(next: DropOptions) {
      opts = next;
    },
    destroy() {
      node.removeEventListener("dragenter", enter);
      node.removeEventListener("dragover", over);
      node.removeEventListener("dragleave", leave);
      node.removeEventListener("drop", drop);
    },
  };
}

export const sidebarSections = new SidebarSections();
