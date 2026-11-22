/**
 * The one WebSocket to /api/live. It reconnects, re-sends every watch with the newest item id each watcher holds, and hands each event to
 * the listeners of its type; the server's hello on each open makes the stores and kept panels read what they missed. Stores in
 * stores.svelte.ts subscribe here; a page rarely needs this file directly.
 *
 * A network that drops packets, as a Mac asleep or a tailnet coming back after a wake does, closes nothing: the socket stays open, the
 * events sent meanwhile wait in the server's TCP retries, which back off to seconds and minutes, and the page shows the panels of before
 * until they arrive. In a walk at a 200 ms round trip (scripts/wake-walk.mjs, ~/work/p209-wake), a message sent during a 5 s cut showed
 * 2.6 s after the network came back. So a page that has heard nothing for `QUIET_MS` asks the server for a pong, drops a socket that does
 * not answer, and tries a new one every `TRY_EVERY_MS` until one opens, at once when the browser says it is online or the page shows again.
 */
import { RIDE_OUT_MS, retryNow } from "./client.ts";
import type { ConversationId, LiveCommand, LiveEvent } from "./types.ts";

/**
 * The wait before a new try after one failed fast, as a try at a closed port does while a release restarts :5184, so the socket is back
 * within this wait and a round trip of the new server listening.
 */
const QUICK_RETRY_MS = 250;

/**
 * The longest a try to open the socket may go unanswered before the page drops it and starts a new one. A try into a network that drops
 * packets gets no answer at all, and the browser's own retries of its connect wait 1 s, then 2 s, then 4 s and longer, while a browser
 * opens one socket to a host at a time. The owner's round trip is about 210 ms (his tailnet calls' p50 network time on 11-21 and 11-22,
 * requests/2026-11-22.jsonl), so a try's connect, TLS and upgrade take about 0.6 s; the brief of p209 asks for fresh panels within 2 s
 * of the network's return.
 */
const TRY_EVERY_MS = 1_000;

/**
 * How long the page waits with nothing heard before it pings. The owner's page hears an event every few seconds while his agents work,
 * so most of the time it never pings. A 5 s cut must be found inside it for the panels to be fresh 2 s after it ends (p209).
 */
const QUIET_MS = 2_000;

/** How long a ping waits for any answer before the page drops the socket: about 7 of the owner's round trips. */
const PONG_WITHIN_MS = 1_500;

type Listener = (event: LiveEvent) => void;

class Live {
  /** False once the socket has been down `RIDE_OUT_MS`, so a release restart shows no Offline note; the page reads it as offline. */
  connected = $state(false);
  /** When the socket last opened (`performance.now()`); a read that left after it missed no event the socket brings. */
  openedAt = Infinity;
  /** The open socket, and the one try on its way while there is none. */
  private socket: WebSocket | null = null;
  private trying: WebSocket | null = null;
  private listeners = new Set<Listener>();
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
    this.nextTry = setTimeout(() => this.tryOpen(), TRY_EVERY_MS);
    socket.onopen = () => {
      clearTimeout(this.nextTry);
      this.trying = null;
      this.socket = socket;
      this.openedAt = performance.now();
      this.heardAt = Date.now();
      this.pingAt = undefined;
      clearTimeout(this.offline);
      this.offline = undefined;
      this.downSince = undefined;
      this.connected = true;
      for (const [conversation, watch] of this.watches) this.send({ type: "watch", conversation, ...(watch.after() ? { after: watch.after()! } : {}) });
      retryNow();
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
        const down = performance.now() - this.downSince!;
        this.nextTry = setTimeout(() => this.tryOpen(), down < RIDE_OUT_MS ? QUICK_RETRY_MS : TRY_EVERY_MS);
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
