import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GrafanaError, type FiringAlert } from "./alert-bridge.ts";
import { OPS_ROUTE } from "./alert-routes.ts";
import { missing } from "./locked-json.ts";
import { TICK_MS } from "./wakes.ts";

export const STALE_MS = 5 * 60_000;
export const REPEAT_MS = 30 * 60_000;
const REFUSED = new Set([401, 403]);

export interface PollError { at: number; message: string; status: number | null }
export interface PollRecord { configuredAt: number | null; lastOk: number | null; lastError: PollError | null; firing: number | null }
export type Outage = { cause: "refused" | "stale"; since: number };
export interface Alerting { since: number; sentAt: number }
export type BridgeHealth = "starting" | "ok" | "failing" | Outage["cause"];

export class PollHealth {
  record: PollRecord = { configuredAt: null, lastOk: null, lastError: null, firing: null };
  constructor(private readonly now: () => number = Date.now) {}

  async poll(read: () => Promise<FiringAlert[] | null>): Promise<FiringAlert[] | null> {
    const at = this.now();
    try {
      const alerts = await read();
      if (alerts === null) {
        if (this.record.configuredAt !== null) this.failed({ at, message: "the Grafana config file is gone, so the bridge stopped polling", status: null });
        return null;
      }
      this.record = { ...this.record, configuredAt: this.record.configuredAt ?? at, lastOk: at, firing: alerts.length };
      return alerts;
    } catch (error) {
      this.failed({ at, message: error instanceof Error ? error.message : String(error), status: error instanceof GrafanaError ? error.status : null });
      throw error;
    }
  }

  private failed(error: PollError): void {
    this.record = { ...this.record, configuredAt: this.record.configuredAt ?? error.at, lastError: error };
  }
}

const lastWasOk = (record: PollRecord): boolean => record.lastOk !== null && (record.lastError === null || record.lastOk > record.lastError.at);

export function outage(record: PollRecord, now: number, wokeAt: number | null = null): Outage | null {
  if (record.configuredAt === null) return null;
  const since = record.lastOk ?? record.configuredAt;
  if (record.lastError?.status != null && REFUSED.has(record.lastError.status) && !lastWasOk(record)) return { cause: "refused", since };
  return now - Math.max(since, wokeAt ?? since) >= STALE_MS ? { cause: "stale", since } : null;
}

export function macWokeAt(): Promise<number | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise(done => execFile("/usr/sbin/sysctl", ["-n", "kern.waketime"], (error, out) => {
    const sec = error ? null : /sec = (\d+)/.exec(out)?.[1];
    done(sec ? Number(sec) * 1000 : null);
  }));
}

export function healthOf(record: PollRecord, now: number, wokeAt: number | null = null): BridgeHealth {
  const down = outage(record, now, wokeAt);
  if (down) return down.cause;
  if (lastWasOk(record)) return "ok";
  return record.lastError ? "failing" : "starting";
}

const iso = (ms: number): string => new Date(ms).toISOString();
const minute = (ms: number): string => `${iso(ms).slice(0, 16)}Z`;

export function downText(record: PollRecord, down: Outage, now: number, configFile: string): string {
  const lastOk = record.lastOk === null ? `no good poll since the chat service started polling at ${minute(down.since)}` : `last good poll ${minute(record.lastOk)}`;
  const error = record.lastError ? `last error at ${minute(record.lastError.at)}: ${record.lastError.message}` : "no poll error, the poll loop stopped calling Grafana";
  const head = down.cause === "refused"
    ? `Grafana at obs.virev.ai refused the alert bridge's Viewer token (HTTP ${record.lastError?.status}), so firing alerts no longer reach any chat (${lastOk}; ${error}). ` +
      `Mint a new Viewer token and put it in ${configFile}.`
    : `The alert bridge has not read Grafana's firing list from obs.virev.ai for ${Math.round((now - down.since) / 60_000)} min, so firing alerts no longer reach any chat ` +
      `(${lastOk}; ${error}). Check the chat service log and the token in ${configFile}.`;
  return `[alert-bridge-down] ${head} This comes from the bridge's own watchdog, repeats every ${REPEAT_MS / 60_000} min while it lasts, and one line follows when polls work again.`;
}

export function recoveredText(record: PollRecord, alerting: Alerting): string {
  return `[alert-bridge-recovered] The alert bridge read Grafana's firing list again at ${minute(record.lastOk!)} (${record.firing} firing); it had no good poll from ${minute(alerting.since)}.`;
}

export function watchStep(record: PollRecord, alerting: Alerting | null, now: number, configFile: string, wokeAt: number | null = null): { send: string | null; alerting: Alerting | null } {
  const down = outage(record, now, wokeAt);
  if (down) {
    if (alerting && now - alerting.sentAt < REPEAT_MS) return { send: null, alerting };
    return { send: downText(record, down, now, configFile), alerting: { since: alerting?.since ?? down.since, sentAt: now } };
  }
  if (alerting && lastWasOk(record)) return { send: recoveredText(record, alerting), alerting: null };
  return { send: null, alerting };
}

export interface BridgeStatus {
  v: 1;
  ts: string;
  pid: number;
  poll_every_s: number;
  health: BridgeHealth;
  last_ok: string | null;
  last_error: { at: string; status: number | null; message: string } | null;
  firing_count: number | null;
  alert_since: string | null;
  alert_sent_at: string | null;
}

export function statusOf(record: PollRecord, alerting: Alerting | null, now: number, pollMs: number, wokeAt: number | null = null): BridgeStatus {
  return { v: 1, ts: iso(now), pid: process.pid, poll_every_s: pollMs / 1000, health: healthOf(record, now, wokeAt),
    last_ok: record.lastOk === null ? null : iso(record.lastOk),
    last_error: record.lastError && { at: iso(record.lastError.at), status: record.lastError.status, message: record.lastError.message },
    firing_count: record.firing, alert_since: alerting && iso(alerting.since), alert_sent_at: alerting && iso(alerting.sentAt) };
}

export interface BridgeWatchDeps {
  health: PollHealth;
  statusFile: string;
  configFile: string;
  deliver: (session: string, text: string, root?: string) => Promise<void>;
  now?: () => number;
  wokeAt?: () => Promise<number | null>;
  /** Hands the alerting state to the poll worker, which writes the status file after each poll (src/alert-poll.ts). */
  alerting: (alerting: Alerting | null) => void;
  log: (line: string) => void;
}

export class BridgeWatch {
  private alerting: Alerting | null | undefined;
  private readonly now: () => number;
  constructor(private readonly deps: BridgeWatchDeps) { this.now = deps.now ?? Date.now; }

  async tick(): Promise<void> {
    const record = this.deps.health.record;
    if (record.configuredAt === null) return;
    this.alerting ??= await this.restore();
    const now = this.now();
    const wokeAt = outage(record, now)?.cause === "stale" ? await (this.deps.wokeAt ?? macWokeAt)() : null;
    const step = watchStep(record, this.alerting, now, this.deps.configFile, wokeAt);
    if (step.send) {
      try {
        await this.deps.deliver(OPS_ROUTE.session, step.send, OPS_ROUTE.session);
        this.alerting = step.alerting;
        this.deps.log(`alerts: watchdog told ops guy the bridge is ${step.alerting ? healthOf(record, now, wokeAt) : "polling again"}`);
      } catch (error) { this.deps.log(`alerts: watchdog: ${error instanceof Error ? error.message : String(error)}; tried again next tick`); }
    }
    this.deps.alerting(this.alerting);
  }

  private restore(): Promise<Alerting | null> { return readAlerting(this.deps.statusFile, this.deps.log); }
}

/** The watchdog's alerting state the status file kept over a restart; null when it has none. */
export async function readAlerting(file: string, log: (line: string) => void): Promise<Alerting | null> {
  try {
    const status = JSON.parse(await readFile(file, "utf8")) as Partial<BridgeStatus>;
    const since = Date.parse(status.alert_since ?? ""), sentAt = Date.parse(status.alert_sent_at ?? "");
    return Number.isFinite(since) && Number.isFinite(sentAt) ? { since, sentAt } : null;
  } catch (error) {
    if (!missing(error) && !(error instanceof SyntaxError)) log(`alerts: watchdog status: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Writes the status file that box-chat-heal and the Mac's mac_alert_bridge_* series read. */
export async function writeStatus(file: string, status: BridgeStatus): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status)}\n`);
  await rename(temporary, file);
}

export function startBridgeWatch(deps: BridgeWatchDeps, everyMs = TICK_MS): () => void {
  const watch = new BridgeWatch(deps);
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void watch.tick().catch(error => deps.log(`alerts: watchdog: ${error instanceof Error ? error.message : String(error)}`)).finally(() => { running = false; });
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
