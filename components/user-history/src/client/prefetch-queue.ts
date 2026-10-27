/**
 * The sidebar's first-frame prefetches (`Store.prefetch`). Up to `parallel` run at once: one at a time paid one 205 ms round trip per row from
 * the Mac (10-27), so the 13 rows a 1440x900 window shows took about 2.7 s, and on 10-27 at 00:20Z, the run right after the Mac woke, tab
 * switches 3 s after load met rows not primed yet and read a median of 217 ms. A hover starts its row at once, past the cap, since the click
 * that follows is the owner's next switch. A row already on its way is not fetched again.
 */
export class PrefetchQueue {
  private queue: string[] = [];
  private readonly inFlight = new Set<string>();

  /**
   * `parallel` 4 primes those 13 rows in 4 round trips, about 0.8 s, with at most 4 first frames of about 11 KB gzip each (10-27) on the way
   * ahead of a click's own snapshot.
   */
  constructor(private readonly fetchOne: (id: string) => Promise<void>, private readonly parallel = 4) {}

  /** Queues `ids` in order behind the rows already queued; `front` starts them now instead (a hover). */
  add(ids: readonly string[], front = false): void {
    const fresh = ids.filter(id => !this.inFlight.has(id));
    this.queue = this.queue.filter(id => !fresh.includes(id));
    if (front) for (const id of fresh) void this.run(id);
    else this.queue.push(...fresh);
    this.pump();
  }

  private pump(): void {
    while (this.inFlight.size < this.parallel && this.queue.length) void this.run(this.queue.shift()!);
  }

  private async run(id: string): Promise<void> {
    this.inFlight.add(id);
    try { await this.fetchOne(id); } catch { /* the click's own feed snapshot paints it */ } finally {
      this.inFlight.delete(id);
      this.pump();
    }
  }
}
