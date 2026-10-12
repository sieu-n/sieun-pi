import { type CheckInSettings, daemonPause, daemonResume } from "./chat-checkin.ts";

/**
 * The daemon health gate. At 17:58Z on 10-09 the daemon stopped answering (load 293) while 9 chats kept starting check-in jobs. The duty
 * runner's wake (DUTY_TICK_MS) lets the gate send one daemon roster `list`, one at a time; the duty archive queue reports each archive try (its
 * `kill`). A sample is bad when the daemon did not answer: a list that failed or ran past prime-agent's own request timeout, or a failed
 * archive. The first bad sample makes the daemon unhealthy and the first answered list makes it healthy again; no count or interval of ours
 * sits on top of the 30 s timeout (c43). Going unhealthy pauses the check-in of every chat outside `keep` that is not paused already, as
 * `pausedBy: "daemon"`; going healthy resumes only those, chat i of n at now + i * interval / n. Each change writes one log line. The gate
 * posts nothing into a chat: daemon health is server state, no chat can act on it, and each chat's check-in card already shows "paused while the daemon is slow" (10-12 KST: 33 such lines in the AI
 * harness VP chat, each a steer that woke it for a turn). After a restart, a chat still paused by the daemon starts the gate as unhealthy, so
 * it resumes on its own.
 *
 * No answer time counts as slow by itself. The old 5 s bar had no measurement behind it (c43) and fired on lists that answered: on 10-12 the
 * gate paused 17 times, 10 of them on a list that answered in 5.1 s to 11.6 s and 1 on an archive that worked in 17.7 s. The probe lists
 * the roster only (the `list` command without `all`), because `all` adds the daemon's disk scan of every saved session (measured 10-12
 * 23:30 KST: 7.7 MB and 1,135 rows in 16.6 s against 1.3 MB and 377 rows in 0.4 s for the roster list right after it).
 */

type Health = "healthy" | "unhealthy";

/** The daemon request the probe needs: prime-agent's `DaemonClient.request`. */
export type DaemonRequest = (command: { type: "list" }, timeoutMs: undefined, options: { recoverable: false }) => Promise<{ success: boolean; error?: string }>;

/**
 * One roster list for the probe. The timeout is left to prime-agent's DaemonClient default (DEFAULT_DAEMON_REQUEST_TIMEOUT_MS, 30 s in
 * dist/modes/daemon/daemon-client.js), the same bound every other daemon request from this server and from agent_message has.
 */
export async function rosterList(request: DaemonRequest): Promise<void> {
  const response = await request({ type: "list" }, undefined, { recoverable: false });
  if (!response.success) throw new Error(response.error);
}

export interface DaemonGateInput {
  /** One daemon roster list (rosterList), rejecting when the daemon did not answer. */
  list(): Promise<void>;
  settings: CheckInSettings;
  /** Every chat's id. */
  chats(): Promise<Iterable<string>>;
  /** Chats whose check-in the gate never pauses: the `daemonGateChat` in configuration.json. */
  keep: ReadonlySet<string>;
  /** Told after the gate changed settings, so open pages show it. */
  changed?(): Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class DaemonGate {
  private health: Health | undefined;
  private probing: Promise<void> | undefined;
  /** Samples and the changes they cause run one after another. */
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly input: DaemonGateInput) { this.now = input.now ?? Date.now; }

  /** The duty runner's wake: a probe unless one still runs. */
  tick(): Promise<void> {
    if (this.probing) return Promise.resolve();
    return this.probe();
  }

  /** Times one daemon list and records it as a sample. */
  probe(): Promise<void> {
    return this.probing ??= (async () => {
      const started = this.now();
      let failure: string | undefined;
      try { await this.input.list(); }
      catch (error) { failure = message(error); }
      const ms = this.now() - started;
      await this.sample(failure === undefined, failure ? `list failed after ${seconds(ms)}: ${failure}` : `list took ${seconds(ms)}`, true);
    })().finally(() => { this.probing = undefined; });
  }

  /** An archive try from the duty archive queue: a failed one is a bad sample; one that worked does not count toward healthy. */
  kill(ms: number, ok: boolean): Promise<void> {
    if (ok) return Promise.resolve();
    return this.sample(false, `an archive failed after ${seconds(ms)}`, false);
  }

  /** The gate's state for the tests and the log: unknown before the first sample. */
  get state(): Health | undefined { return this.health; }

  private sample(ok: boolean, what: string, list: boolean): Promise<void> {
    const next = this.chain.then(async () => {
      this.health ??= await this.adopt();
      if (this.health === "healthy" && !ok) { this.health = "unhealthy"; await this.pause(what); }
      else if (this.health === "unhealthy" && ok && list) { this.health = "healthy"; await this.resume(); }
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
    this.input.log?.(`daemon gate: unhealthy (${what}); paused the check-in of ${paused.length} chats: ${paused.join(", ") || "none"}`);
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
    this.input.log?.(`daemon gate: healthy (a list answered); resumed the check-in of ${resumed.length} chats, ` +
      `staggered over their interval: ${resumed.join(", ") || "none"}`);
  }
}
