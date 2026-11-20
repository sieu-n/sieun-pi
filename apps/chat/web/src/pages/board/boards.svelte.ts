import { kept, live, reads, type BoardRow } from "$lib/api";

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
}

export const boards = new Boards();

/** A board waits on the owner when it has an open ask or a step that needs his go. */
export const needsYou = (row: BoardRow): boolean => row.openAsks > 0 || row.needsGo > 0;
