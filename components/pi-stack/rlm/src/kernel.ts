import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

/** One host request from the kernel, after `parseHostRequest` checked it. */
export interface HostRequest {
  type: string;
  [key: string]: unknown;
}

export type KernelEvent =
  | { event: "ready"; protocol: number; python: string; reattached?: boolean; running?: string | null; unanswered?: string[] }
  | { event: "stdout" | "stderr"; id: string | null; text: string }
  | { event: "result"; id: string; text: string }
  | { event: "display"; id: string | null; data: Record<string, unknown> }
  | { event: "host_request"; id: string; data: HostRequest }
  | { event: "error"; id: string | null; ename: string; evalue: string; traceback: string[] }
  | ({ event: "done"; id: string; status: "ok" | "error" } & Record<string, unknown>);

export interface CellError {
  ename: string;
  evalue: string;
  traceback: string[];
}

export interface CellResult {
  status: "ok" | "error" | "aborted";
  stdout: string;
  stderr: string;
  result?: string;
  error?: CellError;
  displays: Record<string, unknown>[];
  backgroundOutput: string;
  durationMs: number;
  /** Set when the cell ignored the interrupt and still runs, so the kernel is busy until it ends. */
  stillRunning?: boolean;
}

export interface SnapshotResult {
  status: "ok" | "error";
  saved: string[];
  skipped: unknown[];
  pruned: string[];
  bytes: number;
  reason?: string;
}

export interface RestoreResult {
  status: "ok" | "error";
  restored: string[];
  failed: { name: string; reason?: string }[];
  reason?: string;
}

export interface Ready {
  protocol: number;
  python: string;
  /** True when this kernel was already running under its relay, so its namespace and `bash()` jobs are the ones from before. */
  reattached: boolean;
}

/** Thrown by `execute` while an interrupted cell still runs. The caller waits with `idle()` or restarts with `kill()`. */
export class KernelBusyError extends Error {
  constructor() {
    super("Interrupted Python cell is still running");
  }
}

export interface KernelOptions {
  python: string;
  cwd: string;
  env: Record<string, string>;
  stderrLogPath?: string;
  /** Answers one host request. The return value becomes the `ok` result and a throw becomes the `error` envelope. */
  onHostRequest(request: HostRequest): Promise<unknown>;
  /** Output and display events that no running cell owns, such as a background task writing after its cell ended. */
  onOrphanEvent?(event: KernelEvent): void;
  /** Every display event, owned by a cell or not, such as the `bash()` activity records. */
  onDisplay?(data: Record<string, unknown>): void;
  onExit?(reason: string): void;
  /** How long an aborted cell may take to stop before `execute` returns and leaves it running. */
  interruptGraceMs?: number;
}

/** Where a relayed kernel listens, and what the relay asks pi-host to reopen after a detach. */
export interface RelayOptions {
  socket: string;
  logPath: string;
  hostSocket?: string;
  wakeSession: string;
  /** The systemd unit name for the relay's scope, when systemd-run is there. */
  unit: string;
}

const STDERR_TAIL = 16_384;
const READY_TIMEOUT_MS = 120_000;
const RELAY_SCRIPT = resolve(import.meta.dirname, "..", "relay", "kernel_relay.py");

interface Link {
  readonly stdout: Readable;
  readonly pid: number | undefined;
  write(line: string): void;
  end(): void;
  kill(): void;
  onClose(fn: (reason: string) => void): void;
  onStderr?(fn: (chunk: string) => void): void;
}

function processLink(proc: ChildProcess): Link {
  proc.stdin!.on("error", () => {});
  proc.stderr!.setEncoding("utf8");
  return {
    stdout: proc.stdout!,
    pid: proc.pid,
    write: line => proc.stdin!.write(line),
    end: () => proc.stdin!.end(),
    kill: () => proc.kill("SIGKILL"),
    onClose: fn => {
      proc.on("error", error => fn(`spawn failed: ${error.message}`));
      proc.on("exit", (code, signal) => fn(`exited (code ${code}, signal ${signal})`));
    },
    onStderr: fn => proc.stderr!.on("data", fn),
  };
}

function socketLink(socket: Socket, pid: number | undefined): Link {
  socket.on("error", () => {});
  return {
    stdout: socket,
    pid,
    write: line => socket.write(line),
    end: () => socket.end(),
    kill: () => socket.write('{"type":"relay_kill"}\n'),
    onClose: fn => socket.on("close", () => fn("relay connection closed")),
  };
}

function connect(path: string): Promise<Socket> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => resolvePromise(socket));
    socket.once("error", reject);
  });
}

async function hasSystemdRun(): Promise<boolean> {
  if (process.platform !== "linux" || !process.env.XDG_RUNTIME_DIR) return false;
  return new Promise(r => {
    const p = spawn("systemctl", ["--user", "is-system-running"], { stdio: "ignore" });
    p.on("error", () => r(false));
    p.on("exit", code => r(code === 0 || code === 1));
  });
}

/** Starts `kernel_relay.py` outside this process's cgroup and session, so stopping pi-host leaves the kernel running. */
async function startRelay(options: KernelOptions, relay: RelayOptions): Promise<void> {
  mkdirSync(dirname(relay.socket), { recursive: true });
  const log = openSync(relay.logPath, "a");
  const argv = [options.python, RELAY_SCRIPT, "--socket", relay.socket, "--", options.python, "-m", "rlm.repl"];
  const viaSystemd = await hasSystemdRun();
  const [cmd, ...args] = viaSystemd ? ["systemd-run", "--user", "--scope", "--quiet", "--collect", `--unit=${relay.unit}`, ...argv] : argv;
  const child = spawn(cmd!, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", log, log], detached: true });
  child.on("error", () => {});
  child.unref();
  closeSync(log);
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      (await connect(relay.socket)).destroy();
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`the kernel relay did not open ${relay.socket} within 30 s; see ${relay.logPath}`);
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

function parseEvent(line: string): KernelEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || typeof (value as { event?: unknown }).event !== "string") return undefined;
  return value as KernelEvent;
}

function parseHostRequest(data: unknown): HostRequest {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("host_request data must be an object");
  const type = (data as { type?: unknown }).type;
  if (typeof type !== "string" || !type) throw new Error("host_request data needs a string type");
  return data as HostRequest;
}

interface Pending {
  onEvent(event: KernelEvent): void;
  done(event: Extract<KernelEvent, { event: "done" }>): void;
  fail(error: Error): void;
}

/**
 * One `python -m rlm.repl` process speaking protocol 3 (`python/src/rlm/repl.md`), over its own stdio or through `relay/kernel_relay.py`.
 *
 * The runtime runs requests one at a time in arrival order, so the manager only tracks ids. Host requests are answered as they arrive,
 * because the cell that sent one is itself the running request. A relayed kernel survives this process: `detach()` leaves it running,
 * and `Kernel.attach` on the same socket later picks up its namespace, its `bash()` jobs and every event it sent meanwhile.
 */
export class Kernel {
  readonly ready: Promise<Ready>;
  readonly relayed: boolean;
  private readonly link: Link;
  private readonly pending = new Map<string, Pending>();
  private running: string | undefined;
  private busyId: string | undefined;
  private idleWaiters: (() => void)[] = [];
  private seq = 0;
  private closed = false;
  private stderrTail = "";

  private constructor(
    private readonly options: KernelOptions,
    link: Link,
    relayed: boolean,
  ) {
    this.link = link;
    this.relayed = relayed;
    if (options.stderrLogPath) mkdirSync(dirname(options.stderrLogPath), { recursive: true });
    this.seq = Math.floor(Date.now() / 1000) * 1000;
    let resolveReady!: (v: Ready) => void;
    let rejectReady!: (e: Error) => void;
    this.ready = new Promise((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    this.ready.catch(() => {});
    const timer = setTimeout(() => rejectReady(new Error(`Python kernel did not start within ${READY_TIMEOUT_MS} ms.${this.stderrHint()}`)), READY_TIMEOUT_MS);
    timer.unref();
    link.onStderr?.(chunk => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL);
      if (options.stderrLogPath) {
        try {
          appendFileSync(options.stderrLogPath, chunk);
        } catch {}
      }
    });
    link.onClose(reason => {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(timer);
      rejectReady(new Error(`Python kernel ${reason} before it was ready.${this.stderrHint()}`));
      const error = new Error(`Python kernel ${reason}.${this.stderrHint()}`);
      for (const p of this.pending.values()) p.fail(error);
      this.pending.clear();
      this.clearBusy();
      options.onExit?.(reason);
    });
    createInterface({ input: link.stdout }).on("line", line => {
      const event = parseEvent(line);
      if (!event) return;
      if (event.event === "ready") {
        clearTimeout(timer);
        if (event.running) this.markBusy(event.running);
        resolveReady({ protocol: event.protocol, python: event.python, reattached: event.reattached === true });
        return;
      }
      if (event.event === "host_request") {
        void this.answer(event.id, event.data);
        return;
      }
      if (event.event === "display") options.onDisplay?.(event.data);
      const owner = event.id ?? this.running;
      const p = owner ? this.pending.get(owner) : undefined;
      if (event.event === "done" && event.id === this.busyId) this.clearBusy();
      if (!p) {
        options.onOrphanEvent?.(event);
        return;
      }
      if (event.event === "done") {
        this.pending.delete(event.id);
        if (this.running === event.id) this.running = undefined;
        p.done(event);
      } else {
        p.onEvent(event);
      }
    });
  }

  /** A kernel on this process's own stdio, which ends with this process. */
  static spawn(options: KernelOptions): Kernel {
    const proc = spawn(options.python, ["-m", "rlm.repl"], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    return new Kernel(options, processLink(proc), false);
  }

  /** Attaches to a running relay, or starts one first when `start` is set and nothing listens on the socket. */
  static async relay(options: KernelOptions, relay: RelayOptions, start: boolean): Promise<Kernel | undefined> {
    let socket: Socket;
    try {
      socket = await connect(relay.socket);
    } catch {
      if (!start) return undefined;
      await startRelay(options, relay);
      socket = await connect(relay.socket);
    }
    const kernel = new Kernel(options, socketLink(socket, undefined), true);
    socket.write(JSON.stringify({ type: "relay_hello", host_socket: relay.hostSocket ?? null, wake_session: relay.wakeSession }) + "\n");
    return kernel;
  }

  get pid(): number | undefined {
    return this.link.pid;
  }

  get alive(): boolean {
    return !this.closed;
  }

  /** The id of an interrupted cell that has not stopped yet, if any. */
  get busy(): boolean {
    return this.busyId !== undefined;
  }

  private markBusy(id: string): void {
    this.busyId = id;
  }

  private clearBusy(): void {
    this.busyId = undefined;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  /** Resolves when the interrupted cell ends or the kernel goes away. */
  idle(signal?: AbortSignal): Promise<void> {
    if (!this.busyId) return Promise.resolve();
    return new Promise((res, rej) => {
      this.idleWaiters.push(res);
      signal?.addEventListener("abort", () => rej(new Error("Python execution aborted")), { once: true });
    });
  }

  private stderrHint(): string {
    const tail = this.stderrTail.trim();
    return tail ? `\nKernel stderr:\n${tail.slice(-2000)}` : "";
  }

  private async answer(id: string, data: unknown): Promise<void> {
    let reply: { status: "ok"; result: unknown } | { status: "error"; error: string };
    try {
      const result = await this.options.onHostRequest(parseHostRequest(data));
      reply = { status: "ok", result: result ?? {} };
    } catch (error) {
      reply = { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
    if (!this.closed) this.send({ type: "host_reply", id, data: reply });
  }

  private send(message: unknown): void {
    if (this.closed) throw new Error("Python kernel is not running");
    this.link.write(JSON.stringify(message) + "\n");
  }

  private request(message: Record<string, unknown>, onEvent: (e: KernelEvent) => void = () => {}): Promise<Extract<KernelEvent, { event: "done" }>> {
    const id = `r${++this.seq}`;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { onEvent, done: resolvePromise, fail: reject });
      try {
        this.send({ ...message, id });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * Runs one cell. `onStream` gets the cell's output so far after each stdout or stderr chunk. On abort the cell gets `interrupt`, and a
   * cell that has not stopped after the grace period stays running: `execute` returns `stillRunning` and later calls throw
   * `KernelBusyError` until it ends.
   */
  async execute(code: string, options: { signal?: AbortSignal; onStream?(text: string): void } = {}): Promise<CellResult> {
    await this.ready;
    if (this.busyId) throw new KernelBusyError();
    const started = performance.now();
    const out: CellResult = { status: "ok", stdout: "", stderr: "", displays: [], backgroundOutput: "", durationMs: 0 };
    let streamed = "";
    const id = `c${++this.seq}`;
    let giveUp: (() => void) | undefined;
    const onAbort = () => {
      try {
        this.send({ type: "interrupt", id });
      } catch {}
      const t = setTimeout(() => giveUp?.(), this.options.interruptGraceMs ?? 3000);
      t.unref();
    };
    if (options.signal?.aborted) throw new Error("Python execution aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const done = await new Promise<Extract<KernelEvent, { event: "done" }> | "still_running">((resolvePromise, reject) => {
        giveUp = () => {
          if (!this.pending.has(id)) return;
          this.markBusy(id);
          resolvePromise("still_running");
        };
        this.pending.set(id, {
          done: resolvePromise,
          fail: reject,
          onEvent: event => {
            if (event.event === "stdout" || event.event === "stderr") {
              if (event.id === null) out.backgroundOutput += event.text;
              else out[event.event] += event.text;
              streamed += event.text;
              options.onStream?.(streamed);
            } else if (event.event === "result") out.result = event.text;
            else if (event.event === "display") out.displays.push(event.data);
            else if (event.event === "error") out.error = { ename: event.ename, evalue: event.evalue, traceback: event.traceback };
          },
        });
        this.running = id;
        try {
          this.send({ type: "execute", id, code });
        } catch (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
      if (done === "still_running") {
        out.status = "aborted";
        out.stillRunning = true;
      } else {
        out.status = done.status === "ok" ? "ok" : options.signal?.aborted ? "aborted" : "error";
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      out.durationMs = Math.round(performance.now() - started);
    }
    return out;
  }

  async snapshot(path: string, manifestPath: string, limits: { maxBytes?: number; maxVariableBytes?: number; pruneOversized?: boolean } = {}): Promise<SnapshotResult> {
    await this.ready;
    mkdirSync(dirname(path), { recursive: true });
    const done = await this.request({
      type: "snapshot",
      path,
      manifest_path: manifestPath,
      ...(limits.maxBytes !== undefined ? { max_bytes: limits.maxBytes } : {}),
      ...(limits.maxVariableBytes !== undefined ? { max_variable_bytes: limits.maxVariableBytes } : {}),
      ...(limits.pruneOversized ? { prune_oversized: true } : {}),
    });
    return {
      status: done.status,
      saved: (done.saved as string[]) ?? [],
      skipped: (done.skipped as unknown[]) ?? [],
      pruned: (done.pruned as string[]) ?? [],
      bytes: (done.bytes as number) ?? 0,
      reason: done.reason as string | undefined,
    };
  }

  async restore(path: string): Promise<RestoreResult> {
    await this.ready;
    const done = await this.request({ type: "restore", path });
    return {
      status: done.status,
      restored: (done.restored as string[]) ?? [],
      failed: ((done.failed as unknown[]) ?? []).map(f => (typeof f === "string" ? { name: f } : (f as { name: string; reason?: string }))),
      reason: done.reason as string | undefined,
    };
  }

  async listNames(): Promise<string[]> {
    await this.ready;
    const done = await this.request({ type: "list_names" });
    return (done.names as string[]) ?? [];
  }

  private closedPromise(): Promise<void> {
    return new Promise(r => {
      if (this.closed) return r();
      this.link.onClose(() => r());
    });
  }

  /** Sends `shutdown`, which kills live `bash()` process groups, and kills the kernel if it has not exited after `graceMs`. */
  async shutdown(graceMs = 3000): Promise<void> {
    if (this.closed) return;
    const closed = this.closedPromise();
    try {
      this.send({ type: "shutdown" });
      if (!this.relayed) this.link.end();
    } catch {}
    const timer = setTimeout(() => this.link.kill(), graceMs);
    timer.unref();
    await closed;
    clearTimeout(timer);
  }

  /** Kills the kernel at once, for the "Kill kernel and restart" choice. Its `bash()` jobs keep running in their own process groups. */
  async kill(): Promise<void> {
    if (this.closed) return;
    const closed = this.closedPromise();
    this.link.kill();
    await closed;
  }

  /** Leaves a relayed kernel running and disconnects. `wake` tells the relay when to ask pi-host to reopen the session. */
  detach(wake: "now" | "on_event"): void {
    if (!this.relayed || this.closed) return;
    this.closed = true;
    try {
      this.link.write(JSON.stringify({ type: "relay_detach", wake }) + "\n");
      this.link.end();
    } catch {}
    for (const p of this.pending.values()) p.fail(new Error("the session detached from its Python kernel"));
    this.pending.clear();
  }
}

export function relayPaths(artifactDir: string, sessionId: string): { socket: string; logPath: string; unit: string } {
  const runtime = process.env.XDG_RUNTIME_DIR && process.platform === "linux" ? join(process.env.XDG_RUNTIME_DIR, "pi-rlm") : join(tmpdir(), "pi-rlm");
  return { socket: join(runtime, `kernel-${sessionId}.sock`), logPath: join(artifactDir, "kernel-relay.log"), unit: `pi-rlm-kernel-${sessionId.slice(0, 8)}-${Date.now().toString(36)}` };
}
