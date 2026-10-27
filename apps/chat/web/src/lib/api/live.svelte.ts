/**
 * The one WebSocket to /api/live. It reconnects with backoff, re-sends every watch with the newest item id each watcher holds, and hands
 * each event to the listeners of its type. Stores in stores.svelte.ts subscribe here; a page rarely needs this file directly.
 */
import type { ConversationId, LiveEvent } from "./types.ts";

type Listener = (event: LiveEvent) => void;

class Live {
  connected = $state(false);
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  /** Watch counts per conversation, and the newest item id each one holds for a reconnect. */
  private watches = new Map<ConversationId, { count: number; after: () => string | undefined }>();
  private retry = 0;
  private started = false;

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
      this.connected = false;
      this.socket = null;
      const delay = Math.min(15_000, 500 * 2 ** this.retry++);
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
