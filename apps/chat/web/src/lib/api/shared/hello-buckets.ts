/**
 * What a reconnecting page already holds of the hello's big lists, so the server sends only what changed. On 11-22 the hello held 1.6 MB
 * of JSON (jobs 959 KB, conversations 609 KB) and reached the owner's page about 1 s after each socket open at a 200 ms round trip
 * (~/work/p209-wake/after2), and every apps/chat release reopens every page's socket.
 *
 * Many jobs and conversations of a thread share one time: a running job's `updatedAt` is its thread's time, and an idle one keeps the
 * thread's time when it last changed (server/threads.ts `jobTime`). The hello therefore carries each thread's newest job time once in
 * `times`, and an item with that time goes as its `Timed` form, without the time and marked `"@t": 1`.
 *
 * Each list splits by id into `HELLO_BUCKETS` buckets, and a bucket's digest is FNV-1a over its timed items' JSON in id order. The page
 * sends the digests of the timed items of its last hello when it opens the socket (live.svelte.ts), and the hello carries the items of
 * each bucket whose digest differs, with their bucket numbers in `partial`; the page swaps those buckets and puts each thread's time back.
 * Equal digests mean equal timed items, so the lists equal a whole hello's.
 */

/** The lists a hello may send in part; `agents` and the sidebar always go whole. */
export const PARTIAL_LISTS = ["jobs", "conversations"] as const;
export type PartialList = typeof PARTIAL_LISTS[number];

/** 256 buckets of 8 hex digits are 2 KB per list in the socket's URL; on 11-22 a bucket held about 7 jobs. */
export const HELLO_BUCKETS = 256;

type Keyed = { readonly id: string };
/** An item without its time when its time is its thread's (`"@t": 1`). */
export type Timed<T> = T | (Omit<T, "updatedAt" | "lastActivityAt"> & { "@t": 1 });
/** Each thread's time, by thread id. */
export type ThreadTimes = Record<string, number>;

const TIME_FIELD: Record<PartialList, "updatedAt" | "lastActivityAt"> = { jobs: "updatedAt", conversations: "lastActivityAt" };
/** The thread of a job (`thread`) or of a conversation, whose id is the thread's or `<thread>:<conversation>`. */
const threadOf = (item: Keyed & { thread?: string }): string => item.thread ?? item.id.split(":")[0]!;

/** Each thread's newest job time, which its running jobs carry. */
export function threadTimes(jobs: readonly (Keyed & { thread: string; updatedAt: number })[]): ThreadTimes {
  const times: ThreadTimes = {};
  for (const job of jobs) times[job.thread] = Math.max(times[job.thread] ?? 0, job.updatedAt);
  return times;
}

/** The list's items in their `Timed` form. */
export function timed<T extends Keyed>(list: PartialList, items: readonly T[], times: ThreadTimes): Timed<T>[] {
  const field = TIME_FIELD[list];
  return items.map(item => {
    const time = (item as Record<string, unknown>)[field];
    if (time === undefined || times[threadOf(item)] !== time) return item;
    const { [field]: _time, ...rest } = item as Record<string, unknown>;
    return { ...rest, "@t": 1 } as Timed<T>;
  });
}

/** The items with each thread's time put back. */
export function untimed<T extends Keyed>(list: PartialList, items: readonly Timed<T>[], times: ThreadTimes): T[] {
  const field = TIME_FIELD[list];
  return items.map(item => {
    if (!("@t" in item)) return item as T;
    const { "@t": _mark, ...rest } = item;
    return { ...rest, [field]: times[threadOf(item)] ?? 0 } as unknown as T;
  });
}

function fnv(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export const bucketOf = (id: string): number => fnv(id) % HELLO_BUCKETS;

const byId = (a: Keyed, b: Keyed): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The items of each bucket, in list order. */
export function byBucket<T extends Keyed>(items: readonly T[]): T[][] {
  const groups: T[][] = Array.from({ length: HELLO_BUCKETS }, () => []);
  for (const item of items) groups[bucketOf(item.id)]!.push(item);
  return groups;
}

/** One bucket's digest as 8 hex digits: FNV-1a over its items' JSON in id order. */
export function bucketDigest(items: readonly Keyed[]): string {
  return fnv([...items].sort(byId).map(item => JSON.stringify(item)).join("\n")).toString(16).padStart(8, "0");
}

/** Each bucket's digest as 8 hex digits, all in one string. */
export function digests(items: readonly Keyed[]): string {
  return byBucket(items).map(bucketDigest).join("");
}

/** The buckets whose digest differs from the page's, or null when the page's string is not a set of digests, which gets the whole list. */
export function changedBuckets(held: string, now: string): Set<number> | null {
  if (held.length !== HELLO_BUCKETS * 8 || !/^[0-9a-f]+$/.test(held)) return null;
  const changed = new Set<number>();
  for (let bucket = 0; bucket < HELLO_BUCKETS; bucket++) {
    if (held.slice(bucket * 8, bucket * 8 + 8) !== now.slice(bucket * 8, bucket * 8 + 8)) changed.add(bucket);
  }
  return changed;
}

/** The held list with the items of `buckets` swapped for `items`: replaced ones keep their place, new ones go at the end. */
export function mergeBuckets<T extends Keyed>(held: readonly T[], buckets: readonly number[], items: readonly T[]): T[] {
  const swapped = new Set(buckets);
  const fresh = new Map(items.map(item => [item.id, item]));
  const out: T[] = [];
  for (const item of held) {
    if (!swapped.has(bucketOf(item.id))) out.push(item);
    else if (fresh.has(item.id)) {
      out.push(fresh.get(item.id)!);
      fresh.delete(item.id);
    }
  }
  return [...out, ...fresh.values()];
}
