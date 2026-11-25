/**
 * The pages the page cache keeps (stores.svelte.ts `PageCache`), also in IndexedDB, so a page load shows the room and the thread of its
 * address at once and reads them again behind. A new release reloads the page when the owner switches away (reload.ts): on 11-20, 197 ms
 * from the box, four such loads from 06:43 to 06:58 KST each waited 204 to 222 ms for the room's items and for the replies of the thread
 * that was open, with nothing on the screen (requests/2026-11-19.jsonl). Every call settles, also where IndexedDB is closed to the page.
 */
import { holdReload, releaseReload } from "./reload.ts";

const DB = "chat.pages";
const STORE = "pages";
/** The shape of a kept page. A release that changes `Item` or a header so that an older page no longer renders raises it, which drops every kept page. */
const SHAPE = 1;

/** One kept page: the cache that holds it, its key there, when it was kept, and the page as the cache shows it. */
export interface KeptPage { cache: string; key: string; at: number; value: unknown }

let opened: Promise<IDBDatabase> | undefined;
let writes = 0;

function open(): Promise<IDBDatabase> {
  return (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, SHAPE);
    request.onupgradeneeded = () => {
      if (request.result.objectStoreNames.contains(STORE)) request.result.deleteObjectStore(STORE);
      request.result.createObjectStore(STORE, { keyPath: ["cache", "key"] });
    };
    request.onsuccess = () => {
      // A newer build's tab raises the shape; this tab lets it, and keeps its pages in memory only from then on.
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB did not open"));
    request.onblocked = () => reject(new Error("IndexedDB is held by an older tab"));
  }));
}

async function run<T>(mode: IDBTransactionMode, ask: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = ask(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("IndexedDB refused the call"));
  });
}

const isKept = (value: unknown): value is KeptPage => {
  const page = value as Partial<KeptPage> | null;
  return typeof page?.cache === "string" && typeof page.key === "string" && typeof page.at === "number" && page.value !== undefined;
};

/** The kept pages of one cache, read in a transaction of their own. */
const cachePages = (cache: string): Promise<unknown[]> =>
  run<unknown[]>("readonly", store => store.getAll(IDBKeyRange.bound([cache], [cache, []]))).catch(() => []);

export const pageDb = {
  /**
   * Every kept page of `caches`, the oldest first. Each cache is read in its own transaction, so the browser takes each one's records in a
   * task of its own: on 11-25 one read of all 652 records (2.6 MB of hello buckets, 2.1 MB of panels, 0.7 MB of timelines) took 36 to
   * 45 ms of a reload's first task at CPU rate 1 and 159 ms at rate 4 (~/work/p300-channel-open/trace-summary.md).
   */
  all: (caches: readonly string[]): Promise<KeptPage[]> =>
    Promise.all(caches.map(cachePages)).then(lists => lists.flat().filter(isKept).sort((a, b) => a.at - b.at)),
  /**
   * A write holds a reload for a newer build until it lands, since a write started as the page goes away never does: on 11-23 a reload as
   * his thread reply landed brought back the room without the root's new thread pill, and its open waited a round trip (work/p278-thread-open).
   */
  put: (cache: string, key: string, value: unknown): Promise<void> => {
    const write = `page:${++writes}`;
    holdReload(write);
    return run("readwrite", store => store.put({ cache, key, at: Date.now(), value } satisfies KeptPage))
      .then(() => undefined, () => undefined).finally(() => releaseReload(write));
  },
  /** Puts several pages of one cache in one transaction, holding a reload the same way. */
  putMany: (cache: string, pages: readonly { key: string; value: unknown }[]): Promise<void> => {
    const write = `page:${++writes}`;
    holdReload(write);
    return open()
      .then(db => new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const at = Date.now();
        for (const { key, value } of pages) store.put({ cache, key, at, value } satisfies KeptPage);
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("IndexedDB refused the call"));
      }))
      .then(() => undefined, () => undefined).finally(() => releaseReload(write));
  },
  drop: (cache: string, key: string): Promise<void> => run("readwrite", store => store.delete([cache, key])).then(() => undefined, () => undefined),
};
