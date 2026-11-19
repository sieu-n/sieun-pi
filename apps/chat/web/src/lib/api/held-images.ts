/**
 * The bytes of the images of a send whose uploads had not ended, kept in IndexedDB by the send's requestId, since localStorage holds no
 * blobs. With them a reload in the middle of an upload sends the message again from the next page (held-sends.ts `uploading`); before, such
 * a send was kept nowhere and the reload lost it without a word. Every call settles, also where IndexedDB is closed to the page.
 */
const DB = "chat.heldImages";
const STORE = "images";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB did not open"));
  });
}

async function run<T>(mode: IDBTransactionMode, ask: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = ask(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("IndexedDB refused the write"));
    });
  } finally {
    db.close();
  }
}

const isBlobs = (value: unknown): value is Blob[] => Array.isArray(value) && value.every(blob => blob instanceof Blob);

export const heldImages = {
  put: (requestId: string, files: Blob[]): Promise<void> => run("readwrite", store => store.put(files, requestId)).then(() => undefined, () => undefined),
  get: (requestId: string): Promise<Blob[] | undefined> =>
    run<unknown>("readonly", store => store.get(requestId)).then(value => (isBlobs(value) ? value : undefined), () => undefined),
  drop: (requestId: string): Promise<void> => run("readwrite", store => store.delete(requestId)).then(() => undefined, () => undefined),
};
