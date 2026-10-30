/**
 * `Host` over one box's agent relay (apps/chat/docs/agent-model.md, section 4 and phase 6): the `/v2/agents` WebSocket at
 * `ws://<box>:<agentRelayPort>/v2/agents` with the box's bearer token, and the frames in components/prime-relay/agents/protocol.ts.
 *
 * 1. The client dials, waits for `hello`, and answers `welcome` with the feed cursor it saved for the box. Each pi-host command goes as a
 *    `call` frame and comes back as `result`.
 * 2. Watches are `watch` calls under this client's own watch ids; after a reconnect each live watch opens again from the newest entry it saw.
 * 3. While the link is down a call fails at once with `HostAway`. A call that was in flight when the link dropped goes again after the
 *    reconnect when sending it twice cannot act twice (as PiHost's call loop decides), and fails with `HostAway` otherwise.
 * 4. Each feed `event` runs the App's handler, which reads the room feed of the row's thread; only after it finishes is the cursor saved and
 *    `ack` sent, so a crash in between replays the row and the room feed's own dedup keeps one post.
 * 5. A thread on the box reaches this server's HTTP API through the relay as a `chat_http` call, which this client forwards to 127.0.0.1.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import {
  AGENT_RELAY_PROTOCOL, parseFrame, type BoxInfo, type ChatHttpArgs, type ChatHttpResult, type FeedRow, type RelayFrame, type ServerFrame, type ServerOp,
} from "../../../../components/prime-relay/agents/protocol.ts";
import { writeJson } from "../store.ts";
import {
  HostAway, type CreateOptions, type DurableEvent, type DurableThread, type EntryRecord, type Host, type Ping, type SearchPage, type SearchQuery,
  type SubmissionRecord, type Submitted, type SubmitInput, type Ticket, type TreeNode, type UsageTotal,
} from "./types.ts";

/** The same answer limit PiHost gives a pi-host command. */
const COMMAND_TIMEOUT_MS = 120_000;
/** How long an in-flight call that may go twice waits for the link to come back, PiHost's wait for a pi-host restart. */
const RECONNECT_WAIT_MS = 30_000;
/** Redial waits double from 1 s to this and stay there, PiHost's reconnect ceiling; the client dials forever. */
const MAX_REDIAL_MS = 10_000;
/**
 * A sleeping Mac keeps no TCP state, so its half-open link answers nothing and never closes. The client pings at this pace and drops a link
 * that missed a whole interval's pong, and a dial that has not upgraded in one interval gives up, so a sleep reads as away within 30 s.
 */
const LIVENESS_MS = 15_000;

export type LinkState = { state: "up" | "away"; since: number };
/** A shell check's result on the box, legacy wakes.ts `CheckResult` with the exit code the relay adds. */
export interface BoxCheck { ok: boolean; output: string; code?: number | null }
/** A file on the box, as the relay's `file_get` reads it. */
export interface BoxFile { exists: boolean; text?: string; size?: number; modifiedAt?: number }

export interface RelayHostOptions {
  box: string;
  /** `ws://<address>:<agentRelayPort>/v2/agents`. */
  url: string;
  token: string;
  /** Where the box's feed cursor is saved, `<data dir>/relay/<box>.json`. */
  dataDir: string;
  /** This server's port, for `chat_http` calls up. */
  chatPort?: number;
  /** Reads the room feed a feed row names; the row is acked only after it resolves. */
  onFeed?: (row: FeedRow) => Promise<void>;
  log?: (line: string) => void;
  /** The wait before redial `attempt` (1, 2, ...); a test shortens it. */
  redialWait?: (attempt: number) => number;
  /** The ping pace and dial limit, LIVENESS_MS by default; a test shortens it. */
  livenessMs?: number;
}

type Pending = {
  op: ServerOp; args: Record<string, unknown>; timeoutMs: number; repeatable: boolean; sent: boolean;
  resolve: (data: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout; waitTimer?: NodeJS.Timeout;
};
type Watch = { id: string; thread: string; conversation?: number; fromEntry?: number; sink: (event: DurableEvent) => void; open: boolean; stopped: boolean };

const headersOf = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => (out[key] = value));
  return out;
};

/** Whether sending the call twice cannot act twice, as PiHost's call loop reads it. */
const repeatable = (op: ServerOp, args: Record<string, unknown>): boolean =>
  op !== "durable_create" && op !== "durable_import" && op !== "file_put" && op !== "check" && !(op === "durable_submit" && !args.requestId);

export class RelayHost implements Host {
  readonly name: string;
  private socket?: WebSocket;
  private ready = false;
  private link: LinkState = { state: "away", since: Date.now() };
  private readonly pending = new Map<string, Pending>();
  private readonly watches = new Map<string, Watch>();
  private readonly listeners = new Set<(link: LinkState) => void>();
  private closed = false;
  private attempt = 0;
  private redialTimer?: NodeJS.Timeout;
  private livenessTimer?: NodeJS.Timeout;
  private get liveness(): number {
    return this.options.livenessMs ?? LIVENESS_MS;
  }
  private feedChain: Promise<void> = Promise.resolve();
  /** Set when a feed row's handler failed: later rows wait for the next `welcome`, which replays from the saved cursor. */
  private feedHalted = false;
  /** What the relay said in its last `hello`. */
  hello?: Extract<RelayFrame, { type: "hello" }>;
  onFeed?: (row: FeedRow) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly cursorFile: string;

  constructor(readonly options: RelayHostOptions) {
    this.name = options.box;
    this.log = options.log ?? (() => {});
    this.onFeed = options.onFeed;
    this.cursorFile = join(options.dataDir, "relay", `${options.box.replace(/[^\w.-]/g, "_")}.json`);
  }

  /** The box's BoxInfo from its last `hello`, kept after the link drops. */
  get info(): BoxInfo | undefined {
    return this.hello?.info;
  }

  state(): LinkState {
    return { ...this.link };
  }

  /** Resolves true once the link is up, or false after `timeoutMs`. */
  whenUp(timeoutMs: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, timeoutMs);
      const off = this.onLink(link => {
        if (link.state !== "up") return;
        clearTimeout(timer);
        off();
        resolve(true);
      });
    });
  }

  /** Calls `listener` on every change between up and away. */
  onLink(listener: (link: LinkState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The seq of the newest feed row this server acked for the box. */
  cursor(): number {
    try {
      return Number((JSON.parse(readFileSync(this.cursorFile, "utf8")) as { feedAfter?: number }).feedAfter) || 0;
    } catch {
      return 0;
    }
  }

  private saveCursor(seq: number): void {
    mkdirSync(join(this.options.dataDir, "relay"), { recursive: true });
    writeJson(this.cursorFile, { feedAfter: seq });
  }

  /** Starts dialing; the client redials with backoff until `close`. */
  start(): void {
    if (this.closed || this.socket) return;
    this.dial();
  }

  private dial(): void {
    if (this.closed) return;
    const socket = new WebSocket(this.options.url, { headers: { authorization: `Bearer ${this.options.token}` }, handshakeTimeout: this.liveness });
    this.socket = socket;
    let alive = true;
    socket.on("pong", () => (alive = true));
    socket.once("open", () => {
      clearInterval(this.livenessTimer);
      this.livenessTimer = setInterval(() => {
        if (socket !== this.socket) return;
        if (!alive) {
          this.log(`relay ${this.name}: no pong in ${this.liveness / 1000} s, dropping the link`);
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, this.liveness);
    });
    socket.on("message", data => this.onMessage(socket, String(data)));
    socket.on("close", () => this.onClose(socket));
    // An offline box fails every redial; its first failure is logged, and the link state says the rest.
    socket.on("error", error => {
      if (this.attempt <= 1) this.log(`relay ${this.name}: ${error.message}`);
    });
  }

  private setLink(state: LinkState["state"]): void {
    if (this.link.state === state) return;
    this.link = { state, since: Date.now() };
    this.log(`relay ${this.name}: link ${state}`);
    for (const listener of this.listeners) {
      try {
        listener(this.state());
      } catch (error) {
        this.log(`relay ${this.name}: link listener failed: ${String(error)}`);
      }
    }
  }

  private send(frame: ServerFrame): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  private onMessage(socket: WebSocket, text: string): void {
    if (socket !== this.socket) return;
    const frame = parseFrame<RelayFrame>(text);
    if (!frame) return;
    switch (frame.type) {
      case "hello": {
        if (Math.floor(frame.protocol) !== AGENT_RELAY_PROTOCOL) {
          this.log(`relay ${this.name}: refused protocol ${frame.protocol}, this server speaks ${AGENT_RELAY_PROTOCOL}`);
          socket.close(1002, "protocol");
          return;
        }
        this.hello = frame;
        this.send({ type: "welcome", protocol: AGENT_RELAY_PROTOCOL, feedAfter: this.cursor() });
        this.ready = true;
        this.attempt = 0;
        this.feedHalted = false;
        this.feedChain = Promise.resolve();
        this.setLink("up");
        for (const [id, pending] of this.pending) if (!pending.sent) this.write(id, pending);
        void this.rewatch();
        return;
      }
      case "result": {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.ok) pending.resolve(frame.data ?? {});
        else pending.reject(new Error(frame.error));
        return;
      }
      case "watch_event": {
        const watch = this.watches.get(frame.watch);
        if (!watch || watch.stopped) return;
        const event = frame.event as DurableEvent;
        if (event.type === "events") {
          for (const agentEvent of event.events) {
            const entry = agentEvent.type === "entry_appended" || agentEvent.type === "message_end" ? (agentEvent as { entry?: EntryRecord }).entry : undefined;
            if (entry && typeof entry.id === "number") watch.fromEntry = Math.max(watch.fromEntry ?? 0, entry.id);
          }
        }
        watch.sink(event);
        return;
      }
      case "event": {
        const row = frame.row;
        this.feedChain = this.feedChain.then(() => this.readRow(socket, row));
        return;
      }
      case "call": {
        if (frame.op === "chat_http") void this.chatHttp(frame.id, frame.args);
        else this.send({ type: "result", id: frame.id, ok: false, error: `unknown op ${String(frame.op)}` });
        return;
      }
    }
  }

  /** Runs the App's handler for one feed row, then saves the cursor and acks; a failure halts the feed until the next welcome replays it. */
  private async readRow(socket: WebSocket, row: FeedRow): Promise<void> {
    if (this.feedHalted || socket !== this.socket) return;
    if (row.seq <= this.cursor()) {
      this.send({ type: "ack", seq: row.seq });
      return;
    }
    try {
      await this.onFeed?.(row);
    } catch (error) {
      this.feedHalted = true;
      this.log(`relay ${this.name}: feed row ${row.seq} (${row.thread}) failed, it comes again after the next hello: ${String(error)}`);
      return;
    }
    if (socket !== this.socket) return;
    this.saveCursor(row.seq);
    this.send({ type: "ack", seq: row.seq });
  }

  private async chatHttp(id: string, args: ChatHttpArgs): Promise<void> {
    if (!this.options.chatPort) {
      this.send({ type: "result", id, ok: false, error: "this chat server has no HTTP port to forward to" });
      return;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${this.options.chatPort}${args.path}`, {
        method: args.method, ...(args.headers ? { headers: args.headers } : {}), ...(args.body !== undefined && args.method !== "GET" && args.method !== "HEAD" ? { body: args.body } : {}),
      });
      const result: ChatHttpResult = { status: response.status, headers: headersOf(response.headers), body: await response.text() };
      this.send({ type: "result", id, ok: true, data: result });
    } catch (error) {
      this.send({ type: "result", id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private onClose(socket: WebSocket): void {
    if (socket !== this.socket) return;
    clearInterval(this.livenessTimer);
    this.socket = undefined;
    this.ready = false;
    this.setLink("away");
    for (const watch of this.watches.values()) watch.open = false;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (!pending.sent) continue;
      if (pending.repeatable && !this.closed) {
        // It goes again after the next hello, or fails as away when the link stays down.
        pending.sent = false;
        pending.waitTimer = setTimeout(() => this.fail(id, new HostAway(this.name, this.link.since)), RECONNECT_WAIT_MS);
      } else this.fail(id, new HostAway(this.name, this.link.since));
    }
    if (this.closed) return;
    this.attempt += 1;
    const wait = this.options.redialWait?.(this.attempt) ?? Math.min(MAX_REDIAL_MS, 1000 * 2 ** (this.attempt - 1));
    this.redialTimer = setTimeout(() => this.dial(), wait);
  }

  private fail(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    clearTimeout(pending.waitTimer);
    pending.reject(error);
  }

  private write(id: string, pending: Pending): void {
    clearTimeout(pending.waitTimer);
    pending.sent = this.send({ type: "call", id, op: pending.op, args: pending.args });
    if (!pending.sent) return;
    if (pending.timeoutMs) {
      pending.timer = setTimeout(() => this.fail(id, new Error(`${this.name} did not answer ${pending.op} in ${pending.timeoutMs / 1000} s`)), pending.timeoutMs);
    }
  }

  /** One call to the box; fails at once with `HostAway` while the link is down. `timeoutMs` 0 waits as long as the link lives. */
  call(op: ServerOp, args: Record<string, unknown> = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`relay client for ${this.name} is closed; ${op} not sent`));
    if (!this.ready) return Promise.reject(new HostAway(this.name, this.link.since));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const pending: Pending = { op, args, timeoutMs, repeatable: repeatable(op, args), sent: false, resolve, reject };
      this.pending.set(id, pending);
      this.write(id, pending);
      if (!pending.sent) this.fail(id, new HostAway(this.name, this.link.since));
    });
  }

  private async rewatch(): Promise<void> {
    for (const watch of this.watches.values()) {
      if (watch.open || watch.stopped) continue;
      try {
        await this.openWatch(watch);
      } catch (error) {
        this.log(`relay ${this.name}: rewatch ${watch.thread} failed: ${String(error)}`);
      }
    }
  }

  private async openWatch(watch: Watch): Promise<void> {
    await this.call("watch", {
      watch: watch.id, thread: watch.thread,
      ...(watch.conversation === undefined ? {} : { conversation: watch.conversation }), ...(watch.fromEntry === undefined ? {} : { fromEntry: watch.fromEntry }),
    });
    watch.open = true;
  }

  async threads(opts: { archived?: boolean } = {}): Promise<DurableThread[]> {
    return ((await this.call("durable_threads", opts)) as { threads: DurableThread[] }).threads;
  }
  async create(opts: CreateOptions): Promise<DurableThread> {
    const { box: _box, ...fields } = opts;
    return ((await this.call("durable_create", fields)) as { thread: DurableThread }).thread;
  }
  async submit(thread: string, input: SubmitInput): Promise<Submitted> {
    return (await this.call("durable_submit", { thread, ...input })) as Submitted;
  }
  async ticket(thread: string, conversation?: number): Promise<Ticket | null> {
    return ((await this.call("durable_ticket", { thread, ...(conversation === undefined ? {} : { conversation }) })) as { ticket: Ticket | null }).ticket;
  }
  async abort(thread: string, conversation?: number): Promise<void> {
    await this.call("durable_abort", { thread, ...(conversation === undefined ? {} : { conversation }) });
  }
  async wait(thread: string, submission: number): Promise<SubmissionRecord> {
    return ((await this.call("durable_wait", { thread, submission }, 0)) as { settled: SubmissionRecord }).settled;
  }
  async tree(thread: string): Promise<TreeNode[]> {
    return ((await this.call("durable_tree", { thread })) as { conversations: TreeNode[] }).conversations;
  }
  async entries(thread: string, opts: { conversation?: number; before?: number; after?: number; limit?: number }): Promise<{ entries: EntryRecord[]; more: boolean }> {
    return (await this.call("durable_entries", { thread, ...opts })) as { entries: EntryRecord[]; more: boolean };
  }
  async watch(thread: string, opts: { conversation?: number; fromEntry?: number }, sink: (event: DurableEvent) => void): Promise<() => Promise<void>> {
    const watch: Watch = { id: randomUUID(), thread, ...opts, sink, open: false, stopped: false };
    this.watches.set(watch.id, watch);
    try {
      await this.openWatch(watch);
    } catch (error) {
      this.watches.delete(watch.id);
      throw error;
    }
    return async () => {
      watch.stopped = true;
      this.watches.delete(watch.id);
      if (watch.open && this.ready) await this.call("unwatch", { watch: watch.id }).catch(() => undefined);
    };
  }
  async search(query: SearchQuery): Promise<SearchPage> {
    return (await this.call("durable_search", { ...query })) as SearchPage;
  }
  async usage(range: { since?: number; until?: number; threads?: string[] }): Promise<UsageTotal[]> {
    return ((await this.call("durable_usage", range)) as { usage: UsageTotal[] }).usage;
  }
  async docGet(thread: string, name: string): Promise<unknown> {
    return ((await this.call("durable_doc_get", { thread, name })) as { value: unknown }).value;
  }
  async docPut(thread: string, name: string, value: unknown): Promise<void> {
    await this.call("durable_doc_put", { thread, name, value });
  }
  async set(thread: string, patch: { name?: string; model?: string; thinkingLevel?: string; archived?: boolean; cwd?: string }): Promise<DurableThread> {
    return ((await this.call("durable_set", { thread, ...patch })) as { thread: DurableThread }).thread;
  }
  /** Runs a wake's shell check on the box. */
  async check(command: string, timeoutMs: number): Promise<BoxCheck> {
    return (await this.call("check", { command, timeoutMs }, timeoutMs + COMMAND_TIMEOUT_MS)) as BoxCheck;
  }
  async fileGet(path: string): Promise<BoxFile> {
    return (await this.call("file_get", { path })) as BoxFile;
  }
  /** Writes the file on the box, or removes it with `text` null. */
  async filePut(path: string, text: string | null): Promise<void> {
    await this.call("file_put", text === null ? { path, delete: true } : { path, text });
  }
  async ping(): Promise<Ping> {
    if (!this.ready) return { ok: false, error: `${this.name} is offline since ${new Date(this.link.since).toISOString()}` };
    const piHost = this.hello?.piHost;
    if (piHost && !piHost.up) return { ok: false, error: `${this.name}'s pi-host is down${piHost.error ? `: ${piHost.error}` : ""}` };
    return { ok: true, version: piHost?.version ?? this.hello?.version ?? "unknown" };
  }
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.redialTimer);
    clearInterval(this.livenessTimer);
    for (const id of [...this.pending.keys()]) this.fail(id, new Error(`relay client for ${this.name} is closed`));
    this.socket?.close();
    this.socket = undefined;
    this.ready = false;
  }
}
