/**
 * The owner's status, notification setting and recent searches on this page, the same in every browser and the Mac app. The server keeps
 * them (GET and PATCH /api/owner-settings), and a change in one page reaches the others as an `owner_settings` event. lib/presence.svelte.ts,
 * lib/notify-prefs.svelte.ts and pages/search/recent-searches.svelte.ts read and write through `ownerSettings`.
 *
 * Before the server kept them, each browser held its own copy in localStorage. The first load after the move sends those copies to the
 * server once, which merges them, and then removes them.
 */
import { api } from "$lib/api";
import { live } from "$lib/api/live.svelte";
import { defaultSettings, parseNotify, parsePresence, parseRecent, type OwnerSettings, type SavedSettings } from "$lib/api/shared/owner-settings";
import { toast } from "$lib/ui/toast.svelte";

const OLD_KEYS = { presence: "chat.presence", notify: "chat.notify", recentSearches: "chat.recentSearches" } as const;

/** This browser's old copies, parsed, with the keys they came from; empty when it holds none. */
function oldCopies(): { parts: Partial<OwnerSettings>; keys: string[] } {
  const parts: Partial<OwnerSettings> = {};
  const keys: string[] = [];
  for (const [part, key] of Object.entries(OLD_KEYS) as [keyof OwnerSettings, string][]) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {}
    if (raw === null) continue;
    keys.push(key);
    let data: unknown = null;
    try {
      data = JSON.parse(raw);
    } catch {}
    if (part === "presence") parts.presence = parsePresence(data);
    else if (part === "notify") parts.notify = parseNotify(data);
    else parts.recentSearches = parseRecent(data);
  }
  return { parts, keys };
}

/**
 * The server's copy with this page's edits still on their way laid over it, so an edit shows at once. Edits go out one at a time, in
 * order, and a copy from the server replaces the held one only when its `rev` is newer.
 */
class OwnerSettingsSync {
  private server = $state.raw<SavedSettings>(defaultSettings());
  private pending = $state.raw<{ id: number; parts: Partial<OwnerSettings> }[]>([]);
  private queue: Promise<unknown> = Promise.resolve();
  private next = 0;
  private started = false;
  private moved = false;

  get value(): OwnerSettings {
    this.start();
    return this.pending.reduce<OwnerSettings>((settings, edit) => ({ ...settings, ...edit.parts }), this.server);
  }

  private start(): void {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    live.on(event => {
      if (event.type === "owner_settings") this.take(event.settings);
      // A reconnect may have missed an event, so each hello reads the settings again.
      else if (event.type === "hello") void this.refresh();
    });
    void this.refresh();
  }

  /** Replaces each part `parts` names, here at once and on the server in order. */
  set(parts: Partial<OwnerSettings>): void {
    const id = ++this.next;
    this.pending = [...this.pending, { id, parts }];
    const drop = () => (this.pending = this.pending.filter(edit => edit.id !== id));
    this.queue = this.queue.then(() =>
      api.saveOwnerSettings(parts).then(
        saved => {
          this.take(saved);
          drop();
        },
        () => {
          drop();
          toast.error("Could not save your settings");
        },
      ),
    );
  }

  private take(saved: SavedSettings): void {
    if (saved.rev >= this.server.rev) this.server = saved;
  }

  private async refresh(): Promise<void> {
    try {
      this.take(await api.ownerSettings());
    } catch {
      return;
    }
    await this.moveOld();
  }

  /** Sends this browser's old localStorage copies to the server once and removes them after the server took them. */
  private async moveOld(): Promise<void> {
    if (this.moved) return;
    this.moved = true;
    const { parts, keys } = oldCopies();
    if (!keys.length) return;
    try {
      this.take(await api.importOwnerSettings(parts));
    } catch {
      this.moved = false;
      return;
    }
    for (const key of keys) {
      try {
        localStorage.removeItem(key);
      } catch {}
    }
  }
}

/** Starts on its first read, as the other live stores do: a socket opened at import would bring the hello before they listen. */
export const ownerSettings = new OwnerSettingsSync();
