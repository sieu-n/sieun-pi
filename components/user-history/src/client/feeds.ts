/**
 * One WebSocket per page carries every live feed (sessions, open threads, account sign-in). Each feed used to be its own
 * EventSource, and Chromium allows six HTTP/1.1 connections per host, so a few tabs used them all and later requests queued.
 * The socket opens on the first subscription, reconnects with backoff while any feed is subscribed, and subscribes again
 * after each reconnect. The server answers a new subscription with a fresh snapshot, so nothing is lost across a reconnect.
 */
export type Feed = { feed: "sessions"; delta?: true; archived?: true } | { feed: "login" } | { feed: "refresh" } | { feed: "usage" } | { feed: "thread"; id: string };
type Listener = { feed: Feed; onEvent: (event: string, data: unknown) => void; onError: () => void };
/** The socket the shell's inline script opened before this bundle ran (src/boot-feed.ts), with the feeds its URL named and the frames so far. */
type BootFeed = { socket: WebSocket; subs: Array<{ sub: number } & Feed>; frames: unknown[] };
declare global { interface Window { __bootFeed?: BootFeed } }

/** One string per feed, so a subscribe finds the boot socket's subscription to the same feed. */
const feedKey = (feed: Feed): string => feed.feed === "thread" ? "thread:" + feed.id : feed.feed === "sessions" && feed.delta ? "sessions:delta" + (feed.archived ? ":archived" : "") : feed.feed;

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
  /** Subscriptions the current socket's URL named, so the server already runs them; they are never sent as subscribe frames. */
  private readonly serverSubs = new Set<number>();
  /** Boot subscriptions no listener has taken yet, by `feedKey`, and the frames that came for them meanwhile. */
  private readonly boot = new Map<string, number>();
  private readonly bootFrames = new Map<number, unknown[]>();
  /** The thread frames the page shell carried inline (chat-server.ts shellTail), by `feedKey`: the first subscriber gets them before any socket frame. */
  private readonly inline = new Map<string, unknown[]>();

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
    this.adopt(window.__bootFeed);
    delete window.__bootFeed;
    const shell = document.getElementById("boot-thread");
    if (shell?.dataset.id) {
      try { this.inline.set(feedKey({ feed: "thread", id: shell.dataset.id }), JSON.parse(shell.textContent ?? "[]") as unknown[]); } catch { /* the feed's own snapshot comes anyway */ }
      shell.remove();
    }
  }

  /** Takes over the boot socket while it is still open, and plays back what it received before this bundle ran. */
  private adopt(boot: BootFeed | undefined): void {
    if (!boot || boot.socket.readyState >= WebSocket.CLOSING) return;
    for (const { sub, ...feed } of boot.subs) {
      this.boot.set(feedKey(feed), sub);
      this.bootFrames.set(sub, []);
      this.serverSubs.add(sub);
      this.nextSub = Math.max(this.nextSub, sub + 1);
    }
    this.wire(boot.socket);
    if (boot.socket.readyState === WebSocket.OPEN) { this.openedAt = Date.now(); this.listen(); }
    for (const data of boot.frames) this.receive(data);
  }

  /** The boot subscriptions no listener took once the app has mounted: the server stops them. */
  releaseBoot(): void {
    for (const sub of this.boot.values()) {
      this.bootFrames.delete(sub);
      if (this.socket?.readyState === WebSocket.OPEN) { this.serverSubs.delete(sub); this.send({ type: "unsubscribe", sub }); }
    }
    this.boot.clear();
  }

  subscribe(feed: Feed, onEvent: Listener["onEvent"], onError: Listener["onError"]): () => void {
    const key = feedKey(feed);
    const booted = this.boot.get(key);
    const sub = booted ?? this.nextSub++;
    this.listeners.set(sub, { feed, onEvent, onError });
    const early: unknown[] = (this.inline.get(key) ?? []).map(data => ({ sub, event: "thread", data }));
    this.inline.delete(key);
    if (booted !== undefined) {
      this.boot.delete(key);
      early.push(...this.bootFrames.get(sub) ?? []);
      this.bootFrames.delete(sub);
    } else if (this.socket?.readyState === WebSocket.OPEN) this.send({ type: "subscribe", sub, ...feed });
    else this.connect();
    // After the caller has its stop function: a frame may stop the feed it arrives on.
    if (early.length) queueMicrotask(() => { for (const frame of early) this.dispatch(frame as { sub: number; event: string; data?: unknown }); });
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
    this.wire(new WebSocket(url));
  }

  private wire(socket: WebSocket): void {
    this.socket = socket;
    socket.onopen = () => {
      this.openedAt = Date.now();
      this.listen();
      for (const [sub, listener] of this.listeners) if (!this.serverSubs.has(sub)) this.send({ type: "subscribe", sub, ...listener.feed });
      for (const sub of this.serverSubs) if (!this.listeners.has(sub) && !this.bootFrames.has(sub)) { this.serverSubs.delete(sub); this.send({ type: "unsubscribe", sub }); }
    };
    socket.onmessage = message => this.receive(message.data);
    socket.onclose = () => { if (this.socket === socket) this.lost(); };
  }

  private receive(data: unknown): void {
    this.listen();
    let parsed: { sub?: number; event?: string; data?: unknown };
    try { parsed = JSON.parse(String(data)) as typeof parsed; } catch { return; }
    if (parsed.sub === undefined || parsed.event === undefined) return;
    const waiting = this.bootFrames.get(parsed.sub);
    if (waiting) { waiting.push(parsed); return; }
    this.dispatch(parsed as { sub: number; event: string; data?: unknown });
  }

  private dispatch(parsed: { sub: number; event: string; data?: unknown }): void {
    const listener = this.listeners.get(parsed.sub);
    // The server refused this one feed and keeps the socket for the rest; do not send it again after a reconnect.
    if (parsed.event === "error" && listener) { this.listeners.delete(parsed.sub); listener.onError(); return; }
    listener?.onEvent(parsed.event, parsed.data);
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
    this.dropBoot();
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

  /** A new socket starts with no subscriptions, so every listener subscribes on it and the untaken boot feeds are gone. */
  private dropBoot(): void {
    this.serverSubs.clear();
    this.boot.clear();
    this.bootFrames.clear();
  }

  private lost(): void {
    this.socket = null;
    this.dropBoot();
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

/** Called once the app has mounted and subscribed what it shows: the boot socket's feeds nobody took stop on the server. */
export function releaseBootFeeds(): void {
  shared ??= new FeedSocket();
  shared.releaseBoot();
}

/** A Retry button: reconnect now instead of waiting out the backoff. */
export function retryFeeds(): void { shared?.reconnectNow(); }

export function subscribeFeed(feed: Feed, onEvent: Listener["onEvent"], onError: Listener["onError"] = () => {}): () => void {
  shared ??= new FeedSocket();
  return shared.subscribe(feed, onEvent, onError);
}
