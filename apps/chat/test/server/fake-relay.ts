/**
 * A fake agent relay for the specs: a `/v2/agents` WebSocket server that speaks components/prime-relay/agents/protocol.ts and answers each
 * call from a `FixtureHost`, which plays the box's pi-host. `down` refuses every link as an offline box does, and `onCall` lets a spec drop
 * the link in the middle of a call.
 */
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { AGENT_RELAY_PATH, AGENT_RELAY_PROTOCOL, parseFrame, type BoxInfo, type FeedRow, type RelayFrame, type ServerFrame } from "../../../../components/prime-relay/agents/protocol.ts";
import { FixtureHost } from "../../server/host/fixture.ts";
import type { DurableEvent } from "../../server/host/types.ts";

type Call = Extract<ServerFrame, { type: "call" }>;

export class FakeRelay {
  readonly host = new FixtureHost();
  readonly wss: WebSocketServer;
  readonly calls: Call[] = [];
  readonly welcomes: number[] = [];
  readonly acks: number[] = [];
  readonly files = new Map<string, string>();
  readonly info: BoxInfo;
  /** While true every link is closed as soon as it opens, as when the box is offline. */
  down = false;
  /** Runs before a call is answered; "drop" applies the call and then closes the link without an answer. */
  onCall?: (call: Call) => "drop" | void;
  /** Resolves once the server listens, so `url` has its port. */
  readonly listening: Promise<void>;
  private readonly sockets = new Set<WebSocket>();
  private readonly watches = new Map<string, () => Promise<void>>();

  constructor(readonly box: string, readonly token: string) {
    this.host.wordMs = 0;
    this.info = { box, platform: "darwin", home: "/Users/test", projects: ["/Users/test/src/sieun-pi"], agentsDir: "/Users/test/.pi/agent/agents" };
    this.wss = new WebSocketServer({ port: 0, host: "127.0.0.1", path: AGENT_RELAY_PATH });
    this.listening = new Promise(resolve => this.wss.once("listening", () => resolve()));
    this.wss.on("connection", (socket, req) => {
      if (this.down || req.headers.authorization !== `Bearer ${this.token}`) {
        socket.terminate();
        return;
      }
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("message", data => void this.onFrame(socket, String(data)));
      this.send(socket, { type: "hello", protocol: AGENT_RELAY_PROTOCOL, box, version: "fake", piHost: { up: true, version: "fake-pi-host" }, info: this.info });
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}${AGENT_RELAY_PATH}`;
  }

  get connected(): number {
    return this.sockets.size;
  }

  /** Closes every live link; with `down`, the box stays offline until `down` is false again. */
  drop(down = this.down): void {
    this.down = down;
    for (const socket of this.sockets) socket.terminate();
  }

  /** Sends a feed row up every live link. */
  feed(row: FeedRow): void {
    for (const socket of this.sockets) this.send(socket, { type: "event", kind: "message", row });
  }

  private send(socket: WebSocket, frame: RelayFrame): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  }

  private async onFrame(socket: WebSocket, text: string): Promise<void> {
    const frame = parseFrame<ServerFrame>(text);
    if (!frame) return;
    if (frame.type === "welcome") this.welcomes.push(frame.feedAfter);
    if (frame.type === "ack") this.acks.push(frame.seq);
    if (frame.type !== "call") return;
    this.calls.push(frame);
    const verdict = this.onCall?.(frame);
    let answer: RelayFrame;
    try {
      answer = { type: "result", id: frame.id, ok: true, data: await this.answer(socket, frame) };
    } catch (error) {
      answer = { type: "result", id: frame.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (verdict === "drop") {
      socket.terminate();
      return;
    }
    this.send(socket, answer);
  }

  private async answer(socket: WebSocket, call: Call): Promise<unknown> {
    const { thread, ...rest } = call.args as { thread: string } & Record<string, unknown>;
    const h = this.host;
    switch (call.op) {
      case "durable_threads": return { threads: await h.threads(call.args) };
      case "durable_create": return { thread: await h.create(call.args) };
      case "durable_submit": return h.submit(thread, rest);
      case "durable_entries": return h.entries(thread, rest);
      case "durable_tree": return { conversations: await h.tree(thread) };
      case "durable_ticket": return { ticket: await h.ticket(thread, rest.conversation as number | undefined) };
      case "durable_abort": await h.abort(thread, rest.conversation as number | undefined); return {};
      case "durable_wait": return { settled: await h.wait(thread, rest.submission as number) };
      case "durable_doc_get": return { value: await h.docGet(thread, rest.name as string) };
      case "durable_doc_put": await h.docPut(thread, rest.name as string, rest.value); return {};
      case "durable_set": return { thread: await h.set(thread, rest) };
      case "durable_usage": return { usage: await h.usage(call.args) };
      case "durable_search": return h.search(call.args as never);
      case "watch": {
        const id = rest.watch as string;
        const stop = await h.watch(thread, rest as { conversation?: number; fromEntry?: number }, (event: DurableEvent) => this.send(socket, { type: "watch_event", watch: id, event }));
        this.watches.set(id, stop);
        socket.once("close", () => void stop());
        return {};
      }
      case "unwatch": await this.watches.get(rest.watch as string)?.(); return {};
      case "check": return { ok: true, output: `ran ${String(rest.command)}`, code: 0 };
      case "box_info": return this.info;
      case "file_get": {
        const text = this.files.get(rest.path as string);
        return text === undefined ? { exists: false } : { exists: true, text, size: text.length, modifiedAt: 1 };
      }
      case "file_put": {
        if (rest.delete) this.files.delete(rest.path as string);
        else this.files.set(rest.path as string, rest.text as string);
        return {};
      }
      default: throw new Error(`unknown op ${call.op}`);
    }
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    await new Promise(resolve => this.wss.close(resolve));
  }
}
