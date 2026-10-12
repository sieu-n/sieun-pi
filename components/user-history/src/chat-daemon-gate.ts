import { type CheckInSettings, daemonPause, daemonResume } from "./chat-checkin.ts";
import { CHECK_IN_PREFIX } from "./shared/chat-feed.ts";

/**
 * The daemon health gate. At 17:58Z on 10-09 the daemon stopped answering (load 293) while 9 chats kept starting check-in jobs. The duty
 * runner's wake lets the gate time one daemon `list` a minute; the duty archive queue reports each archive try (its `kill`). The daemon is
 * unhealthy after UNHEALTHY_SAMPLES bad samples in a row (a list over DAEMON_LIST_OK_MS, a failed list, or a failed or slow kill) and healthy
 * again after HEALTHY_PROBES lists in a row within DAEMON_LIST_OK_MS. Going unhealthy pauses the check-in of every chat outside `keep` that is
 * not paused already, as `pausedBy: "daemon"`; going healthy resumes only those, chat i of n at now + i * interval / n. Each change writes one
 * log line and tells the `tell` chat one line through its steer path. After a restart, a chat still paused by the daemon starts the gate as
 * unhealthy, so it resumes on its own.
 */
export const DAEMON_PROBE_EVERY_MS = 60_000;
export const DAEMON_LIST_OK_MS = 5_000;
/** A probe's list gives up after this; it counts as a bad sample. */
export const DAEMON_PROBE_TIMEOUT_MS = 15_000;
/** An archive try (dispose, kill with the supervisor's 2 s stop window, then a list) slower than this counts as a bad sample. */
export const DAEMON_KILL_OK_MS = 15_000;
export const HEALTHY_PROBES = 3;
export const UNHEALTHY_SAMPLES = 2;

type Health = "healthy" | "unhealthy";

export interface DaemonGateInput {
  /** One daemon `list`, rejecting on failure or after `timeoutMs`. */
  list(timeoutMs: number): Promise<void>;
  settings: CheckInSettings;
  /** Every chat's id. */
  chats(): Promise<Iterable<string>>;
  /** Chats whose check-in the gate never pauses: the `daemonGateChat` in configuration.json. */
  keep: ReadonlySet<string>;
  /** The chat told of each pause and resume; none: only the log. */
  tell?: string;
  steer(chatId: string, message: string): Promise<void>;
  /** Told after the gate changed settings, so open pages show it. */
  changed?(): Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class DaemonGate {
  private health: Health | undefined;
  private good = 0;
  private bad = 0;
  private lastProbe = -Infinity;
  private probing: Promise<void> | undefined;
  /** Samples and the changes they cause run one after another. */
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly input: DaemonGateInput) { this.now = input.now ?? Date.now; }

  /** The duty runner's wake: a probe when the last one is a minute old. */
  tick(): Promise<void> {
    if (this.probing || this.now() - this.lastProbe < DAEMON_PROBE_EVERY_MS) return Promise.resolve();
    return this.probe();
  }

  /** Times one daemon list and records it as a sample. */
  probe(): Promise<void> {
    return this.probing ??= (async () => {
      this.lastProbe = this.now();
      const started = this.now();
      let failure: string | undefined;
      try { await this.input.list(DAEMON_PROBE_TIMEOUT_MS); }
      catch (error) { failure = message(error); }
      const ms = this.now() - started;
      await this.sample(failure === undefined && ms <= DAEMON_LIST_OK_MS, failure ? `list failed after ${seconds(ms)}: ${failure}` : `list took ${seconds(ms)}`, true);
    })().finally(() => { this.probing = undefined; });
  }

  /** An archive try from the duty archive queue: a failed or slow one is a bad sample; a fast one does not count toward healthy. */
  kill(ms: number, ok: boolean): Promise<void> {
    if (ok && ms <= DAEMON_KILL_OK_MS) return Promise.resolve();
    return this.sample(false, ok ? `an archive took ${seconds(ms)}` : `an archive failed after ${seconds(ms)}`, false);
  }

  /** The gate's state for the tests and the log: unknown before the first sample. */
  get state(): Health | undefined { return this.health; }

  private sample(ok: boolean, what: string, list: boolean): Promise<void> {
    const next = this.chain.then(async () => {
      this.health ??= await this.adopt();
      if (ok && list) { this.good++; this.bad = 0; }
      else if (!ok) { this.bad++; this.good = 0; }
      if (this.health === "healthy" && this.bad >= UNHEALTHY_SAMPLES) { this.health = "unhealthy"; await this.pause(what); }
      else if (this.health === "unhealthy" && this.good >= HEALTHY_PROBES) { this.health = "healthy"; await this.resume(); }
    });
    this.chain = next.catch(error => this.input.log?.(`daemon gate: ${message(error)}`));
    return this.chain;
  }

  /** The state a fresh gate starts in: unhealthy while a chat is still paused by the daemon (a restart during an outage), else healthy. */
  private async adopt(): Promise<Health> {
    const settings = await this.input.settings.all();
    return Object.values(settings).some(setting => setting.pausedBy === "daemon") ? "unhealthy" : "healthy";
  }

  private async pause(what: string): Promise<void> {
    const now = this.now();
    const paused: string[] = [];
    for (const id of await this.input.chats()) {
      if (this.input.keep.has(id)) continue;
      let changed = false;
      await this.input.settings.update(id, current => { const next = daemonPause(current, now); changed = next !== null; return next ?? current; });
      if (changed) paused.push(id);
    }
    await this.input.changed?.().catch(() => {});
    this.input.log?.(`daemon gate: unhealthy (${what}, ${UNHEALTHY_SAMPLES} bad samples in a row); paused the check-in of ${paused.length} chats: ${paused.join(", ") || "none"}`);
    await this.tell(`${CHECK_IN_PREFIX}The daemon is slow (${what}), so the server paused the check-in of ${paused.length} chats; they resume on their own after ` +
      `${HEALTHY_PROBES} lists in a row within ${DAEMON_LIST_OK_MS / 1000} s.`);
  }

  private async resume(): Promise<void> {
    const now = this.now();
    const settings = await this.input.settings.all();
    const ids = Object.keys(settings).filter(id => settings[id]!.pausedBy === "daemon");
    const resumed: string[] = [];
    for (const [index, id] of ids.entries()) {
      let changed = false;
      await this.input.settings.update(id, current => {
        const next = daemonResume(current, now + Math.round(index * current.everyMs / ids.length));
        changed = next !== null;
        return next ?? current;
      });
      if (changed) resumed.push(id);
    }
    await this.input.changed?.().catch(() => {});
    this.input.log?.(`daemon gate: healthy (${HEALTHY_PROBES} lists in a row within ${DAEMON_LIST_OK_MS / 1000} s); resumed the check-in of ${resumed.length} chats, ` +
      `staggered over their interval: ${resumed.join(", ") || "none"}`);
    await this.tell(`${CHECK_IN_PREFIX}The daemon answers again, so the server resumed the check-in of ${resumed.length} chats, spread over their interval.`);
  }

  private async tell(line: string): Promise<void> {
    if (!this.input.tell) return;
    await this.input.steer(this.input.tell, line).catch(error => this.input.log?.(`daemon gate: could not tell ${this.input.tell}: ${message(error)}`));
  }
}
