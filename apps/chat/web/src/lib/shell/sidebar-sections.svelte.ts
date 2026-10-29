import type { ConversationSummary } from "$lib/api";

const KEY = "chat.sidebarSections";

/** The sidebar's built-in sections, each of which folds on its own. */
export type BuiltinSection = "solo" | "channels" | "dms";
export type SectionId = `sec_${string}`;

/** A section the owner made in the Team group, holding the channels he moves there. */
export interface CustomSection {
  id: SectionId;
  name: string;
  collapsed: boolean;
}

/** Everything the owner set about sections, saved in localStorage under `chat.sidebarSections`; the server keeps no sidebar settings. */
export interface SectionsModel {
  /** Custom sections in creation order. */
  sections: CustomSection[];
  /** Channel id to the custom section it sits in; a channel with no entry sits under Channels. */
  placement: Record<string, SectionId>;
  collapsed: Record<BuiltinSection, boolean>;
}

/** One custom section with its channels, and the channels left for the built-in Channels list. */
export interface ChannelGroups {
  sections: { section: CustomSection; rows: ConversationSummary[] }[];
  rest: ConversationSummary[];
}

/** The section dialog's job: name a new section, optionally moving a channel into it, rename one, or confirm deleting one that holds channels. */
export type SectionDialogTarget = { kind: "new"; channelId?: string } | { kind: "rename"; id: SectionId } | { kind: "delete"; id: SectionId };

const empty = (): SectionsModel => ({ sections: [], placement: {}, collapsed: { solo: false, channels: false, dms: false } });

const isSectionId = (v: unknown): v is SectionId => typeof v === "string" && /^sec_[\w-]+$/.test(v);

/** Reads a saved model, keeping only well-formed sections and the placements that name one of them. */
export function parseSections(raw: string | null): SectionsModel {
  const model = empty();
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    return model;
  }
  if (!data || typeof data !== "object") return model;
  const { sections, placement, collapsed } = data as Record<string, unknown>;
  if (Array.isArray(sections)) {
    for (const s of sections as unknown[]) {
      if (!s || typeof s !== "object") continue;
      const { id, name, collapsed: folded } = s as Record<string, unknown>;
      if (!isSectionId(id) || typeof name !== "string" || !name.trim()) continue;
      if (model.sections.some((x) => x.id === id || sameName(x.name, name))) continue;
      model.sections.push({ id, name: name.trim(), collapsed: folded === true });
    }
  }
  if (placement && typeof placement === "object") {
    for (const [channel, section] of Object.entries(placement as Record<string, unknown>)) {
      if (isSectionId(section) && model.sections.some((s) => s.id === section)) model.placement[channel] = section;
    }
  }
  if (collapsed && typeof collapsed === "object") {
    for (const key of ["solo", "channels", "dms"] as const) model.collapsed[key] = (collapsed as Record<string, unknown>)[key] === true;
  }
  return model;
}

/** Splits the server's channel rows over the custom sections, keeping the server's order inside each. */
export function groupChannels(rows: readonly ConversationSummary[], model: SectionsModel): ChannelGroups {
  const sections = model.sections.map((section) => ({ section, rows: [] as ConversationSummary[] }));
  const rest: ConversationSummary[] = [];
  for (const row of rows) {
    const id = model.placement[row.id];
    (sections.find((s) => s.section.id === id)?.rows ?? rest).push(row);
  }
  return { sections, rest };
}

/** The rows a section shows: all of them, or only the open conversation while it is folded. */
export function visibleRows<T extends { id: string }>(rows: readonly T[], collapsed: boolean, current: string | null): T[] {
  return collapsed ? rows.filter((row) => row.id === current) : [...rows];
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Custom sections, channel placement and folds, saved on every change. */
class SidebarSections {
  model = $state<SectionsModel>(parseSections(read()));
  dialog = $state<SectionDialogTarget | null>(null);

  get sections(): CustomSection[] {
    return this.model.sections;
  }

  section(id: SectionId): CustomSection | undefined {
    return this.model.sections.find((s) => s.id === id);
  }

  sectionOf(channelId: string): SectionId | null {
    return this.model.placement[channelId] ?? null;
  }

  isFolded(id: BuiltinSection | SectionId): boolean {
    return isSectionId(id) ? (this.section(id)?.collapsed ?? false) : this.model.collapsed[id];
  }

  toggle(id: BuiltinSection | SectionId): void {
    if (isSectionId(id)) {
      const section = this.section(id);
      if (section) section.collapsed = !section.collapsed;
    } else this.model.collapsed[id] = !this.model.collapsed[id];
    this.save();
  }

  /** Why a name cannot be used, or null when it can: blank, or another section already has it. */
  nameError(name: string, except?: SectionId): string | null {
    if (!name.trim()) return "Give the section a name";
    if (this.model.sections.some((s) => s.id !== except && sameName(s.name, name))) return "A section with this name already exists";
    return null;
  }

  create(name: string, channelId?: string): SectionId {
    const id: SectionId = `sec_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.model.sections.push({ id, name: name.trim(), collapsed: false });
    if (channelId) this.model.placement[channelId] = id;
    this.save();
    return id;
  }

  rename(id: SectionId, name: string): void {
    const section = this.section(id);
    if (!section) return;
    section.name = name.trim();
    this.save();
  }

  /** Deletes a section; its channels go back under Channels. */
  remove(id: SectionId): void {
    this.model.sections = this.model.sections.filter((s) => s.id !== id);
    for (const [channel, section] of Object.entries(this.model.placement)) if (section === id) delete this.model.placement[channel];
    this.save();
  }

  /** Moves a channel into a custom section, or back under Channels with null. */
  move(channelId: string, to: SectionId | null): void {
    if (to && !this.section(to)) return;
    if (to) this.model.placement[channelId] = to;
    else delete this.model.placement[channelId];
    this.save();
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify($state.snapshot(this.model)));
    } catch {}
  }
}

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export const CHANNEL_DRAG_TYPE = "application/x-chat-channel";

/** Makes an element a drop target for dragged channel rows, marking it while a row is over it. */
export function channelDrop(node: HTMLElement, ondrop: (channelId: string) => void) {
  let handler = ondrop;
  let depth = 0;
  const carries = (e: DragEvent) => !!e.dataTransfer?.types.includes(CHANNEL_DRAG_TYPE);
  const mark = (on: boolean) => (on ? node.setAttribute("data-drop", "") : node.removeAttribute("data-drop"));
  const enter = (e: DragEvent) => {
    if (!carries(e)) return;
    depth += 1;
    mark(true);
  };
  const over = (e: DragEvent) => {
    if (!carries(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  };
  const leave = (e: DragEvent) => {
    if (!carries(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) mark(false);
  };
  const drop = (e: DragEvent) => {
    const id = e.dataTransfer?.getData(CHANNEL_DRAG_TYPE);
    depth = 0;
    mark(false);
    if (!id) return;
    e.preventDefault();
    handler(id);
  };
  node.addEventListener("dragenter", enter);
  node.addEventListener("dragover", over);
  node.addEventListener("dragleave", leave);
  node.addEventListener("drop", drop);
  return {
    update(next: (channelId: string) => void) {
      handler = next;
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
