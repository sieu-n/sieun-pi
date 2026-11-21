/**
 * Remind me: fires the owner's Later reminders when they fall due. One timer waits for the earliest open owner item whose remindAt has not
 * fired yet. The timer is armed on boot from the items on disk and again after every Later write, so a reminder set before a restart still
 * fires, and one that fell due while the server was down fires on boot. An item has fired when its notifiedAt is at or after its remindAt,
 * so a snooze to a later time fires again with no reset. Agents' items are left to the agent wake files (later.ts).
 */

/** The fields of a Later item the due check reads (later.ts holds the whole item). */
export interface DueItem {
  id: string;
  by: string;
  state: "open" | "archived" | "done";
  remindAt?: number;
  notifiedAt?: number;
}

export interface LaterDueOptions<T extends DueItem> {
  /** Every Later item of the owner. */
  items: () => readonly T[];
  /** Writes notifiedAt on the item, and returns it as stored, or undefined when it is gone. */
  notified: (item: T, at: number) => T | undefined;
  /** Tells the pages the item fell due. */
  fire: (item: T) => void;
  log?: (line: string) => void;
  now?: () => number;
}

const OWNER = "owner";
/** setTimeout's longest delay, 2^31 - 1 ms (about 24.8 days); a later reminder re-arms when this one runs out. */
const MAX_DELAY = 2_147_483_647;

/** True when the item's reminder is due by `now` and has not fired. */
export function isDue(item: DueItem, now: number): boolean {
  return waiting(item) && item.remindAt! <= now;
}

function waiting(item: DueItem): boolean {
  return item.by === OWNER && item.state === "open" && item.remindAt !== undefined && !(item.notifiedAt !== undefined && item.notifiedAt >= item.remindAt);
}

export class LaterDue<T extends DueItem> {
  private timer?: NodeJS.Timeout;
  /** True while arm fires reminders, whose notifiedAt writes call arm again through the store's change hook. */
  private firing = false;
  private readonly now: () => number;

  constructor(private readonly options: LaterDueOptions<T>) {
    this.now = options.now ?? Date.now;
  }

  /** Fires every reminder that is due and sets the timer for the next one. */
  arm(): void {
    if (this.firing) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const now = this.now();
    const items = this.options.items().filter(waiting);
    this.firing = true;
    try {
      for (const item of items.filter(i => i.remindAt! <= now)) {
        const stored = this.options.notified(item, now);
        if (!stored) continue;
        this.options.log?.(`later: reminder ${item.id} fired, due ${new Date(item.remindAt!).toISOString()}`);
        this.options.fire(stored);
      }
    } finally {
      this.firing = false;
    }
    const next = Math.min(...items.filter(i => i.remindAt! > now).map(i => i.remindAt!));
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => this.arm(), Math.min(next - now, MAX_DELAY));
    this.timer.unref?.();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
