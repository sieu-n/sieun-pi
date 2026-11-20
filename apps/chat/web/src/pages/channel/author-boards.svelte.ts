import { SvelteMap } from "svelte/reactivity";
import { BoardStore, kept, reads, type Kept, type DutyRow } from "$lib/api";
import type { AuthorContext } from "$lib/ui/markdown";
import { boardTitles, rememberTitles } from "$pages/board/chips";

/**
 * The live boards of the agents that post in a room, so each post's board ids chip against its own author's board: p12 in vent's post is
 * vent's p12 even in a channel whose home chat is another agent, and a Solo room, which has no board of its own, chips its members' ids.
 * Each board is the same kept answer the side panel reads, plus the agent's duty names for d-ids.
 */
export class AuthorBoards {
  #open = new SvelteMap<string, { board: BoardStore; duties: Kept<{ duties: DutyRow[] }>; leave: () => void }>();

  /** Keep a board open for each of `ids` and close the rest. */
  sync(ids: readonly string[]): void {
    for (const [id, open] of this.#open) {
      if (ids.includes(id)) continue;
      this.#leave(open);
      this.#open.delete(id);
    }
    for (const id of ids) {
      if (this.#open.has(id)) continue;
      const duties = kept(reads.duties(id));
      this.#open.set(id, { board: new BoardStore(id), duties, leave: duties.open() });
    }
  }

  #leave(open: { board: BoardStore; leave: () => void }): void {
    open.board.close();
    open.leave();
  }

  /** The Markdown board context of one agent, once its board has loaded. */
  board(id: string): AuthorContext["board"] {
    const open = this.#open.get(id);
    const view = open?.board.view;
    if (!view?.board) return null;
    const titles = boardTitles(view.board, open?.duties.value?.duties.map((d) => d.duty) ?? []);
    rememberTitles(id, titles);
    return { chatId: id, titles };
  }

  close(): void {
    for (const open of this.#open.values()) this.#leave(open);
    this.#open.clear();
  }
}
