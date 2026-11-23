/**
 * Slack's saved items on the page: the owner's Saved list for the Saved page, the save and unsave every message's bookmark button and menu
 * item call, and the memo he writes on a saved item (server/later.ts). A post's own `later` mark says whether it is saved; `optimistic`
 * covers the moment between his click and the post the server sends back, so the bookmark fills at once.
 */
import { SvelteMap } from "svelte/reactivity";
import { api, type Item, type LaterItem, type LaterList, type LaterMark, type LaterRow, type LaterState, type Wait } from "$lib/api";
import { live } from "$lib/api/live.svelte";
import { hrefFor, router } from "$lib/router.svelte";
import { isOverdue, remindedText } from "$lib/remind";
import { askNotifyPermission } from "$lib/remind-notify";
import { savedPage } from "$lib/saved-items";
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
  /** Whether the last read kept test-room posts, for `#/c/saved?test=1`. */
  withTest = $state(false);
  /** Saves and unsaves on their way, by `<room>:<post>`, which the bookmark shows before the server's answer. */
  readonly optimistic = new SvelteMap<string, boolean>();
  private started = false;
  private latest = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The last Saved toast, which the next one replaces, so three quick saves show one toast as in Slack. */
  private toastId: number | undefined;
  /** The item whose memo the save toast's Add memo is writing (lib/MemoPrompt.svelte), or null. */
  memoPrompt = $state<{ id: string; memo: string } | null>(null);
  /** The toast of each due reminder this tab shows, by row id, with the reminder time it fell due at. */
  private readonly dueToasts = new Map<string, { toast: number; remindAt?: number; test: boolean }>();

  private note(text: string, ...actions: { label: string; run: () => void }[]): void {
    if (this.toastId !== undefined) toast.dismiss(this.toastId);
    this.toastId = toast.show(text, { actions });
  }

  /** The toast after a save: Add memo opens the memo field over where the toast sat, and View opens Saved. */
  private savedToast(item: Pick<LaterItem, "id" | "memo">): void {
    this.note(
      "Saved",
      { label: item.memo ? "Edit memo" : "Add memo", run: () => (this.memoPrompt = { id: item.id, memo: item.memo ?? "" }) },
      { label: "View", run: () => router.navigate(laterHref()) },
    );
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    live.on((event) => {
      if (event.type === "later" && event.by === "owner") this.open = event.open;
      if ((event.type === "later" && event.by === "owner") || event.type === "hello") {
        clearTimeout(this.timer);
        const behind = event.type === "hello";
        this.timer = setTimeout(() => void this.refresh(behind), 80);
      }
    });
    void this.refresh();
  }

  /**
   * Reads every tab; only the newest read writes. A walk opens `#/c/saved?test=1` to see the posts it saved in its test rooms, which the
   * owner's Saved list leaves out. `behind` reads behind what the page shows, after a reconnect, in the lane behind his calls (client.ts).
   */
  async refresh(behind = false): Promise<void> {
    const mine = ++this.latest;
    const test = router.route.params.test === "1";
    this.withTest = test;
    const wait = (): Wait | undefined => (behind ? { background: "shown" } : undefined);
    try {
      const [open, archived, done] = await Promise.all([api.later("open", test, wait()), api.later("archived", test, wait()), api.later("done", test, wait())]);
      if (mine !== this.latest) return;
      this.set(open, archived, done);
      this.error = null;
    } catch (error) {
      if (mine === this.latest) this.error = error instanceof Error ? error.message : "Could not read your saved items.";
    }
  }

  private set(open: LaterList, archived: LaterList, done: LaterList): void {
    this.lists = { open: open.items, archived: archived.items, done: done.items };
    this.open = open.open;
    this.archived = open.archived;
    this.done = open.done;
    this.settleDue(open.items);
  }

  /** Keeps a due reminder's toast (lib/remind-live.ts) until the reminder is handled, here or in another tab. */
  showsDue(row: LaterRow, toastId: number): void {
    this.dueToasts.set(row.id, { toast: toastId, remindAt: row.remindAt, test: row.room !== undefined && !!row.test });
  }

  /**
   * Takes away the toast of a reminder that is no longer due: checked off, archived, removed, snoozed or cleared in any tab or the Mac
   * app's notification, so no tab keeps offering Mark complete on it. A test-room row stays, since a read without `test=1` leaves it out.
   */
  private settleDue(open: LaterRow[]): void {
    for (const [id, shown] of this.dueToasts) {
      if (shown.test && !this.withTest) continue;
      if (open.some((row) => row.id === id && row.remindAt === shown.remindAt)) continue;
      toast.dismiss(shown.toast);
      this.dueToasts.delete(id);
    }
  }

  /** Open rows whose reminder came due and is not done or snoozed, which the sidebar's Saved row counts in red, as Slack's Later badge does. */
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

  /** Remind me about this on a post: saves it with the reminder, or clears the reminder and keeps the save. */
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
      const { item } = await api.saveLater(room, post);
      this.savedToast(item);
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
      this.note("Removed from Saved", { label: "Undo", run: () => void (item ? this.restore(item) : this.save(room, post)) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the message from Saved");
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
      toast.error(error instanceof Error ? error.message : "Could not put the message back in Saved");
    } finally {
      if (saved) this.optimistic.delete(saved);
    }
  }

  /** The open Saved row that saves this wiki page, a note whose text is the page's link. */
  pageRow(path: string): LaterRow | undefined {
    return this.lists.open?.find((row) => row.room === undefined && savedPage(row.text)?.path === path);
  }

  /** A canvas's Save on a wiki page: a saved note whose text is the page's link, or Remove from Saved when the page is saved. */
  async togglePage(path: string, title: string): Promise<void> {
    const row = this.pageRow(path);
    if (row) return this.remove(row);
    try {
      const { item } = await api.remindNote(`[${title.replace(/[[\]]/g, "") || path}](wiki:${path})`);
      this.savedToast(item);
      void this.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the page");
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

  /** Sets an item's memo, or clears it when the text is blank; its row shows the new memo at once and goes back if the write fails. */
  async setMemo(id: string, text: string): Promise<void> {
    const memo = text.trim() || undefined;
    const before = [this.lists.open, this.lists.archived, this.lists.done].flatMap((list) => list ?? []).find((r) => r.id === id);
    if (before && before.memo === memo) return;
    this.memoOf(id, memo);
    try {
      await api.patchLater(id, { memo: memo ?? null });
    } catch (error) {
      if (before) this.memoOf(id, before.memo);
      toast.error(error instanceof Error ? error.message : "Could not save the memo");
    }
  }

  private memoOf(id: string, memo: string | undefined): void {
    const set = (list: LaterRow[] | null) => list?.map((r) => (r.id === id ? { ...r, memo } : r)) ?? null;
    this.lists = { open: set(this.lists.open), archived: set(this.lists.archived), done: set(this.lists.done) };
  }

  /** Unsaves a row from the Saved page. */
  async remove(row: LaterRow): Promise<void> {
    this.lists = { ...this.lists, [row.state]: this.lists[row.state]?.filter((r) => r.id !== row.id) ?? null };
    if (row.room !== undefined) return this.unsave(row.room, row.post);
    try {
      const { item } = await api.unsaveLater(row.id);
      if (item) this.note("Removed from Saved", { label: "Undo", run: () => void this.restore(item) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the item from Saved");
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

/** Saved is a Messages view: `#/c/saved` is In progress, `#/c/saved/archived` Archived and `#/c/saved/done` Completed. */
export const laterHref = (state: LaterState = "open"): string => hrefFor("messages", state === "open" ? ["saved"] : ["saved", state]);

/** The message menu's Save item, or Remove from Saved on a saved post. */
export function laterMenuItem(room: string, message: Pick<Message, "id" | "later">): MenuEntry {
  const saved = later.saved(room, message);
  return {
    id: "later", label: saved ? "Remove from Saved" : "Save", icon: saved ? "bookmark-filled" : "bookmark",
    onselect: () => void later.toggle(room, message),
  };
}
