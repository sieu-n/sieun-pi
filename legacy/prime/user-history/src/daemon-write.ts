import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createConnection, type Socket } from "node:net";
import { DAEMON_PROTOCOL_NAME, DAEMON_PROTOCOL_VERSION } from "prime-agent";
import { DaemonClient } from "./daemon-sdk.ts";

/*
 * Daemon writes whose retries run once. A send_message, steer, follow_up or prompt that times out on the client still runs in the daemon, and
 * a retry from a new DaemonClient runs it again: in the 10-22 scratch load test all 3 message write types reached the model twice after a
 * timeout and a retry (~/work/prime-under-load/LOAD.md), since every DaemonClient makes a new client id and every request a new command id.
 * Prime keys each mutating command by client id plus command id in its journal (docs/daemon.md, "Idempotency and Crash Recovery"): a resend
 * of a finished command answers its stored result, and one still running answers command_result_uncertain and is not run again. So every
 * write here goes with this box's one write client id, and the command id of a write whose answer never came stays in its `WriteSlot`, which
 * the caller keeps with the message (the outboxes keep it on disk), so the retry sends that same id.
 *
 * The connection to each daemon socket stays open. The supervisor drops the stored results of a client 120 s after its last connection
 * closed (qur in the 0.9.8 s3int.9 supervisor), and a result dropped that way would let a late retry run the write again.
 */

/** This box's client id for every keyed write, the same in each process and across service restarts, so a retry from any of them matches. */
export const WRITE_CLIENT_ID = `sieun-pi-write:${hostname()}`;

/**
 * The write in flight for one message. `id` is the command id of the last request whose answer never came, and `supervisor` the supervisor
 * that took it; both are cleared once an answer comes, so the next request of the same message gets a new id.
 */
export interface WriteSlot { id?: string; supervisor?: string }

export type WriteAnswer = { success: true; data?: unknown } | { success: false; error: string; errorInfo?: Record<string, unknown> };

/** The daemon's answer to a resend whose first send has no result yet: the write may still run, so it is not sent again. */
export class WriteUncertain extends Error {}

/** Each call the writers make, for the call log (src/prime-calls.ts). */
export interface WriteCall { method: string; target?: string; socketPath: string; ms: number; outcome: "ok" | "refused" | "timeout" | "closed" | "error"; error?: string }
let observer: ((call: WriteCall) => void) | null = null;
/** Sets the one observer of every keyed write in this process, or clears it with null. */
export function setWriteObserver(next: ((call: WriteCall) => void) | null): void { observer = next; }

const UNCERTAIN = "command_result_uncertain";
const HELLO_MS = 30_000;

type Hello = { protocol?: { version?: number }; supervisorOwnerToken?: string; supervisorPid?: number; supervisorProcessStartId?: string };
type Pending = { resolve: (answer: Record<string, unknown>) => void; reject: (error: Error) => void };
type Link = { socket: Socket; hello: Promise<Hello>; pending: Map<string, Pending> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const supervisorOf = (hello: Hello): string => hello.supervisorOwnerToken ?? `${hello.supervisorPid ?? "?"}:${hello.supervisorProcessStartId ?? "?"}`;
const closedError = (socketPath: string) => new Error(`Prime Agent daemon client closed before the operation completed. Socket: ${socketPath}`);

/** One kept connection to a daemon socket (this box's, or another box's bridge socket) that sends keyed writes. */
export class DaemonWriter {
  private link: Link | null = null;

  constructor(readonly socketPath: string, private readonly clientId = WRITE_CLIENT_ID, private readonly helloMs = HELLO_MS) {}

  /**
   * Sends `command` under the slot's id, or a new id when the slot holds none, and answers the daemon's answer. A timeout or a closed link
   * throws and leaves the id in the slot for the retry. A resend the daemon holds no result for throws WriteUncertain, unless another supervisor
   * took the first send: a supervisor that started after it can never finish it, so the write goes once more under a new id.
   */
  async request(command: { type: string } & Record<string, unknown>, slot: WriteSlot, timeoutMs: number): Promise<WriteAnswer> {
    const started = performance.now();
    const target = [command.activeSessionId, command.targetActiveSessionId].find((value): value is string => typeof value === "string");
    const note = (outcome: WriteCall["outcome"], error?: string) => {
      try { observer?.({ method: command.type, ...target ? { target } : {}, socketPath: this.socketPath, ms: Math.round(performance.now() - started), outcome, ...error ? { error: error.slice(0, 200) } : {} }); } catch { /* the log never fails a write */ }
    };
    try {
      let answer = await this.once(command, slot, timeoutMs);
      if (answer === "lost") answer = await this.once(command, slot, timeoutMs);
      if (answer === "lost") throw new WriteUncertain("The previous command result is uncertain and was not replayed");
      note(answer.success ? "ok" : "refused", answer.success ? undefined : answer.error);
      return answer;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      note(text.startsWith("Timed out") ? "timeout" : /closed before/.test(text) ? "closed" : "error", text);
      throw error;
    }
  }

  /** Closes the connection; a write still out rejects as closed and keeps its id. */
  close(): void {
    const link = this.link;
    this.link = null;
    link?.socket.destroy();
  }

  private async once(command: { type: string } & Record<string, unknown>, slot: WriteSlot, timeoutMs: number): Promise<WriteAnswer | "lost"> {
    const link = this.connect();
    const hello = await link.hello;
    const supervisor = supervisorOf(hello);
    const version = Math.min(hello.protocol?.version ?? DAEMON_PROTOCOL_VERSION, DAEMON_PROTOCOL_VERSION);
    slot.id ??= `w-${randomUUID()}`;
    slot.supervisor ??= supervisor;
    const id = slot.id;
    const answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.pending.delete(id);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for the Prime Agent daemon response to "${command.type}". Socket: ${this.socketPath}`));
      }, timeoutMs);
      link.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      link.socket.write(this.envelope({ ...command, id }, version));
    });
    const info = isRecord(answer.errorInfo) ? answer.errorInfo : isRecord(answer.errorDetails) ? answer.errorDetails : undefined;
    if (answer.success !== true && info?.code === UNCERTAIN) {
      // An ack here would drop the daemon's record of the first send, and the next resend would run it.
      if (slot.supervisor === undefined || slot.supervisor === supervisor) throw new WriteUncertain(typeof answer.error === "string" ? answer.error : UNCERTAIN);
      delete slot.id; delete slot.supervisor;
      return "lost";
    }
    delete slot.id; delete slot.supervisor;
    link.socket.write(this.envelope({ id: `ack-${randomUUID()}`, type: "ack_result", commandId: id }, version));
    if (answer.success === true) return { success: true, ...answer.data === undefined ? {} : { data: answer.data } };
    return { success: false, error: typeof answer.error === "string" ? answer.error : `${command.type} failed with no error text`, ...info ? { errorInfo: info } : {} };
  }

  private envelope(command: { id: string; type: string } & Record<string, unknown>, version: number): string {
    return `${JSON.stringify({ type: "command", id: command.id, protocol: { name: DAEMON_PROTOCOL_NAME, version }, clientId: this.clientId, command })}\n`;
  }

  /** The kept link, opened again when it closed; a late answer to a write that timed out is dropped unacknowledged. */
  private connect(): Link {
    if (this.link && !this.link.socket.destroyed) return this.link;
    const socket = createConnection(this.socketPath);
    socket.unref();
    const pending = new Map<string, Pending>();
    let buffer = "";
    let gotHello: (hello: Hello) => void = () => {};
    let failHello: (error: Error) => void = () => {};
    const hello = new Promise<Hello>((resolve, reject) => { gotHello = resolve; failHello = reject; });
    hello.catch(() => {});
    const helloTimer = setTimeout(() => {
      failHello(new Error(`Timed out after ${this.helloMs}ms waiting for the Prime Agent daemon hello. Socket: ${this.socketPath}`));
      socket.destroy();
    }, this.helloMs);
    const link: Link = { socket, hello, pending };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: unknown;
        try { message = JSON.parse(line); } catch { continue; }
        if (!isRecord(message)) continue;
        if (message.type === "daemon_hello") { clearTimeout(helloTimer); gotHello(message as Hello); continue; }
        if (message.type !== "response" || typeof message.id !== "string") continue;
        const waiting = pending.get(message.id);
        if (!waiting) continue;
        pending.delete(message.id);
        waiting.resolve(message);
      }
    });
    const closed = () => {
      clearTimeout(helloTimer);
      if (this.link === link) this.link = null;
      const error = closedError(this.socketPath);
      failHello(error);
      for (const waiting of pending.values()) waiting.reject(error);
      pending.clear();
    };
    socket.on("close", closed);
    let connected = false;
    socket.on("connect", () => { connected = true; });
    socket.on("error", error => {
      if (!connected) failHello(new Error(`Failed to connect to the Prime Agent daemon: ${error.message}. Socket: ${this.socketPath}`));
      socket.destroy();
    });
    this.link = link;
    return link;
  }
}

const writers = new Map<string, DaemonWriter>();

/** The kept writer of a daemon socket, one per socket in this process. */
export function writerFor(socketPath: string): DaemonWriter {
  let writer = writers.get(socketPath);
  if (!writer) writers.set(socketPath, writer = new DaemonWriter(socketPath));
  return writer;
}

/**
 * `command` as a keyed write on the daemon socket `client` connects to, which keeps the caller's routing to its box. A stand-in client that is
 * no DaemonClient, as the tests hand the hub, takes it as its own request.
 */
export function keyedRequest(client: Pick<DaemonClient, "request">, command: { type: string } & Record<string, unknown>, slot: WriteSlot, timeoutMs: number): Promise<WriteAnswer> {
  const socketPath: unknown = client instanceof DaemonClient ? Reflect.get(client, "socketPath") : undefined;
  if (typeof socketPath === "string") return writerFor(socketPath).request(command, slot, timeoutMs);
  return client.request(command as never, timeoutMs, { recoverable: false }) as Promise<WriteAnswer>;
}

/** Closes every kept writer, for a service stop or the end of a CLI run. */
export function closeWriters(): void {
  for (const writer of writers.values()) writer.close();
  writers.clear();
}
