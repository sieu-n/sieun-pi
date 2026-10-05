/**
 * One WebSocket per page carries every live feed (sessions, open threads, account sign-in). Each feed used to be its own
 * EventSource, and Chromium allows six HTTP/1.1 connections per host, so a few tabs used them all and later requests queued.
 * The socket opens on the first subscription, reconnects with backoff while any feed is subscribed, and subscribes again
 * after each reconnect. The server answers a new subscription with a fresh snapshot, so nothing is lost across a reconnect.
 */
export type Feed = { feed: "sessions" } | { feed: "login" } | { feed: "thread"; id: string };
type Listener = { feed: Feed; onEvent: (event: string, data: unknown) => void; onError: () => void };

const token = document.body.dataset.chatToken ?? "";
/** The server pings every 25 s; a socket silent this long is dead even if the browser has not noticed. */
const silenceMs = 70_000;

class FeedSocket {
  private socket: WebSocket | null = null;
  private readonly listeners = new Map<number, Listener>();
  private nextSub = 1;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const wake = () => { if (document.visibilityState === "visible") this.reconnectNow(); };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
  }

  subscribe(feed: Feed, onEvent: Listener["onEvent"], onError: Listener["onError"]): () => void {
    const sub = this.nextSub++;
    this.listeners.set(sub, { feed, onEvent, onError });
    if (this.socket?.readyState === WebSocket.OPEN) this.send({ type: "subscribe", sub, ...feed });
    else this.connect();
    return () => {
      if (!this.listeners.delete(sub)) return;
      if (this.socket?.readyState === WebSocket.OPEN) this.send({ type: "unsubscribe", sub });
    };
  }

  private send(message: unknown): void { this.socket?.send(JSON.stringify(message)); }

  private connect(): void {
    if (this.socket || this.retryTimer) return;
    const url = new URL("api/ws", document.baseURI);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", token);
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.listen();
      for (const [sub, listener] of this.listeners) this.send({ type: "subscribe", sub, ...listener.feed });
    };
    socket.onmessage = message => {
      this.listen();
      let parsed: { sub?: number; event?: string; data?: unknown };
      try { parsed = JSON.parse(String(message.data)) as typeof parsed; } catch { return; }
      if (parsed.sub === undefined || parsed.event === undefined) return;
      this.listeners.get(parsed.sub)?.onEvent(parsed.event, parsed.data);
    };
    socket.onclose = () => { if (this.socket === socket) this.lost(); };
  }

  private listen(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.drop(), silenceMs);
  }

  /** Forget the current socket without waiting for its close handshake, which never ends on a dead network. */
  private drop(): void {
    const socket = this.socket;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = null;
    socket.close();
    this.lost();
  }

  private lost(): void {
    this.socket = null;
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    for (const listener of [...this.listeners.values()]) listener.onError();
    if (!this.listeners.size || this.retryTimer) return;
    const delay = Math.min(30_000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() / 2);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.listeners.size) this.connect(); }, delay);
  }

  /** Back from sleep or offline: try at once instead of waiting out the backoff. */
  private reconnectNow(): void {
    if (this.socket || !this.listeners.size) return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.attempt = 0;
    this.connect();
  }
}

let shared: FeedSocket | null = null;

export function subscribeFeed(feed: Feed, onEvent: Listener["onEvent"], onError: Listener["onError"] = () => {}): () => void {
  shared ??= new FeedSocket();
  return shared.subscribe(feed, onEvent, onError);
}
