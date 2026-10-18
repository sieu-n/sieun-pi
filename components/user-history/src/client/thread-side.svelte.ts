import { api } from "./api.ts";
import type { ChildUsage } from "../shared/types.ts";

/**
 * Per-thread data the view draws beside the messages, cached: `value` paints at once from the last answer. The thread feed pushes it after
 * each new subscription (`side` frames, shared/thread-side.ts), so `expect` marks it coming and `ensure` asks only when nothing is held or
 * coming. `load` asks with at most one request in flight per thread: a `load` while one is in flight shares it, and `load(id, true)`, for
 * data that changed since that request went out, runs one more after it. On 10-18 one thread switch fired about 100 identical child-usage
 * requests at once (each timed out at 20 s), and the Duties card waited for its request on every switch.
 */
export class ThreadCache<T> {
  private values = $state.raw<Record<string, T>>({});
  private inflight = new Map<string, Promise<void>>();
  private again = new Set<string>();
  private coming = new Set<string>();

  constructor(private readonly fetch: (id: string) => Promise<T>, private readonly keep: (error: unknown) => T | undefined = () => undefined) {}

  value(id: string): T | undefined { return this.values[id]; }

  set(id: string, value: T): void {
    this.coming.delete(id);
    this.values = { ...this.values, [id]: value };
  }

  /** The feed will push this thread's value; `drop` when the subscription ends without it. */
  expect(id: string): void { if (this.values[id] === undefined) this.coming.add(id); }
  drop(id: string): void { this.coming.delete(id); }

  ensure(id: string): Promise<void> {
    return this.values[id] !== undefined || this.coming.has(id) ? Promise.resolve() : this.load(id);
  }

  load(id: string, changed = false): Promise<void> {
    const running = this.inflight.get(id);
    if (running) { if (changed) this.again.add(id); return running; }
    const request = this.fetch(id).then(value => { this.set(id, value); }, error => { const kept = this.keep(error); if (kept !== undefined) this.set(id, kept); })
      .finally(() => {
        this.inflight.delete(id);
        if (this.again.delete(id)) void this.load(id);
      });
    this.inflight.set(id, request);
    return request;
  }
}

export const childUsage = new ThreadCache<ChildUsage[]>(id => api.childUsage(id));

/** Threads whose feed will push the accounts view, and a count that moves when one lands, so a waiting account chip reads the cache again. */
class PushedAccounts {
  revision = $state(0);
  private coming = new Set<string>();
  expect(id: string): void { this.coming.add(id); }
  landed(id: string): void { this.coming.delete(id); this.revision++; }
  isComing(id: string): boolean { return this.coming.has(id); }
}
export const pushedAccounts = new PushedAccounts();
