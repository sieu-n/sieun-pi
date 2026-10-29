import { api, live, type BoardRow } from "$lib/api";

/** Every chat's board row from /api/boards, shared by the Board sidebar and the index so they fetch once and agree; reloads on board and hello events. */
class Boards {
  rows = $state<BoardRow[] | null>(null);
  error = $state<string | null>(null);
  private started = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private latest = 0;

  start(): void {
    if (this.started) return;
    this.started = true;
    live.on(event => {
      if (event.type === "board" || event.type === "hello") {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.load(), 150);
      }
    });
    void this.load();
  }

  /** Only the newest call writes, so a slow answer never replaces a newer one. */
  async load(): Promise<void> {
    const mine = ++this.latest;
    try {
      const rows = await api.boards();
      if (mine !== this.latest) return;
      this.rows = rows;
      this.error = null;
    } catch (e) {
      if (mine !== this.latest) return;
      this.error = e instanceof Error ? e.message : "The boards did not load.";
    }
  }

  row(chatId: string): BoardRow | undefined {
    return this.rows?.find(row => row.chatId === chatId);
  }
}

export const boards = new Boards();

/** A board waits on the owner when it has an open ask or a step that needs his go. */
export const needsYou = (row: BoardRow): boolean => row.openAsks > 0 || row.needsGo > 0;
