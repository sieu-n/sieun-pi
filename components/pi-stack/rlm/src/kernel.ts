import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

/** One host request from the kernel, after `parseHostRequest` checked it. */
export interface HostRequest {
  type: string;
  [key: string]: unknown;
}

export type KernelEvent =
  | { event: "ready"; protocol: number; python: string }
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

export interface KernelOptions {
  python: string;
  cwd: string;
  env: Record<string, string>;
  stderrLogPath?: string;
  /** Answers one host request. The return value becomes the `ok` result and a throw becomes the `error` envelope. */
  onHostRequest(request: HostRequest): Promise<unknown>;
  /** Output and display events that no running cell owns, such as a background task writing after its cell ended. */
  onOrphanEvent?(event: KernelEvent): void;
  onExit?(code: number | null, signal: NodeJS.Signals | null): void;
}

const STDERR_TAIL = 16_384;
const READY_TIMEOUT_MS = 120_000;

interface Pending {
  onEvent(event: KernelEvent): void;
  done(event: Extract<KernelEvent, { event: "done" }>): void;
  fail(error: Error): void;
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

/**
 * One `python -m rlm.repl` process speaking protocol 3 (`python/src/rlm/repl.md`) over stdio.
 *
 * The runtime runs requests one at a time in arrival order, so the manager only tracks ids. Host requests are answered as they arrive,
 * because the cell that sent one is itself the running request.
 */
export class Kernel {
  readonly ready: Promise<{ protocol: number; python: string }>;
  private readonly proc: ChildProcess;
  private readonly pending = new Map<string, Pending>();
  private running: string | undefined;
  private seq = 0;
  private exited = false;
  private stderrTail = "";

  constructor(private readonly options: KernelOptions) {
    if (options.stderrLogPath) mkdirSync(dirname(options.stderrLogPath), { recursive: true });
    this.proc = spawn(options.python, ["-m", "rlm.repl"], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    let resolveReady!: (v: { protocol: number; python: string }) => void;
    let rejectReady!: (e: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.ready.catch(() => {});
    const timer = setTimeout(() => rejectReady(new Error(`Python kernel did not start within ${READY_TIMEOUT_MS} ms.${this.stderrHint()}`)), READY_TIMEOUT_MS);
    timer.unref();
    this.proc.on("error", error => rejectReady(error));
    this.proc.stderr!.setEncoding("utf8");
    this.proc.stderr!.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL);
      if (options.stderrLogPath) {
        try {
          appendFileSync(options.stderrLogPath, chunk);
        } catch {}
      }
    });
    this.proc.stdin!.on("error", () => {});
    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      clearTimeout(timer);
      rejectReady(new Error(`Python kernel exited before it was ready (code ${code}, signal ${signal}).${this.stderrHint()}`));
      const error = new Error(`Python kernel exited (code ${code}, signal ${signal}).${this.stderrHint()}`);
      for (const p of this.pending.values()) p.fail(error);
      this.pending.clear();
      options.onExit?.(code, signal);
    });
    createInterface({ input: this.proc.stdout! }).on("line", line => {
      const event = parseEvent(line);
      if (!event) return;
      if (event.event === "ready") {
        clearTimeout(timer);
        resolveReady({ protocol: event.protocol, python: event.python });
        return;
      }
      if (event.event === "host_request") {
        void this.answer(event.id, event.data);
        return;
      }
      const owner = event.id ?? this.running;
      const p = owner ? this.pending.get(owner) : undefined;
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

  get pid(): number | undefined {
    return this.proc.pid;
  }

  get alive(): boolean {
    return !this.exited;
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
    this.send({ type: "host_reply", id, data: reply });
  }

  private send(message: unknown): void {
    if (this.exited) throw new Error("Python kernel is not running");
    this.proc.stdin!.write(JSON.stringify(message) + "\n");
  }

  private request(message: Record<string, unknown>, onEvent: (e: KernelEvent) => void = () => {}): Promise<Extract<KernelEvent, { event: "done" }>> {
    const id = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { onEvent, done: resolve, fail: reject });
      try {
        this.send({ ...message, id });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** Runs one cell. `onStream` gets the cell's output so far after each stdout or stderr chunk. */
  async execute(code: string, options: { signal?: AbortSignal; onStream?(text: string): void } = {}): Promise<CellResult> {
    await this.ready;
    const started = performance.now();
    const out: CellResult = { status: "ok", stdout: "", stderr: "", displays: [], backgroundOutput: "", durationMs: 0 };
    let streamed = "";
    const id = `c${++this.seq}`;
    const onAbort = () => {
      try {
        this.send({ type: "interrupt", id });
      } catch {}
    };
    if (options.signal?.aborted) throw new Error("Python execution aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const done = await new Promise<Extract<KernelEvent, { event: "done" }>>((resolve, reject) => {
        this.pending.set(id, {
          done: resolve,
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
      out.status = done.status === "ok" ? "ok" : options.signal?.aborted ? "aborted" : "error";
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

  /** Sends `shutdown`, which kills live `bash()` process groups, and kills the process if it has not exited after `graceMs`. */
  async shutdown(graceMs = 3000): Promise<void> {
    if (this.exited) return;
    const exited = new Promise<void>(resolve => this.proc.once("exit", () => resolve()));
    try {
      this.send({ type: "shutdown" });
      this.proc.stdin!.end();
    } catch {}
    const timer = setTimeout(() => this.proc.kill("SIGKILL"), graceMs);
    timer.unref();
    await exited;
    clearTimeout(timer);
  }
}
