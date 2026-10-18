import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PeerReach } from "./host-reach.ts";
import { type AgentKind, MAX_BACKOFF_MS, type Obsolete, Outbox, type Stored } from "./outbox.ts";
import { isSendTimeout, messageAt, QUEUED_PREFIX, sendKey, type TargetState } from "./send-once.ts";
import { relayNote, stoppedSubagent } from "./subagent-relay.ts";
import { moveOf } from "./worker-move.ts";

/*
 * Every agent message the service sends (wakes, spawn briefs, alerts, the bridge watchdog) waits on disk here until the daemon takes it, so
 * the callers move on at once and a slow or restarting daemon never drops or doubles one. The daemon gives a target's worker 30 s to
 * confirm a send_message and then raises, but the worker still delivers it when it is free (p334): 10-16 one board.wake reached a job 3
 * times and one Grafana alert reached its owner 11 times. So a send that timed out is looked for (landed in the target's file, or queued in
 * its worker) before it goes again, and while the target is busy and the copy is in neither place, it is not sent again.
 *
 * A message that waited is dropped only on proof that it is needless, and is then kept on disk as "obsolete" with the proof and one log line.
 * The proofs are the same text in the target's file since it was queued, a wake for the same run or set time in that file since it was queued,
 * the cleanup's delete of the target job, the owner's archive of the target chat for a wake or a retry (an archived chat still answers a new
 * message, `Chats.archive`), and a newer report with the same replaceable key (`[replaceable: <key>]`, which its sender sets on purpose)
 * waiting behind it for the same target. Its age, a later message of another kind, or a turn the target ended since never drops one, and every
 * other message goes in order, headed with its age once it waited (`agedText`). The sender names the kind when it queues (`AgentKind`).
 * On 10-18 the Mac was offline from about 13:10Z to 19:42Z, and its return sent 221 held messages 1.7 h to 7.4 h after they were queued,
 * among them a 13:20Z time wake to 01a14b8d-c276, which the owner had archived at 07:22Z.
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
  /** The record that stopped the target (`stopRecords`), or null. */
  stopped?: (session: string, file: string | null) => Promise<Stop | null>;
  /**
   * Opens a target that has no worker from its file (`reopenSession`); true when it opened one. The daemon can leave get_state and send_message
   * for such a root unanswered: on us-metal02 on 10-18 the 22:15Z wakes to "metal box owner" (01a11d24) timed out, every get_state of it hung
   * after that, and its lane held every later send for an hour, while a daemon create opened it in 1.6 s at 23:18Z and a send then went at once.
   */
  open?: (session: string) => Promise<boolean>;
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

/** The counts a pending-limit refusal names ("Target session has too many pending messages: 21 unfinished, limit is 20"). */
export function pendingCounts(error: unknown): { pending: number; limit: number } | undefined {
  const found = /too many pending messages: (\d+) unfinished, limit is (\d+)/.exec(error instanceof Error ? error.message : String(error));
  return found ? { pending: Number(found[1]), limit: Number(found[2]) } : undefined;
}

/** The pending message limit of prime-agent 0.9.8's send_message, which every refusal on 10-18 named; the target when a queued send names none. */
export const DAEMON_PENDING_LIMIT = 20;

/**
 * An agent_message.send the daemon refused for the target's pending message limit, which the sender's kernel hands to the outbox instead of
 * raising (message-limit-check.py, owner c98: a limit is a target, never a refusal).
 */
export interface QueuedSend {
  session: string;
  text: string;
  /** The sender, whom the delivered text names, since the daemon heads a message from the chat service with the service's client id only. */
  from: { id: string; name: string };
  /** The receiver_role the sender used. */
  role: "child" | "parent" | "sibling";
  /** The refusal's counts; absent for a send that only follows an earlier queued one (`behind`). */
  pending?: number;
  limit?: number;
  /** Queue it only while an earlier message to the session still waits here, so the sender's messages keep their order; else "clear". */
  behind?: boolean;
  root?: string;
}

export interface QueuedReceipt {
  deliveryStatus: "queued" | "clear";
  id?: string;
  /** The target's unfinished messages when the send came, when known. */
  pending?: number;
  target: number;
  /** Messages to the session that wait here ahead of this one. */
  ahead: number;
}

/** The delivered text: who sent it and how to answer, then the message. */
export function queuedText(from: QueuedSend["from"], role: QueuedSend["role"], text: string): string {
  const who = role === "child" ? "your parent" : role === "parent" ? "your job" : "sibling";
  const answer = role === "child" ? 'receiver_role="parent"' : `receiver_role="${role === "parent" ? "child" : "sibling"}", receiver_name=${JSON.stringify(from.id)}`;
  return `[message from ${who} ${from.name} (${from.id}), held in the chat service's outbox while this session's queue was full; answer with ` +
    `agent_message.send(text, ${answer})]\n\n${text}`;
}

/** The opener a sender puts on its own line in a report that a newer report with the same key replaces, such as a check-in's report. */
export const replaceableLine = (key: string): string => `[replaceable: ${key}]`;

/** The key of a replaceable report (`replaceableLine`) anywhere in the text's headers, else undefined. */
export function replaceableKey(text: string): string | undefined {
  return /^\[replaceable: ([^\]\n]+)\]$/m.exec(text)?.[1];
}

/** What a wake is about, its run id or the time it was set for; two wakes with one identity are the same wake. */
export function wakeOf(text: string): string | undefined {
  const found = /^\[wake\] (?:Run (\d+)\b|It is [^,\n]+, the time you set with board\.wake \(([^)\n]+)\))/.exec(text);
  return found?.[1] ? `run ${found[1]}` : found?.[2] ? `time ${found[2]}` : undefined;
}

const AGED = /^\[queued [^\]\n]* ago at [^\]\n]*\]\n\n/;
const clock = (at: number, now: number): string => {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? "" : iso.slice(5, 10) + " "}${iso.slice(11, 16)}Z`;
};
const ago = (ms: number): string => ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${(ms / 3_600_000).toFixed(1)} h`;

/**
 * The text as it goes: a message queued at `at` that waited past the longest wait between two tries opens with its age and queue time, like
 * "[queued 4.8 h ago at 13:13Z; ...]", so the target reads it as old news. One that went at once goes as it is.
 */
export function agedText(text: string, at: number, now: number): string {
  if (now - at < MAX_BACKOFF_MS) return text;
  return `[queued ${ago(now - at)} ago at ${clock(at, now)}; the chat service's outbox held it until the target could take it]\n\n${text}`;
}

/** The text without the age header `agedText` put on it. */
export const unaged = (text: string): string => text.replace(AGED, "");

/** A record that stopped the target: a deleted job takes nothing more, and an archived chat takes only a message (`AgentKind`). */
export interface Stop { record: "delete" | "archive"; reason: string }

/**
 * The records that stop a target: `deleted-jobs.json` lists the jobs the cleanup deleted, by root and job folder
 * (`session-artifacts/<root>/<job>/<session>.jsonl`), and `archived-chats.json` the chats the owner archived.
 */
export function stopRecords(dataDir: string): (session: string, file: string | null) => Promise<Stop | null> {
  const read = async (name: string): Promise<unknown> => JSON.parse(await readFile(join(dataDir, name), "utf8").catch(() => "null"));
  return async (session, file) => {
    const job = file ? /\/session-artifacts\/([0-9a-f-]{36})\/([^/]+)\/[^/]+\.jsonl$/.exec(file) : null;
    const deleted = job ? (await read("deleted-jobs.json") as Record<string, Record<string, unknown>> | null)?.[job[1]!]?.[job[2]!] : undefined;
    if (typeof deleted === "number") return { record: "delete", reason: `the cleanup deleted the target job ${job![2]} at ${new Date(deleted).toISOString()}` };
    const archived = await read("archived-chats.json") as { ids?: unknown } | null;
    return Array.isArray(archived?.ids) && archived.ids.includes(session) ? { record: "archive", reason: "the owner archived the target chat" } : null;
  };
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
        const proof = await this.obsolete(entry);
        if (proof) return proof;
        const text = agedText(entry.text, entry.at, this.now());
        if (await this.inTree(session, async () => { await sending(); return this.send(session, entry.id, text); }) === "sent") return;
        // A stopped subagent is reached through its parent's rlm handle, and a parent that is gone too through its own parent.
        const file = await deps.fileOf(session).catch(() => null);
        const child = file ? await stoppedSubagent(file) : null;
        if (child) {
          await this.deliver(child.parents[0]!, relayNote(child, text), entry.root);
          deps.log(`relay: ${session.slice(0, 8)} (${child.name}) is stopped; its message goes through its parent ${child.parents[0]!.slice(0, 8)}`);
          return;
        }
        if (entry.root && deps.startRoot) {
          await deps.startRoot(entry.root);
          await sending();
          if (await deps.send(session, text) === "sent") return;
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
      // A pending-limit refusal is a wait like Full: send() logs it once with its counts, and the Whole system precheck reads that line as detail.
      quiet: error => error instanceof Full || error instanceof Moving || pendingCounts(error) !== undefined,
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
   * `kind` says what the sender meant it as (`AgentKind`).
   */
  async deliver(session: string, text: string, root?: string, kind: AgentKind = "message"): Promise<void> {
    await this.keep(session, text, root, kind);
  }

  /** `deliver`, answering the id of the entry that holds the message. */
  private async keep(session: string, text: string, root?: string, kind: AgentKind = "message"): Promise<string> {
    const key = sendKey(session, text);
    const held = await this.outbox.pending(entry => sendKey(entry.threadId, entry.text) === key);
    if (held) return held.id;
    const id = `m-${randomUUID()}`;
    await this.outbox.submit({ id, threadId: session, text, images: [], mode: "steer", fingerprint: key, kind, ...root ? { root } : {} });
    return id;
  }

  /**
   * Keeps a send the daemon refused for its pending limit (`QueuedSend`) and delivers it once the target has room, after the messages to it that
   * wait here already. The target is marked full first, so the outbox reads get_state for room before it sends and gets no second refusal.
   */
  async queue(send: QueuedSend): Promise<QueuedReceipt> {
    const ahead = (await this.outbox.waiting(send.session)).length;
    const limit = send.limit ?? this.full.get(send.session) ?? DAEMON_PENDING_LIMIT;
    if (send.behind && !ahead) return { deliveryStatus: "clear", target: limit, ahead };
    if (send.pending !== undefined) this.full.set(send.session, limit);
    const pending = send.pending ?? (await this.deps.target(send.session).catch(() => null))?.unfinished;
    const id = await this.keep(send.session, queuedText(send.from, send.role, send.text), send.root);
    this.deps.log(`outbox ${this.where(send.session)}: queued ${id} from ${send.from.name} (${send.from.id.slice(0, 8)}) while the target held ` +
      `${pending ?? "an unknown number of"} of ${limit} pending, ${ahead} ahead of it here`);
    return { deliveryStatus: "queued", id, ...pending === undefined ? {} : { pending }, target: limit, ahead };
  }

  /** The proof that the entry need not go (see the rule at the top of this file), or undefined when it goes. */
  private async obsolete(entry: Stored): Promise<Obsolete | undefined> {
    const session = entry.threadId;
    const file = await this.deps.fileOf(session).catch(() => null);
    const stop = await this.deps.stopped?.(session, file).catch(() => null);
    const kind = entry.kind ?? "message";
    if (stop && (stop.record === "delete" || kind !== "message")) return { obsolete: stop.record === "delete" ? stop.reason : `${stop.reason}, and it is a ${kind}` };
    const key = replaceableKey(entry.text);
    const newer = key === undefined ? undefined : (await this.outbox.waiting(session)).find(other => other.at > entry.at && replaceableKey(other.text) === key);
    if (newer) return { obsolete: `the newer report ${newer.id} with the replaceable key "${key}" waits behind it` };
    if (!file) return undefined;
    const text = entry.text.trim();
    const wake = wakeOf(text);
    const landed = await messageAt(file, entry.at, other => { const sent = unaged(other).trim(); return sent === text || (wake !== undefined && wakeOf(sent) === wake); })
      .catch(() => null);
    if (landed === null) return undefined;
    return { obsolete: `${wake ? `a wake for the same ${wake}` : "the same message"} landed in the target's file at ${new Date(landed).toISOString()}, after it was queued` };
  }

  private async send(session: string, id: string, text: string): Promise<"sent" | "gone"> {
    let sent: "sent" | "gone";
    try { sent = await this.deps.send(session, text); } catch (error) {
      const doing = moveOf(error);
      if (doing) {
        if (!this.moving.has(session)) {
          this.moving.set(session, { doing, since: this.now() });
          this.deps.log(`outbox ${this.where(session)}: the target's worker is ${doing}; ${id} and the sends after it wait until get_state reads it`);
        }
        throw new Moving(error instanceof Error ? error.message : String(error));
      }
      const counts = pendingCounts(error);
      if (counts && !this.full.has(session)) {
        this.full.set(session, counts.limit);
        this.deps.log(`outbox ${this.where(session)}: the target is full at ${counts.pending} of ${counts.limit} pending; ${id} and the sends after it wait until it holds fewer`);
      }
      throw error;
    }
    const moved = this.moving.get(session);
    if (moved) {
      this.moving.delete(session);
      if (sent === "sent") this.deps.log(`outbox ${this.where(session)}: ${id} went after its target's worker was ${moved.doing} for ${Math.round((this.now() - moved.since) / 1000)} s`);
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
    const sent = (other: string) => unaged(other).trim() === entry.text.trim();
    if (file && await messageAt(file, since, sent)) return "landed";
    let target = await this.deps.target(session).catch(() => null);
    if (target === null && await this.deps.open?.(session).catch(() => false)) {
      this.deps.log(`outbox ${this.where(session)}: get_state did not answer for ${entry.id}, and the target had no worker; opened it from its file`);
      target = await this.deps.target(session).catch(() => null);
    }
    if (target === null) return "unknown";
    if (target.queued.some(item => item === entry.text || item === QUEUED_PREFIX + entry.text || item.includes(entry.text))) return "queued";
    // The worker may have written it between the file read and the queue read.
    if (file && await messageAt(file, since, sent)) return "landed";
    // On 10-16 at 10:16Z and 22:53Z such a copy was still with the supervisor after a run of timeouts, and a resend made 4 extra wake copies.
    return target.busy ? "busy" : "absent";
  }

  /** Stops delivery and waits for the sends out now, which take at most the daemon's 30 s send_message timeout. */
  close(): Promise<void> { return this.outbox.close(true); }
}
