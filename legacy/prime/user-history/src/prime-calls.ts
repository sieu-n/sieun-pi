import { appendFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { DaemonClient } from "./daemon-sdk.ts";

/**
 * One JSON line per Prime daemon call the chat service makes, reads included, in `<data dir>/prime-calls.jsonl`. The prime-under-load page
 * (option C, picked by the owner on 10-27) found no log of a delivery, read or turn in the daemon logs, so the board could not show p50, p99
 * or an error rate per method. The kernel's host_request wrapper (message-limit-check.py `timed`) writes the same fields with src "kernel",
 * and harness-feed's latency reader turns both into harness.latency.prime_call and harness.latency.prime_calls.
 */
export type PrimeCallOutcome = "ok" | "refused" | "timeout" | "closed" | "error";
export interface PrimeCall {
  /** When the call ended, ISO UTC. */
  ts: string;
  src: "chat";
  /** The daemon command type, or "hello" for a wait on the daemon_hello. */
  method: string;
  /** The session the command names, absent when it names none. */
  target?: string;
  /** The box whose daemon answered through its bridge socket, absent for this box. */
  host?: string;
  ms: number;
  outcome: PrimeCallOutcome;
  /** The error's first 200 characters, absent on "ok". */
  error?: string;
}

const ERROR_CHARS = 200;
const TARGET_KEYS = ["activeSessionId", "targetActiveSessionId", "sessionId"] as const;
/** src/hosts.ts names each bridge socket `<dir>/hosts/<box>.sock`. */
const BRIDGE = /\/hosts\/([\w.-]+)\.sock$/;

/**
 * A thrown call's outcome. Prime load-e's DaemonSessionUnavailableError (code `session_unavailable`, with the session's state) is a refusal,
 * as Prime's own call log counts it: the supervisor ran nothing because no worker could take the session.
 */
export function outcomeOfError(error: unknown): { outcome: PrimeCallOutcome; error: string } {
  const text = error instanceof Error ? error.message : String(error);
  const outcome: PrimeCallOutcome = text.startsWith("Timed out") ? "timeout"
    : error instanceof Error && error.name === "DaemonSocketClosedError" || /not connected|closed before the operation completed|Daemon worker socket closed/.test(text) ? "closed"
    : error instanceof Error && (error.name === "DaemonSessionUnavailableError" || Reflect.get(error, "code") === "session_unavailable") ? "refused" : "error";
  return { outcome, error: text.slice(0, ERROR_CHARS) };
}

export function targetOf(command: unknown): string | undefined {
  if (typeof command !== "object" || command === null) return undefined;
  for (const key of TARGET_KEYS) {
    const value: unknown = Reflect.get(command, key);
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export const hostOf = (socketPath: unknown): string | undefined => typeof socketPath === "string" ? BRIDGE.exec(socketPath)?.[1] : undefined;

/** Buffers lines and appends them in one write at a time, so a burst of reads costs one append and never blocks the event loop. */
export class CallLog {
  private lines: string[] = [];
  private writing: Promise<void> | null = null;
  constructor(private readonly file: string, private readonly onError: (error: unknown) => void = () => {}) {}

  add(call: PrimeCall): void {
    this.lines.push(JSON.stringify(call) + "\n");
    this.writing ??= this.drain();
  }

  /** Resolves once every line added so far is on disk. */
  async flushed(): Promise<void> { while (this.writing) await this.writing; }

  private async drain(): Promise<void> {
    await Promise.resolve();
    while (this.lines.length) {
      const text = this.lines.join("");
      this.lines = [];
      await appendFile(this.file, text, { mode: 0o600 }).catch(this.onError);
    }
    this.writing = null;
  }
}

type Request = DaemonClient["request"];
type WaitForHello = DaemonClient["waitForHello"];
const ORIGINAL = Symbol.for("sieun-pi.prime-calls.original");

/**
 * Times every `DaemonClient.request` and every hello wait in this process and adds one line each to `log`. It patches the class, so every
 * client the service opens is covered, those of the catalog, the threads, the outbox and the host bridges alike. Returns the undo.
 */
export function logPrimeCalls(log: CallLog, now: () => Date = () => new Date()): () => void {
  const proto = DaemonClient.prototype as DaemonClient & { [ORIGINAL]?: { request: Request; waitForHello: WaitForHello } };
  const original = proto[ORIGINAL] ?? { request: proto.request, waitForHello: proto.waitForHello };
  const record = (client: DaemonClient, method: string, target: string | undefined, started: number, result: { outcome: PrimeCallOutcome; error?: string }) => {
    const host = hostOf(Reflect.get(client, "socketPath"));
    log.add({ ts: now().toISOString(), src: "chat", method, ...target ? { target } : {}, ...host ? { host } : {}, ms: Math.round(performance.now() - started), ...result });
  };
  const timed = <T>(client: DaemonClient, method: string, target: string | undefined, call: () => Promise<T>, judge: (value: T) => { outcome: PrimeCallOutcome; error?: string }): Promise<T> => {
    const started = performance.now();
    let promise: Promise<T>;
    try { promise = call(); } catch (error) { record(client, method, target, started, outcomeOfError(error)); throw error; }
    promise.then(value => record(client, method, target, started, judge(value)), (error: unknown) => record(client, method, target, started, outcomeOfError(error)));
    return promise;
  };
  proto[ORIGINAL] = original;
  proto.request = function (this: DaemonClient, ...args: Parameters<Request>) {
    return timed(this, args[0].type, targetOf(args[0]), () => original.request.apply(this, args),
      response => response.success ? { outcome: "ok" } : { outcome: "refused", error: String(response.error ?? "").slice(0, ERROR_CHARS) });
  };
  proto.waitForHello = function (this: DaemonClient, ...args: Parameters<WaitForHello>) {
    if (this.hello) return original.waitForHello.apply(this, args);
    return timed(this, "hello", undefined, () => original.waitForHello.apply(this, args), () => ({ outcome: "ok" }));
  };
  return () => {
    proto.request = original.request;
    proto.waitForHello = original.waitForHello;
    delete proto[ORIGINAL];
  };
}
