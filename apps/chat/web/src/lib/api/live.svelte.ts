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
import { RIDE_OUT_MS, retryNow } from "./client.ts";
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
 * packets gets no answer, and the system sends its connect again 1 s and 3 s after it started, so a new try each 4 s keeps the gap
 * between connects at 2 s at most while it adds few failed tries: Chrome waits before each new socket of a page 1 to 5 s times
 * 2^min(pending + failed / (opened + 1), 16) / 65536, over the failed and opened sockets of the last 2 to 4 minutes, and a try the page
 * drops counts as failed (services/network/websocket_throttler.cc). In the wake walk (scripts/wake-walk.mjs, ~/work/p209-wake/after1),
 * a new try each second through a 60 s cut left Chromium with no socket for 90 s after the network came back.
 */
const TRY_LIFE_MS = 4_000;

/**
 * How long the page waits with nothing heard before it pings. The owner's page hears an event every few seconds while his agents work,
 * so most of the time it never pings. A 5 s cut must be found inside it for the panels to be fresh 2 s after it ends (p209).
 */
const QUIET_MS = 2_000;

/** How long a ping waits for any answer before the page drops the socket: about 7 of the owner's round trips. */
const PONG_WITHIN_MS = 1_500;

type Listener = (event: LiveEvent) => void;
type Opener = () => void;

class Live {
  /** False once the socket has been down `RIDE_OUT_MS`, so a release restart shows no Offline note; the page reads it as offline. */
  connected = $state(false);
  /** When the socket last opened (`performance.now()`); a read that left after it missed no event the socket brings. */
  openedAt = Infinity;
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
  /** When the open socket last brought anything, and when the ping on its way left, in `Date.now()`, so the time a Mac slept counts as quiet. */
  private heardAt = 0;
  private pingAt: number | undefined;
  /** The tries since the socket went down. */
  private tries = 0;

  start(): void {
    if (this.started || typeof WebSocket === "undefined") return;
    this.started = true;
    this.tryOpen();
    addEventListener("online", () => this.check());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.check();
    });
    setInterval(() => this.tick(), 500);
  }

  /** The browser is online again or the page shows again: a dead socket is found now, and a new try goes now. */
  private check(): void {
    if (this.socket) this.ping();
    else this.tryOpen();
  }

  private tick(): void {
    const socket = this.socket;
    if (!socket || document.visibilityState !== "visible") return;
    if (this.pingAt !== undefined) {
      if (Date.now() - this.pingAt >= PONG_WITHIN_MS) this.drop(socket);
    } else if (Date.now() - this.heardAt >= QUIET_MS) this.ping();
  }

  private ping(): void {
    if (this.pingAt !== undefined || !this.socket) return;
    this.pingAt = Date.now();
    this.send({ type: "ping" });
  }

  private tryOpen(): void {
    clearTimeout(this.nextTry);
    if (this.trying) this.forget(this.trying);
    const url = new URL("/api/live", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.trying = socket;
    this.tries += 1;
    this.nextTry = setTimeout(() => this.tryOpen(), TRY_LIFE_MS);
    socket.onopen = () => {
      clearTimeout(this.nextTry);
      this.trying = null;
      this.socket = socket;
      this.tries = 0;
      this.openedAt = performance.now();
      this.heardAt = Date.now();
      this.pingAt = undefined;
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
      this.pingAt = undefined;
      let event: LiveEvent;
      try {
        event = JSON.parse(String(message.data)) as LiveEvent;
      } catch {
        return;
      }
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
    socket.close();
  }

  /** The open socket went unanswered: the network dropped it, so a new try goes now. */
  private drop(socket: WebSocket): void {
    this.forget(socket);
    this.lost(0);
  }

  private lost(wait: number): void {
    this.socket = null;
    this.pingAt = undefined;
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

  on(listener: Listener): () => void {
    this.start();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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

  /** Streams a conversation's items, partial text and status until the returned function runs. */
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
