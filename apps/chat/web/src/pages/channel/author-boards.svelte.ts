import { SvelteMap } from "svelte/reactivity";
import { api, BoardStore } from "$lib/api";
import type { AuthorContext } from "$lib/ui/markdown";
import { boardTitles, rememberTitles } from "$pages/board/chips";

/**
 * The live boards of the agents that post in a room, so each post's board ids chip against its own author's board: p12 in vent's post is
 * vent's p12 even in a channel whose home chat is another agent, and a Solo room, which has no board of its own, chips its members' ids.
 * Each board is the same live `BoardStore` the side panel reads, plus the agent's duty names for d-ids.
 */
export class AuthorBoards {
  #stores = new SvelteMap<string, BoardStore>();
  #duties = $state<Record<string, { id: string; name: string }[]>>({});

  /** Keep a board open for each of `ids` and close the rest. */
  sync(ids: readonly string[]): void {
    for (const [id, store] of this.#stores) {
      if (ids.includes(id)) continue;
      store.close();
      this.#stores.delete(id);
    }
    for (const id of ids) {
      if (this.#stores.has(id)) continue;
      this.#stores.set(id, new BoardStore(id));
      void api.duties(id).then((body) => (this.#duties = { ...this.#duties, [id]: body.duties.map((d) => d.duty) })).catch(() => undefined);
    }
  }

  /** The Markdown board context of one agent, once its board has loaded. */
  board(id: string): AuthorContext["board"] {
    const view = this.#stores.get(id)?.view;
    if (!view?.board) return null;
    const titles = boardTitles(view.board, this.#duties[id] ?? []);
    rememberTitles(id, titles);
    return { chatId: id, titles };
  }

  close(): void {
    for (const store of this.#stores.values()) store.close();
    this.#stores.clear();
  }
}
