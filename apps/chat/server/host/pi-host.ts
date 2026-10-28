/**
 * `Host` over pi-host's socket: one long-lived connection that sends `durable_*` commands as JSON lines and routes `durable_event` lines to
 * their watches. A dropped connection reconnects with backoff and restarts every live watch from the newest entry it delivered.
 */
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { DurableEvent, DurableThread, EntryRecord, Host, SearchHit, SearchQuery, SubmissionRecord, Submitted, SubmitInput, Ticket, TreeNode, UsageTotal } from "./types.ts";

type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Watch = { thread: string; conversation?: number; fromEntry?: number; sink: (event: DurableEvent) => void; hostId?: string; stopped: boolean };

const COMMAND_TIMEOUT_MS = 120_000;
/** How long a call waits for pi-host to come back after a restart; its unit restarts in about 2 s. */
const RESTART_WAIT_MS = 30_000;

class ConnectionLost extends Error {
  constructor(message: string, readonly sent: boolean) {
    super(message);
  }
}

export class PiHost implements Host {
  readonly name = "pi-host";
  private socket?: Socket;
  private connecting?: Promise<Socket>;
  private buffer = "";
  private readonly pending = new Map<string, Pending>();
  private readonly watches = new Set<Watch>();
  private closed = false;
  private version = "unknown";

  constructor(readonly socketPath: string, private readonly log: (line: string) => void = () => {}) {}

  private open(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<Socket>((resolve, reject) => {
      const socket = connect(this.socketPath);
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        this.socket = socket;
        this.connecting = undefined;
        resolve(socket);
        void this.rewatch();
      });
      socket.once("error", error => {
        this.connecting = undefined;
        reject(error);
      });
      socket.on("data", chunk => this.onData(String(chunk)));
      socket.on("close", () => this.onClose(socket));
    });
    return this.connecting;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: { type?: string; id?: string; success?: boolean; data?: unknown; error?: string; watch?: string; event?: DurableEvent; appVersion?: string };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === "daemon_hello" && message.appVersion) this.version = message.appVersion;
      if (message.type === "response" && message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.success) pending.resolve(message.data ?? {});
        else pending.reject(new Error(typeof message.error === "string" ? message.error : JSON.stringify(message.error ?? "pi-host refused the command")));
      } else if (message.type === "durable_event" && message.event) {
        for (const watch of this.watches) {
          if (watch.hostId !== message.watch || watch.stopped) continue;
          const event = message.event;
          if (event.type === "events") {
            for (const agentEvent of event.events) {
              const entry = agentEvent.type === "entry_appended" || agentEvent.type === "message_end" ? (agentEvent as { entry?: EntryRecord }).entry : undefined;
              if (entry && typeof entry.id === "number") watch.fromEntry = Math.max(watch.fromEntry ?? 0, entry.id);
            }
          }
          watch.sink(event);
        }
      }
    }
  }

  private onClose(socket: Socket): void {
    if (this.socket === socket) this.socket = undefined;
    this.buffer = "";
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new ConnectionLost("pi-host closed the connection", true));
      this.pending.delete(id);
    }
    for (const watch of this.watches) watch.hostId = undefined;
    if (!this.closed && this.watches.size) this.reconnect(1000);
  }

  /** Opens the socket again until pi-host answers, so live watches come back after a pi-host restart. */
  private reconnect(delay: number): void {
    setTimeout(() => {
      if (this.closed || !this.watches.size) return;
      this.open().catch(() => this.reconnect(Math.min(delay * 2, 10_000)));
    }, delay);
  }

  private async rewatch(): Promise<void> {
    for (const watch of this.watches) {
      if (watch.hostId || watch.stopped) continue;
      try {
        const data = (await this.call("durable_watch", {
          thread: watch.thread,
          ...(watch.conversation === undefined ? {} : { conversation: watch.conversation }),
          ...(watch.fromEntry === undefined ? {} : { fromEntry: watch.fromEntry }),
        })) as { watch: string };
        watch.hostId = data.watch;
      } catch (error) {
        this.log(`rewatch ${watch.thread} failed: ${String(error)}`);
      }
    }
  }

  /**
   * Sends one command. While pi-host restarts (its socket refuses, or it closes mid-call), the call tries again for up to 30 s, except a
   * command that would act twice: `durable_create` and `durable_import` make a new thread each time, and a submit without a requestId.
   * `timeoutMs` 0 waits as long as the connection lives, for `durable_wait`.
   */
  async call(type: string, fields: Record<string, unknown> = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<unknown> {
    const repeatable = type !== "durable_create" && type !== "durable_import" && !(type === "durable_submit" && !fields.requestId);
    const end = Date.now() + RESTART_WAIT_MS;
    for (;;) {
      try {
        return await this.callOnce(type, fields, timeoutMs);
      } catch (error) {
        const lost = error instanceof ConnectionLost || /ECONNREFUSED|ENOENT|EPIPE|ECONNRESET/.test(String(error));
        const sent = error instanceof ConnectionLost && error.sent;
        if (!lost || this.closed || Date.now() > end || (sent && !repeatable)) throw error;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  private async callOnce(type: string, fields: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const socket = await this.open();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi-host did not answer ${type} in ${timeoutMs / 1000} s`));
      }, timeoutMs || 2 ** 31 - 1);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ ...fields, type, id })}\n`);
    });
  }

  async threads(opts: { archived?: boolean } = {}): Promise<DurableThread[]> {
    return ((await this.call("durable_threads", opts)) as { threads: DurableThread[] }).threads;
  }
  async create(opts: { name?: string; model?: string; thinkingLevel?: string; cwd?: string }): Promise<DurableThread> {
    return ((await this.call("durable_create", opts)) as { thread: DurableThread }).thread;
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
    const watch: Watch = { thread, ...opts, sink, stopped: false };
    this.watches.add(watch);
    try {
      const data = (await this.call("durable_watch", { thread, ...opts })) as { watch: string };
      watch.hostId = data.watch;
    } catch (error) {
      this.watches.delete(watch);
      throw error;
    }
    return async () => {
      watch.stopped = true;
      this.watches.delete(watch);
      if (watch.hostId) await this.call("durable_unwatch", { watch: watch.hostId }).catch(() => undefined);
    };
  }
  async search(query: SearchQuery): Promise<SearchHit[]> {
    return ((await this.call("durable_search", { ...query })) as { hits: SearchHit[] }).hits;
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
  async set(thread: string, patch: { name?: string; model?: string; thinkingLevel?: string; archived?: boolean }): Promise<DurableThread> {
    return ((await this.call("durable_set", { thread, ...patch })) as { thread: DurableThread }).thread;
  }
  async ping(): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
    try {
      await this.call("durable_threads", { archived: false });
      return { ok: true, version: this.version };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.socket?.destroy();
  }
}
