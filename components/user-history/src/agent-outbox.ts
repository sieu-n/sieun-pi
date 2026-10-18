import { randomUUID } from "node:crypto";
import { Outbox, type Stored } from "./outbox.ts";
import { isSendTimeout, landedAt, QUEUED_PREFIX, sendKey, type TargetState } from "./send-once.ts";
import { relayNote, stoppedSubagent } from "./subagent-relay.ts";

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
  log: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The daemon knows no such target, its root did not bring it back, and it is no stopped subagent to reach through its parent. */
class Gone extends Error {}

export class AgentOutbox {
  readonly outbox: Outbox;

  constructor(dir: string, private readonly deps: AgentOutboxDeps) {
    this.outbox = new Outbox({ dir, log: deps.log, ...deps.sleep ? { sleep: deps.sleep } : {}, ...deps.now ? { now: deps.now } : {},
      deliver: async (entry, sending) => {
        const session = entry.threadId;
        await sending();
        if (await deps.send(session, entry.text) === "sent") return;
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
