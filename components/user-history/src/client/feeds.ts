import type { ThreadHave } from "../shared/types.ts";
/**
 * One WebSocket per page carries every live feed (sessions, open threads, account sign-in). Each feed used to be its own
 * EventSource, and Chromium allows six HTTP/1.1 connections per host, so a few tabs used them all and later requests queued.
 * The socket opens on the first subscription, reconnects with backoff while any feed is subscribed, and subscribes again
 * after each reconnect. The server answers a new subscription with a fresh snapshot, so nothing is lost across a reconnect.
 */
export type Feed = { feed: "sessions"; delta?: true; archived?: true; have?: string } | { feed: "login" } | { feed: "refresh" } | { feed: "usage" } | { feed: "thread"; id: string; delta?: true; have?: ThreadHave } | { feed: "agents"; id: string; delta?: true; have?: string };
/** A feed given as a function is read again at each subscribe, so a reconnect names what the page holds by then (chat-socket.ts `have`). */
type FeedSource = Feed | (() => Feed);
type Listener = { feed: FeedSource; onEvent: (event: string, data: unknown) => void; onError: () => void };
const feedOf = (source: FeedSource): Feed => typeof source === "function" ? source() : source;
/** The socket the shell's inline script opened before this bundle ran (src/boot-feed.ts), with the feeds its URL named and the frames so far. */
type BootFeed = { socket: WebSocket; subs: Array<{ sub: number } & Feed>; frames: unknown[] };
declare global { interface Window { __bootFeed?: BootFeed } }

/** One string per feed, so a subscribe finds the boot socket's subscription to the same feed. */
const feedKey = (feed: Feed): string => feed.feed === "thread" ? "thread:" + feed.id : feed.feed === "agents" ? "agents:" + feed.id : feed.feed === "sessions" && feed.delta ? "sessions:delta" + (feed.archived ? ":archived" : "") : feed.feed;

const token = document.body.dataset.chatToken ?? "";
/** The server pings every 25 s; a socket silent this long is dead even if the browser has not noticed. */
const silenceMs = 70_000;
const stableMs = 10_000;

class FeedSocket {
  private socket: WebSocket | null = null;
  private readonly listeners = new Map<number, Listener>();
  private nextSub = 1;
  private attempt = 0;
  /** When the current socket opened. The backoff resets only for a socket that stayed open, so a server that accepts and then closes is not retried every half second. */
  private openedAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Subscriptions the current socket's URL named, so the server already runs them; they are never sent as subscribe frames. */
  private readonly serverSubs = new Set<number>();
  /** Boot subscriptions no listener has taken yet, by `feedKey`, and the frames that came for them meanwhile. */
  private readonly boot = new Map<string, number>();
  private readonly bootFrames = new Map<number, unknown[]>();
  /** The thread frames the page shell carried inline (chat-server.ts shellTail), by `feedKey`: the first subscriber gets them before any socket frame. */
  private readonly inline = new Map<string, unknown[]>();

  constructor() {
    window.addEventListener("online", () => { if (document.visibilityState === "visible") this.reconnectNow(); });
    // A hidden tab keeps its socket: the browser answers the server's pings itself, so a throttled tab is not dropped, and coming back costs
    // nothing. From 10-08 to 10-18 a tab hidden for 30 s closed its socket, and each return pulled the sessions list and the thread again,
    // 1.0 MB of JSON over a Mac link of 12 to 400 KB/s. A socket that did drop meanwhile reconnects at once when the tab shows.
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") this.reconnectNow(); });
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

  subscribe(feed: FeedSource, onEvent: Listener["onEvent"], onError: Listener["onError"]): () => void {
    const key = feedKey(feedOf(feed));
    const booted = this.boot.get(key);
    const sub = booted ?? this.nextSub++;
    this.listeners.set(sub, { feed, onEvent, onError });
    const early: unknown[] = (this.inline.get(key) ?? []).map(data => ({ sub, event: "thread", data }));
    this.inline.delete(key);
    if (booted !== undefined) {
      this.boot.delete(key);
      early.push(...this.bootFrames.get(sub) ?? []);
      this.bootFrames.delete(sub);
    } else if (this.socket?.readyState === WebSocket.OPEN) this.send({ type: "subscribe", sub, ...feedOf(feed) });
    else this.connect();
    // After the caller has its stop function: a frame may stop the feed it arrives on.
    if (early.length) queueMicrotask(() => { for (const frame of early) this.dispatch(frame as { sub: number; event: string; data?: unknown }); });
    return () => {
      if (!this.listeners.delete(sub)) return;
      if (this.socket?.readyState === WebSocket.OPEN) this.send({ type: "unsubscribe", sub });
    };
  }

  /** A prefetched first frame for a thread feed nobody holds yet: its first subscriber paints it before the socket answers. */
  prime(id: string, frames: unknown[]): void {
    const key = feedKey({ feed: "thread", id });
    if ([...this.listeners.values()].some(listener => feedKey(feedOf(listener.feed)) === key)) return;
    this.inline.set(key, frames);
  }

  private send(message: unknown): void { this.socket?.send(JSON.stringify(message)); }

  private connect(): void {
    if (this.socket || this.retryTimer) return;
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
      // Thread feeds first: the server holds an agents feed's frames until every thread feed asked for before it sent its first frame.
      const feeds = [...this.listeners].filter(([sub]) => !this.serverSubs.has(sub)).map(([sub, listener]) => ({ sub, feed: feedOf(listener.feed) }));
      for (const { sub, feed } of [...feeds.filter(entry => entry.feed.feed === "thread"), ...feeds.filter(entry => entry.feed.feed !== "thread")]) this.send({ type: "subscribe", sub, ...feed });
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
    // The first close after a stable socket reconnects at once; only a reopen that fails again backs off. On 10-18 the Mac waited 1.24 to
    // 1.43 s between a close and the new socket, most of a 1.07 to 2.07 s reconnect once the resume had cut its bytes. A restart queues
    // the new socket on systemd's listening socket, so an at-once try reaches the next process instead of failing.
    const attempt = this.attempt++;
    if (attempt === 0) { this.connect(); return; }
    const delay = Math.min(30_000, 500 * 2 ** (attempt - 1)) * (0.75 + Math.random() / 2);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.listeners.size) this.connect(); }, delay);
  }

  /** Back from sleep or offline, or a Retry: try at once instead of waiting out the backoff. */
  reconnectNow(): void {
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

/** See `FeedSocket.prime`. */
export function primeThread(id: string, frames: unknown[]): void {
  shared ??= new FeedSocket();
  shared.prime(id, frames);
}

export function subscribeFeed(feed: FeedSource, onEvent: Listener["onEvent"], onError: Listener["onError"] = () => {}): () => void {
  shared ??= new FeedSocket();
  return shared.subscribe(feed, onEvent, onError);
}
