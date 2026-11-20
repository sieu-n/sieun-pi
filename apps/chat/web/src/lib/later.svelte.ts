/**
 * Slack's Save for later on the page: the owner's Later list for the Later page, and the save and unsave every message's bookmark button
 * and menu item call (server/later.ts). A post's own `later` mark says whether it is saved; `optimistic` covers the moment between his
 * click and the post the server sends back, so the bookmark fills at once.
 */
import { SvelteMap } from "svelte/reactivity";
import { api, type Item, type LaterList, type LaterRow, type LaterState } from "$lib/api";
import { live } from "$lib/api/live.svelte";
import { hrefFor, router } from "$lib/router.svelte";
import { isOverdue } from "$lib/remind";
import type { MenuEntry } from "$lib/ui/menu";
import { toast } from "$lib/ui/toast.svelte";

type Message = Extract<Item, { kind: "message" }>;

const key = (room: string, post: string): string => `${room}:${post}`;

class LaterStore {
  /** Each tab's rows, newest first, once read. */
  lists = $state<Record<LaterState, LaterRow[] | null>>({ open: null, done: null });
  open = $state(0);
  done = $state(0);
  error = $state<string | null>(null);
  /** Saves and unsaves on their way, by `<room>:<post>`, which the bookmark shows before the server's answer. */
  readonly optimistic = new SvelteMap<string, boolean>();
  private started = false;
  private latest = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The last Later toast, which the next one replaces, so three quick saves show one toast as in Slack. */
  private toastId: number | undefined;

  private note(text: string, action: { label: string; run: () => void }): void {
    if (this.toastId !== undefined) toast.dismiss(this.toastId);
    this.toastId = toast.show(text, { action });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    live.on((event) => {
      if (event.type === "later" && event.by === "owner") this.open = event.open;
      if ((event.type === "later" && event.by === "owner") || event.type === "hello") {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh(), 80);
      }
    });
    queueMicrotask(() => void this.refresh());
  }

  /** Reads both tabs; only the newest read writes. */
  async refresh(): Promise<void> {
    const mine = ++this.latest;
    try {
      const [open, done] = await Promise.all([api.later("open"), api.later("done")]);
      if (mine !== this.latest) return;
      this.set(open, done);
      this.error = null;
    } catch (error) {
      if (mine === this.latest) this.error = error instanceof Error ? error.message : "Could not read Later.";
    }
  }

  private set(open: LaterList, done: LaterList): void {
    this.lists = { open: open.items, done: done.items };
    this.open = open.open;
    this.done = open.done;
  }

  /** Open rows whose reminder came due and is not done or snoozed, which the sidebar's Later row counts in red, as Slack's Later badge does. */
  get due(): number {
    return this.lists.open?.filter((row) => isOverdue(row)).length ?? 0;
  }

  /** Whether the post reads as saved: his click on its way, else the post's own mark. */
  saved(room: string, message: Pick<Message, "id" | "later">): boolean {
    return this.optimistic.get(key(room, message.id)) ?? !!message.later?.saved;
  }

  async save(room: string, post: string): Promise<void> {
    this.optimistic.set(key(room, post), true);
    try {
      await api.saveLater(room, post);
      this.note("Saved for later", { label: "View", run: () => router.navigate(laterHref()) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the message");
    } finally {
      this.optimistic.delete(key(room, post));
    }
  }

  async unsave(room: string, post: string): Promise<void> {
    this.optimistic.set(key(room, post), false);
    try {
      await api.unsaveLater(key(room, post));
      this.note("Removed from Later", { label: "Undo", run: () => void this.save(room, post) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the message from Later");
    } finally {
      this.optimistic.delete(key(room, post));
    }
  }

  toggle(room: string, message: Pick<Message, "id" | "later">): Promise<void> {
    return this.saved(room, message) ? this.unsave(room, message.id) : this.save(room, message.id);
  }

  /** Checks a row off, or moves a done row back to In progress; the row leaves its tab at once. */
  async setState(row: LaterRow, state: LaterState): Promise<void> {
    const from = row.state;
    this.move(row, state);
    try {
      await api.patchLater(row.id, { state });
      if (state === "done") this.note("Marked complete", { label: "Undo", run: () => void this.setState({ ...row, state: "done" }, "open") });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the item");
    }
    if (from !== state) void this.refresh();
  }

  /** Unsaves a row from the Later page. */
  async remove(row: LaterRow): Promise<void> {
    this.lists = { ...this.lists, [row.state]: this.lists[row.state]?.filter((r) => r.id !== row.id) ?? null };
    await this.unsave(row.room, row.post);
  }

  private move(row: LaterRow, state: LaterState): void {
    const without = (list: LaterRow[] | null) => list?.filter((r) => r.id !== row.id) ?? null;
    this.lists = { open: without(this.lists.open), done: without(this.lists.done) };
    if (row.state !== state) {
      this.open += state === "open" ? 1 : -1;
      this.done += state === "done" ? 1 : -1;
    }
  }
}

export const later = new LaterStore();

/** Later is a Messages view: `#/c/later` is In progress and `#/c/later/done` Completed. */
export const laterHref = (done = false): string => hrefFor("messages", done ? ["later", "done"] : ["later"]);

/** The message menu's Save for later item, or Remove from Later on a saved post. */
export function laterMenuItem(room: string, message: Pick<Message, "id" | "later">): MenuEntry {
  const saved = later.saved(room, message);
  return {
    id: "later", label: saved ? "Remove from Later" : "Save for later", icon: saved ? "bookmark-filled" : "bookmark",
    onselect: () => void later.toggle(room, message),
  };
}
