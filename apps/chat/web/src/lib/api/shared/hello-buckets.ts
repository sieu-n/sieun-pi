/**
 * What a reconnecting page already holds of the hello's big lists, so the server sends only what changed. On 11-22 the hello held 1.6 MB
 * of JSON (jobs 959 KB, conversations 609 KB) and reached the owner's page about 1 s after each socket open at a 200 ms round trip
 * (~/work/p209-wake/after2), and every apps/chat release reopens every page's socket.
 *
 * Each list splits by id into `HELLO_BUCKETS` buckets, and a bucket's digest is FNV-1a over its items' JSON in id order. The page sends the
 * digests of what it holds when it opens the socket (live.svelte.ts), and the hello carries the items of each bucket whose digest differs,
 * with their bucket numbers in `partial`; the page drops what it held in those buckets and takes the hello's items. Equal digests mean
 * equal JSON, so the merged list holds what a whole hello would.
 */

/** The lists a hello may send in part; `agents` and the sidebar always go whole. */
export const PARTIAL_LISTS = ["jobs", "conversations"] as const;
export type PartialList = typeof PARTIAL_LISTS[number];

export const HELLO_BUCKETS = 128;

type Keyed = { readonly id: string };

function fnv(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export const bucketOf = (id: string): number => fnv(id) % HELLO_BUCKETS;

/** Each bucket's digest as 8 hex digits, all in one string. */
export function digests(items: readonly Keyed[]): string {
  const groups: string[][] = Array.from({ length: HELLO_BUCKETS }, () => []);
  for (const item of [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) groups[bucketOf(item.id)]!.push(JSON.stringify(item));
  return groups.map(group => fnv(group.join("\n")).toString(16).padStart(8, "0")).join("");
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
