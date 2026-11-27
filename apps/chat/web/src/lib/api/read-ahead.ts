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
 * The least time between two reads ahead of one item. An agent at rest still moves its `updatedAt` at every step of its jobs and every turn
 * of its comm threads: on 11-26 between 05:00 and 09:14 UTC the owner's page read ag_seo's check-in 21 times in 3 min, and a box page read
 * VP of GTM's check-in, jobs and work thread 7 times each in 3 min while its jobs ran (requests/2026-11-26.jsonl). Agent factory asked for
 * at most 2 reads of a path in 3 min (p324). A 90 s gap still let 3 reads into 3 min: a walk on 11-27 saw ag_seo's check-in read at 2.1,
 * 91.8 and 181.8 s (~/work/p354-reread-walk), and the page posts its timing lines in 10 s batches, which can log 3 such reads closer still.
 * At 100 s, 3 reads span 200 s, which stays over 3 min after that batching.
 * The open of a panel or a room reads it again behind what it shows, so a kept answer up to 100 s old costs no wait unless it changed.
 */
export const READ_AGAIN_MS = 100_000;

/**
 * Reads conversations and panels before the owner opens them, as many at once as the lane sends (client.ts `AHEAD_LANE`), so a first open
 * shows from the page's cache with no call in front of it. Each is read once, and again only when it shows activity newer than that read
 * once its run is at rest, and `READ_AGAIN_MS` after its last read: a working or sleeping one changes with every step, and its open view
 * reads it live. A hidden page reads nothing
 * until it shows again; those first reads also open the connection again after a sleep, where on 11-19 a lone replies call 29 min after
 * the last one took 3 round trips. A socket that comes back reads again only the ones its hello shows newer, and each open panel its own
 * (kept.svelte.ts `missed`): on 11-22 a reconnect that read all 12 agents' four board reads again sent 48 calls, and in walks of 5 restarts
 * two WebKit board reads in that burst took 2.1 s.
 */
export class ReadAhead<Wanted extends Ahead = Ahead> {
  /** Each one's `at` when its kept answer was read, and the page's clock then. */
  private readonly readAt = new Map<string, { at: number; when: number }>();
  /** The timer that runs the queue again when the next held one may be read. */
  private timer: ReturnType<typeof setTimeout> | undefined;
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
    if (found) this.readAt.set(id, { at: found.at, when: Date.now() });
  }

  /** The first one to read now, or else when the first changed one held by `READ_AGAIN_MS` may be read. */
  private next(): Wanted | number | undefined {
    const now = Date.now();
    let due: number | undefined;
    for (const c of this.wanted) {
      if (this.viewing(c.id)) continue;
      const read = this.readAt.get(c.id);
      if (!read) return c;
      if (!atRest(c.status) || c.at <= read.at) continue;
      const when = read.when + READ_AGAIN_MS;
      if (when <= now) return c;
      due = Math.min(due ?? when, when);
    }
    return due;
  }

  private run(): void {
    if (typeof document === "undefined") return;
    while (this.reading < AHEAD_LANE && document.visibilityState === "visible") {
      const c = this.next();
      if (c === undefined) return;
      if (typeof c === "number") {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.run(), c - Date.now());
        return;
      }
      this.readAt.set(c.id, { at: c.at, when: Date.now() });
      this.reading += 1;
      void this.warm(c).catch(() => undefined).finally(() => {
        this.reading -= 1;
        this.run();
      });
    }
  }
}
