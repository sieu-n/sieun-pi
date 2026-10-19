import { parseAgentQueue, readAgentQueue } from "./chat-pool.ts";
import type { JobFact } from "./checkin-steps.ts";
import type { AgentQueueReading, ChildAgent, QueuePlace } from "./shared/types.ts";

/** What the turn queues of every box hold: the queued sessions with their places, and the sessions whose run holds a working slot. */
export interface PoolPlaces { queued: ReadonlyMap<string, QueuePlace>; working: ReadonlySet<string> }
const NO_PLACES: PoolPlaces = { queued: new Map(), working: new Set() };

/** The sessions `pi-pool queue --json` lists as queued, by session id; none when the pool did not answer. */
export const queuedPlaces = (reading: AgentQueueReading | null): Map<string, QueuePlace> =>
  new Map((reading?.queued ?? []).map(entry => [entry.session, { position: entry.position, total: entry.total, since: entry.since }]));

/** The sessions `pi-pool queue --json` lists as working: each one's run holds a slot from its first model call to its end, tool calls included. */
export const workingSessions = (reading: AgentQueueReading | null): Set<string> => new Set((reading?.working ?? []).map(entry => entry.session));

/**
 * The check-in's job facts with each one's place in the turn queue, so a job whose turn waits for a slot reads as queued and one whose run
 * holds a slot reads as in its turn, neither stalled: a thread by its own id, a subagent by its session id, or by the one a child in `children`
 * gives its child id (a hub child has none; the daemon's has).
 */
export function withQueuePlaces(facts: readonly JobFact[], places: PoolPlaces, children: readonly ChildAgent[]): JobFact[] {
  if (!places.queued.size && !places.working.size) return [...facts];
  return facts.map(fact => {
    const session = fact.key.startsWith("thread:") ? fact.key.slice("thread:".length) : fact.sessionId ?? children.find(child => child.id === fact.key && child.sessionId)?.sessionId;
    if (session === undefined) return fact;
    const queued = places.queued.get(session);
    if (queued) return { ...fact, queued };
    return places.working.has(session) ? { ...fact, inTurn: true as const } : fact;
  });
}

/**
 * Every box's turn queue as one reading: this box's own (`self`) and each other box's `pi-pool queue --json` through its relay's /v1/host, the
 * read Settings > Hosts makes for its Agent queue cards. A Mac chat's jobs queue in the Mac's pool, and the check-in runs on us-metal02: from
 * 21:44Z to 22:00Z on 10-19 it read only its own pool and restarted "email template", "dev tip reds" and "new frontend plan" twice each while
 * they sat 39th to 44th for a Mac slot, and each restart aborted the waiting model request with no output. A box whose relay or pool does not
 * answer adds nothing; this box's failure fails the read, as before.
 */
export function hostsQueueRead(self: () => Promise<AgentQueueReading>, remotes: () => readonly (() => Promise<unknown>)[]): () => Promise<AgentQueueReading> {
  return async () => {
    const [own, ...others] = await Promise.all([self(), ...remotes().map(read => read().then(remotePool, () => null))]);
    const read = others.filter((other): other is AgentQueueReading => other !== null);
    return { ...own, working: [own, ...read].flatMap(reading => reading.working), queued: [own, ...read].flatMap(reading => reading.queued) };
  };
}

/** A relay's `pool` field (prime-relay host-stats.ts PoolReading) as a queue reading, or null when that box's pool did not answer. */
function remotePool(stats: unknown): AgentQueueReading | null {
  const pool = typeof stats === "object" && stats !== null ? (stats as { pool?: unknown }).pool : undefined;
  if (typeof pool !== "object" || pool === null || !("queue" in pool)) return null;
  try { return parseAgentQueue(pool.queue); } catch { return null; }
}

/**
 * How old a queue reading the board, the check-ins, the duties and the Mac usable watch take. The catalog sends its rows every 2 s while an
 * agent works (RATES_MS), and the chip shows whole minutes, so they share a reading for 10 s instead of asking at every send.
 */
export const QUEUE_READ_MS = 10_000;

/** The queue from the shared pool read (chat-pool.ts readPoolStatus), at most QUEUE_READ_MS old. */
export const boardQueueRead = (): Promise<AgentQueueReading> => readAgentQueue(QUEUE_READ_MS);

/**
 * The queued and working sessions; a read that fails gives none, so everything reads as it did before the queue. After the first read it
 * answers at once with the last places and reads again behind them: every catalog projection asks, and a read older than QUEUE_READ_MS waits
 * out the pool's tick and a `pi-pool snapshot`, which took up to 3.6 s through api/agent-queue on us-metal02 on 10-18 at 16:41Z, so
 * api/threads/<id>/agents, which waits for a projection, answered in 1 to 7 s.
 */
export function queueReader(read: () => Promise<AgentQueueReading> = boardQueueRead): () => Promise<PoolPlaces> {
  let last: PoolPlaces | null = null;
  let reading: Promise<PoolPlaces> | null = null;
  return () => {
    reading ??= read().then((value): PoolPlaces => ({ queued: queuedPlaces(value), working: workingSessions(value) }), () => NO_PLACES)
      .then(places => { last = places; reading = null; return places; });
    return last ? Promise.resolve(last) : reading;
  };
}
