/**
 * The one WebSocket to /api/live. It reconnects, re-sends every watch with the newest item id each watcher holds, and hands each event to
 * the listeners of its type; the server's hello on each open makes the stores and kept panels read what they missed. Stores in
 * stores.svelte.ts subscribe here; a page rarely needs this file directly.
 *
 * A network that drops packets, as a Mac asleep or a tailnet coming back after a wake does, closes nothing: the socket stays open, the
 * events sent meanwhile wait in the server's TCP retries, which back off to seconds and minutes, and the page shows the panels of before
 * until they arrive. In a walk at a 200 ms round trip (scripts/wake-walk.mjs, ~/work/p209-wake), a message sent during a 5 s cut showed
 * 2.6 s after the network came back. So a page that has heard nothing for `QUIET_MS` asks the server for a pong, drops a socket that does
 * not answer, and tries a new one until one opens, at once when the browser says it is online or the page shows again.
 */
import { ApiError, RIDE_OUT_MS, retryNow } from "./client.ts";
import type { ConversationId, LiveCommand, LiveEvent } from "./types.ts";

/**
 * The wait before a new try after one failed fast, as a try at a closed port does while a release restarts :5184, for the first
 * `QUICK_TRIES` tries of an outage, so the socket is back within this wait and a round trip of the new server listening; `TRY_EVERY_MS`
 * after them.
 */
const QUICK_RETRY_MS = 250;
const QUICK_TRIES = 4;
const TRY_EVERY_MS = 1_000;

/**
 * How long a try to open the socket may go unanswered before the page drops it and starts a new one. A try into a network that drops
 * packets gets no answer, and the system sends its connect again 1 s and 3 s after it started (Linux), so a new try each 2 s keeps the
 * gap between connects at 1 s, and one each 4 s at 2 s. Each dropped try counts against the page: Chrome waits before each new socket
 * 1 to 5 s times 2^min(pending + failed / (opened + 1), 16) / 65536, over the failed and opened sockets of the last 2 to 4 minutes
 * (services/network/websocket_throttler.cc). In the wake walk a try each second through a 60 s cut left Chromium with no socket for
 * 90 s after the network came back (~/work/p209-wake/after1), and a try each 4 s left a 2 s gap that made fresh panels wait 2.9 s after
 * a 5 s cut (after5). So tries go each 2 s for the first `SHORT_OUTAGE_MS`, 15 dropped tries, and each 4 s after: a 60 s outage then
 * drops about 22 tries, which at one opened socket waits 31 to 156 ms.
 */
const SHORT_TRY_LIFE_MS = 2_000;
const SHORT_OUTAGE_MS = 30_000;
const TRY_LIFE_MS = 4_000;

/**
 * How long the page waits with nothing heard before it pings. The owner's page hears an event every few seconds while his agents work,
 * so most of the time it never pings. A 5 s cut must be found inside it for the panels to be fresh 2 s after it ends (p209).
 */
const QUIET_MS = 2_000;

/** How long a ping waits for any answer before the page drops the socket: about 7 of the owner's round trips. */
const PONG_WITHIN_MS = 1_500;

/**
 * How often the page checks its socket. The ping and the drop both run on this tick, so the drop's check allows half a tick: a timer that
 * fired 1 ms early read 1,499 ms since the ping and waited a whole tick more, and 12 of 60 drops in wake-fresh.spec.ts took 2,000 ms
 * (~/work/chat-specs-red/specs-red-channel-wake-fresh/notes.md).
 */
const TICK_MS = 500;

type Listener = (event: LiveEvent) => void;
type Opener = () => void;

class Live {
  /** False once the socket has been down `RIDE_OUT_MS`, so a release restart shows no Offline note; the page reads it as offline. */
  connected = $state(false);
  /** When the socket last opened (`performance.now()`); a read that left after it missed no event the socket brings. */
  openedAt = Infinity;
  /** How many times the socket has opened since the page loaded. */
  opens = 0;
  /** The open socket, and the one try on its way while there is none. */
  private socket: WebSocket | null = null;
  private trying: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private openers = new Set<Opener>();
  /** Watch counts per conversation, and the newest item id each one holds for a reconnect. */
  private watches = new Map<ConversationId, { count: number; after: () => string | undefined }>();
  private started = false;
  /** When the socket went down (`performance.now()`), and the timer that then marks the page offline. */
  private downSince: number | undefined;
  private offline: ReturnType<typeof setTimeout> | undefined;
  /** The next try, or the end of the try on its way. */
  private nextTry: ReturnType<typeof setTimeout> | undefined;
  /**
   * When the open socket last brought anything, and when the oldest ping that nothing answered since left, in `Date.now()`, so the time a
   * Mac slept counts as quiet.
   */
  private heardAt = 0;
  private askedAt: number | undefined;
  /** The tries since the socket went down. */
  private tries = 0;
  /** What the page holds of the hello's lists, sent with each try so the hello carries only what changed (shared/hello-buckets.ts). */
  private held: () => Record<string, string> = () => ({});
  /** The reads on their way over the open socket, by id. */
  private reads = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readId = 0;

  start(): void {
    if (this.started || typeof WebSocket === "undefined") return;
    this.started = true;
    this.tryOpen();
    addEventListener("online", () => this.check());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.check();
    });
    setInterval(() => this.tick(), TICK_MS);
  }

  /** The browser is online again or the page shows again: a dead socket is found now, and a new try goes now. */
  private check(): void {
    if (this.socket) this.ping();
    else this.tryOpen();
  }

  /**
   * Pings a socket that has been quiet `QUIET_MS`, and drops one that has heard nothing in the `PONG_WITHIN_MS` since its oldest unanswered
   * ping, whatever its `readyState` says. The drop reads only the clock and the last thing heard, so no event the socket fires or misses
   * keeps a dead socket: in the restart walk after13 on 11-22 (~/work/apps-chat-restart/after13) a WebKit page kept a socket the server
   * had closed for 15.5 s, until WebKit fired its close.
   */
  private tick(): void {
    const socket = this.socket;
    if (!socket || document.visibilityState !== "visible") return;
    const now = Date.now();
    if (now - this.heardAt >= QUIET_MS) this.ping();
    if (this.askedAt !== undefined && this.heardAt < this.askedAt && now - this.askedAt >= PONG_WITHIN_MS - TICK_MS / 2) this.drop(socket);
  }

  /** Asks the server for a pong; the oldest ping that nothing answered yet starts the drop's clock. */
  private ping(): void {
    if (!this.socket) return;
    if (this.askedAt === undefined || this.heardAt >= this.askedAt) this.askedAt = Date.now();
    this.send({ type: "ping" });
  }

  private tryOpen(): void {
    clearTimeout(this.nextTry);
    if (this.trying) this.forget(this.trying);
    const url = new URL("/api/live", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    for (const [name, value] of Object.entries(this.held())) url.searchParams.set(name, value);
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.wentDown();
      this.nextTry = setTimeout(() => this.tryOpen(), TRY_EVERY_MS);
      return;
    }
    this.trying = socket;
    this.tries += 1;
    const down = this.downSince === undefined ? 0 : performance.now() - this.downSince;
    this.nextTry = setTimeout(() => this.tryOpen(), down < SHORT_OUTAGE_MS ? SHORT_TRY_LIFE_MS : TRY_LIFE_MS);
    socket.onopen = () => {
      clearTimeout(this.nextTry);
      this.trying = null;
      this.socket = socket;
      this.tries = 0;
      this.opens += 1;
      this.openedAt = performance.now();
      this.heardAt = Date.now();
      this.askedAt = undefined;
      clearTimeout(this.offline);
      this.offline = undefined;
      this.downSince = undefined;
      this.connected = true;
      for (const [conversation, watch] of this.watches) this.send({ type: "watch", conversation, ...(watch.after() ? { after: watch.after()! } : {}) });
      retryNow();
      for (const opener of this.openers) opener();
    };
    socket.onmessage = message => {
      this.heardAt = Date.now();
      let event: LiveEvent;
      try {
        event = JSON.parse(String(message.data)) as LiveEvent;
      } catch {
        return;
      }
      if (event.type === "answer") return this.answered(event);
      for (const listener of this.listeners) listener(event);
    };
    socket.onclose = () => {
      if (this.socket === socket) this.lost(QUICK_RETRY_MS);
      else if (this.trying === socket) {
        this.trying = null;
        this.wentDown();
        clearTimeout(this.nextTry);
        this.nextTry = setTimeout(() => this.tryOpen(), this.tries < QUICK_TRIES ? QUICK_RETRY_MS : TRY_EVERY_MS);
      }
    };
  }

  /** Closes a socket the page no longer uses, without its close counting as the open socket's. */
  private forget(socket: WebSocket): void {
    socket.onopen = socket.onmessage = socket.onclose = null;
    try {
      socket.close();
    } catch {
      // A socket the browser already gave up on may refuse the close; the page uses it no more either way.
    }
  }

  /** The open socket went unanswered: the network dropped it, so a new try goes now. */
  private drop(socket: WebSocket): void {
    this.socket = null;
    this.forget(socket);
    this.lost(0);
  }

  private answered({ id, status, value, error }: Extract<LiveEvent, { type: "answer" }>): void {
    const read = this.reads.get(id);
    if (!read) return;
    this.reads.delete(id);
    if (error === undefined && status < 400) read.resolve(value);
    else read.reject(new ApiError(status, error ?? `The socket read answered ${status}`));
  }

  private lost(wait: number): void {
    this.socket = null;
    this.askedAt = undefined;
    for (const read of this.reads.values()) read.reject(new Error("The live socket closed before the answer came"));
    this.reads.clear();
    this.wentDown();
    clearTimeout(this.nextTry);
    if (wait) this.nextTry = setTimeout(() => this.tryOpen(), wait);
    else this.tryOpen();
  }

  private wentDown(): void {
    const now = performance.now();
    this.downSince ??= now;
    this.offline ??= setTimeout(() => (this.connected = false), Math.max(0, this.downSince + RIDE_OUT_MS - now));
  }

  private send(command: LiveCommand): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(command));
  }

  /**
   * Hands each event to `listener` from now on. Listening opens no socket: the socket hands each event to the listeners it has when it
   * comes, and the Skills page's listener, added as its module loads (pages/skills/kept.svelte.ts), opened the socket before the page's
   * lists listened (stores.svelte.ts `restorePages`). On the fixture on 11-23 a hello that came first left 5 of 40 loads of #/agents with
   * no sidebar and no reads ahead until the socket opened again (test/shell/first-hello.spec.ts).
   */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Names what the page holds of the hello's lists for each try to open the socket. */
  holding(held: () => Record<string, string>): void {
    this.held = held;
  }

  /**
   * Names a board the page read, in the `boards=` form, so the server sends its next change as a delta; a socket that opens later names
   * every kept board in its URL instead.
   */
  holdsBoards(held: string): void {
    this.send({ type: "boards", held });
  }

  /**
   * Reads a GET route over the open socket, which the server answers in order with its events. A page reads its open panels this way at
   * the open: the socket is a new connection, while its HTTP connection may still wait in TCP's retries after a cut, as a panel's read at
   * the open took 4.7 s in the wake walk on 11-22 (~/work/p209-wake/after4). It fails at once when no socket is open.
   */
  read(path: string): Promise<unknown> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("No live socket is open"));
    const id = ++this.readId;
    return new Promise((resolve, reject) => {
      this.reads.set(id, { resolve, reject });
      this.send({ type: "read", id, path });
    });
  }

  /**
   * Runs `opener` each time the socket opens, when the events since the last one may be lost, without waiting for the server's hello: at
   * box load 80 on 11-22 the hello came 0.9 s after the open in the wake walk (~/work/p209-wake/after1).
   */
  onOpen(opener: Opener): () => void {
    this.start();
    this.openers.add(opener);
    return () => this.openers.delete(opener);
  }

  /** Streams a conversation's items and status until the returned function runs. */
  watch(conversation: ConversationId, after: () => string | undefined = () => undefined): () => void {
    this.start();
    const existing = this.watches.get(conversation);
    if (existing) existing.count += 1;
    else {
      this.watches.set(conversation, { count: 1, after });
      this.send({ type: "watch", conversation, ...(after() ? { after: after()! } : {}) });
    }
    return () => {
      const watch = this.watches.get(conversation);
      if (!watch) return;
      watch.count -= 1;
      if (watch.count > 0) return;
      this.watches.delete(conversation);
      this.send({ type: "unwatch", conversation });
    };
  }
}

export const live = new Live();
