/**
 * One `/v2/agents` link: a WebSocket from the chat server and the pi-host socket connection the relay opens for it. The relay says `hello`,
 * starts pi-host's `durable_feed` after the server's `welcome`, forwards feed rows and watch events, and answers the server's `call` frames.
 * Either side closing ends both, so the chat server redials and sets up its watches again.
 */
import type { WebSocket } from "ws";
import { boxInfo, fileGet, filePut, instructions, runCheck } from "./ops.ts";
import { PiHostSocket, type Answer, type PiHostLine } from "./pi-host-socket.ts";
import { AGENT_RELAY_PROTOCOL, DURABLE_OPS, parseFrame, type BoxInfo, type ChatHttpArgs, type FeedRow, type RelayFrame, type ServerFrame } from "./protocol.ts";

export interface LinkOptions {
  box: string;
  home: string;
  agentsDir: string;
  piHostSocket: string;
  version: string;
  log: (line: string) => void;
  /** Runs after pi-host takes a `durable_submit`, so the Mac's sleep hold starts with the turn (awake.ts). */
  onSubmit?: () => void;
}

const durableOps = new Set<string>(DURABLE_OPS);
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class AgentLink {
  /** "hello" until the server's welcome, "live" after it starts the feed, "closed" once either side ends. */
  state: "opening" | "hello" | "live" | "closed" = "opening";
  acked = 0;
  private piHost?: PiHostSocket;
  private readonly info: BoxInfo;
  /** pi-host watch id to the server's watch id, and back. */
  private readonly watchByHost = new Map<string, string>();
  private readonly hostByWatch = new Map<string, string>();
  /** Watch events that came before their `durable_watch` answer named the watch. */
  private readonly early = new Map<string, unknown[]>();
  private readonly upCalls = new Map<string, (answer: Answer) => void>();
  private nextUp = 1;
  private readonly ws: WebSocket;
  private readonly options: LinkOptions;
  private readonly onEnd: () => void;

  constructor(ws: WebSocket, options: LinkOptions, onEnd: () => void) {
    this.ws = ws;
    this.options = options;
    this.onEnd = onEnd;
    this.info = boxInfo(options.box, options.home, options.agentsDir);
    ws.on("message", (data, isBinary) => { if (!isBinary) void this.onFrame(String(data)); });
    ws.on("close", () => this.end());
    ws.on("error", error => options.log(`agents link: ${error.message}`));
    void this.open();
  }

  private async open(): Promise<void> {
    try {
      this.piHost = await PiHostSocket.open(this.options.piHostSocket);
    } catch (error) {
      this.send({ type: "hello", protocol: AGENT_RELAY_PROTOCOL, box: this.options.box, version: this.options.version, piHost: { up: false, error: message(error) }, info: this.info });
      this.close(`pi-host is down: ${message(error)}`);
      return;
    }
    if (this.state === "closed") return this.piHost.close();
    this.piHost.onLine(line => this.onPiHostLine(line));
    this.piHost.onClose(reason => this.close(reason));
    this.state = "hello";
    this.send({ type: "hello", protocol: AGENT_RELAY_PROTOCOL, box: this.options.box, version: this.options.version, piHost: { up: true, version: this.piHost.version }, info: this.info });
  }

  /** Sends a call up to the chat server and waits for its `result`; the chat proxy uses it for `chat_http`. */
  callUp(args: ChatHttpArgs): Promise<Answer> {
    if (this.state !== "live") return Promise.resolve({ ok: false, error: "the link to the chat server is not live", unsent: true });
    const id = `up-${this.nextUp++}`;
    return new Promise(resolve => {
      this.upCalls.set(id, resolve);
      this.send({ type: "call", id, op: "chat_http", args });
    });
  }

  close(reason: string): void {
    if (this.state === "closed") return;
    this.options.log(`agents link closed: ${reason}`);
    this.end();
    this.ws.close(1011, reason.slice(0, 120));
  }

  private end(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.piHost?.close();
    for (const resolve of this.upCalls.values()) resolve({ ok: false, error: "the link to the chat server closed" });
    this.upCalls.clear();
    this.onEnd();
  }

  private send(frame: RelayFrame): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private onPiHostLine(line: PiHostLine): void {
    if (line.type === "durable_feed_event" && line.row) {
      this.send({ type: "event", kind: "message", row: line.row as FeedRow });
    } else if (line.type === "durable_event" && typeof line.watch === "string") {
      const watch = this.watchByHost.get(line.watch);
      if (watch) this.send({ type: "watch_event", watch, event: line.event });
      else this.early.set(line.watch, [...(this.early.get(line.watch) ?? []), line.event]);
    }
  }

  private async onFrame(text: string): Promise<void> {
    const frame = parseFrame<ServerFrame>(text);
    if (!frame) return this.options.log(`agents link: dropped a frame that is not JSON with a type: ${text.slice(0, 80)}`);
    if (frame.type === "welcome") return this.welcome(frame.protocol, frame.feedAfter);
    if (frame.type === "ack") {
      this.acked = Math.max(this.acked, frame.seq);
      return;
    }
    if (frame.type === "result") {
      const resolve = this.upCalls.get(frame.id);
      this.upCalls.delete(frame.id);
      resolve?.(frame.ok ? { ok: true, data: frame.data } : { ok: false, error: frame.error });
      return;
    }
    if (frame.type === "call") {
      const answer = await this.serve(frame.op, frame.args ?? {}).catch((error: unknown): Answer => ({ ok: false, error: message(error) }));
      this.send(answer.ok ? { type: "result", id: frame.id, ok: true, data: answer.data } : { type: "result", id: frame.id, ok: false, error: answer.error, ...(answer.unsent ? { unsent: true } : {}) });
    }
  }

  private async welcome(protocol: number, feedAfter: number): Promise<void> {
    if (this.state !== "hello" || !this.piHost) return;
    if (Math.floor(protocol) !== AGENT_RELAY_PROTOCOL) return this.close(`the server speaks protocol ${protocol}, this relay ${AGENT_RELAY_PROTOCOL}`);
    const feed = await this.piHost.call("durable_feed", { after: Number(feedAfter) || 0 });
    if (!feed.ok) return this.close(`pi-host refused durable_feed: ${feed.error}`);
    if (this.state === "hello") this.state = "live";
    this.options.log(`agents link live for ${this.options.box}, feed after ${feedAfter}`);
  }

  private async serve(op: string, args: Record<string, unknown>): Promise<Answer> {
    const piHost = this.piHost;
    if (durableOps.has(op)) {
      if (!piHost) return { ok: false, error: "pi-host is not connected", unsent: true };
      const answer = await piHost.call(op, args);
      if (op === "durable_submit" && answer.ok) this.options.onSubmit?.();
      return answer;
    }
    switch (op) {
      case "watch": {
        if (!piHost) return { ok: false, error: "pi-host is not connected", unsent: true };
        const watch = String(args.watch ?? "");
        if (!watch) return { ok: false, error: "watch needs a watch id" };
        await this.unwatch(watch);
        const { watch: _id, ...fields } = args;
        const answer = await piHost.call("durable_watch", fields);
        if (!answer.ok) return answer;
        const hostId = String((answer.data as { watch?: unknown }).watch);
        this.watchByHost.set(hostId, watch);
        this.hostByWatch.set(watch, hostId);
        for (const event of this.early.get(hostId) ?? []) this.send({ type: "watch_event", watch, event });
        this.early.delete(hostId);
        return { ok: true, data: {} };
      }
      case "unwatch":
        await this.unwatch(String(args.watch ?? ""));
        return { ok: true, data: {} };
      case "check":
        if (typeof args.command !== "string" || typeof args.timeoutMs !== "number" || args.timeoutMs <= 0) return { ok: false, error: "check needs command and a positive timeoutMs" };
        return { ok: true, data: await runCheck(args.command, args.timeoutMs) };
      case "box_info":
        return { ok: true, data: this.info };
      case "file_get":
        return { ok: true, data: await fileGet(args, this.options.agentsDir) };
      case "file_put":
        return { ok: true, data: await filePut(args, this.options.agentsDir) };
      case "instructions":
        return { ok: true, data: instructions(args, this.options.home) };
      default:
        return { ok: false, error: `unknown op ${op}` };
    }
  }

  private async unwatch(watch: string): Promise<void> {
    const hostId = this.hostByWatch.get(watch);
    if (!hostId) return;
    this.hostByWatch.delete(watch);
    this.watchByHost.delete(hostId);
    await this.piHost?.call("durable_unwatch", { watch: hostId });
  }
}
