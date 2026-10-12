import { snapshotJsonFile, transactJsonFile, type JsonFile } from "./locked-json.ts";
import { sameMessage, type Bookmark, type BookmarkAction } from "./shared/bookmarks.ts";

interface BookmarksState { bookmarks: Bookmark[] }

function parse(value: unknown): BookmarksState {
  if (typeof value !== "object" || value === null || !("bookmarks" in value) || !Array.isArray(value.bookmarks)) throw new Error("Invalid browser bookmarks");
  return {
    bookmarks: value.bookmarks.map((entry: unknown) => {
      const item = entry as Partial<Bookmark> | null;
      if (typeof item?.chat !== "string" || typeof item.at !== "number" || typeof item.text !== "string" || typeof item.savedAt !== "number") throw new Error("Invalid browser bookmark");
      return { chat: item.chat, at: item.at, text: item.text, savedAt: item.savedAt };
    }),
  };
}

/** The owner's saved chat messages, newest saved first, in bookmarks.json next to the notes, so every tab and device sees the same list. */
export class ChatBookmarks {
  private readonly file: JsonFile<BookmarksState>;
  constructor(path: string) { this.file = { path, label: "Browser bookmarks", parse, initial: () => ({ bookmarks: [] }) }; }
  async list(): Promise<Bookmark[]> { return (await snapshotJsonFile(this.file)).bookmarks; }
  /** Adding a saved message again keeps its place and refreshes its preview; removing a missing one is a no-op. */
  async apply(action: BookmarkAction): Promise<Bookmark[]> {
    const { state } = await transactJsonFile(this.file, state => {
      if (action.op === "clear") { state.bookmarks = []; return; }
      const index = state.bookmarks.findIndex(bookmark => sameMessage(bookmark, action));
      if (action.op === "remove") { if (index >= 0) state.bookmarks.splice(index, 1); return; }
      if (index >= 0) state.bookmarks[index]!.text = action.text;
      else state.bookmarks.unshift({ chat: action.chat, at: action.at, text: action.text, savedAt: Date.now() });
    });
    return state.bookmarks;
  }
}
