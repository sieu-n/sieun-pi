/**
 * One connection to pi-host's socket, JSON lines both ways (packages/pi-host/src/server.ts). The agent relay opens one per `/v2/agents` link,
 * so closing the link ends that connection's feed and watches in pi-host too.
 */
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";

export type Answer = { ok: true; data: unknown } | { ok: false; error: string; unsent?: boolean };
export type PiHostLine = { type?: string; [key: string]: unknown };

type Pending = (answer: Answer) => void;

export class PiHostSocket {
  version = "unknown";
  private buffer = "";
  private readonly pending = new Map<string, Pending>();
  private lineHandler: (line: PiHostLine) => void = () => {};
  private closeHandler: (reason: string) => void = () => {};
  private closed = false;
  private readonly socket: Socket;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", chunk => this.onData(String(chunk)));
    socket.on("error", () => {});
    socket.on("close", () => this.handleClose());
  }

  /** Connects and waits for pi-host's `daemon_hello`, which carries its version. */
  static open(path: string): Promise<PiHostSocket> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      const conn = new PiHostSocket(socket);
      const fail = (error: Error) => reject(error);
      socket.once("error", fail);
      conn.lineHandler = line => {
        if (line.type !== "daemon_hello") return;
        if (typeof line.appVersion === "string") conn.version = line.appVersion;
        socket.off("error", fail);
        conn.lineHandler = () => {};
        resolve(conn);
      };
      conn.closeHandler = () => reject(new Error(`pi-host closed ${path} before its hello`));
    });
  }

  onLine(handler: (line: PiHostLine) => void): void {
    this.lineHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  /**
   * Sends one command and waits for its answer, with no time limit of its own: the chat server times its calls, and `durable_wait` waits as
   * long as the turn runs. `unsent` marks a command that never reached the socket, so a retry cannot act twice.
   */
  call(type: string, fields: Record<string, unknown> = {}): Promise<Answer> {
    if (this.closed || !this.socket.writable) return Promise.resolve({ ok: false, error: `pi-host socket is closed; ${type} not sent`, unsent: true });
    const id = randomUUID();
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.socket.write(`${JSON.stringify({ ...fields, type, id })}\n`);
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (let newline = this.buffer.indexOf("\n"); newline >= 0; newline = this.buffer.indexOf("\n")) {
      const text = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!text.trim()) continue;
      let line: PiHostLine;
      try {
        line = JSON.parse(text) as PiHostLine;
      } catch {
        continue;
      }
      const resolve = line.type === "response" && typeof line.id === "string" ? this.pending.get(line.id) : undefined;
      if (resolve) {
        this.pending.delete(line.id as string);
        resolve(line.success ? { ok: true, data: line.data ?? {} } : { ok: false, error: typeof line.error === "string" ? line.error : JSON.stringify(line.error ?? "pi-host refused the command") });
      } else this.lineHandler(line);
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.pending.values()) resolve({ ok: false, error: "pi-host closed the connection before it answered" });
    this.pending.clear();
    this.closeHandler("pi-host closed");
  }
}
