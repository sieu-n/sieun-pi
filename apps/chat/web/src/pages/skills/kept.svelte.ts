/**
 * The Skills page's reads, kept for as long as the page lives and in IndexedDB for the next page load, so an open draws the last answer
 * at once and reads it again behind: GET /api/skills, the skills DB view the layouts draw, GET /api/skills/text, its descriptions, and
 * GET /api/skills/inventory, which the `current` layout draws. In the p155 rig at the owner's 200 ms round trip on 11-23, every open of the page read both and waited for them:
 * the view is 252 KB as brotli and took 1,094 ms at p50 and 1,471 at p90, and the inventory, read beside it, 642 and 1,410 ms
 * (~/work/p155-sweep/fix-skills/notes.md).
 *
 * Each read asks for the changes since the version the page holds (shared/listed.ts), so a refresh of an unchanged answer is a few bytes
 * and one after a scan carries the skills it changed: in full2-1119bea a refresh after the walk's scans took 1,189 ms for the whole view,
 * and a scan on 11-23 changed 18 of its 609 skills once each copy's checkout went apart (shared/skills.ts `toWire`), 17.8 KB as brotli.
 *
 * Each call's line says what the screen did (client.ts `Wait`): `ahead` for a read no view shows yet, `shown` for a refresh behind an
 * answer the page shows that came back the same, and a wait for a first read or a refresh that changed what the page shows.
 */
import { afterWrite, api, takeOver, type Wait } from "$lib/api/client";
import { live } from "$lib/api/live.svelte";
import { applyListed, type ListedAnswer, type ListedVersion } from "$lib/api/shared/listed";
import { fromWire, type SkillText, type SkillsReport, type SkillsView, type WireView } from "$lib/api/shared/skills";

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

/** The stored version of `key`, or null; every failure, IndexedDB closed to the page included, reads as none. */
function stored(key: string): Promise<unknown> {
  return stores("readonly").then(store => new Promise<unknown>(resolve => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => resolve(null);
  }), () => null);
}

/**
 * Stores a version once the page is idle: IndexedDB copies the 3.4 MB view on the page's thread, which must not hold the answer of the
 * inventory read that comes beside it after a scan.
 */
function store(key: string, version: unknown): void {
  const put = () => void stores("readwrite").then(store => void store.put(version, key), () => undefined);
  if (typeof requestIdleCallback === "function") requestIdleCallback(put, { timeout: 2000 });
  else setTimeout(put);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One read's kept answer, shared by every view of the page that shows it. */
export class KeptAnswer<T, W = T> {
  /** Raw state, replaced whole by each answer that differs: the view is 3.4 MB of JSON, far too big to proxy deeply. */
  value = $state.raw<T | null>(null);
  error = $state<string | null>(null);
  /** The version `value` came from as the server sent it, whose tag the next read sends and on which its changes apply. */
  private held: ListedVersion<W> | null = null;
  private flight: { read: Promise<void>; wait: Wait } | undefined;
  private restored: Promise<void> | undefined;

  constructor(
    private readonly key: string,
    private readonly fetch: (since: string, wait: Wait) => Promise<ListedAnswer>,
    private readonly path: readonly string[],
    /** The answer the page shows of the one the server sent, such as the view with each copy's checkout put back (shared/skills.ts). */
    private readonly shown: (sent: W) => T,
    private readonly valid: (value: unknown) => value is W,
  ) {}

  /** The version an earlier page load stored, taken once, unless a read brought one first. */
  private restore(): Promise<void> {
    return (this.restored ??= stored(this.key).then(found => {
      const version = found as Partial<ListedVersion<unknown>> | null;
      if (this.value !== null || typeof version?.tag !== "string" || !this.valid(version.value)) return;
      this.held = version as ListedVersion<W>;
      this.value = this.shown(this.held.value);
    }));
  }

  /** Draws the kept answer, from IndexedDB on the first open of a page load, and reads it again behind; with none kept he waits on the read. */
  async open(): Promise<void> {
    await this.restore();
    return this.read(this.value === null ? undefined : "shown");
  }

  /**
   * Reads the answer before any view shows it, so a switch to one draws it current; the lane sends it after every call he waits on and
   * every refresh (client.ts). A kept answer reads only its changes, a few KB after a scan.
   */
  async ahead(): Promise<void> {
    await this.restore();
    return this.read("ahead");
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
    const flight = { wait, read: this.settle(wait).finally(() => {
      if (this.flight === flight) this.flight = undefined;
    }) };
    this.flight = flight;
    return flight.read;
  }

  /** One read and its answer; an answer that needs a version the page no longer holds reads the whole answer again. */
  private async settle(wait: Wait): Promise<void> {
    try {
      const held = this.held;
      let next = applyListed(held, await this.fetch(held?.tag ?? "", wait), this.path);
      if (!next) next = applyListed<W>(null, await this.fetch("", wait), this.path);
      if (this.flight?.wait !== wait || !next) return;
      if (next === held) {
        this.error = null;
        return;
      }
      // A refresh that changed what the page shows is one he waited for.
      if (wait.background === "shown") wait.background = undefined;
      this.held = next;
      this.value = this.shown(next.value);
      this.error = null;
      store(this.key, next);
    } catch (error) {
      if (this.flight?.wait === wait) this.error = message(error);
    }
  }

  /** Changes the answer the page shows from a live event, such as a scan that started, until the next read brings the server's. */
  patch(change: (value: T) => T): void {
    if (this.value !== null) this.value = change(this.value);
  }
}

const isView = (value: unknown): value is WireView => {
  const view = value as Partial<WireView> | null;
  return Array.isArray(view?.skills) && Array.isArray(view.boxes) && typeof view.counts === "object" && typeof view.scan === "object" && typeof view.checkouts === "object";
};
const isReport = (value: unknown): value is SkillsReport => {
  const report = value as Partial<SkillsReport> | null;
  return typeof report?.scan === "object" && report.scan !== null && "inventory" in report;
};

const isTexts = (value: unknown): value is { skills: SkillText[] } => Array.isArray((value as { skills?: unknown } | null)?.skills);

/** GET /api/skills, the skills DB view every layout but `current` draws. */
export const skillsView = new KeptAnswer<SkillsView, WireView>("view", (since, wait) => api.skillsSince(since, wait), ["skills"], fromWire, isView);
/** GET /api/skills/text, each skill's description by id, which the view's wire form leaves out (shared/skills.ts `toWire`). */
export const skillsText = new KeptAnswer<ReadonlyMap<string, string>, { skills: SkillText[] }>(
  "text", (since, wait) => api.skillsTextSince(since, wait), ["skills"], sent => new Map(sent.skills.map(t => [t.id, t.description])), isTexts,
);

/**
 * Reads the view, then the texts, ahead in the lane, so his first open of the page draws a kept answer: once the page is idle after each
 * hello of the live socket, and when Settings opens. Without it a fresh profile's first open waited on the whole view, 1,263 ms at a 200 ms
 * round trip in the p155 rig on 11-23 (runs/p179-default-tree-80271e3). A kept answer reads only its changes, a few bytes when none.
 */
export function readSkillsAhead(): void {
  void skillsView.ahead().then(() => skillsText.ahead());
}

if (typeof window !== "undefined") {
  const idle = (run: () => void) => (typeof requestIdleCallback === "function" ? requestIdleCallback(run) : setTimeout(run));
  live.on(event => {
    if (event.type === "hello") idle(readSkillsAhead);
  });
}
/** GET /api/skills/inventory, the scanner's inventory the `current` layout draws. */
export const skillsInventory = new KeptAnswer<SkillsReport>("inventory", (since, wait) => api.skillsInventorySince(since, wait), ["inventory", "skills"], report => report, isReport);
