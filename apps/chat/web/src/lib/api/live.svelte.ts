/**
 * The one WebSocket to /api/live. It reconnects, re-sends every watch with the newest item id each watcher holds, and hands each event to
 * the listeners of its type; the server's hello on each open makes the stores and kept panels read what they missed. Stores in
 * stores.svelte.ts subscribe here; a page rarely needs this file directly.
 */
import { RIDE_OUT_MS } from "./client.ts";
import type { ConversationId, LiveEvent } from "./types.ts";

/**
 * The wait before each new try while the socket has been down less than `RIDE_OUT_MS`, as when a release restarts :5184, so the socket
 * is back within this wait and a round trip of the new server listening. A try at a closed port fails in one round trip, so this sends
 * at most 60 tries in one restart.
 */
const QUICK_RETRY_MS = 250;

type Listener = (event: LiveEvent) => void;

class Live {
  /** False once the socket has been down `RIDE_OUT_MS`, so a release restart shows no Offline note; the page reads it as offline. */
  connected = $state(false);
  /** When the socket last opened (`performance.now()`); a read that left after it missed no event the socket brings. */
  openedAt = Infinity;
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  /** Watch counts per conversation, and the newest item id each one holds for a reconnect. */
  private watches = new Map<ConversationId, { count: number; after: () => string | undefined }>();
  private retry = 0;
  private started = false;
  /** When the socket went down (`performance.now()`), and the timer that then marks the page offline. */
  private downSince: number | undefined;
  private offline: ReturnType<typeof setTimeout> | undefined;

  start(): void {
    if (this.started || typeof WebSocket === "undefined") return;
    this.started = true;
    this.open();
  }

  private open(): void {
    const url = new URL("/api/live", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.openedAt = performance.now();
      clearTimeout(this.offline);
      this.offline = undefined;
      this.downSince = undefined;
      this.connected = true;
      this.retry = 0;
      for (const [conversation, watch] of this.watches) this.send({ type: "watch", conversation, ...(watch.after() ? { after: watch.after()! } : {}) });
    };
    socket.onmessage = message => {
      let event: LiveEvent;
      try {
        event = JSON.parse(String(message.data)) as LiveEvent;
      } catch {
        return;
      }
      for (const listener of this.listeners) listener(event);
    };
    socket.onclose = () => {
      this.socket = null;
      const now = performance.now();
      this.downSince ??= now;
      this.offline ??= setTimeout(() => (this.connected = false), Math.max(0, this.downSince + RIDE_OUT_MS - now));
      const delay = now - this.downSince < RIDE_OUT_MS ? QUICK_RETRY_MS : Math.min(15_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };
  }

  private send(command: unknown): void {
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
