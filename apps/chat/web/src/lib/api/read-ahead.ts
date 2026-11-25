import { AHEAD_LANE } from "./client.ts";
import type { RunStatus } from "./types.ts";

/** What a read ahead needs to know of a conversation or a chat: when it last changed, and the status of the run that changes it. */
export type Ahead = { id: string; at: number; status: RunStatus };

/**
 * Whether a run still changes what a read would bring. A sleeping run is still busy: pi-host says sleeping while a run waits for a working
 * slot or an account (server/threads.ts `hostStatus`), so under load a busy run flips working, sleeping, working at every model call. On
 * 11-25 a box page saw fable auditor's work thread flip 6 times in 2 s, each flip moved its `updatedAt`, and the owner's page read its
 * check-in and jobs again 115 times in 10 min, 2,500 to 3,100 reads ahead per 10 min in all (requests/2026-11-25.jsonl).
 */
const atRest = (status: RunStatus): boolean => status === "idle" || status === "failed";

/**
 * Reads conversations and panels before the owner opens them, as many at once as the lane sends (client.ts `AHEAD_LANE`), so a first open
 * shows from the page's cache with no call in front of it. Each is read once, and again only when it shows activity newer than that read
 * once its run is at rest: a working or sleeping one changes with every step, and its open view reads it live. A hidden page reads nothing
 * until it shows again; those first reads also open the connection again after a sleep, where on 11-19 a lone replies call 29 min after
 * the last one took 3 round trips. A socket that comes back reads again only the ones its hello shows newer, and each open panel its own
 * (kept.svelte.ts `missed`): on 11-22 a reconnect that read all 12 agents' four board reads again sent 48 calls, and in walks of 5 restarts
 * two WebKit board reads in that burst took 2.1 s.
 */
export class ReadAhead<Wanted extends Ahead = Ahead> {
  /** Each one's `at` when its kept answer was read. */
  private readonly readAt = new Map<string, number>();
  private wanted: Wanted[] = [];
  private reading = 0;

  /** `warm` reads one and keeps the answer; one that `viewing` names has an open view, which keeps it current itself. */
  constructor(private readonly warm: (wanted: Wanted) => Promise<unknown>, private readonly viewing: (id: string) => boolean = () => false) {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => this.run());
  }

  /** What to keep read, the first one first. */
  want(list: Wanted[]): void {
    this.wanted = list;
    this.run();
  }

  /** A view of the conversation closed with its page current as of its newest activity. */
  seen(id: string): void {
    const found = this.wanted.find(c => c.id === id);
    if (found) this.readAt.set(id, found.at);
  }

  private next(): Wanted | undefined {
    return this.wanted.find(c => {
      const readAt = this.readAt.get(c.id);
      return !this.viewing(c.id) && (readAt === undefined || (atRest(c.status) && c.at > readAt));
    });
  }

  private run(): void {
    if (typeof document === "undefined") return;
    while (this.reading < AHEAD_LANE && document.visibilityState === "visible") {
      const c = this.next();
      if (!c) return;
      this.readAt.set(c.id, c.at);
      this.reading += 1;
      void this.warm(c).catch(() => undefined).finally(() => {
        this.reading -= 1;
        this.run();
      });
    }
  }
}
