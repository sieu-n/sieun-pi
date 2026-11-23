/**
 * The Skills page's two reads, kept for as long as the page lives and in IndexedDB for the next page load, so an open draws the last
 * answer at once and reads it again behind: GET /api/skills, the skills DB view the layouts draw, and GET /api/skills/inventory, which the
 * `current` layout draws. In the p155 rig at the owner's 200 ms round trip on 11-23, every open of the page read both and waited for them:
 * the view is 252 KB as brotli and took 1,094 ms at p50 and 1,471 at p90, and the inventory, read beside it, 642 and 1,410 ms
 * (~/work/p155-sweep/fix-skills/notes.md).
 *
 * Each call's line says what the screen did (client.ts `Wait`): `ahead` for a read no layout shows yet, `shown` for a refresh behind an
 * answer the page shows that came back the same, and a wait for a first read or a refresh that changed what the page shows.
 */
import { afterWrite, api, takeOver, type Wait } from "$lib/api/client";
import type { SkillsReport, SkillsView } from "$lib/api/shared/skills";

/** The IndexedDB store of the answers, apart from page-db.ts, whose every kept page each page load reads before it mounts. */
const DB = "chat.skills";
const STORE = "answers";
let opened: Promise<IDBDatabase> | undefined;

function stores(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB did not open"));
    request.onblocked = () => reject(new Error("IndexedDB is held by an older tab"));
  });
  return opened.then(db => db.transaction(STORE, mode).objectStore(STORE));
}

/** The stored answer of `key`, or null; every failure, IndexedDB closed to the page included, reads as none. */
function stored(key: string): Promise<unknown> {
  return stores("readonly").then(store => new Promise<unknown>(resolve => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => resolve(null);
  }), () => null);
}

function store(key: string, value: unknown): void {
  void stores("readwrite").then(store => void store.put(value, key), () => undefined);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** One read's kept answer, shared by every view of the page that shows it. */
export class KeptAnswer<T> {
  /** Raw state, replaced whole by each answer that differs: the view is 3.4 MB of JSON, far too big to proxy deeply. */
  value = $state.raw<T | null>(null);
  error = $state<string | null>(null);
  private flight: { read: Promise<void>; wait: Wait } | undefined;
  private restored: Promise<void> | undefined;

  constructor(private readonly key: string, private readonly fetch: (wait: Wait) => Promise<T>, private readonly valid: (value: unknown) => value is T) {}

  /** The answer an earlier page load stored, taken once, unless a read brought one first. */
  private restore(): Promise<void> {
    return (this.restored ??= stored(this.key).then(value => {
      if (this.value === null && this.valid(value)) this.value = value;
    }));
  }

  /** Draws the kept answer, from IndexedDB on the first open of a page load, and reads it again behind; with none kept he waits on the read. */
  async open(): Promise<void> {
    await this.restore();
    return this.read(this.value === null ? undefined : "shown");
  }

  /** Reads the answer before any view shows it, when none is kept; the lane sends it after every call he waits on (client.ts). */
  async ahead(): Promise<void> {
    await this.restore();
    if (this.value === null) return this.read("ahead");
  }

  /**
   * Reads the answer again: `shown` for a refresh behind the answer the page shows, `ahead` for one no view shows, and nothing for a read
   * he waits on, such as a layout's read after his change. A read on its way serves it, unless it left before his last write answered.
   */
  read(background?: Wait["background"]): Promise<void> {
    if (this.flight && !(background !== "ahead" && afterWrite(this.flight.wait))) {
      if (background !== "ahead") takeOver(this.flight.wait, background);
      return this.flight.read;
    }
    const wait: Wait = background ? { background } : {};
    const flight = {
      wait,
      read: this.fetch(wait).then(answer => {
        if (this.flight !== flight) return;
        if (same(this.value, answer)) this.error = null;
        else {
          // A refresh that changed what the page shows is one he waited for.
          if (wait.background === "shown") wait.background = undefined;
          this.set(answer);
        }
      }, (error: unknown) => {
        if (this.flight === flight) this.error = message(error);
      }).finally(() => {
        if (this.flight === flight) this.flight = undefined;
      }),
    };
    this.flight = flight;
    return flight.read;
  }

  /** An answer a read brought; it is kept for the next page load too. */
  private set(value: T): void {
    this.value = value;
    this.error = null;
    store(this.key, value);
  }

  /** Changes the answer the page shows from a live event, such as a scan that started, until the next read brings the server's. */
  patch(change: (value: T) => T): void {
    if (this.value !== null) this.value = change(this.value);
  }
}

const isView = (value: unknown): value is SkillsView => {
  const view = value as Partial<SkillsView> | null;
  return Array.isArray(view?.skills) && Array.isArray(view.boxes) && typeof view.counts === "object" && typeof view.scan === "object";
};
const isReport = (value: unknown): value is SkillsReport => {
  const report = value as Partial<SkillsReport> | null;
  return typeof report?.scan === "object" && report.scan !== null && "inventory" in report;
};

/** GET /api/skills, the skills DB view every layout but `current` draws. */
export const skillsView = new KeptAnswer<SkillsView>("view", wait => api.skills(wait), isView);
/** GET /api/skills/inventory, the scanner's inventory the `current` layout draws. */
export const skillsInventory = new KeptAnswer<SkillsReport>("inventory", wait => api.skillsInventory(wait), isReport);
