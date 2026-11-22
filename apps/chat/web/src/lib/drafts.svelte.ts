/**
 * The owner's unsent drafts, one per conversation box and one per thread box, kept in localStorage as `chat.draft.<key>` so a reload or a
 * release keeps them (lib/api/reload.ts). The Composer writes here as he types; the sidebar draws a pencil on a room with a draft and the
 * Drafts page lists them all, as Slack's Drafts & sent does. A `storage` event keeps a second tab's list current.
 *
 * Until 11-22 a thread box saved under `thread:<root post or job id>`, which named no room, so the same post id in two channels shared one
 * draft. Those drafts load as `legacy` places and move to their room's `reply:` key as soon as the room is known: a job's from the agent
 * it works for, a channel post's from the one channel that has that post as a thread, and any other when the owner opens a thread with
 * that id. Until then the Drafts page lists them, readable, so no typed text is dropped.
 */
import { SvelteMap } from "svelte/reactivity";
import { agents, api, jobs } from "$lib/api";
import { hrefFor } from "$lib/router.svelte";
import { sidebar } from "$lib/shell/sidebar.svelte";
import { toast } from "$lib/ui/toast.svelte";

const PREFIX = "chat.draft.";
const REPLY = "reply:";
const LEGACY = "thread:";
/** The `thread:<room>:<thread>` keys 363f5088 wrote for about an hour on 11-21, whose room ids all start with one of these. */
const ROOM_FIRST = /^((?:ch|dm|so)_[^:]+):(.+)$/;
const POST = /^p\d+$/;

/**
 * Where a draft sits: a conversation's own box, the thread pane of one of its posts or jobs, or a thread box saved before 11-22 whose
 * room is not known yet.
 */
export type DraftPlace = { kind: "room"; room: string } | { kind: "thread"; room: string; thread: string } | { kind: "legacy"; thread: string };
export type Draft = { key: string; place: DraftPlace; text: string; at: number };

export const draftsHref = (): string => hrefFor("messages", ["drafts"]);
export const roomDraftKey = (room: string): string => room;
/** The room is encoded, so a job conversation id, which holds a colon, still splits from the thread at the first colon. */
export const threadDraftKey = (room: string, thread: string): string => `${REPLY}${encodeURIComponent(room)}:${thread}`;

export function placeOf(key: string): DraftPlace | null {
  if (key.startsWith(LEGACY)) {
    const thread = key.slice(LEGACY.length);
    return thread ? { kind: "legacy", thread } : null;
  }
  if (!key.startsWith(REPLY)) return key ? { kind: "room", room: key } : null;
  const rest = key.slice(REPLY.length);
  const cut = rest.indexOf(":");
  if (cut <= 0 || cut === rest.length - 1) return null;
  try {
    return { kind: "thread", room: decodeURIComponent(rest.slice(0, cut)), thread: rest.slice(cut + 1) };
  } catch {
    return null;
  }
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
  /** Post ids whose channels this page already asked about, so a draft no single channel claims is asked about once per load. */
  private readonly asked = new Set<string>();
  private resolving = false;
  /** A call that came while one was asking the server, which runs once that one ends, since the jobs or the sidebar may have loaded. */
  private again = false;

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
    for (const draft of this.legacy) {
      const named = ROOM_FIRST.exec(draft.place.thread);
      if (named?.[1] && named[2]) this.move(draft, threadDraftKey(named[1], named[2]));
    }
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

  /** Every draft, the last one edited first. */
  get list(): Draft[] {
    return [...this.byKey.values()].sort((a, b) => b.at - a.at);
  }

  private get legacy(): (Draft & { place: { kind: "legacy" } })[] {
    return [...this.byKey.values()].filter((d): d is Draft & { place: { kind: "legacy" } } => d.place.kind === "legacy");
  }

  text(key: string): string | null {
    return this.byKey.get(key)?.text ?? null;
  }

  /** The key's draft, else a thread draft saved before 11-22 under the same thread id, which moves to this key and room. */
  take(key: string): string | null {
    const own = this.text(key);
    if (own !== null) return own;
    const place = placeOf(key);
    const old = place?.kind === "thread" ? this.legacy.find((d) => d.place.thread === place.thread) : undefined;
    return old && this.move(old, key) ? old.text : null;
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

  /** Moves a draft to another key unless that key holds a draft of its own, in which case both stay. */
  private move(draft: Draft, key: string): boolean {
    if (this.byKey.has(key)) return false;
    this.write(key, draft.text, draft.at);
    this.drop(draft.key);
    return true;
  }

  /**
   * Gives each thread draft saved before 11-22 its room once the page knows it: a job's draft goes to the DM of the agent the job works
   * for, and a post's draft to the one channel that has that post as a thread, or failing that the one channel that has the post at all.
   * Runs again as the jobs and the sidebar load; each post id is asked about once.
   */
  async resolveLegacy(): Promise<void> {
    if (this.resolving) {
      this.again = true;
      return;
    }
    this.resolving = true;
    this.again = false;
    try {
      for (const draft of this.legacy) {
        const thread = draft.place.thread;
        const agent = jobs.byId(thread)?.agent;
        if (agent) {
          this.move(draft, threadDraftKey(agents.room(agent.id), thread));
          continue;
        }
        const channels = sidebar.data.channels;
        if (!POST.test(thread) || this.asked.has(thread) || !channels.length) continue;
        this.asked.add(thread);
        // No view waits on these lookups, so they go out as reads ahead: on 11-21 at 22:49 UTC one legacy draft's 12 lookups counted as
        // reply opens of 206 to 400 ms in the d2 duty (requests/2026-11-21.jsonl).
        const found = await Promise.all(channels.map((c) => api.replies(c.id, thread, { background: "ahead" }).then((r) => ({ room: c.id, replies: r.items.length }), () => null)));
        const rooms = found.filter((f) => f !== null);
        const threads = rooms.filter((f) => f.replies > 0);
        const room = threads.length === 1 ? threads[0]?.room : threads.length === 0 && rooms.length === 1 ? rooms[0]?.room : undefined;
        if (room) this.move(draft, threadDraftKey(room, thread));
      }
    } finally {
      this.resolving = false;
    }
    if (this.again) await this.resolveLegacy();
  }

  /** Deletes a draft from the Drafts list, with an Undo that puts it back as it was. */
  remove(draft: Draft): void {
    this.drop(draft.key);
    toast.show("Draft deleted", { action: { label: "Undo", run: () => this.write(draft.key, draft.text, draft.at) } });
  }
}

export const drafts = new Drafts();
