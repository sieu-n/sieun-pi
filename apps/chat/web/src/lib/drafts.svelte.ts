/**
 * The owner's unsent drafts, one per conversation box and one per thread box, kept in localStorage as `chat.draft.<key>` so a reload or a
 * release keeps them (lib/api/reload.ts). The Composer writes here as he types; the sidebar draws a pencil on a room with a draft and the
 * Drafts page lists them all, as Slack's Drafts & sent does. A `storage` event keeps a second tab's list current.
 */
import { SvelteMap } from "svelte/reactivity";
import { hrefFor } from "$lib/router.svelte";
import { toast } from "$lib/ui/toast.svelte";

const PREFIX = "chat.draft.";
const THREAD = "thread:";

/** Where a draft sits: a conversation's own box, or the thread pane of one of its posts or jobs. */
export type DraftPlace = { kind: "room"; room: string } | { kind: "thread"; room: string; thread: string };
export type Draft = { key: string; place: DraftPlace; text: string; at: number };

export const draftsHref = (): string => hrefFor("messages", ["drafts"]);
export const roomDraftKey = (room: string): string => room;
export const threadDraftKey = (room: string, thread: string): string => `${THREAD}${room}:${thread}`;

/** The place a key names, or null for a thread key from before 11-22, which named no room and so can't be opened again. */
export function placeOf(key: string): DraftPlace | null {
  if (!key.startsWith(THREAD)) return key ? { kind: "room", room: key } : null;
  const rest = key.slice(THREAD.length);
  const cut = rest.indexOf(":");
  return cut > 0 && cut < rest.length - 1 ? { kind: "thread", room: rest.slice(0, cut), thread: rest.slice(cut + 1) } : null;
}

/** A stored value: `{text, at}` since 11-22, or the bare text written before, which has no time. */
function parse(raw: string): { text: string; at: number } {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && "text" in value && typeof value.text === "string") {
      return { text: value.text, at: "at" in value && typeof value.at === "number" ? value.at : 0 };
    }
  } catch {}
  return { text: raw, at: 0 };
}

function stored(key: string, raw: string | null): Draft | null {
  const place = placeOf(key);
  if (!place || raw === null) return null;
  const { text, at } = parse(raw);
  return text.trim() ? { key, place, text, at } : null;
}

class Drafts {
  readonly byKey = new SvelteMap<string, Draft>();

  constructor() {
    if (typeof window === "undefined") return;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i);
        if (!name?.startsWith(PREFIX)) continue;
        const draft = stored(name.slice(PREFIX.length), localStorage.getItem(name));
        if (draft) this.byKey.set(draft.key, draft);
      }
    } catch {}
    window.addEventListener("storage", (e) => {
      if (e.storageArea !== localStorage) return;
      if (e.key === null) return this.byKey.clear();
      if (!e.key.startsWith(PREFIX)) return;
      const key = e.key.slice(PREFIX.length);
      const draft = stored(key, e.newValue);
      if (draft) this.byKey.set(key, draft);
      else this.byKey.delete(key);
    });
  }

  /** Every draft that can be opened again, the last one edited first. */
  get list(): Draft[] {
    return [...this.byKey.values()].sort((a, b) => b.at - a.at);
  }

  text(key: string): string | null {
    return this.byKey.get(key)?.text ?? null;
  }

  /** Whether the room's own box holds a draft; a thread draft shows only in the Drafts list, as in Slack. */
  inRoom(room: string): boolean {
    return this.byKey.has(roomDraftKey(room));
  }

  /** Keeps the text as the key's draft, or drops the draft when the text is blank. */
  write(key: string, text: string, at = Date.now()): void {
    const place = placeOf(key);
    if (!text.trim() || !place) return this.drop(key);
    if (this.byKey.get(key)?.text === text) return;
    this.byKey.set(key, { key, place, text, at });
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify({ text, at }));
    } catch {}
  }

  drop(key: string): void {
    this.byKey.delete(key);
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {}
  }

  /** Deletes a draft from the Drafts list, with an Undo that puts it back as it was. */
  remove(draft: Draft): void {
    this.drop(draft.key);
    toast.show("Draft deleted", { action: { label: "Undo", run: () => this.write(draft.key, draft.text, draft.at) } });
  }
}

export const drafts = new Drafts();
