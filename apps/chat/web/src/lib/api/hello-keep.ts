/**
 * The hello's timed lists as the page holds them between socket opens and page loads (shared/hello-buckets.ts), kept in IndexedDB one
 * bucket per record, each with its digest.
 *
 * The page used to put both whole lists in one record, and to digest both whole lists, inside the hello's own task. In traces of the
 * #1124-cost-management open on 11-25 (~/work/p300-channel-open/trace-summary.md) that put cost 49 to 54 ms and the digests 29 to 33 ms
 * of a 157 to 172 ms hello task on a reload, and 234 ms and 125 ms of 1,111 ms at CPU rate 4. A put of the 2.5 MB lists alone took 36 to
 * 50 ms at CPU rate 1 and 237 to 250 ms at rate 4 (bench.mjs there). Now a hello only marks the buckets it changed. Their digests and
 * records are made later, in slices of idle time, and a page load reads each bucket's digest back instead of digesting the lists again.
 */
import { pageDb, type KeptPage } from "./page-db.ts";
import { holdReload, releaseReload } from "./reload.ts";
import { bucketDigest, byBucket, HELLO_BUCKETS, PARTIAL_LISTS, type PartialList } from "./shared/hello-buckets.ts";

type Keyed = { readonly id: string };

/** The page-db.ts cache of the kept buckets; a record's key is `<list>/<bucket>`. */
export const HELLO_BUCKET_CACHE = "hello-bucket";
/** The one record that held both whole lists before, under cache and key `hello`, which a page load drops. */
const OLD_RECORD = "hello";

/** One kept bucket: its items in list order and its digest. */
interface KeptBucket { items: Keyed[]; digest: string }

/** One list as the page holds it, with each bucket's digest, worked out only when something asks for it. */
export class HeldList<T extends Keyed> {
  private grouped: T[][] | undefined;
  private readonly digest: (string | undefined)[];

  constructor(readonly items: readonly T[], digest?: readonly (string | undefined)[]) {
    this.digest = digest ? [...digest] : Array.from({ length: HELLO_BUCKETS }, () => undefined);
  }

  /** The list a hello leaves: `items`, whose buckets outside `changed` hold what this list held, so their digests carry over. */
  next(items: readonly T[], changed: readonly number[]): HeldList<T> {
    const digest = [...this.digest];
    for (const bucket of changed) digest[bucket] = undefined;
    return new HeldList(items, digest);
  }

  bucket(bucket: number): T[] {
    return (this.grouped ??= byBucket(this.items))[bucket]!;
  }

  digestOf(bucket: number): string {
    return (this.digest[bucket] ??= bucketDigest(this.bucket(bucket)));
  }

  /** Every bucket's digest in one string, as the socket's URL names them (shared/hello-buckets.ts `digests`). */
  held(): string {
    let out = "";
    for (let bucket = 0; bucket < HELLO_BUCKETS; bucket++) out += this.digestOf(bucket);
    return out;
  }
}

const isBucket = (value: unknown): value is KeptBucket => {
  const kept = value as Partial<KeptBucket> | null;
  return Array.isArray(kept?.items) && typeof kept.digest === "string" && kept.digest.length === 8;
};

/** The lists the last page load kept, each only when all its buckets are there, or undefined. */
export function keptLists(pages: readonly KeptPage[]): Record<PartialList, HeldList<Keyed>> | undefined {
  if (pages.some(page => page.cache === OLD_RECORD && page.key === OLD_RECORD)) void pageDb.drop(OLD_RECORD, OLD_RECORD);
  const buckets = new Map<string, KeptBucket>();
  for (const page of pages) if (page.cache === HELLO_BUCKET_CACHE && isBucket(page.value)) buckets.set(page.key, page.value);
  const lists: Partial<Record<PartialList, HeldList<Keyed>>> = {};
  for (const list of PARTIAL_LISTS) {
    const items: Keyed[] = [];
    const digest: string[] = [];
    for (let bucket = 0; bucket < HELLO_BUCKETS; bucket++) {
      const kept = buckets.get(`${list}/${bucket}`);
      if (!kept) return undefined;
      items.push(...kept.items);
      digest.push(kept.digest);
    }
    lists[list] = new HeldList(items, digest);
  }
  return lists as Record<PartialList, HeldList<Keyed>>;
}

/**
 * The digest time one slice spends before its put, whose structured clone takes about as long again. The slice's task stays well under
 * the 50 ms a browser counts as a long task: at CPU rate 4 the 512 buckets of 2,716 jobs and 3,006 conversations took 125 ms to digest and
 * 237 to 250 ms to put on 11-25, under 1 ms a bucket.
 */
const DIGEST_MS = 4;
const HOLD = "hello-buckets";
/** The buckets not kept yet, by record key, each with the list it comes from; a later hello's list replaces an earlier one's. */
const pending = new Map<string, { list: HeldList<Keyed>; bucket: number }>();
let scheduled = false;

const idle = (run: () => void): void => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(run);
  else setTimeout(run, 0);
};

/** Keeps the `changed` buckets of `list`, every bucket when undefined, in later slices of idle time. A reload waits until they land. */
export function keepBuckets(name: PartialList, list: HeldList<Keyed>, changed: readonly number[] | undefined): void {
  const buckets = changed ?? Array.from({ length: HELLO_BUCKETS }, (_, bucket) => bucket);
  for (const bucket of buckets) pending.set(`${name}/${bucket}`, { list, bucket });
  schedule();
}

function schedule(): void {
  if (scheduled || !pending.size) return;
  scheduled = true;
  holdReload(HOLD);
  idle(slice);
}

function slice(): void {
  scheduled = false;
  const started = performance.now();
  const pages: { key: string; value: KeptBucket }[] = [];
  for (const [key, { list, bucket }] of pending) {
    pending.delete(key);
    pages.push({ key, value: { items: list.bucket(bucket), digest: list.digestOf(bucket) } });
    if (performance.now() - started >= DIGEST_MS) break;
  }
  void pageDb.putMany(HELLO_BUCKET_CACHE, pages).finally(() => {
    if (pending.size) schedule();
    else if (!scheduled) releaseReload(HOLD);
  });
}
