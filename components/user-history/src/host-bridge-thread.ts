import { Worker } from "node:worker_threads";
import type { Host, HostsRegistry } from "./hosts.ts";

/**
 * The bridge sockets of `HostBridge` (src/hosts.ts), each tunneled to another box's relay, on a worker thread of their own. On the main thread
 * every byte of a Mac daemon read or prompt waited for the chat service's event loop, which read 100% busy at box load 80 to 260 on 10-19:
 * get_state through mac.sock took 0.27 to 3.6 s against 0.19 s straight to the Mac relay, and a prompt took 0.46 to 1.57 s to reach the Mac
 * against 0.1 s (~/work/mac-feel-check on us-metal02). The main thread keeps `HostBridge.socketPath` and talks to the sockets as any client does.
 */
type Options = { dir?: string; self?: Host | null; replaceLive?: boolean; log?: (line: string) => void };
/** Worker to main. */
type Frame = { type: "started"; live: string[] } | { type: "failed"; error: string } | { type: "closed" } | { type: "log"; line: string };
/** The same wait the box copy of another host's sessions takes before it connects again (RECONNECT_MS in src/host-catalogs.ts). */
const RESTART_MS = 5000;

export class BridgeThread {
  private worker: Worker | null = null;
  private stopped = false;
  constructor(private readonly registry: HostsRegistry, private readonly options: Options = {}) {}

  private log(line: string): void { this.options.log?.(line); }

  /** Opens the sockets on a new worker; resolves with the hosts it left to a live socket, as `HostBridge.start` does. */
  start(): Promise<{ live: string[] }> {
    const { log: _log, ...options } = this.options;
    const worker = this.worker = new Worker(new URL("./host-bridge-worker.mjs", import.meta.url), { workerData: { registry: this.registry, options } });
    worker.unref();
    return new Promise((resolve, reject) => {
      worker.on("message", (frame: Frame) => {
        if (frame.type === "log") this.log(frame.line);
        else if (frame.type === "started") resolve({ live: frame.live });
        else if (frame.type === "failed") { void this.close(); reject(new Error(frame.error)); }
      });
      worker.on("error", (error: Error) => this.log(`hosts: bridge worker: ${error.message}`));
      worker.on("exit", code => {
        if (this.worker === worker) this.worker = null;
        reject(new Error(`hosts: bridge worker exited ${code} before its sockets opened`));
        if (this.stopped) return;
        this.log(`hosts: bridge worker exited ${code}; a new one starts in ${RESTART_MS / 1000} s`);
        setTimeout(() => { if (!this.stopped) this.start().catch(error => this.log(error instanceof Error ? error.message : String(error))); }, RESTART_MS).unref();
      });
    });
  }

  /** Ends the tunnels and removes the sockets this bridge put there, as `HostBridge.close` does, then ends the worker. */
  async close(): Promise<void> {
    this.stopped = true;
    const worker = this.worker;
    if (!worker) return;
    await new Promise<void>(resolve => {
      worker.once("exit", () => resolve());
      worker.on("message", (frame: Frame) => { if (frame.type === "closed") resolve(); });
      worker.postMessage({ type: "close" });
    });
    await worker.terminate();
  }
}
