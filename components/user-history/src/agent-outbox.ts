import { randomUUID } from "node:crypto";
import type { PeerReach } from "./host-reach.ts";
import { Outbox, type Stored } from "./outbox.ts";
import { isSendTimeout, landedAt, QUEUED_PREFIX, sendKey, type TargetState } from "./send-once.ts";
import { relayNote, stoppedSubagent } from "./subagent-relay.ts";
import { moveOf } from "./worker-move.ts";

/*
 * Every agent message the service sends (wakes, spawn briefs, alerts, the bridge watchdog) waits on disk here until the daemon takes it, so
 * the callers move on at once and a slow or restarting daemon never drops or doubles one. The daemon gives a target's worker 30 s to
 * confirm a send_message and then raises, but the worker still delivers it when it is free (p334): 10-16 one board.wake reached a job 3
 * times and one Grafana alert reached its owner 11 times. So a send that timed out is looked for (landed in the target's file, or queued in
 * its worker) before it goes again, and while the target is busy and the copy is in neither place, it is not sent again.
 */

export interface AgentOutboxDeps {
  /** One send_message; "gone" when the daemon knows no such session, even after a reopen from its file. Throws on any other failure. */
  send: (session: string, text: string) => Promise<"sent" | "gone">;
  /** The target's worker: its queued texts and whether it is busy; idle and empty when it has no worker, null when the daemon did not answer. */
  target: (session: string) => Promise<TargetState | null>;
  /** The target's session file, or null. */
  fileOf: (session: string) => Promise<string | null>;
  /** Starts a tree's root from its file, for a target the daemon does not find. */
  startRoot?: (root: string) => Promise<void>;
  /** The box that runs the session, null for this box; the outbox lines name another box, so the Whole system precheck books them there. */
  hostOf?: (session: string) => string | null;
  /** Whether that box is up (src/host-reach.ts); a message to a session on a box that reads offline waits with no try until it is back. */
  reach?: (host: string) => Promise<PeerReach>;
  log: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The daemon knows no such target, its root did not bring it back, and it is no stopped subagent to reach through its parent. */
class Gone extends Error {}

/** The target still holds as many unfinished messages as the daemon takes, so nothing was sent. */
class Full extends Error {}

/** The target's worker is stopping or starting, so nothing was sent. */
class Moving extends Error {}

/** The daemon's pending message limit a refusal names ("Target session has too many pending messages: 20 unfinished, limit is 20"). */
export function pendingLimit(error: unknown): number | undefined {
  const found = /too many pending messages: \d+ unfinished, limit is (\d+)/.exec(error instanceof Error ? error.message : String(error));
  return found ? Number(found[1]) : undefined;
}

/** The root of a subagent's tree from its session file (`session-artifacts/<root>/...`); undefined for a root's own file. */
export function treeOf(file: string | null): string | undefined {
  return file ? /\/session-artifacts\/([0-9a-f-]{36})\//.exec(file)?.[1] : undefined;
}

export class AgentOutbox {
  readonly outbox: Outbox;
  /**
   * Targets whose last send the daemon refused for its pending message limit, with that limit. 10-18 Mac chat 01a0cc5e ("Untitled") held 19
   * queued messages behind a turn that waited 3.2 h on a 429's retry-after, and the outbox sent again every 30 s from 11:15Z, 52 refusals that
   * made each minute of the Whole system precheck dirty. Such a target's next send waits until get_state reads room.
   */
  private readonly full = new Map<string, number>();
  /** Targets whose worker was stopping or starting at the last send, with what it was doing and since when; their sends wait on get_state. */
  private readonly moving = new Map<string, { doing: string; since: number }>();

  /**
   * The send under way into each session tree, by its root. A tree's sessions share one worker, which took the 18 wakes of CI run 39124631211
   * that went into the Crawler VP tree at 12:18:05Z on 10-18 one after another while us-metal02 read 59% cpu some: 7 landed from 12:18:06Z
   * to 12:18:38Z, and the 11 still waiting at 12:18:35Z each timed out at the daemon's 30 s and counted as a fault. One send into a tree at a
   * time asks the worker for what it does anyway, so each call waits only for its own target.
   */
  private readonly trees = new Map<string, Promise<unknown>>();

  private readonly now: () => number;

  constructor(dir: string, private readonly deps: AgentOutboxDeps) {
    this.now = deps.now ?? Date.now;
    this.outbox = new Outbox({ dir, log: deps.log, where: session => this.where(session), ...deps.sleep ? { sleep: deps.sleep } : {}, ...deps.now ? { now: deps.now } : {},
      deliver: async (entry, sending) => {
        const session = entry.threadId;
        await this.room(session, entry.id);
        if (await this.inTree(session, async () => { await sending(); return this.send(session, entry); }) === "sent") return;
        // A stopped subagent is reached through its parent's rlm handle, and a parent that is gone too through its own parent.
        const file = await deps.fileOf(session).catch(() => null);
        const child = file ? await stoppedSubagent(file) : null;
        if (child) {
          await this.deliver(child.parents[0]!, relayNote(child, entry.text), entry.root);
          deps.log(`relay: ${session.slice(0, 8)} (${child.name}) is stopped; its message goes through its parent ${child.parents[0]!.slice(0, 8)}`);
          return;
        }
        if (entry.root && deps.startRoot) {
          await deps.startRoot(entry.root);
          await sending();
          if (await deps.send(session, entry.text) === "sent") return;
        }
        deps.log(`messages: ${session.slice(0, 8)} is not a session the daemon has or can reopen; message ${entry.id} dropped`);
        throw new Gone("The daemon has no such session.");
      },
      copy: async (entry, since) => {
        const state = await this.copyState(entry, since);
        return state === "busy" ? "unknown" : state;
      },
      final: error => error instanceof Gone ? error.message : null,
      uncertain: isSendTimeout,
      quiet: error => error instanceof Full || error instanceof Moving,
      held: async entry => {
        const host = deps.reach && deps.hostOf?.(entry.threadId);
        return !!host && !(await deps.reach!(host)).online;
      },
      changed: () => {},
    });
  }

  /**
   * Keeps `text` for `session` on disk and sends it in the background; resolves once it is on disk. A copy of a message still waiting for the
   * same target, with only its ISO times changed (`sendKey`), is the same message. `root` is started when the daemon does not find the target.
   */
  async deliver(session: string, text: string, root?: string): Promise<void> {
    const key = sendKey(session, text);
    if (await this.outbox.pending(entry => sendKey(entry.threadId, entry.text) === key)) return;
    await this.outbox.submit({ id: `m-${randomUUID()}`, threadId: session, text, images: [], mode: "steer", fingerprint: key, ...root ? { root } : {} });
  }

  private async send(session: string, entry: Stored): Promise<"sent" | "gone"> {
    let sent: "sent" | "gone";
    try { sent = await this.deps.send(session, entry.text); } catch (error) {
      const doing = moveOf(error);
      if (doing) {
        if (!this.moving.has(session)) {
          this.moving.set(session, { doing, since: this.now() });
          this.deps.log(`outbox ${this.where(session)}: the target's worker is ${doing}; ${entry.id} and the sends after it wait until get_state reads it`);
        }
        throw new Moving(error instanceof Error ? error.message : String(error));
      }
      const limit = pendingLimit(error);
      if (limit !== undefined && !this.full.has(session)) {
        this.full.set(session, limit);
        this.deps.log(`outbox ${this.where(session)}: the target is full; ${entry.id} and the sends after it wait until it holds fewer than ${limit} unfinished messages`);
      }
      throw error;
    }
    const moved = this.moving.get(session);
    if (moved) {
      this.moving.delete(session);
      if (sent === "sent") this.deps.log(`outbox ${this.where(session)}: ${entry.id} went after its target's worker was ${moved.doing} for ${Math.round((this.now() - moved.since) / 1000)} s`);
    }
    return sent;
  }

  /** `act` once the send before it into the same tree (`treeOf`) ended. */
  private async inTree<T>(session: string, act: () => Promise<T>): Promise<T> {
    const tree = treeOf(await this.deps.fileOf(session).catch(() => null)) ?? session;
    const run = (this.trees.get(tree) ?? Promise.resolve()).then(act);
    const done = run.then(() => {}, () => {});
    this.trees.set(tree, done);
    void done.then(() => { if (this.trees.get(tree) === done) this.trees.delete(tree); });
    return run;
  }

  /** The session's short id, and the box that runs it when that is another box. */
  private where(session: string): string {
    const host = this.deps.hostOf?.(session) ?? null;
    return `${session.slice(0, 8)}${host ? ` on ${host}` : ""}`;
  }

  /** Throws Full while a target the daemon refused as full still reads as full, or does not answer; a target with no worker has room. */
  private async room(session: string, id: string): Promise<void> {
    // The daemon refuses get_state too while the worker moves; a target that reads running or gone takes the send.
    if (this.moving.has(session) && await this.deps.target(session).catch(() => null) === null) throw new Moving(`the target's worker is still ${this.moving.get(session)!.doing}`);
    const limit = this.full.get(session);
    if (limit === undefined) return;
    const target = await this.deps.target(session).catch(() => null);
    const unfinished = target === null ? undefined : target.unfinished ?? 0;
    if (unfinished === undefined || unfinished >= limit) throw new Full(`the target holds ${unfinished ?? "an unknown number of"} unfinished messages, limit ${limit}`);
    this.full.delete(session);
    this.deps.log(`outbox ${this.where(session)}: the target has room, ${unfinished} of ${limit} unfinished; sending ${id}`);
  }

  /** Where a copy that may have gone is: in the target's file, in its worker's queue, held while the target is busy, in neither, or unknown. */
  private async copyState(entry: Stored, since: number): Promise<"landed" | "queued" | "busy" | "absent" | "unknown"> {
    const session = entry.threadId;
    const file = await this.deps.fileOf(session).catch(() => null);
    if (file && await landedAt(file, [entry.text], since)) return "landed";
    const target = await this.deps.target(session).catch(() => null);
    if (target === null) return "unknown";
    if (target.queued.some(item => item === entry.text || item === QUEUED_PREFIX + entry.text || item.includes(entry.text))) return "queued";
    // The worker may have written it between the file read and the queue read.
    if (file && await landedAt(file, [entry.text], since)) return "landed";
    // On 10-16 at 10:16Z and 22:53Z such a copy was still with the supervisor after a run of timeouts, and a resend made 4 extra wake copies.
    return target.busy ? "busy" : "absent";
  }

  /** Stops delivery and waits for the sends out now, which take at most the daemon's 30 s send_message timeout. */
  close(): Promise<void> { return this.outbox.close(true); }
}
