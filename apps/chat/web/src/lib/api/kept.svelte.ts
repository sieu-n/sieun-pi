/**
 * The answers of the panel reads (`reads` in client.ts), kept by path for as long as the page lives. A panel shows the kept answer the
 * moment it opens and reads it again behind, and `ahead` fills it before the first open. The owner reads :5184 from Korea: in the 24 h to
 * 11-20 09:03 KST his board and duties calls took 203 and 213 ms at p50 and up to 1,040 and 947 ms (requests/2026-11-19.jsonl), while the
 * server answered them in 2 to 7 ms, and each panel stayed empty for that long on every open.
 *
 * Each call's line says what the screen did (client.ts `Wait`): `ahead` for a read no panel shows yet, `shown` for a refresh behind a
 * panel that already showed the kept answer and got the same one back, and a wait for a first read or a refresh that changed the panel.
 */
import { get, reads, type Read, type Wait } from "./client.ts";
import { live } from "./live.svelte.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** One read's kept answer, shared by every panel that shows it. */
export class Kept<T> {
  /** Raw state, replaced whole by each answer that differs: a board measured 142 KB on 11-20, too big to proxy deeply. */
  value = $state.raw<T | null>(null);
  error = $state<string | null>(null);
  private flight: { read: Promise<void>; wait: Wait } | undefined;
  private views = 0;
  /** A `live` read holds what the socket's events said since its last answer, so reading it ahead again would bring the same. */
  private current = false;

  constructor(private readonly of: Read<T>) {}

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
    if (this.flight) {
      if (background !== "ahead") this.flight.wait.background = background;
      return this.flight.read;
    }
    const wait: Wait = background ? { background } : {};
    const flight = {
      wait,
      read: get(this.of, wait).then(next => {
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
      }),
    };
    this.flight = flight;
    return flight.read;
  }

  /** The answer a write returned or a live event carried. */
  set(value: T): void {
    this.value = value;
    this.error = null;
  }

  /** A panel shows this answer until the returned function runs: it reads it again now and after each time the socket comes back. */
  open(): () => void {
    this.views += 1;
    void this.read();
    return () => void (this.views -= 1);
  }

  /** The socket came back, so events may have been missed: an open panel reads again, and a read ahead may run again. */
  missed(): void {
    this.current = false;
    if (this.views) void this.read();
  }
}

/**
 * How many answers the page keeps. On 11-20 ag_vent's board, duties, jobs and config were 142, 54, 55 and 48 KB of JSON (GET
 * /api/agents/ag_vent/...), so 100 answers hold under 15 MB; the box had 8 agents then, each with those four and a check-in.
 */
const KEEP = 100;
const entries = new Map<string, Kept<unknown>>();
let listening = false;

const known = <T>(of: Read<T>): Kept<T> | undefined => entries.get(of.path) as Kept<T> | undefined;

/** The kept answer of a read, the same object for every caller. The board and duties events carry their read's whole answer. */
export function kept<T>(of: Read<T>): Kept<T> {
  if (!listening) {
    listening = true;
    live.on(event => {
      if (event.type === "hello") for (const entry of entries.values()) entry.missed();
      else if (event.type === "board") known(reads.board(event.chatId))?.set({ board: event.board, awaitingGo: event.awaitingGo });
      else if (event.type === "duties") known(reads.duties(event.chatId))?.set({ duties: event.duties });
    });
  }
  let entry = known(of);
  entries.delete(of.path);
  entry ??= new Kept(of);
  entries.set(of.path, entry as Kept<unknown>);
  for (const [path, oldest] of entries) {
    if (entries.size <= KEEP) break;
    if (oldest.idle) entries.delete(path);
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
  $effect(() => entry?.open());
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
