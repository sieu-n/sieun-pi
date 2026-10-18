/**
 * One WebSocket per page carries every live feed (sessions, open threads, account sign-in). Each feed used to be its own
 * EventSource, and Chromium allows six HTTP/1.1 connections per host, so a few tabs used them all and later requests queued.
 * The socket opens on the first subscription, reconnects with backoff while any feed is subscribed, and subscribes again
 * after each reconnect. The server answers a new subscription with a fresh snapshot, so nothing is lost across a reconnect.
 */
export type Feed = { feed: "sessions" } | { feed: "login" } | { feed: "refresh" } | { feed: "usage" } | { feed: "thread"; id: string };
type Listener = { feed: Feed; onEvent: (event: string, data: unknown) => void; onError: () => void };

const token = document.body.dataset.chatToken ?? "";
/** The server pings every 25 s; a socket silent this long is dead even if the browser has not noticed. */
const silenceMs = 70_000;
const stableMs = 10_000;
const hiddenMs = 30_000;

class FeedSocket {
  private socket: WebSocket | null = null;
  private readonly listeners = new Map<number, Listener>();
  private nextSub = 1;
  private attempt = 0;
  /** When the current socket opened. The backoff resets only for a socket that stayed open, so a server that accepts and then closes is not retried every half second. */
  private openedAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * A background tab reads its socket so rarely that it misses the server's pings and gets dropped about once a minute, then
   * reconnects and pulls every snapshot again. So a tab hidden for `hiddenMs` closes its socket, and showing it reconnects.
   */
  private paused = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    window.addEventListener("online", () => { if (document.visibilityState === "visible") this.reconnectNow(); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
        this.reconnectNow();
        return;
      }
      this.hideTimer ??= setTimeout(() => { this.hideTimer = null; if (document.visibilityState === "hidden") this.pause(); }, hiddenMs);
    });
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
    if (this.paused || this.socket || this.retryTimer) return;
    const url = new URL("api/ws", document.baseURI);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("token", token);
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.openedAt = Date.now();
      this.listen();
      for (const [sub, listener] of this.listeners) this.send({ type: "subscribe", sub, ...listener.feed });
    };
    socket.onmessage = message => {
      this.listen();
      let parsed: { sub?: number; event?: string; data?: unknown };
      try { parsed = JSON.parse(String(message.data)) as typeof parsed; } catch { return; }
      if (parsed.sub === undefined || parsed.event === undefined) return;
      const listener = this.listeners.get(parsed.sub);
      // The server refused this one feed and keeps the socket for the rest; do not send it again after a reconnect.
      if (parsed.event === "error" && listener) { this.listeners.delete(parsed.sub); listener.onError(); return; }
      listener?.onEvent(parsed.event, parsed.data);
    };
    socket.onclose = () => { if (this.socket === socket) this.lost(); };
  }

  private listen(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.drop(), silenceMs);
  }

  /** Forget the current socket without waiting for its close handshake, which never ends on a dead network. */
  private drop(): void {
    if (this.forget()) this.lost();
  }

  private forget(): boolean {
    const socket = this.socket;
    if (!socket) return false;
    socket.onopen = socket.onmessage = socket.onclose = null;
    socket.close();
    return true;
  }

  /** Hidden long enough: close quietly, with no error for the feeds, and stay closed until the tab shows again. */
  private pause(): void {
    this.paused = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    this.forget();
    this.socket = null;
  }

  private lost(): void {
    this.socket = null;
    if (this.openedAt && Date.now() - this.openedAt >= stableMs) this.attempt = 0;
    this.openedAt = 0;
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    for (const listener of [...this.listeners.values()]) listener.onError();
    if (!this.listeners.size || this.retryTimer) return;
    const delay = Math.min(30_000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() / 2);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.listeners.size) this.connect(); }, delay);
  }

  /** Back from sleep or offline, or a Retry: try at once instead of waiting out the backoff. */
  reconnectNow(): void {
    this.paused = false;
    if (this.socket || !this.listeners.size) return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.attempt = 0;
    this.connect();
  }
}

let shared: FeedSocket | null = null;

/** A Retry button: reconnect now instead of waiting out the backoff. */
export function retryFeeds(): void { shared?.reconnectNow(); }

export function subscribeFeed(feed: Feed, onEvent: Listener["onEvent"], onError: Listener["onError"] = () => {}): () => void {
  shared ??= new FeedSocket();
  return shared.subscribe(feed, onEvent, onError);
}
