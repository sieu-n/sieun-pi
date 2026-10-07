import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

/**
 * One WebSocket per browser tab carries every live feed the page watches. A tab used to hold an EventSource per feed, and
 * Chromium allows only six HTTP/1.1 connections per host, so three tabs used them all and every later request queued.
 *
 * Client to server: `{ type: "subscribe", sub, feed: "sessions" | "login" | "refresh" }`, `{ type: "subscribe", sub, feed: "thread", id }`
 * and `{ type: "unsubscribe", sub }`. `sub` is a number the page picks. Server to client: `{ sub, event, data }` for a feed
 * event, and `{ event: "ping" }` every `pingMs` so proxies keep the socket open and the page can tell a dead socket.
 */
export type Feed = { feed: "sessions" } | { feed: "login" } | { feed: "refresh" } | { feed: "thread"; id: string };
export type FeedSend = (event: string, data: unknown) => void;
/** Starts one feed. A thread feed opens the thread first, so it may resolve later; the returned function stops it. */
export type FeedSubscriber = (feed: Feed, send: FeedSend) => (() => void) | Promise<() => void>;

const maxSubscriptions = 256;
/** Every socket the server ends or feed it refuses gets a timestamped line in service.log, so a dropped page can be traced. */
const log = (line: string) => { process.stderr.write(`${new Date().toISOString()} feeds: ${line}\n`); };
/** A tab that stops reading (a sleeping phone) gets dropped instead of holding megabytes; it reconnects and gets fresh snapshots. */
const maxBufferedBytes = 32 * 1024 * 1024;

/** `null` for a frame with no usable `sub`, which closes the socket. A subscribe the server cannot serve is a `reject` for that `sub` only. */
function parseMessage(raw: RawData): { type: "subscribe"; sub: number; feed: Feed } | { type: "unsubscribe"; sub: number } | { type: "reject"; sub: number; message: string } | null {
  let value: unknown;
  try { value = JSON.parse(raw.toString()); } catch { return null; }
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  const sub = message.sub;
  if (typeof sub !== "number" || !Number.isSafeInteger(sub) || sub < 0) return null;
  if (message.type === "unsubscribe") return { type: "unsubscribe", sub };
  if (message.type !== "subscribe") return { type: "reject", sub, message: "Unknown message type." };
  if (message.feed === "sessions" || message.feed === "login" || message.feed === "refresh") return { type: "subscribe", sub, feed: { feed: message.feed } };
  if (message.feed === "thread" && typeof message.id === "string" && message.id.length <= 512) return { type: "subscribe", sub, feed: { feed: "thread", id: message.id } };
  return { type: "reject", sub, message: `Unknown feed: ${String(message.feed).slice(0, 40)}.` };
}

export class FeedSockets {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 1 } } });
  private readonly sockets = new Set<WebSocket>();
  private readonly ping: ReturnType<typeof setInterval>;

  constructor(private readonly subscribe: FeedSubscriber, private readonly pingMs = 25_000) {
    this.ping = setInterval(() => this.heartbeat(), pingMs);
    this.ping.unref();
  }

  get size(): number { return this.sockets.size; }

  /** The caller checks host, path, Origin and token before handing the upgrade over. */
  accept(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.server.handleUpgrade(req, socket, head, ws => this.attach(ws));
  }

  close(): void {
    clearInterval(this.ping);
    for (const ws of this.sockets) ws.terminate();
    this.sockets.clear();
    this.server.close();
  }

  private heartbeat(): void {
    for (const ws of this.sockets) {
      const state = ws as WebSocket & { alive?: boolean };
      if (state.alive === false) { log("closed a socket that missed a pong for " + this.pingMs + " ms"); ws.terminate(); continue; }
      state.alive = false;
      ws.ping();
      this.write(ws, '{"event":"ping"}');
    }
  }

  private write(ws: WebSocket, text: string): void {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > maxBufferedBytes) { log(`closed a socket with ${ws.bufferedAmount} bytes unread`); ws.terminate(); return; }
    ws.send(text);
  }

  private attach(ws: WebSocket): void {
    this.sockets.add(ws);
    const state = ws as WebSocket & { alive?: boolean };
    state.alive = true;
    /** null while the feed is still starting. */
    const subscriptions = new Map<number, (() => void) | null>();
    const stop = (sub: number) => {
      const unsubscribe = subscriptions.get(sub);
      subscriptions.delete(sub);
      unsubscribe?.();
    };
    ws.on("pong", () => { state.alive = true; });
    ws.on("message", raw => {
      state.alive = true;
      const message = parseMessage(raw);
      if (!message) { log("closed a socket that sent a malformed frame"); ws.close(1008, "Unexpected message."); return; }
      if (message.type === "unsubscribe") { stop(message.sub); return; }
      const reject = message.type === "reject" ? message.message
        : subscriptions.has(message.sub) ? `Feed ${message.sub} is already subscribed.`
        : subscriptions.size >= maxSubscriptions ? "Too many feeds." : null;
      if (message.type === "reject" || reject !== null) {
        log(`rejected feed ${message.sub}: ${reject}`);
        this.write(ws, JSON.stringify({ sub: message.sub, event: "error", data: { message: reject } }));
        return;
      }
      const { sub } = message;
      subscriptions.set(sub, null);
      const send: FeedSend = (event, data) => { if (subscriptions.has(sub)) this.write(ws, JSON.stringify({ sub, event, data })); };
      void Promise.resolve().then(() => this.subscribe(message.feed, send)).then(unsubscribe => {
        if (subscriptions.has(sub) && subscriptions.get(sub) === null) subscriptions.set(sub, unsubscribe);
        else unsubscribe();
      }, (error: unknown) => {
        send("error", { message: error instanceof Error ? error.message : String(error) });
        subscriptions.delete(sub);
      });
    });
    ws.on("close", () => {
      this.sockets.delete(ws);
      for (const sub of [...subscriptions.keys()]) stop(sub);
    });
    ws.on("error", () => { ws.terminate(); });
  }
}
