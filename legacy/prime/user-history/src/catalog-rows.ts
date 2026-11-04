import type { AgentRow, RowLookup } from "./chat-agents.ts";
import type { SessionRow } from "./shared/types.ts";

/** A projected row's sort time, parsed once per row object: a kept row is the same object in each projection. */
const sortTimes = new WeakMap<SessionRow, number>();
export function sortTime(row: SessionRow): number {
  let at = sortTimes.get(row);
  if (at === undefined) { at = Date.parse(row.lastActivityAt ?? row.created ?? ""); sortTimes.set(row, at); }
  return at;
}

type Entry = { id: string; time: number; agent: AgentRow };
/** Newest first, a row with no time last, and the lower session id first between two rows of the same time. */
const before = (left: Entry, right: Entry): boolean => left.time > right.time || (left.time === right.time && left.id < right.id);

/**
 * The catalog's projected rows in the sidebar's order, newest first, kept across projections, so a projection puts only the rows it built
 * again (`put`) and reads the rest as they were. It is also the chats' row lookup (`RowLookup`): a session id or name finds the first row in
 * this order whose id or name it is. On 11-04 each live projection walked all 4,500 listed rows to check, sort and index them, and those
 * walks were about a third of its 210 ms of own code, while a roster update changed a few rows.
 */
export class RowOrder implements RowLookup {
  private entries: Entry[] = [];
  private readonly byId = new Map<string, Entry>();
  private readonly byName = new Map<string, Set<Entry>>();
  /** Each name's first entry in the order (`lookup`), worked out when asked and dropped when an entry of that name comes or goes. */
  private readonly firstByName = new Map<string, Entry | undefined>();
  /** Set between `begin(true)` and `end`: the puts of a projection that builds every row, sorted once at its end. */
  private batch: Map<string, Entry> | undefined;

  get size(): number { return this.batch?.size ?? this.entries.length; }

  /** Starts a projection's puts. `full`: every row comes again, and a row it does not put leaves. */
  begin(full: boolean): void { this.batch = full ? new Map() : undefined; }

  end(): void {
    const batch = this.batch;
    if (!batch) return;
    this.batch = undefined;
    this.entries = [...batch.values()].sort((left, right) => before(left, right) ? -1 : before(right, left) ? 1 : 0);
    this.byId.clear();
    this.byName.clear();
    this.firstByName.clear();
    for (const entry of this.entries) { this.byId.set(entry.id, entry); this.named(entry, true); }
  }

  /** The row of session `id` is `row` now; `first` is its first task, for the chats' agents. The same row object again changes nothing. */
  put(id: string, row: SessionRow, first: (row: SessionRow) => string): void {
    if (this.batch) {
      const known = this.byId.get(id);
      this.batch.set(id, known?.agent.row === row ? known : this.entry(id, row, first));
      return;
    }
    const known = this.byId.get(id);
    if (known?.agent.row === row) return;
    if (known) this.drop(known);
    const entry = this.entry(id, row, first);
    let low = 0;
    let high = this.entries.length;
    while (low < high) { const middle = (low + high) >> 1; if (before(this.entries[middle]!, entry)) low = middle + 1; else high = middle; }
    this.entries.splice(low, 0, entry);
    this.byId.set(id, entry);
    this.named(entry, true);
  }

  /** Session `id` has no row now. */
  remove(id: string): void {
    if (this.batch) { this.batch.delete(id); return; }
    const known = this.byId.get(id);
    if (known) this.drop(known);
  }

  has(id: string): boolean { return this.byId.has(id); }

  /** The row ids the order holds; between `begin(true)` and `end`, the ones the last order held. */
  ids(): IterableIterator<string> { return this.byId.keys(); }

  /** The rows in order, in a new array. */
  rows(): SessionRow[] {
    const rows = new Array<SessionRow>(this.entries.length);
    for (let at = 0; at < rows.length; at++) rows[at] = this.entries[at]!.agent.row;
    return rows;
  }

  /** The place of session `id`'s row in `rows`, or -1 for none. */
  indexOf(id: string): number {
    const entry = this.byId.get(id);
    return entry ? this.place(entry) : -1;
  }

  lookup(who: string): AgentRow | undefined {
    const byId = this.byId.get(who);
    const byName = this.firstNamed(who);
    if (!byId || !byName) return (byId ?? byName)?.agent;
    return before(byName, byId) ? byName.agent : byId.agent;
  }

  private entry(id: string, row: SessionRow, first: (row: SessionRow) => string): Entry {
    const time = sortTime(row);
    const text = first(row);
    return { id, time: Number.isNaN(time) ? -Infinity : time, agent: text ? { row, first: text } : { row } };
  }

  private place(entry: Entry): number {
    let low = 0;
    let high = this.entries.length;
    while (low < high) { const middle = (low + high) >> 1; if (before(this.entries[middle]!, entry)) low = middle + 1; else high = middle; }
    return this.entries[low] === entry ? low : -1;
  }

  private drop(entry: Entry): void {
    const at = this.place(entry);
    if (at >= 0) this.entries.splice(at, 1);
    this.byId.delete(entry.id);
    this.named(entry, false);
  }

  private named(entry: Entry, add: boolean): void {
    const name = entry.agent.row.name;
    let set = this.byName.get(name);
    if (add) { if (!set) this.byName.set(name, set = new Set()); set.add(entry); }
    else if (set) { set.delete(entry); if (!set.size) this.byName.delete(name); }
    this.firstByName.delete(name);
  }

  private firstNamed(name: string): Entry | undefined {
    if (this.firstByName.has(name)) return this.firstByName.get(name);
    let first: Entry | undefined;
    for (const entry of this.byName.get(name) ?? []) if (!first || before(entry, first)) first = entry;
    this.firstByName.set(name, first);
    return first;
  }
}
