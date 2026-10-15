import { admitTurn, readAgentQueue, releaseTurn, type TurnClass } from "./chat-pool.ts";
import { CHECK_IN_DUTY_ID } from "./shared/chat-duties.ts";
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
 * How long one read of the queue serves the board and the check-ins. The catalog sends its rows every 2 s while an agent works (RATES_MS), and
 * one pi-pool call took 0.16 to 0.20 s at load 20 on 10-14, so a read per send would run pi-pool 30 times a minute; the chip shows whole minutes.
 */
export const QUEUE_READ_MS = 10_000;

/** One pi-pool queue read shared by its readers for `ttlMs`, so the Mac usable watch adds no pi-pool call while the catalog reads every 10 s; a failed read is not kept. */
export function sharedQueueRead(read: () => Promise<AgentQueueReading> = readAgentQueue, ttlMs = QUEUE_READ_MS, now: () => number = Date.now): () => Promise<AgentQueueReading> {
  let cached: { at: number; value: Promise<AgentQueueReading> } | null = null;
  return () => {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    const value = read();
    const entry = { at: now(), value };
    cached = entry;
    value.catch(() => { if (cached === entry) cached = null; });
    return value;
  };
}

/** The queued sessions, read at most once per `ttlMs`; a read that fails gives none, so everything reads as it did before the queue. */
export function queueReader(read: () => Promise<AgentQueueReading> = readAgentQueue, ttlMs = QUEUE_READ_MS, now: () => number = Date.now): () => Promise<ReadonlyMap<string, QueuePlace>> {
  let cached: { at: number; value: Promise<ReadonlyMap<string, QueuePlace>> } | null = null;
  return () => {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    const value = read().then(queuedPlaces, () => new Map<string, QueuePlace>());
    cached = { at: now(), value };
    return value;
  };
}

/**
 * A new turn would only wait once the queue holds this many turns per working slot: over the 2,529 turns pi-pool queued and admitted on 10-15
 * (pi-pool.log, the queue length each `turn_queued` logged against the governor's limit then), the median wait was 504 s at 3 to 3.5 queued
 * per slot and 456 s at 3.5 to 4, and 738 s at 4 to 4.5, 637 s at 4.5 to 5, 741 s at 5 to 6 and 1,757 s above 6. Past 600 s a session that
 * waits holds a worker Prime's idle sweep would have stopped (idleEvictionMinutes is 10 in ~/.prime/agent/settings.json), and Prime counts a
 * session whose run waits in the queue as running, so it never evicts it: at 15:2xZ on 10-15, 80 of 118 live sessions waited in the queue and
 * 47 of 72 workers held nothing else.
 */
export const QUEUE_LONG_PER_SLOT = 4;

/** Why a turn started now would only wait (`QUEUE_LONG_PER_SLOT`), or null when the queue is off, unread or shorter. */
export function queueLong(reading: AgentQueueReading | null): string | null {
  if (!reading?.enabled) return null;
  const limit = reading.governor?.limit ?? reading.macWorkingMax;
  if (reading.queued.length < QUEUE_LONG_PER_SLOT * limit) return null;
  return `the turn queue holds ${reading.queued.length} turns for ${limit} slots`;
}

/** A duty run's key in the turn queue before its job's session exists: one per chat and duty, as a duty runs one run at a time. */
export const dutyQueueKey = (chatId: string, dutyId: string): string => `duty:${chatId}:${dutyId}`;

export interface DutyAdmitter {
  /**
   * Waits until the pool admits the duty's run as a low turn and returns its release; null when the queue is off or the pool failed, and the
   * job starts as before.
   */
  admit(chatId: string, dutyId: string): Promise<(() => Promise<void>) | null>;
  /** Releases the duty keys a past run of this service left in the pool, working or queued, for the chats `isChat` takes (a restart kills the waits). */
  sweep(isChat: (chatId: string) => Promise<boolean>): Promise<void>;
}

/**
 * The duty runner's side of the Mac-wide turn queue: before it creates a duty or check-in job it asks `pi-pool admit --wait` under the duty's
 * key, so a queued duty holds no worker (312 to 360 MB fresh on 10-14) until its turn, and its scheduled run still happens. The runner
 * releases the key once the job's session exists or its start failed; the job's own turns then admit under its real session id through
 * pi-pool's extension. A duty asks as `low`, and a chat's check-in as `checkin` (`dutyClass`).
 */
/**
 * The class a duty's run asks the queue for. A check-in, one key per chat, goes ahead of every queued turn and is never held under memory
 * pressure: on 10-15 at the critical limit of 12 with 60 to 77 turns queued, every turn aged to high within 36 s and the check-in keys,
 * asked as low, waited 49 s at p50, 179 s at p90 and 381 s at most (23 waits in this service's log); the check-in job's own first run then
 * waited 0 s at p90 over 282 jobs (pi-pool.log), so only the key needs the class. Every other duty stays low.
 */
export const dutyClass = (dutyId: string): TurnClass => dutyId === CHECK_IN_DUTY_ID ? "checkin" : "low";

/**
 * A duty asks the pool at once, whatever the Prime workers hold: at 10:18Z on 10-15, with 44 workers at 38.6 GB, duty jobs were at most 6 of
 * the 114 live sessions and about 2.4 GB, so holding them could not bring the workers near the 16 GB under which minutes stayed usable.
 */
export function dutyAdmitter(input: { log: (line: string) => void; now?: () => number;
  pool?: { admit: typeof admitTurn; release: typeof releaseTurn; read: () => Promise<AgentQueueReading> } }): DutyAdmitter {
  const pool = input.pool ?? { admit: admitTurn, release: releaseTurn, read: readAgentQueue };
  const now = input.now ?? Date.now;
  const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
  return {
    async admit(chatId, dutyId) {
      const key = dutyQueueKey(chatId, dutyId);
      const asked = now();
      let state: "admitted" | "off";
      try { state = await pool.admit(key, key, dutyClass(dutyId)); }
      catch (error) {
        input.log(`duty ${chatId.slice(0, 8)}/${dutyId}: the turn queue did not answer, so its job starts unqueued: ${reason(error)}`);
        await pool.release(key).catch(() => {});
        return null;
      }
      if (state === "off") return null;
      const waited = Math.round((now() - asked) / 1000);
      if (waited >= 1) input.log(`duty ${chatId.slice(0, 8)}/${dutyId}: the turn queue admitted its job after ${waited} s`);
      return () => pool.release(key);
    },
    async sweep(isChat) {
      const reading = await pool.read();
      for (const entry of [...reading.working, ...reading.queued]) {
        const chat = /^duty:([^:]+):/.exec(entry.session)?.[1];
        if (!chat || !(await isChat(chat))) continue;
        await pool.release(entry.session).catch(error => input.log(`turn queue: release ${entry.session}: ${reason(error)}`));
      }
    },
  };
}
