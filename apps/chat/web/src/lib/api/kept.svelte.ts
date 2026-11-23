/**
 * The answers of the panel reads (`reads` in client.ts), kept by path for as long as the page lives and in IndexedDB for the next page
 * load (page-db.ts). A panel shows the kept answer the moment it opens and reads it again behind, and `ahead` fills it before the first
 * open. A page load used to wait on the open room's board pane: on 11-21 its board read, 42 KB, held GET /api/later about 575 ms on a
 * connection whose window had gone back to slow start (~/work/p155-readahead/lane-summary.md); a kept board makes that read a refresh,
 * which waits in the lane behind his calls (client.ts). The owner reads :5184 from Korea: in the 24 h to
 * 11-20 09:03 KST his board and duties calls took 203 and 213 ms at p50 and up to 1,040 and 947 ms (requests/2026-11-19.jsonl), while the
 * server answered them in 2 to 7 ms, and each panel stayed empty for that long on every open.
 *
 * Each call's line says what the screen did (client.ts `Wait`): `ahead` for a read no panel shows yet, `shown` for a refresh behind a
 * panel that already showed the kept answer and got the same one back, and a wait for a first read or a refresh that changed the panel.
 */
import { untrack } from "svelte";
import { afterWrite, get, reads, takeOver, type Read, type Wait } from "./client.ts";
import { live } from "./live.svelte.ts";
import { pageDb, type KeptPage } from "./page-db.ts";
import { withAsks, withRow } from "./shared/board-lists.ts";

/** The page-db.ts cache the answers go to, so a page load shows them at once and its first read of each is a refresh behind them. */
const STORED = "kept";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** A read on its way, with the live events' changes that came meanwhile (`Kept.change`). */
type Flight<T> = { read: Promise<void>; wait: Wait; changes: ((value: T) => T | undefined)[] };

/** One read's kept answer, shared by every panel that shows it. */
export class Kept<T> {
  /** Raw state, replaced whole by each answer that differs: a board measured 142 KB on 11-20, too big to proxy deeply. */
  value = $state.raw<T | null>(null);
  error = $state<string | null>(null);
  private flight: Flight<T> | undefined;
  private views = 0;
  /** A `live` read holds what the socket's events said since its last answer, so reading it ahead again would bring the same. */
  private current = false;
  /** When the read of the kept answer left the page (`Wait.sent`), unset for an answer the last page load kept. */
  private sent = -Infinity;

  constructor(private readonly of: Read<T>, value: T | null) {
    this.value = value;
  }

  get loading(): boolean {
    return this.value === null && this.error === null;
  }

  get idle(): boolean {
    return !this.views && !this.flight;
  }

  /**
   * Reads the answer for a panel that shows this one. A read ahead that is on its way serves it too, and from then on counts as what the
   * panel waits on, or as a refresh behind it when the panel already shows an answer.
   */
  read(): Promise<void> {
    return this.fetch(this.value === null ? undefined : "shown");
  }

  /** Reads the answer before any panel shows it, unless a panel has it open or the socket keeps it current. */
  ahead(): Promise<void> {
    return this.views || (this.of.live && this.current) ? Promise.resolve() : this.fetch("ahead");
  }

  private fetch(background: Wait["background"]): Promise<void> {
    // A refresh asked as his write answered reads again, since a read on its way since before may carry the answer from before the write.
    if (this.flight && !(background !== "ahead" && afterWrite(this.flight.wait))) {
      if (background !== "ahead") takeOver(this.flight.wait, background);
      return this.flight.read;
    }
    const wait: Wait = background ? { background } : {};
    let unplaced = false;
    const flight: Flight<T> = {
      wait,
      changes: [],
      read: get(this.of, wait).then(answer => {
        if (this.flight !== flight) return;
        this.sent = wait.sent ?? -Infinity;
        // An event that came while the read was on its way may be newer than the answer, so it goes on top of it, in order.
        let next = answer;
        for (const change of flight.changes) {
          const changed = change(next);
          if (changed === undefined) unplaced = true;
          else next = changed;
        }
        // A refresh that changed what the panel shows is one the owner waited for.
        if (same(this.value, next)) this.error = null;
        else {
          if (wait.background === "shown") wait.background = undefined;
          this.set(next);
        }
        this.current = true;
      }, error => {
        if (this.value === null) this.error = message(error);
      }).finally(() => {
        if (this.flight === flight) this.flight = undefined;
        if (unplaced) void this.read();
      }),
    };
    this.flight = flight;
    return flight.read;
  }

  /**
   * Brings the kept answer up to date from a live event, with no read: `change` gives the new answer, or `undefined` when the event cannot
   * be placed in it, which reads it again. An answer on its way takes the change too, since it may have left the server before the event.
   */
  change(change: (value: T) => T | undefined): void {
    this.flight?.changes.push(change);
    if (this.value === null) return;
    const next = change(this.value);
    if (next === undefined) void this.read();
    else if (!same(this.value, next)) this.set(next);
  }

  /** The answer a read, a write or a live event brought; it is kept for the next page load too. */
  set(value: T): void {
    this.value = value;
    this.error = null;
    void pageDb.put(STORED, this.of.path, value);
  }

  /** A panel shows this answer until the returned function runs: it reads it again now and after each time the socket comes back. */
  open(): () => void {
    this.views += 1;
    void this.read();
    return () => void (this.views -= 1);
  }

  /**
   * The socket opened again, so events may have been missed: an open panel reads again, and a read ahead may run again. An answer whose read
   * left after the socket opened missed nothing, and on the page's first open so did one still waiting to leave. On a page load the panels read before the socket's hello
   * came, and the hello read each of them again: in a walk at a 200 ms round trip on 11-22 every load read /api/rooms, the board and its
   * duties twice (~/work/p189-rooms).
   */
  missed(): void {
    // After a drop, a read still waiting to leave may wait behind the owner's calls on the old HTTP connection, which TCP brings back seconds
    // after the network: in the wake walk on 11-22 a board refresh queued in the lane showed 2.6 s after the network came back while the
    // socket opened at 0.8 s (~/work/p209-wake/after7). So only a read that left after this open counts then.
    const waiting = live.opens > 1 ? -Infinity : Infinity;
    if ((this.flight ? this.flight.wait.sent ?? waiting : this.sent) >= live.openedAt) return;
    this.current = false;
    if (this.views) this.readOverSocket();
  }

  /**
   * An open panel's read at the socket's open goes over the socket, whose connection is new: in the wake walk on 11-22 the panels' HTTP
   * reads at the open took 4.7 s behind a read ahead that the cut caught on the HTTP connection (~/work/p209-wake/after4). It reads over
   * HTTP when the socket read fails.
   */
  private readOverSocket(): void {
    const sent = performance.now();
    live.read(this.of.path).then(answer => {
      const next = (this.of.pick ? this.of.pick(answer as never) : answer) as T;
      this.sent = Math.max(this.sent, sent);
      this.current = true;
      if (same(this.value, next)) this.error = null;
      else this.set(next);
    }, () => void this.read());
  }
}

/**
 * How many answers the page keeps. On 11-20 ag_vent's board, duties, jobs and config were 142, 54, 55 and 48 KB of JSON (GET
 * /api/agents/ag_vent/...), so 100 answers hold under 15 MB; the box had 8 agents then, each with those four and a check-in.
 */
const KEEP = 100;
const entries = new Map<string, Kept<unknown>>();
/** The answers an earlier page load kept, by path, each taken by the first `kept` of its read. */
const restored = new Map<string, unknown>();
let listening = false;

/** Takes the answers the last page load kept (page-db.ts), the newest `KEEP`, before the first view mounts. */
export function restoreKept(pages: readonly KeptPage[]): void {
  const mine = pages.filter(page => page.cache === STORED);
  const extra = Math.max(0, mine.length - KEEP);
  for (const page of mine.slice(0, extra)) void pageDb.drop(STORED, page.key);
  for (const page of mine.slice(extra)) if (!entries.has(page.key)) restored.set(page.key, page.value);
}

/**
 * A new kept answer, its state made outside the derived or effect that asked for it first. Svelte tracks no state a reaction made itself,
 * so the # typeahead, whose derived made the rooms answer, never saw the rooms arrive and listed no channel (rename.spec.ts, 11-21).
 */
function outsideReactions<T>(of: Read<T>, value: T | null): Kept<T> {
  let entry!: Kept<T>;
  $effect.root(() => {
    entry = new Kept(of, value);
  })();
  return entry;
}

const known = <T>(of: Read<T>): Kept<T> | undefined => entries.get(of.path) as Kept<T> | undefined;

/**
 * Brings a kept answer up to date from a live event, also one the last page load kept that no view of this load has opened yet: in a walk
 * at a 200 ms round trip on 11-22, a load that never opened the Board page let its kept list go stale, and the next load's Board open
 * waited 824 ms for a refresh that changed it (~/work/p213-boards). One the event cannot be placed in is dropped, so its next open reads it.
 */
function changeKept<T>(of: Read<T>, change: (value: T) => T | undefined): void {
  const entry = known(of);
  if (entry) return entry.change(change);
  if (!restored.has(of.path)) return;
  const next = change(restored.get(of.path) as T);
  if (next === undefined) {
    restored.delete(of.path);
    void pageDb.drop(STORED, of.path);
  } else {
    restored.set(of.path, next);
    void pageDb.put(STORED, of.path, next);
  }
}

/**
 * The kept answer of a read, the same object for every caller. The board and duties events carry their read's whole answer, which goes on
 * top of a read on its way and into an answer the last page load kept: a read that left before the event would bring the answer from before
 * it, and a kept copy no view opened yet would show it stale (`changeKept`).
 */
export function kept<T>(of: Read<T>): Kept<T> {
  if (!listening) {
    listening = true;
    live.onOpen(() => {
      for (const entry of entries.values()) entry.missed();
    });
    live.on(event => {
      if (event.type === "board") {
        changeKept(reads.board(event.chatId), () => ({ board: event.board, awaitingGo: event.awaitingGo }));
        changeKept(reads.boards(), rows => withRow(rows, event.chatId, event.row));
        changeKept(reads.forYou(), items => withAsks(items, event.chatId, event.forYou));
      } else if (event.type === "board_row") changeKept(reads.boards(), rows => withRow(rows, event.chatId, event.row));
      else if (event.type === "duties") changeKept(reads.duties(event.chatId), () => ({ duties: event.duties }));
    });
  }
  let entry = known(of);
  entries.delete(of.path);
  if (!entry) {
    entry = outsideReactions(of, restored.has(of.path) ? (restored.get(of.path) as T) : null);
    restored.delete(of.path);
  }
  entries.set(of.path, entry as Kept<unknown>);
  for (const [path, oldest] of entries) {
    if (entries.size + restored.size <= KEEP) break;
    if (!oldest.idle) continue;
    entries.delete(path);
    void pageDb.drop(STORED, path);
  }
  return entry;
}

/**
 * In a component: the kept answer of `of()`, shown from the first frame when the page holds it and read again behind. It follows `of()`
 * to another read, and `null` shows nothing.
 */
export function view<T>(of: () => Read<T> | null): { readonly value: T | null; readonly error: string | null; readonly loading: boolean; set(value: T): void; refresh(): Promise<void> } {
  const entry = $derived.by(() => {
    const read = of();
    return read ? kept(read) : null;
  });
  // The open reads the kept answer, which must not make the effect follow it: each board event that set the answer opened it again, and
  // every open read it again (board-lists-live.spec.ts).
  $effect(() => {
    const shown = entry;
    return untrack(() => shown?.open());
  });
  return {
    get value() {
      return entry?.value ?? null;
    },
    get error() {
      return entry?.error ?? null;
    },
    get loading() {
      return entry?.loading ?? false;
    },
    set: value => entry?.set(value),
    refresh: () => entry?.read() ?? Promise.resolve(),
  };
}
