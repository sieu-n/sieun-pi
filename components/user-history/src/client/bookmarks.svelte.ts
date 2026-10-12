import { api } from "./api.ts";
import { store } from "./store.svelte.ts";
import { bookmarkPreview, sameMessage, type Bookmark, type BookmarkAction } from "../shared/bookmarks.ts";

/** The saved messages this page shows: read at start and again when the Bookmarks view opens, replaced by the server's list after each change. */
class Bookmarks {
  list = $state.raw<Bookmark[]>([]);
  private keys = $derived(new Set(this.list.map(bookmark => bookmark.chat + "@" + bookmark.at)));

  has(chat: string, at: number): boolean { return this.keys.has(chat + "@" + at); }

  async load(): Promise<void> {
    const list = await store.run(api.bookmarks());
    if (list) this.list = list;
  }

  /** The bookmark button on a message: saves it with a one-line preview, or removes the saved one. */
  toggle(chat: string, at: number, text: string): Promise<void> {
    return this.apply(this.has(chat, at) ? { op: "remove", chat, at } : { op: "add", chat, at, text: bookmarkPreview(text) });
  }
  remove(chat: string, at: number): Promise<void> { return this.apply({ op: "remove", chat, at }); }
  clear(): Promise<void> { return this.apply({ op: "clear" }); }

  /** The change shows at once; the server's answer then becomes the list, and a failed write puts the old list back and shows the error. */
  private async apply(action: BookmarkAction): Promise<void> {
    const before = this.list;
    this.list = action.op === "clear" ? [] : action.op === "remove" ? before.filter(bookmark => !sameMessage(bookmark, action))
      : [{ chat: action.chat, at: action.at, text: action.text, savedAt: Date.now() }, ...before];
    this.list = await store.run(api.bookmark(action)) ?? before;
  }
}

export const bookmarks = new Bookmarks();
