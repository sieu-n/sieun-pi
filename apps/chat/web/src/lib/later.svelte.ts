/**
 * Slack's Save for later on the page: the owner's Later list for the Later page, and the save and unsave every message's bookmark button
 * and menu item call (server/later.ts). A post's own `later` mark says whether it is saved; `optimistic` covers the moment between his
 * click and the post the server sends back, so the bookmark fills at once.
 */
import { SvelteMap } from "svelte/reactivity";
import { api, type Item, type LaterItem, type LaterList, type LaterMark, type LaterRow, type LaterState } from "$lib/api";
import { live } from "$lib/api/live.svelte";
import { hrefFor, router } from "$lib/router.svelte";
import { isOverdue, remindedText } from "$lib/remind";
import { askNotifyPermission } from "$lib/remind-notify";
import type { MenuEntry } from "$lib/ui/menu";
import { toast } from "$lib/ui/toast.svelte";

type Message = Extract<Item, { kind: "message" }>;

const key = (room: string, post: string): string => `${room}:${post}`;

class LaterStore {
  /** Each tab's rows, newest first, once read. */
  lists = $state<Record<LaterState, LaterRow[] | null>>({ open: null, archived: null, done: null });
  open = $state(0);
  archived = $state(0);
  done = $state(0);
  error = $state<string | null>(null);
  /** Whether the last read kept test-room posts, for `#/c/later?test=1`. */
  withTest = $state(false);
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
    void this.refresh();
  }

  /**
   * Reads every tab; only the newest read writes. A walk opens `#/c/later?test=1` to see the posts it saved in its test rooms, which the
   * owner's Later leaves out.
   */
  async refresh(): Promise<void> {
    const mine = ++this.latest;
    const test = router.route.params.test === "1";
    this.withTest = test;
    try {
      const [open, archived, done] = await Promise.all([api.later("open", test), api.later("archived", test), api.later("done", test)]);
      if (mine !== this.latest) return;
      this.set(open, archived, done);
      this.error = null;
    } catch (error) {
      if (mine === this.latest) this.error = error instanceof Error ? error.message : "Could not read Later.";
    }
  }

  private set(open: LaterList, archived: LaterList, done: LaterList): void {
    this.lists = { open: open.items, archived: archived.items, done: done.items };
    this.open = open.open;
    this.archived = open.archived;
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

  /** A post's save and reminder read from the open list, for a place that holds no post of its own to carry a `later` mark, such as a search result. */
  mark(room: string, post: string): LaterMark | undefined {
    const row = this.lists.open?.find((r) => r.room === room && r.post === post);
    return row ? { saved: true, ...(row.remindAt !== undefined ? { remindAt: row.remindAt } : {}) } : undefined;
  }

  /** Remind me about this on a post: saves it for later with the reminder, or clears the reminder and keeps the save. */
  async remindPost(room: string, post: string, at: number | null): Promise<void> {
    try {
      if (at === null) await api.patchLater(key(room, post), { remindAt: null });
      else {
        void askNotifyPermission();
        await api.saveLater(room, post, at);
        toast.show(remindedText(at));
      }
    } catch {
      toast.error(at === null ? "Could not remove the reminder" : "Could not set the reminder");
    }
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

  /** Unsaves the post; its toast's Undo puts the item back as it was, with its reminder, Keep unread mark, state and place in the list. */
  async unsave(room: string, post: string): Promise<void> {
    this.optimistic.set(key(room, post), false);
    try {
      const { item } = await api.unsaveLater(key(room, post));
      this.note("Removed from Later", { label: "Undo", run: () => void (item ? this.restore(item) : this.save(room, post)) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the message from Later");
    } finally {
      this.optimistic.delete(key(room, post));
    }
  }

  private async restore(item: LaterItem): Promise<void> {
    const saved = item.room !== undefined ? key(item.room, item.post) : null;
    if (saved) this.optimistic.set(saved, true);
    try {
      await api.restoreLater(item);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not put the message back in Later");
    } finally {
      if (saved) this.optimistic.delete(saved);
    }
  }

  /** Slack's /remind me: sets a reminder of his own text; a failure throws, so the command keeps its draft. */
  async remindMe(note: string, at: number): Promise<void> {
    void askNotifyPermission();
    await api.remindNote(note, at);
    toast.success(remindedText(at, Date.now()));
  }

  /** Sets, snoozes or clears (`null`) a row's reminder, or on a post kept unread moves or stops its return; the live later event re-reads the list. */
  async remind(row: Pick<LaterRow, "id" | "unread">, at: number | null): Promise<void> {
    try {
      if (at !== null) void askNotifyPermission();
      await api.patchLater(row.id, { remindAt: at });
      toast.show(at === null ? (row.unread ? "It won't come back unread" : "Reminder removed") : remindedText(at, Date.now(), !!row.unread));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the reminder");
    }
  }

  toggle(room: string, message: Pick<Message, "id" | "later">): Promise<void> {
    return this.saved(room, message) ? this.unsave(room, message.id) : this.save(room, message.id);
  }

  /** Checks a row off, archives it, or moves it back to In progress; the row leaves its tab at once, and the toast's Undo moves it back. */
  async setState(row: LaterRow, state: LaterState): Promise<void> {
    const from = row.state;
    this.move(row, state);
    try {
      await api.patchLater(row.id, { state });
      const moved = state === "done" ? "Marked complete" : state === "archived" ? "Archived" : from === "archived" ? "Moved out of Archived" : "Moved to In progress";
      if (from !== state) this.note(moved, { label: "Undo", run: () => void this.setState({ ...row, state }, from) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the item");
    }
    if (from !== state) void this.refresh();
  }

  /** Unsaves a row from the Later page. */
  async remove(row: LaterRow): Promise<void> {
    this.lists = { ...this.lists, [row.state]: this.lists[row.state]?.filter((r) => r.id !== row.id) ?? null };
    if (row.room !== undefined) return this.unsave(row.room, row.post);
    try {
      const { item } = await api.unsaveLater(row.id);
      if (item) this.note("Removed from Later", { label: "Undo", run: () => void this.restore(item) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the reminder from Later");
    }
  }

  private move(row: LaterRow, state: LaterState): void {
    const without = (list: LaterRow[] | null) => list?.filter((r) => r.id !== row.id) ?? null;
    this.lists = { open: without(this.lists.open), archived: without(this.lists.archived), done: without(this.lists.done) };
    if (row.state !== state) {
      this[row.state] -= 1;
      this[state] += 1;
    }
  }
}

export const later = new LaterStore();

/** Later is a Messages view: `#/c/later` is In progress, `#/c/later/archived` Archived and `#/c/later/done` Completed. */
export const laterHref = (state: LaterState = "open"): string => hrefFor("messages", state === "open" ? ["later"] : ["later", state]);

/** The message menu's Save for later item, or Remove from Later on a saved post. */
export function laterMenuItem(room: string, message: Pick<Message, "id" | "later">): MenuEntry {
  const saved = later.saved(room, message);
  return {
    id: "later", label: saved ? "Remove from Later" : "Save for later", icon: saved ? "bookmark-filled" : "bookmark",
    onselect: () => void later.toggle(room, message),
  };
}
