import { readFile, rename, writeFile } from "node:fs/promises";
import type { FleetAsk, FleetDone } from "./fleet-budget.ts";
import type { AgentQueueReading } from "./shared/types.ts";

/**
 * Parking a root job whose turn only waits in pi-pool's queue. Prime counts a session whose turn waits in pi-pool's admit hook as running, so it
 * never evicts its worker, and the daemon has no command to unload one session (wiki memory mac_usable_idle_passivated_queued_roots_20261015).
 * At 20:03Z on 10-15, with the fleet budget shut since 19:23Z, 33 workers held 21.2 GB while pi-pool ran 14 turns: 36 of the 38 trees with a
 * queued turn had none working, and 31 of them were one root session alone, each holding a worker for nothing but its place in the queue. That
 * hour 8 of 48 watch minutes were unusable, all with the workers over 16 GB. A parked job's turn is aborted, which drops its queue entry
 * (pi-pool's admit wait releases on Stop), and Prime's idle sweep then unloads its worker; it gets "continue" through the fleet budget once
 * pi-pool has a free slot for it.
 */

/** A queued turn is parked once it waited this long: past pi-pool's 120 s ticket renew poll, so a turn about to be admitted is left alone. */
export const PARK_AFTER_S = 120;
export const PARK_CONTINUE = "[queue] Your turn waited for a working slot, so the chat service parked it to unload your worker. A slot is free now; continue where you left off.";

export interface QueueEntry { session: string; tree: string; parent: string | null; class: string; position: number; waitS: number }
export interface QueueView { working: readonly { session: string; tree: string }[]; queued: readonly QueueEntry[]; limit: number }
export interface Parked { session: string; at: number; position: number }

/** A Prime session id; a duty run's key (`duty:<chat>:<duty>`) waits in the queue with no session to abort. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-/;

/** Classes that never wait in the queue, so a session of theirs is never parked. */
const NEVER = new Set(["owner", "prod", "ahead", "checkin"]);

/**
 * What to park and what to let go now. A queued turn parks when its session is a root alone in its tree (no subagent waits or works under it),
 * not a chat, not an owner, prod or check-in turn, it waited PARK_AFTER_S, and more turns wait ahead of it than pi-pool runs at once. Parked
 * sessions go back oldest first, one per free slot: a slot is free while fewer turns wait than pi-pool's limit.
 */
export function parkPlan(view: QueueView, parked: readonly Parked[], chats: ReadonlySet<string>): { park: QueueEntry[]; unpark: Parked[] } {
  const working = new Set(view.working.map(entry => entry.tree));
  const perTree = new Map<string, number>();
  for (const entry of view.queued) perTree.set(entry.tree, (perTree.get(entry.tree) ?? 0) + 1);
  const already = new Set(parked.map(entry => entry.session));
  const park = view.queued.filter(entry => SESSION_ID.test(entry.session) && entry.parent === null && entry.tree === entry.session && !working.has(entry.tree) && perTree.get(entry.tree) === 1 &&
    !chats.has(entry.session) && !NEVER.has(entry.class) && entry.waitS >= PARK_AFTER_S && entry.position > view.limit && !already.has(entry.session));
  const room = Math.max(0, view.limit - (view.queued.length - park.length));
  const unpark = [...parked].sort((a, b) => a.at - b.at).slice(0, room);
  return { park, unpark };
}

export interface ParkDeps {
  file: string;
  queue: () => Promise<QueueView | null>;
  chats: () => Promise<ReadonlySet<string>>;
  /** Aborts the session's turn without attaching a client (an attached client keeps the worker from Prime's idle sweep). */
  abort: (session: string) => Promise<void>;
  /** Starts the parked session's turn again with `text`. */
  resume: (session: string, text: string) => Promise<void>;
  fleet: { tryAdmit(ask: FleetAsk): Promise<FleetDone | null> };
  log: (line: string) => void;
  now?: () => number;
}

/** One pass: park the turns `parkPlan` names, then let parked ones go through the fleet budget while it is open. The list survives restarts. */
export async function parkTick(deps: ParkDeps): Promise<{ parked: number; resumed: number }> {
  const now = deps.now ?? Date.now;
  const view = await deps.queue().catch(() => null);
  if (!view) return { parked: 0, resumed: 0 };
  let list = await readParked(deps.file);
  const { park, unpark } = parkPlan(view, list, await deps.chats());
  let parked = 0, resumed = 0;
  for (const entry of park) {
    try { await deps.abort(entry.session); list.push({ session: entry.session, at: now(), position: entry.position }); parked++; }
    catch (error) { deps.log(`queue park: ${entry.session.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  for (const entry of unpark) {
    const done = await deps.fleet.tryAdmit({ kind: "continue", label: `parked ${entry.session.slice(0, 8)}` });
    if (!done) break;
    try { await deps.resume(entry.session, PARK_CONTINUE); done(entry.session); resumed++; list = list.filter(item => item.session !== entry.session); }
    catch (error) { done(); deps.log(`queue park: resume ${entry.session.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (parked || resumed) {
    deps.log(`queue park: parked ${parked}, resumed ${resumed}; ${list.length} parked, ${view.queued.length - parked} queued for ${view.limit} slots`);
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
