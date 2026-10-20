import type { SessionSummary } from "prime-agent";
import { nativeStatus } from "./chat-catalog.ts";
import type { TargetState } from "./send-once.ts";
import { type Wake, wakeLabel } from "./wakes.ts";

/** Where `treeWait` reads a duty job's tree. */
export interface JobTree {
  /** The job's root and every session below it as the daemon lists them now (`Catalog.tree`); empty when the root is not listed. */
  sessions: (id: string) => readonly SessionSummary[];
  /** A live session's queued input and whether its worker is busy (the outbox's get_state read); null when the daemon did not answer. */
  queue: (session: string) => Promise<TargetState | null>;
  /** An agent message the service's outbox still holds for one of `sessions` (a relay, a wake, a report), or undefined. */
  relay: (sessions: ReadonlySet<string>) => Promise<{ id: string; threadId: string } | undefined>;
  /** The board.wakes the service still owes (`pendingWakes`). */
  wakes: () => Promise<readonly Wake[]>;
}

/**
 * Why a listed session still has work coming by its own row, or null: its worker starts or recovers, the daemon lists it queued or recovering,
 * its turn runs, or an action waits in it. An archived session has none.
 */
export function sessionWait(row: SessionSummary): string | null {
  if (row.lifecycle === "archived") return null;
  if (row.workerState === "starting" || row.workerState === "recovering") return `is ${row.workerState}`;
  if (row.statusLabel === "queued" || row.statusLabel === "recovering") return `reads ${row.statusLabel}`;
  if (row.activeSessionId === undefined) return null;
  if (nativeStatus(row) === "running") return "runs";
  if ((row.unfinishedActionCount ?? 0) > 0 || (row.sessionActions?.queuedCount ?? 0) > 0) return "has queued input";
  return null;
}

/**
 * What still waits on a duty job's tree, or null when nothing does: a session of it that starts, recovers, sits queued or runs
 * (`sessionWait`), an agent message the outbox holds for one of them, a board.wake one of them set, or input queued in a live one's worker.
 * The root's own row can read idle meanwhile, as the restored roots of update ctl-847650 did on 10-20 while their subagents were still to come
 * back. An archive of such a root only comes undone: at 06:46:06Z on 10-20 the runner archived owner corrections 06:46 while its subagents
 * repeat c79 and repeat c129 slept on wakes, and a relay to repeat c72 reopened it through its parent 26 s later.
 */
export async function treeWait(id: string, tree: JobTree): Promise<string | null> {
  const sessions = tree.sessions(id);
  const who = (row: SessionSummary) => row.sessionId === id ? "its root" : `its subagent ${row.sessionName?.trim() || row.sessionId.slice(0, 8)}`;
  for (const row of sessions) {
    const wait = sessionWait(row);
    if (wait) return `${who(row)} ${wait}`;
  }
  const ids = new Set([id, ...sessions.map(row => row.sessionId)]);
  const relay = await tree.relay(ids);
  const named = (session: string) => { const row = sessions.find(entry => entry.sessionId === session); return row ? who(row) : session.slice(0, 8); };
  if (relay) return `agent message ${relay.id} waits in the outbox for ${named(relay.threadId)}`;
  const owed = (await tree.wakes()).filter(wake => ids.has(wake.session));
  if (owed.length) return `${named(owed[0]!.session)} waits on ${wakeLabel(owed.filter(wake => wake.session === owed[0]!.session))}`;
  for (const row of sessions) {
    if (row.activeSessionId === undefined || row.lifecycle === "archived") continue;
    const queue = await tree.queue(row.sessionId);
    if (!queue) return `the worker queue of ${who(row)} did not read`;
    if (queue.queued.length) return `${who(row)} has ${queue.queued.length} queued input${queue.queued.length === 1 ? "" : "s"}`;
    if (queue.busy) return `${who(row)} is busy`;
  }
  return null;
}
