import { Worker } from "node:worker_threads";
import { errorText, type FiringAlert, holdUnevaluated, readGrafanaAlerts, readUnevaluatedRules } from "./alert-bridge.ts";
import { type Alerting, macWokeAt, PollHealth, type PollRecord, readAlerting, statusOf, writeStatus } from "./alert-bridge-health.ts";
import { TokenHookWatch, withHookAlert } from "./token-hook-watch.ts";
import { TICK_MS } from "./wakes.ts";

/**
 * The alert bridge's Grafana poll and its status file, on a worker thread of their own. From 11:43Z to 11:48:41Z on 10-19 the poll did not run
 * at all while the chat service's main thread read 100% busy (catalog line at 11:48:08Z: median 418 ms, p90 1925 ms, max 3469 ms), the
 * watchdog told ops guy the bridge was stale, and box-chat-heal restarts the service when the status file goes 180 s without a write. The
 * main thread keeps the bridge's state and its sends; it takes each poll's result from here when it gets to it.
 */
export interface PollInput { grafanaConfig: string; sessionsDir: string; statusFile: string; pollMs: number }
/** One poll's result, worker to main. */
export interface PollFrame { type: "poll"; record: PollRecord; alerts: FiringAlert[] | null }
/** The watchdog's alerting state, main to worker, for the status file. */
export interface AlertingFrame { type: "alerting"; alerting: Alerting | null }

/** The worker's loop: every `pollMs` a poll if none runs, and the status file written with the latest record. */
export function runPoll(input: PollInput, post: (frame: PollFrame) => void, onAlerting: (listener: (alerting: Alerting | null) => void) => void, log: (line: string) => void): () => void {
  const health = new PollHealth();
  const hookWatch = new TokenHookWatch({ sessionsDir: input.sessionsDir });
  // The state the status file kept, until the watchdog on the main thread sends its own, so a restart keeps alert_since.
  let alerting: Alerting | null | undefined;
  onAlerting(value => { alerting = value; });
  let polling = false;
  // The last list the bridge got, for holdUnevaluated.
  let previous: FiringAlert[] | null = null;
  const read = async (): Promise<FiringAlert[] | null> => {
    const current = await readGrafanaAlerts(input.grafanaConfig);
    return current && (previous = await holdUnevaluated(previous, current, () => readUnevaluatedRules(input.grafanaConfig)));
  };
  // One status write at a time: during the 16:07Z to 16:15Z stall on 10-19 seven writes queued on the one temp file name and all but the
  // first failed with ENOENT at 16:15:00Z.
  let writing: Promise<void> | null = null;
  const write = (): Promise<void> => writing ??= writeOnce().finally(() => { writing = null; });
  const writeOnce = async () => {
    if (health.record.configuredAt === null) return;
    if (alerting === undefined) alerting = await readAlerting(input.statusFile, log);
    const now = Date.now();
    await writeStatus(input.statusFile, statusOf(health.record, alerting, now, input.pollMs, process.platform === "darwin" ? await macWokeAt() : null));
  };
  const tick = () => {
    void write().catch(error => log(`alerts: status: ${error instanceof Error ? error.message : String(error)}`));
    if (polling) return;
    polling = true;
    void health.poll(() => withHookAlert(read(), hookWatch))
      .then(alerts => post({ type: "poll", record: health.record, alerts }), error => {
        post({ type: "poll", record: health.record, alerts: null });
        log(`alerts: ${errorText(error)}`);
      })
      .then(write).catch(error => log(`alerts: status: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { polling = false; });
  };
  const timer = setInterval(tick, input.pollMs);
  tick();
  return () => clearInterval(timer);
}

/**
 * The main thread's side: `health.record` follows the worker's polls, `alerts()` hands the bridge each new poll's alerts once (null when no
 * poll came since its last tick, which the bridge skips), and `alerting()` passes the watchdog's state on for the status file.
 */
export class AlertPoll {
  readonly health = new PollHealth();
  private fresh: FiringAlert[] | null = null;
  private worker: Worker | null = null;
  private stopped = false;
  constructor(private readonly input: PollInput, private readonly log: (line: string) => void) { this.start(); }

  private start(): void {
    const worker = this.worker = new Worker(new URL("./alert-poll-worker.mjs", import.meta.url), { workerData: this.input });
    worker.unref();
    worker.on("message", (frame: PollFrame | { type: "log"; line: string }) => {
      if (frame.type === "log") { this.log(frame.line); return; }
      this.health.record = frame.record;
      if (frame.alerts) this.fresh = frame.alerts;
    });
    worker.on("error", (error: Error) => this.log(`alerts: poll worker: ${error.message}`));
    worker.on("exit", code => {
      if (this.stopped) return;
      this.log(`alerts: poll worker exited ${code}; a new one starts in ${this.input.pollMs / 1000} s`);
      setTimeout(() => { if (!this.stopped) this.start(); }, this.input.pollMs).unref();
    });
  }

  async alerts(): Promise<FiringAlert[] | null> {
    const alerts = this.fresh;
    this.fresh = null;
    return alerts;
  }

  alerting(alerting: Alerting | null): void { this.worker?.postMessage({ type: "alerting", alerting } satisfies AlertingFrame); }

  stop(): void {
    this.stopped = true;
    void this.worker?.terminate();
  }
}

export const startAlertPoll = (input: Omit<PollInput, "pollMs"> & { pollMs?: number }, log: (line: string) => void): AlertPoll =>
  new AlertPoll({ ...input, pollMs: input.pollMs ?? TICK_MS }, log);
