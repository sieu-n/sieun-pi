import type { ImageInput } from "../shared/types.ts";
import type { OutboxAccepted, OutboxEntry } from "../shared/outbox.ts";
import type { PendingSend } from "../shared/chat-feed.ts";

/*
 * The page's half of the owner's outbox (src/shared/outbox.ts). On 10-18 08:16Z a send bounced with 'Timed out after 30000ms waiting for the
 * Prime Agent daemon response to "attach"', a red toast, and the text back in the box. Now a send is kept in IndexedDB first (its base64
 * images overflow localStorage's ~5 MB), shows at once as a sending bubble, and is posted with its id until the server holds it. A reload or a
 * reconnect posts every send the server has not delivered again with the same id; the server dedupes, so two tabs that do it both are fine.
 */

/** posting: the server has not answered the POST yet. held: the server has it on disk. failed: it cannot go, and the bubble says why. */
export type PageSendState = "posting" | "held" | "failed";

export interface PageSend { id: string; threadId: string; text: string; images: ImageInput[]; at: number; state: PageSendState; error?: string }

/** `sends` are kept in storage; `sent` are the delivered ones the thread has not echoed yet, shown as normal bubbles until it does. */
export interface OutboxView { sends: PageSend[]; sent: PageSend[] }

export type OutboxChange =
  | { type: "submit"; send: PageSend }
  /** What the server says about sends: a POST answer, or a thread's outbox list. Ids this page does not hold are ignored. */
  | { type: "server"; entries: readonly OutboxEntry[] }
  /** A 409: the server holds this id already. */
  | { type: "held"; id: string }
  /** A 4xx answer to the POST: the send cannot go as it is. */
  | { type: "refused"; id: string; error: string }
  | { type: "echoed"; ids: ReadonlySet<string> }
  | { type: "drop"; id: string };

export const EMPTY_OUTBOX: OutboxView = { sends: [], sent: [] };

export function reduceOutbox(view: OutboxView, change: OutboxChange): OutboxView {
  switch (change.type) {
    case "submit":
      return view.sends.some(send => send.id === change.send.id) ? view : { ...view, sends: [...view.sends, change.send] };
    case "server": {
      const byId = new Map(change.entries.map(entry => [entry.id, entry]));
      if (!view.sends.some(send => byId.has(send.id))) return view;
      const sends: PageSend[] = [];
      const sent = [...view.sent];
      for (const send of view.sends) {
        const entry = byId.get(send.id);
        if (!entry || send.state === "failed") sends.push(send);
        else if (entry.state === "delivered") sent.push(send);
        else if (entry.state === "failed") sends.push({ ...send, state: "failed", error: entry.error ?? "This message could not be sent." });
        else sends.push(send.state === "held" ? send : { ...send, state: "held" });
      }
      return { sends, sent };
    }
    case "held":
      return mapSend(view, change.id, send => send.state === "posting" ? { ...send, state: "held" } : send);
    case "refused":
      return mapSend(view, change.id, send => ({ ...send, state: "failed", error: change.error }));
    case "echoed": {
      const sends = view.sends.filter(send => send.state === "failed" || !change.ids.has(send.id));
      const sent = view.sent.filter(send => !change.ids.has(send.id));
      return sends.length === view.sends.length && sent.length === view.sent.length ? view : { sends, sent };
    }
    case "drop":
      return view.sends.some(send => send.id === change.id) ? { ...view, sends: view.sends.filter(send => send.id !== change.id) } : view;
  }
}

function mapSend(view: OutboxView, id: string, change: (send: PageSend) => PageSend): OutboxView {
  let changed = false;
  const sends = view.sends.map(send => {
    if (send.id !== id) return send;
    const next = change(send);
    if (next !== send) changed = true;
    return next;
  });
  return changed ? { ...view, sends } : view;
}

/** The outbox as the chat feed draws it, by thread: sending and failed sends, then the delivered ones not echoed yet. */
export function pendingOf(view: OutboxView): Record<string, PendingSend[]> {
  const byThread: Record<string, PendingSend[]> = {};
  const sent = new Set(view.sent);
  for (const send of [...view.sends, ...view.sent].sort((a, b) => a.at - b.at)) {
    const images = send.images.map(image => ({ type: "image" as const, mimeType: image.mimeType, url: "data:" + image.mimeType + ";base64," + image.data }));
    (byThread[send.threadId] ??= []).push({ id: send.id, text: send.text, images, at: send.at,
      ...(send.state === "failed" ? { failed: send.error ?? "This message could not be sent." } : sent.has(send) ? { sent: true as const } : {}) });
  }
  return byThread;
}

/** Where the page keeps its sends. `update` and `remove` leave alone a send another tab removed, so tabs never write one back. */
export interface OutboxStorage {
  all(): Promise<PageSend[]>;
  /** Writes a new send; resolves once it is on disk. */
  add(send: PageSend): Promise<void>;
  /** Writes a send that is still there; one another tab removed stays removed. */
  update(send: PageSend): Promise<void>;
  remove(id: string): Promise<void>;
}

/** The storage writes that take `before` to `after`. */
async function persist(storage: OutboxStorage, before: readonly PageSend[], after: readonly PageSend[]): Promise<void> {
  const old = new Map(before.map(send => [send.id, send]));
  const now = new Set(after.map(send => send.id));
  const writes: Promise<void>[] = [];
  for (const send of after) {
    const was = old.get(send.id);
    if (!was) writes.push(storage.add(send));
    else if (was !== send) writes.push(storage.update(send));
  }
  for (const id of old.keys()) if (!now.has(id)) writes.push(storage.remove(id));
  await Promise.all(writes);
}

export interface OutboxDeps {
  storage: OutboxStorage;
  post(send: PageSend): Promise<OutboxAccepted>;
  /** The HTTP status of a failed POST, or null when no answer came (network error, timeout). */
  status(error: unknown): number | null;
  onChange(view: OutboxView): void;
  log?(line: string): void;
  sleep?(ms: number): Promise<void>;
}

/** 1 s, doubling to 30 s, as the server's outbox does. */
const backoff = (attempt: number) => Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
const retryable = (status: number | null) => status === null || status >= 500 || status === 408 || status === 429;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export class PageOutbox {
  view: OutboxView = EMPTY_OUTBOX;
  /** Sends that need a POST: new ones, and every one not delivered after a load or reconnect. */
  private readonly due = new Set<string>();
  /** One POST loop per thread, so its sends reach the server in the order they were written. */
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly wakers = new Map<string, () => void>();
  /** Sends whose write to storage failed (private mode, full disk); they still go, from memory. */
  private readonly unsaved = new Set<string>();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly deps: OutboxDeps) {}

  private apply(change: OutboxChange): Promise<void> {
    const before = this.view;
    const after = reduceOutbox(before, change);
    if (after === before) return this.writes;
    this.view = after;
    this.deps.onChange(after);
    // Writes go in order, so an update never lands before the add it changes.
    this.writes = this.writes.then(() => persist(this.deps.storage, before.sends, after.sends))
      .catch(error => this.deps.log?.(`outbox: write: ${errorText(error)}`));
    return this.writes;
  }

  /** Keeps a new send and posts it once it is in storage. A second submit of one id adds nothing and posts nothing. */
  async submit(send: Omit<PageSend, "state" | "error">): Promise<void> {
    if (this.view.sends.some(held => held.id === send.id)) return;
    const entry: PageSend = { ...send, state: "posting" };
    this.view = reduceOutbox(this.view, { type: "submit", send: entry });
    this.deps.onChange(this.view);
    const write = this.writes.then(() => this.deps.storage.add(entry)).catch(error => {
      this.unsaved.add(entry.id);
      this.deps.log?.(`outbox: keep ${entry.id}: ${errorText(error)}`);
    });
    this.writes = write;
    await write;
    this.due.add(entry.id);
    this.kick(entry.threadId);
  }

  /**
   * Reads storage again, which holds what other tabs wrote, and posts every send not failed with its own id: the answer says where each one is.
   * Runs on page load (all threads) and on each thread snapshot, which a socket reconnect brings.
   */
  async resend(threadId?: string): Promise<void> {
    await this.writes;
    let stored: PageSend[];
    try { stored = await this.deps.storage.all(); } catch (error) { this.deps.log?.(`outbox: read: ${errorText(error)}`); stored = this.view.sends; }
    const ids = new Set(stored.map(send => send.id));
    const sends = [...stored, ...this.view.sends.filter(send => this.unsaved.has(send.id) && !ids.has(send.id))].sort((a, b) => a.at - b.at);
    this.view = { ...this.view, sends };
    this.deps.onChange(this.view);
    for (const send of sends) {
      if (send.state === "failed" || (threadId !== undefined && send.threadId !== threadId)) continue;
      this.due.add(send.id);
      this.kick(send.threadId);
    }
  }

  /** The server's outbox list for a thread, from an `outbox` event or a snapshot. */
  server(entries: readonly OutboxEntry[]): Promise<void> { return this.apply({ type: "server", entries }); }

  /** The thread echoed these sends back as messages. */
  echoed(ids: ReadonlySet<string>): Promise<void> { return this.apply({ type: "echoed", ids }); }

  /** Edit on a failed send: it leaves the outbox and its text goes back to the composer. */
  drop(id: string): Promise<void> { this.due.delete(id); return this.apply({ type: "drop", id }); }

  /** Retry on a failed send: the same text and images go again under `newId`, since the server keeps the old id as failed. */
  async retry(id: string, newId: string, at: number): Promise<void> {
    const send = this.view.sends.find(held => held.id === id);
    if (!send) return;
    await this.drop(id);
    await this.submit({ id: newId, threadId: send.threadId, text: send.text, images: send.images, at });
  }

  /** Sends the server does not hold yet; a reload now would post them again from storage, but the page offers it instead. */
  hasUnsent(): boolean { return this.view.sends.some(send => send.state === "posting"); }

  private kick(threadId: string): void {
    this.wakers.get(threadId)?.();
    if (this.lanes.has(threadId)) return;
    this.lanes.set(threadId, this.drain(threadId).finally(() => {
      this.lanes.delete(threadId);
      if (this.view.sends.some(send => send.threadId === threadId && this.due.has(send.id))) this.kick(threadId);
    }));
  }

  /** Resolves once every POST loop has ended and the writes are done; tests use it. */
  async idle(): Promise<void> {
    while (this.lanes.size) await Promise.all([...this.lanes.values()]);
    await this.writes;
  }

  private async drain(threadId: string): Promise<void> {
    let attempt = 0;
    for (;;) {
      const send = this.view.sends.find(held => held.threadId === threadId && this.due.has(held.id));
      if (!send) return;
      if (send.state === "failed") { this.due.delete(send.id); continue; }
      try {
        const answer = await this.deps.post(send);
        this.due.delete(send.id);
        attempt = 0;
        await this.apply({ type: "server", entries: [answer.outbox] });
      } catch (error) {
        const status = this.deps.status(error);
        if (retryable(status)) {
          this.deps.log?.(`outbox: ${send.id} try ${attempt + 1}: ${errorText(error)}`);
          await this.pause(threadId, backoff(attempt++));
          continue;
        }
        this.due.delete(send.id);
        attempt = 0;
        await this.apply(status === 409 ? { type: "held", id: send.id } : { type: "refused", id: send.id, error: errorText(error) });
      }
    }
  }

  /** The backoff wait; a resend or a new send on the thread ends it early. */
  private pause(threadId: string, ms: number): Promise<void> {
    const sleep = this.deps.sleep ?? (wait => new Promise<void>(resolve => setTimeout(resolve, wait)));
    return new Promise<void>(resolve => {
      const done = () => { this.wakers.delete(threadId); resolve(); };
      this.wakers.set(threadId, done);
      void sleep(ms).then(done);
    });
  }
}

/** Sends in memory only; tests use it, and so does a browser without IndexedDB. */
export function memoryStorage(initial: PageSend[] = []): OutboxStorage & { sends: Map<string, PageSend> } {
  const sends = new Map(initial.map(send => [send.id, send]));
  return {
    sends,
    all: async () => [...sends.values()],
    add: async send => { if (!sends.has(send.id)) sends.set(send.id, send); },
    update: async send => { if (sends.has(send.id)) sends.set(send.id, send); },
    remove: async id => { sends.delete(id); },
  };
}

/** The sends in IndexedDB; each write resolves once its transaction is committed with strict durability. */
export function indexedDbStorage(name = "sieun-pi-outbox"): OutboxStorage {
  let opened: Promise<IDBDatabase> | null = null;
  const db = () => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("sends", { keyPath: "id" }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opened = null; reject(request.error); };
  });
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | undefined): Promise<T | undefined> => {
    const handle = await db();
    return new Promise<T | undefined>((resolve, reject) => {
      const tx = handle.transaction("sends", mode, { durability: "strict" });
      const request = work(tx.objectStore("sends"));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  /** Writes `send` only when the id is or is not there yet, in one transaction. */
  const putIf = (send: PageSend, present: boolean) => run("readwrite", store => {
    const found = store.getKey(send.id);
    found.onsuccess = () => { if ((found.result !== undefined) === present) store.put(send); };
    return undefined;
  }).then(() => {});
  return {
    all: () => run("readonly", store => store.getAll() as IDBRequest<PageSend[]>).then(sends => sends ?? []),
    add: send => putIf(send, false),
    update: send => putIf(send, true),
    remove: id => run("readwrite", store => { store.delete(id); return undefined; }).then(() => {}),
  };
}
