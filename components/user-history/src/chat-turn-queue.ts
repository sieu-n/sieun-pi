import { readAgentQueue } from "./chat-pool.ts";
import type { JobFact } from "./checkin-steps.ts";
import type { AgentQueueReading, ChildAgent, QueuePlace } from "./shared/types.ts";

/** The sessions `pi-pool queue --json` lists as queued, by session id; none when the pool did not answer. */
export const queuedPlaces = (reading: AgentQueueReading | null): Map<string, QueuePlace> =>
  new Map((reading?.queued ?? []).map(entry => [entry.session, { position: entry.position, total: entry.total, since: entry.since }]));

/**
 * The check-in's job facts with each one's place in the turn queue, so a job whose turn waits for a slot reads as queued, not stalled: a thread
 * by its own id, a subagent by its session id, or by the one a child in `children` gives its child id (a hub child has none; the daemon's has).
 */
export function withQueuePlaces(facts: readonly JobFact[], places: ReadonlyMap<string, QueuePlace>, children: readonly ChildAgent[]): JobFact[] {
  if (!places.size) return [...facts];
  return facts.map(fact => {
    const session = fact.key.startsWith("thread:") ? fact.key.slice("thread:".length) : fact.sessionId ?? children.find(child => child.id === fact.key && child.sessionId)?.sessionId;
    const queued = session === undefined ? undefined : places.get(session);
    return queued ? { ...fact, queued } : fact;
  });
}

/**
 * How old a queue reading the board, the check-ins, the duties and the Mac usable watch take. The catalog sends its rows every 2 s while an
 * agent works (RATES_MS), and the chip shows whole minutes, so they share a reading for 10 s instead of asking at every send.
 */
export const QUEUE_READ_MS = 10_000;

/** The queue from the shared pool read (chat-pool.ts readPoolStatus), at most QUEUE_READ_MS old. */
export const boardQueueRead = (): Promise<AgentQueueReading> => readAgentQueue(QUEUE_READ_MS);

/**
 * The queued sessions; a read that fails gives none, so everything reads as it did before the queue. After the first read it answers at once
 * with the last places and reads again behind them: every catalog projection asks, and a read older than QUEUE_READ_MS waits out the pool's
 * tick and a `pi-pool snapshot`, which took up to 3.6 s through api/agent-queue on us-metal02 on 10-18 at 16:41Z, so api/threads/<id>/agents,
 * which waits for a projection, answered in 1 to 7 s.
 */
export function queueReader(read: () => Promise<AgentQueueReading> = boardQueueRead): () => Promise<ReadonlyMap<string, QueuePlace>> {
  let last: ReadonlyMap<string, QueuePlace> | null = null;
  let reading: Promise<ReadonlyMap<string, QueuePlace>> | null = null;
  return () => {
    reading ??= read().then(queuedPlaces, () => new Map<string, QueuePlace>()).then(places => { last = places; reading = null; return places; });
    return last ? Promise.resolve(last) : reading;
  };
}
