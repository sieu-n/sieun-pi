import { agents, api, kept, live, reads, type BoardRow } from "$lib/api";
import { hrefFor, router } from "$lib/router.svelte";
import { toast, type MenuEntry } from "$lib/ui";
import { boardHref, chatHref } from "./chips";

/**
 * Every chat's board row from /api/boards, shared by the Board sidebar and the index so they read once and agree. It is the page's kept
 * answer (kept.svelte.ts), read again on each board event and after the socket comes back.
 */
class Boards {
  private get kept() {
    return kept(reads.boards());
  }

  private started = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.kept.open();
    live.on(event => {
      if (event.type !== "board") return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.kept.read(), 150);
    });
  }

  load(): Promise<void> {
    return this.kept.read();
  }

  get rows(): BoardRow[] | null {
    return this.kept.value;
  }

  get error(): string | null {
    return this.kept.error;
  }

  row(chatId: string): BoardRow | undefined {
    return this.rows?.find(row => row.chatId === chatId);
  }

  /** Hides a board from All boards and the sidebar, or shows it again, at once and with Undo on the toast; a refused write puts it back. */
  async setHidden(row: BoardRow, hidden: boolean): Promise<void> {
    const mark = (list: BoardRow[]) => list.map(each => {
      if (each.chatId !== row.chatId) return each;
      const { hidden: _was, ...rest } = each;
      return hidden ? { ...rest, hidden: true as const } : rest;
    });
    if (this.rows) this.kept.set(mark(this.rows));
    try {
      await api.setBoardHidden(row.chatId, hidden);
    } catch (error) {
      void this.load();
      toast.error(error instanceof Error ? error.message : `${row.chatName}'s board did not change.`);
      return;
    }
    toast.show(hidden ? `Hid ${row.chatName}'s board` : `${row.chatName}'s board shows again`, { action: { label: "Undo", run: () => void this.setHidden(row, !hidden) } });
  }
}

/** The row menu of a board in All boards and the Board sidebar, the same on a right-click and on its "..." button. */
export function boardMenu(row: BoardRow): MenuEntry[] {
  const agent = agents.list.find(entry => entry.id === row.chatId);
  return [
    { id: "open", label: "Open board", icon: "board", onselect: () => router.navigate(boardHref(row.chatId)) },
    { id: "dm", label: `Message ${row.chatName}`, icon: "messages", onselect: () => router.navigate(chatHref(row.chatId)) },
    ...(agent ? [{ id: "agent", label: "Open agent", icon: "robot", onselect: () => router.navigate(hrefFor("agents", [agent.id])) }] : []),
    {
      id: "link", label: "Copy link", icon: "link",
      onselect: () => void navigator.clipboard.writeText(`${location.origin}${location.pathname}${boardHref(row.chatId)}`).then(() => toast.show("Link copied")),
    },
    { type: "separator" },
    row.hidden
      ? { id: "show", label: "Show board", icon: "eye", onselect: () => void boards.setHidden(row, false) }
      : { id: "hide", label: "Hide board", icon: "eye-off", onselect: () => void boards.setHidden(row, true) },
  ];
}

export const boards = new Boards();

/** A board waits on the owner when it has an open ask or a step that needs his go. */
export const needsYou = (row: BoardRow): boolean => row.openAsks > 0 || row.needsGo > 0;
