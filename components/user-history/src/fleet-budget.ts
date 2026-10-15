import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readAgentQueue } from "./chat-pool.ts";
import { queueLong } from "./chat-turn-queue.ts";
import type { AgentQueueReading } from "./shared/types.ts";

/**
 * The GiB the Prime workers may hold before the chat service starts no more non-owner sessions. Over 721 watch minutes on 10-14 and 10-15,
 * 0 of 364 minutes with the worker footprint at 16 GB or less were unusable (wiki memory mac_usable_turn_and_worker_lines_20261015,
 * test fixture usable_minutes_1014_1015.json), and the reboot at 13:48:58Z on 10-15 went from 0 to 37 GB of workers in 47 min.
 */
export const FLEET_GB = 16;
/**
 * What one more root session adds before the next read sees it: a fit over about 1,000 watch minutes on 10-15 gave 0.72 GiB per worker
 * (wiki memory mac_memory_10_15_gib_follows_prime_workers_root_sessions_about_0_72_gib_each_a_c).
 */
export const WORKER_GB = 0.72;
/** How often a waiting start reads the workers again; pi-pool's reader took 6 ms on 10-15. */
export const FLEET_READ_MS = 15_000;
/**
 * How long a fix job the budget let start counts as its chat's live fix while the catalog does not list it yet: a new session showed in the
 * catalog 9 s at p50, 35 s at p90 and 195 s at most after its create from the 13:50Z restart on 10-15 (service.log).
 */
export const FIX_UNLISTED_MS = 200_000;

/**
 * The stop switch: while this file exists in the chat service's data folder, the budget admits no non-owner start at all, and the service holds
 * every message it would send on its own (wakes, notices, continues, non-prod alerts). The owner asked on 10-16 at about 04:00 KST to "FIRST KILL
 * EVERYTHING FOR NOW UNTIL EVERYTHING IS FIXED", after the 03:55 KST batch started 6 check-ins and 8 fix jobs within 1 min of a daemon restart.
 * Owner sends and prod turns never read it. Delete the file to open the budget again; it is read on every check.
 */
export const FLEET_STOP_FILE = "fleet-stop.json";

/**
 * The budget's state for the sessions themselves, next to the stop file: `{ at, closed }`, rewritten every FLEET_READ_MS. The user-history
 * extension reads it before an rlm.create_session (src/fleet-guard.ts), so a root job an agent starts on its own waits like the server's: at 04:03
 * KST on 10-16, with the budget shut at 17.9 GB, jobs started "5180 comes back after daemon stop fix" and "5180 restart cause fix" themselves.
 */
export const FLEET_STATE_FILE = "fleet-state.json";
/** `waiting`: the starts that wait now, oldest first (`FleetBudget.queued`), so a check-in run outside the service reads them too. */
export interface FleetState { at: number; closed: string | null; waiting?: readonly FleetAsk[] }

/** Whether an alert text names a prod alert and no staging or dev one, the same rule pi-pool's prod turns use (pool/prod.py). */
export const isProdAlert = (text: string): boolean => /\b(prod|production)\b/i.test(text) && !/\b(staging|stg|dev)\b/i.test(text);

/**
 * Why the Mac as a whole has no room, from pi-pool's memory governor: high or critical shuts the budget even with the workers under FLEET_GB,
 * as FLEET_GB counts only the Prime workers. At 04:00 KST on 10-16 the workers held 11.8 GB while the owner's browsers held about 19 GB, the
 * governor read critical with 16 GB compressed and load 46, and the budget still let 4 fix jobs start.
 */
export function pressured(reading: AgentQueueReading | null): string | null {
  const level = reading?.governor?.level;
  return level === "high" || level === "critical" ? `pi-pool reads memory pressure ${level}` : null;
}

/** The job names of `chat` whose start waits in the budget: its own starts, and the send-backs and continues, which name no chat. */
export const startsOf = (waiting: readonly FleetAsk[], chat: string): string[] =>
  waiting.filter(ask => ask.chat === chat || ask.chat === undefined).map(ask => ask.label);

/** The non-owner starts the budget orders. An owner message, a chat's own wake and a prod turn never ask it. */
export type FleetKind = "duty" | "checkin" | "fix" | "sendback" | "continue" | "wake";
export interface FleetAsk { kind: FleetKind; label: string; chat?: string }
/** Tells the budget the session an admitted start made or woke, so a fix job counts as its chat's live fix; called once, with none when it failed. */
export type FleetDone = (session?: string) => void;

export interface FleetDeps {
  /** GiB in the Prime workers and their processes, or null when it cannot be read (the budget then lets starts through). */
  gb: () => Promise<number | null>;
  /** The pi-pool queue, or null; while it is long (`queueLong`) a start would only wait there with its worker loaded. */
  queue?: () => Promise<AgentQueueReading | null>;
  /** Whether a session still works or waits in the turn queue, for the one-fix-per-chat rule. */
  live: (session: string) => Promise<boolean>;
  /** Whether a fix job of the chat that this process did not start is live (after a service restart). */
  fixLive?: (chat: string) => Promise<boolean>;
  /** The stop switch file (FLEET_STOP_FILE); absent: never stopped. */
  stopFile?: string;
  log: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readMs?: number;
}

interface Waiter { ask: FleetAsk; at: number; resolve: (done: FleetDone) => void }

/**
 * The fleet budget: every non-owner session the chat service starts or wakes (duty and check-in jobs, fix jobs, send-backs, the continue of a
 * cut turn, a job's board.wake) asks it first. It lets them through one at a time in the order they asked, only while the Prime workers hold
 * under FLEET_GB and pi-pool's queue is not long, and it lets a chat have one fix job at a time. After the reboot at 13:48:58Z on 10-15 these
 * starts came all at once: 48 fix sessions (one duty 7 times), 8 duty runs, 15 duty restarts, 6 send-backs and 39 wakes in 57 min, and the
 * workers went from 0 to 37 GB while 102 turns waited in the queue (session files and service.log).
 */
export class FleetBudget {
  private readonly waiting: Waiter[] = [];
  private readonly places = new Map<string, { done?: FleetDone }>();
  private readonly fixes = new Map<string, { at: number; pending: boolean; session?: string }>();
  private reading: { at: number; gb: number | null; long: string | null } | null = null;
  private sinceRead = 0;
  private pumping = false;
  private closedWhy: string | null = null;
  private stopped = false;
  private publishing: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly readMs: number;

  constructor(private readonly deps: FleetDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); }));
    this.readMs = deps.readMs ?? FLEET_READ_MS;
    if (deps.stopFile) {
      const file = join(dirname(deps.stopFile), FLEET_STATE_FILE);
      const publish = () => { void this.publish(file); };
      this.publishing = setInterval(publish, this.readMs);
      this.publishing.unref?.();
      publish();
    }
  }

  /** Writes FLEET_STATE_FILE (FleetState) through a temp file, so a reader never sees half of it. A failed write is left for the next one. */
  private async publish(file: string): Promise<void> {
    const why = this.waiting.length ? await this.held().catch(() => null) : await this.closed().catch(() => null);
    const state: FleetState = { at: this.now(), closed: why, waiting: this.queued() };
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(state)).then(() => rename(temp, file)).catch(() => {});
  }

  /** Waits for this start's turn and returns the call that names its session. */
  admit(ask: FleetAsk): Promise<FleetDone> {
    return new Promise<FleetDone>(resolve => {
      this.waiting.push({ ask, at: this.now(), resolve });
      void this.pump();
    });
  }

  /** Lets the start through now only when no start waits and the budget is open; null otherwise, so a sweep tries again next time. */
  async tryAdmit(ask: FleetAsk): Promise<FleetDone | null> {
    if (this.waiting.length || this.pumping || this.stopped) return null;
    if (await this.closed() !== null) return null;
    if (!(await this.fixFree(ask))) return null;
    return this.grant(ask);
  }

  /**
   * For a start its caller asks again on every tick, such as a job's due wake: it goes now when `tryAdmit` lets it, and otherwise it takes a
   * place in line under its kind and label, and a later call returns the grant once that place came up. `tryAdmit` alone never let such a
   * start go while any start waited, and starts always waited: from 18:55Z to 20:58Z on 10-15 the budget admitted check-ins, fix jobs and
   * send-backs, and it held the due wakes of 38 jobs 3,374 times and delivered none. census canary run slept from its 19:20Z wake on, and
   * the Crawler VP check-in counted its steps stuck (service.log). A place shows in `queued()`, so the check-in counts its owner as moving.
   */
  async place(ask: FleetAsk): Promise<FleetDone | null> {
    const key = `${ask.kind}\n${ask.label}`;
    const held = this.places.get(key);
    if (held) {
      if (!held.done) return null;
      this.places.delete(key);
      return held.done;
    }
    const now = await this.tryAdmit(ask);
    if (now) return now;
    const entry: { done?: FleetDone } = {};
    this.places.set(key, entry);
    void this.admit(ask).then(done => { entry.done = done; });
    return null;
  }

  /** Why a start asked now would wait, or null when it would go at once. */
  async held(): Promise<string | null> {
    if (this.waiting.length) return `${this.waiting.length} starts wait for the fleet budget`;
    return this.closed();
  }

  /** Why the stop switch is on (its file's `why`, or a plain line), or null when it is off. */
  async switchedOff(): Promise<string | null> {
    if (!this.deps.stopFile) return null;
    const text = await readFile(this.deps.stopFile, "utf8").catch(() => null);
    if (text === null) return null;
    let why = "";
    try { const value: unknown = JSON.parse(text); if (typeof value === "object" && value && "why" in value && typeof value.why === "string") why = value.why; } catch {}
    return `the fleet stop switch is on${why ? ` (${why})` : ""}`;
  }

  /** The starts waiting now, oldest first. */
  queued(): readonly FleetAsk[] { return this.waiting.map(entry => entry.ask); }

  /** Stops the wait loop for good (service shutdown): the starts still waiting never go, and later asks only wait. */
  stop(): void {
    this.stopped = true;
    if (this.publishing) clearInterval(this.publishing);
    this.publishing = null;
  }

  private async read(): Promise<{ gb: number | null; long: string | null }> {
    if (!this.reading || this.now() - this.reading.at >= this.readMs) {
      const [gb, queue] = await Promise.all([this.deps.gb().catch(() => null), this.deps.queue ? this.deps.queue().catch(() => null) : Promise.resolve(null)]);
      this.reading = { at: this.now(), gb, long: queueLong(queue) ?? pressured(queue) };
      this.sinceRead = 0;
    }
    return this.reading;
  }

  /** Why the budget is shut now, counting the starts let through since the last read at WORKER_GB each. */
  private async closed(): Promise<string | null> {
    const stop = await this.switchedOff();
    if (stop) return stop;
    const { gb, long } = await this.read();
    const projected = gb === null ? null : gb + WORKER_GB * this.sinceRead;
    if (projected !== null && projected >= FLEET_GB) return `the Prime workers hold ${projected.toFixed(1)} GB (budget ${FLEET_GB} GB)`;
    return long;
  }

  private async fixFree(ask: FleetAsk): Promise<boolean> {
    if (ask.kind !== "fix" || !ask.chat) return true;
    const mine = this.fixes.get(ask.chat);
    if (mine) {
      if (mine.pending || this.now() - mine.at < FIX_UNLISTED_MS) return false;
      if (mine.session && await this.deps.live(mine.session).catch(() => false)) return false;
      this.fixes.delete(ask.chat);
    }
    return !(await this.deps.fixLive?.(ask.chat).catch(() => false) ?? false);
  }

  private grant(ask: FleetAsk): FleetDone {
    this.sinceRead++;
    if (ask.kind === "fix" && ask.chat) this.fixes.set(ask.chat, { at: this.now(), pending: true });
    let called = false;
    return session => {
      if (called) return;
      called = true;
      if (ask.kind !== "fix" || !ask.chat) return;
      const entry = this.fixes.get(ask.chat);
      if (!entry) return;
      entry.pending = false;
      entry.at = this.now();
      if (session) entry.session = session;
      else this.fixes.delete(ask.chat);
    };
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      while (this.waiting.length && !this.stopped) {
        const why = await this.closed().catch(() => null);
        if (why) {
          if (why !== this.closedWhy) this.deps.log(`fleet budget: ${this.waiting.length} starts wait, ${why}`);
          this.closedWhy = why;
          await this.sleep(this.readMs);
          continue;
        }
        if (this.closedWhy) this.deps.log(`fleet budget: open again; ${this.waiting.length} starts go one at a time`);
        this.closedWhy = null;
        let index = -1;
        for (let i = 0; i < this.waiting.length; i++) if (await this.fixFree(this.waiting[i]!.ask)) { index = i; break; }
        if (index < 0) { await this.sleep(this.readMs); continue; }
        const [entry] = this.waiting.splice(index, 1);
        const waited = Math.round((this.now() - entry!.at) / 1000);
        if (waited >= 1) this.deps.log(`fleet budget: ${entry!.ask.kind} ${entry!.ask.label} starts after ${waited} s`);
        entry!.resolve(this.grant(entry!.ask));
      }
    } finally { this.pumping = false; }
  }
}

/** pi-pool's reader of the workers' phys_footprint (pool/pressure.py read_workers_gb), from the installed pool. */
export function readWorkersGb(home: string = homedir()): Promise<number | null> {
  const pool = join(home, ".local", "share", "pi-pool", "current");
  const code = "import sys; sys.path.insert(0, sys.argv[1]); from pool.pressure import read_workers_gb; print(read_workers_gb())";
  return new Promise(resolve => {
    execFile("/usr/bin/python3", ["-c", code, pool], { timeout: 10_000 }, (error, stdout) => {
      const value = Number.parseFloat(String(stdout).trim());
      resolve(error || !Number.isFinite(value) ? null : value);
    });
  });
}

export const readFleetQueue = (): Promise<AgentQueueReading | null> => readAgentQueue().catch(() => null);
