import type { AgentsView } from "../shared/sessions-delta.ts";

/** `api.agentsStream`: subscribes one agents feed from the view the page holds, and returns its stop function. */
export type AgentsStream = (id: string, held: AgentsView | null, onView: (view: AgentsView) => void, onError: () => void) => () => void;

/**
 * The agents feeds a page holds: the open thread's and each unfolded sidebar chat's (App.svelte). After a cold load and after a lost socket
 * they wait until the open thread's first page has drawn (`ready`), so the thread's lines go first on the 185 ms link from Korea; on 10-18 a
 * reconnect from the Mac pulled 428 KB of agents lists before it was current. A feed that stops keeps its view and names it on the next
 * subscribe (`agentsHave`), so the server sends only the agents that changed.
 */
export class AgentFeeds {
  private readonly feeds = new Map<string, () => void>();
  private readonly views = new Map<string, AgentsView>();
  private wanted: readonly string[] = [];
  /** False while the open thread's first page is on its way. */
  private ready: boolean;

  /** `changed` runs when a shown view changes, and `threadOpen` says whether the page shows a thread whose first page goes first. */
  constructor(private readonly stream: AgentsStream, private readonly changed: () => void, private readonly threadOpen: () => boolean) {
    this.ready = !threadOpen();
  }

  /** Starts the feeds for `ids` once ready, and stops the others. */
  show(ids: readonly string[]): void {
    this.wanted = ids;
    const wanted = new Set(ids);
    let dropped = false;
    for (const [id, stop] of this.feeds) if (!wanted.has(id)) { stop(); this.feeds.delete(id); }
    for (const id of [...this.views.keys()]) if (!wanted.has(id)) dropped = this.views.delete(id) || dropped;
    if (dropped) this.changed();
    if (!this.ready) return;
    for (const id of wanted) {
      if (this.feeds.has(id)) continue;
      this.feeds.set(id, this.stream(id, this.views.get(id) ?? null, view => { this.views.set(id, view); this.changed(); }, () => this.lost()));
    }
  }

  /** The open thread's first page has drawn, it failed, or no thread is open: the feeds start. */
  open(): void {
    if (this.ready) return;
    this.ready = true;
    this.show(this.wanted);
  }

  /**
   * The socket dropped: with a thread open, every feed stops, keeps its view, and starts again at the next `open`; with none, the socket
   * subscribes them again itself.
   */
  private lost(): void {
    if (!this.threadOpen()) return;
    this.ready = false;
    for (const stop of this.feeds.values()) stop();
    this.feeds.clear();
  }

  /** Each shown chat's agents, by chat id. */
  byChat(): Map<string, AgentsView["agents"]> {
    return new Map([...this.views.values()].flatMap(view => view.chat ? [[view.chat, view.agents] as const] : []));
  }
}
