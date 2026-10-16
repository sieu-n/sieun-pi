import { readFile, rename, writeFile } from "node:fs/promises";
import type { FleetAsk, FleetDone } from "./fleet-budget.ts";
import type { AgentQueueReading } from "./shared/types.ts";

/**
 * Parking a root job whose turn only waits in pi-pool's queue. Prime counts a session whose turn waits in pi-pool's admit hook as running, so it
 * never evicts its worker, and the daemon has no command to unload one session (wiki memory mac_usable_idle_passivated_queued_roots_20261015).
 * At 20:03Z on 10-15, with the fleet budget shut since 19:23Z, 33 workers held 21.2 GB while pi-pool ran 14 turns: 36 of the 38 trees with a
 * queued turn had none working, and 31 of them were one root session alone, each holding a worker for nothing but its place in the queue. That
 * hour 8 of 48 watch minutes were unusable, all with the workers over 16 GB. A parked job's turn is aborted, which drops its queue entry
 * (pi-pool's admit wait releases on Stop), and then its worker is stopped at once (`unload`), not by Prime's idle sweep: at 06:0x KST on 10-16
 * parked jobs still held their workers 47 and 53 min after their last message, since a sweep ends at the first worker that "did not stop" (99
 * such sweeps on 10-15 in daemon.sock.bab13329.log). It gets "continue" through the fleet budget once pi-pool has a free slot for it.
 */

/** A queued turn is parked once it waited this long: past pi-pool's 120 s ticket renew poll, so a turn about to be admitted is left alone. */
export const PARK_AFTER_S = 120;
/**
 * A parked job goes back against the lowest limit pi-pool's governor gave in this window, and at most UNPARK_PER_TICK per pass. The governor
 * reads pressure every 30 s and its limit swings: at 09:25-09:27 KST on 10-16 it read 16, 30, 12 and 30 within 2 min, the park resumed 14 jobs
 * on one reading of 30 (22 queued for 16 slots right after) and parked them again as the limit fell to 12, loading and unloading their workers.
 */
export const UNPARK_SETTLE_MS = 5 * 60_000;
export const UNPARK_PER_TICK = 2;

/** The lowest limit seen within UNPARK_SETTLE_MS, with `limit` added at `now`; `seen` is pruned in place. */
export function settledLimit(seen: { at: number; limit: number }[], limit: number, now: number): number {
  seen.push({ at: now, limit });
  while (seen.length && now - seen[0]!.at > UNPARK_SETTLE_MS) seen.shift();
  return Math.min(...seen.map(entry => entry.limit));
}

const limitsSeen: { at: number; limit: number }[] = [];

export const PARK_CONTINUE = "[queue] Your turn waited for a working slot, so the chat service parked it to unload your worker. A slot is free now; continue where you left off.";

export interface QueueEntry { session: string; tree: string; parent: string | null; class: string; position: number; waitS: number }
export interface QueueView { working: readonly { session: string; tree: string }[]; queued: readonly QueueEntry[]; limit: number }
export interface Parked { session: string; at: number; position: number; resumedAt?: number }

/** A Prime session id; a duty run's key (`duty:<chat>:<duty>`) waits in the queue with no session to abort. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-/;

/** Classes that never wait in the queue, so a session of theirs is never parked. */
const NEVER = new Set(["owner", "prod", "ahead", "checkin"]);

/**
 * What to park, what to let go, and which list entries are done. A queued turn parks when its session is a root alone in its tree (no
 * subagent waits or works under it), not a chat, not an owner, prod or check-in turn, it waited PARK_AFTER_S, and more turns wait ahead of it
 * than pi-pool runs at once. A parked session goes back, oldest first, once fewer turns that asked before it parked still wait than pi-pool's
 * limit, so it keeps its place: with "fewer than the limit wait at all", 14 jobs parked from 20:08Z to 20:57Z on 10-15 and none went back,
 * because 19 to 41 turns waited for 12 slots the whole hour. A resumed session is not parked again while its resumed turn waits, and an entry
 * ends once its session works, or, resumed, has left the queue; a parked session that something else woke (it works or waits again) is dropped.
 */
export function parkPlan(view: QueueView, parked: readonly Parked[], chats: ReadonlySet<string>, now: number, settled = view.limit): { park: QueueEntry[]; unpark: Parked[]; drop: Parked[] } {
  const working = new Set(view.working.map(entry => entry.tree));
  const workingSessions = new Set(view.working.map(entry => entry.session));
  const queuedSessions = new Set(view.queued.map(entry => entry.session));
  const perTree = new Map<string, number>();
  for (const entry of view.queued) perTree.set(entry.tree, (perTree.get(entry.tree) ?? 0) + 1);
  const drop = parked.filter(entry => workingSessions.has(entry.session) || (entry.resumedAt === undefined ? queuedSessions.has(entry.session) : !queuedSessions.has(entry.session)));
  const known = new Set(parked.map(entry => entry.session));
  const park = view.queued.filter(entry => SESSION_ID.test(entry.session) && entry.parent === null && entry.tree === entry.session && !working.has(entry.tree) && perTree.get(entry.tree) === 1 &&
    !chats.has(entry.session) && !NEVER.has(entry.class) && entry.waitS >= PARK_AFTER_S && entry.position > view.limit && !known.has(entry.session));
  const waiting = parked.filter(entry => entry.resumedAt === undefined && !drop.includes(entry)).sort((a, b) => a.at - b.at);
  const unpark: Parked[] = [];
  for (const entry of waiting) {
    const ahead = view.queued.filter(queued => !park.includes(queued) && now - queued.waitS * 1000 < entry.at).length;
    if (ahead + unpark.length >= settled || unpark.length >= UNPARK_PER_TICK) break;
    unpark.push(entry);
  }
  return { park, unpark, drop };
}

export interface ParkDeps {
  file: string;
  queue: () => Promise<QueueView | null>;
  chats: () => Promise<ReadonlySet<string>>;
  /** Aborts the session's turn without attaching a client (an attached client keeps the worker from Prime's idle sweep). */
  abort: (session: string) => Promise<void>;
  /** Stops the session's worker without archiving it; the session stays listed and loads again on its next message. */
  unload: (session: string) => Promise<void>;
  /** Starts the parked session's turn again with `text`. */
  resume: (session: string, text: string) => Promise<void>;
  /** A parked job takes a place in the fleet budget's line (`FleetBudget.place`); `tryAdmit` refuses while any start waits. */
  fleet: { place(ask: FleetAsk): Promise<FleetDone | null> };
  log: (line: string) => void;
  now?: () => number;
  /** The governor limits seen (`settledLimit`); the module's own list when absent. */
  limitsSeen?: { at: number; limit: number }[];
}

/** One pass: park the turns `parkPlan` names, then let parked ones go through the fleet budget while it is open. The list survives restarts. */
export async function parkTick(deps: ParkDeps): Promise<{ parked: number; resumed: number }> {
  const now = deps.now ?? Date.now;
  const view = await deps.queue().catch(() => null);
  if (!view) return { parked: 0, resumed: 0 };
  let list = await readParked(deps.file);
  const { park, unpark, drop } = parkPlan(view, list, await deps.chats(), now(), settledLimit(deps.limitsSeen ?? limitsSeen, view.limit, now()));
  list = list.filter(entry => !drop.includes(entry));
  let parked = 0, resumed = 0;
  for (const entry of park) {
    try { await deps.abort(entry.session); list.push({ session: entry.session, at: now(), position: entry.position }); parked++; }
    catch (error) { deps.log(`queue park: ${entry.session.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`); continue; }
    await deps.unload(entry.session).catch(error => deps.log(`queue park: unload ${entry.session.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`));
  }
  for (const entry of unpark) {
    const done = await deps.fleet.place({ kind: "continue", label: entry.session });
    if (!done) continue;
    try { await deps.resume(entry.session, PARK_CONTINUE); done(entry.session); resumed++; entry.resumedAt = now(); }
    catch (error) { done(); deps.log(`queue park: resume ${entry.session.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (parked || resumed || drop.length) {
    const held = list.filter(entry => entry.resumedAt === undefined).length;
    deps.log(`queue park: parked ${parked}, resumed ${resumed}, done ${drop.length}; ${held} parked, ${view.queued.length - parked} queued for ${view.limit} slots`);
    await writeParked(deps.file, list);
  }
  return { parked, resumed };
}

async function readParked(file: string): Promise<Parked[]> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(value) ? value.filter((entry): entry is Parked => typeof entry?.session === "string" && typeof entry?.at === "number") : [];
  } catch { return []; }
}

async function writeParked(file: string, list: readonly Parked[]): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(list)).then(() => rename(temp, file));
}

/** The chat service's pi-pool queue reading as the view `parkPlan` reads; the limit is the governor's, else mac_working_max. */
export function queueView(reading: AgentQueueReading | null): QueueView | null {
  if (!reading?.enabled) return null;
  const limit = reading.governor?.limit ?? reading.macWorkingMax;
  return { working: reading.working, queued: reading.queued.map(entry => ({ session: entry.session, tree: entry.tree, parent: entry.parent, class: entry.priority,
    position: entry.position, waitS: Math.round(entry.waitMs / 1000) })), limit };
}
