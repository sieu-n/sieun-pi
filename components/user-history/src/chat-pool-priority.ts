import { CHECK_IN_DUTY } from "./shared/chat-duties.ts";
import type { PoolPriority, Priority, SessionRow } from "./shared/types.ts";

/** The sidebar priority label as a pool class. None (0) leaves the thread's own class; Low (1) is low, Medium (2) normal, High (3) high. */
export const LABEL_POOL_PRIORITY: Readonly<Record<Priority, PoolPriority | null>> = { 0: null, 1: "low", 2: "normal", 3: "high" };
const RANK: Readonly<Record<PoolPriority, number>> = { low: 0, normal: 1, high: 2 };
/** A chat's pool class: its sidebar label, and high with none (rule 3 of `poolPriorities`). Its duties' morning band follows it (MORNING_BANDS). */
export const chatPoolPriority = (label: Priority): PoolPriority => LABEL_POOL_PRIORITY[label] ?? "high";

/**
 * The pool class of every live root thread, first match wins (pi-pool scheduler design, "Priority"):
 * 1. its own sidebar priority label, when set (LABEL_POOL_PRIORITY);
 * 2. a duty job (`duties`, the session ids the duty runner registered) is low, except a check-in job (`isCheckInJob`), which is normal
 *    (`checkInClass`), and low only under a chat labelled Low, so a chat roster that has not listed the new job yet cannot drop it to low;
 * 3. a chat is high;
 * 4. a job a chat started (an Agents entry linked as root) or gave a step to (linked as step) takes the highest class among those chats;
 * 5. a thread the owner started is high, and any other thread is normal.
 * Archived and saved (not loaded) threads are left out: they send no requests.
 */
export function poolPriorities(rows: readonly SessionRow[], duties: ReadonlySet<string>): Map<string, PoolPriority> {
  const live = rows.filter(row => row.kind === "live" && !row.archived);
  const label = (row: SessionRow): PoolPriority | null => LABEL_POOL_PRIORITY[row.priority];
  const owned = new Map<string, PoolPriority>();
  for (const chat of live) {
    if (!chat.chat) continue;
    const own = chatPoolPriority(chat.priority);
    for (const agent of chat.agents ?? []) {
      if (!agent.sessionId || (agent.link !== "root" && agent.link !== "step")) continue;
      const before = owned.get(agent.sessionId);
      if (!before || RANK[own] > RANK[before]) owned.set(agent.sessionId, own);
    }
  }
  return new Map(live.map(row => [row.id, label(row) ?? (duties.has(row.id) ? (isCheckInJob(row.name) ? checkInClass(owned.get(row.id) ?? "normal") : "low")
    : row.chat ? "high" : owned.get(row.id) ?? (row.origin === "user" ? "high" : "normal"))]));
}

/**
 * Whether a duty job is its chat's check-in job, by the name `dutyJobName` gives it ("check-in frontend bro 19:05"). A check-in job is the
 * one turn that gives the chat's stuck steps an owner. As low, from 08:25Z to 11:05Z on 10-18 the check-in jobs of frontend bro, AI harness,
 * VP of CI and ops guy waited 57 to 90 min for a slot (R5 orders waits by class), and the runner skipped every slot meanwhile, so d7 read 6 to
 * 9 stuck steps.
 */
export const isCheckInJob = (name: string): boolean => name.trim().toLowerCase().startsWith(`${CHECK_IN_DUTY.name.toLowerCase()} `);

/**
 * A check-in job's class: normal, so the chats themselves still go first when slots are short, or its chat's class when that is lower. On
 * 10-18 from 08:00Z to 12:00Z normal trees waited 3 min at p50 for a slot, high 18 min and low 97 min (pi-pool.log); the AI harness VP picked
 * normal over high.
 */
export const checkInClass = (chat: PoolPriority): PoolPriority => chat === "low" ? "low" : "normal";

/** The class a duty job's first request carries: `checkInClass` of its chat for a check-in job (`isCheckInJob`), low for every other duty job. */
export const dutyJobPriority = (name: string, chat: PoolPriority): PoolPriority => isCheckInJob(name) ? checkInClass(chat) : "low";

/** What a sync needs: the catalog rows, the duty job ids, and the pi-pool call that sets one root's class. */
export interface PoolPrioritySource {
  rows(): Promise<readonly SessionRow[]>;
  /** The duty and check-in job ids among `rows`. */
  duties(rows: readonly SessionRow[]): Promise<ReadonlySet<string>>;
  set(sessionId: string, priority: PoolPriority): Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * The duty job ids among `rows`: the duty runner registers a duty job by its session id (src/chat-duty-job.ts), and a chat registers the roots
 * it starts with rlm.create_session by name, so a registry entry that is a row id is a duty job.
 */
export async function dutyJobIds(rows: readonly SessionRow[], registry: { rootsOf(chat: readonly string[]): Promise<string[]> }): Promise<Set<string>> {
  const chats = rows.filter(row => row.chat).flatMap(row => [row.id, row.name.trim()]).filter(Boolean);
  const ids = new Set(rows.map(row => row.id));
  return new Set((await registry.rootsOf(chats)).filter(key => ids.has(key)));
}

/** A failed set (a root the pool has no record of yet, a busy lock) is tried again after this long. */
export const PRIORITY_RETRY_MS = 5 * 60_000;

/**
 * Keeps each live root's pool class equal to `poolPriorities`. A sync sets only roots whose class changed since this service last set it,
 * so the first sync after a start sets every live root once and later ones cost no pi-pool call. Syncs run one at a time; a sync asked for
 * while one runs runs once more after it.
 */
export class PoolPriorities {
  private readonly applied = new Map<string, PoolPriority>();
  private readonly failed = new Map<string, { priority: PoolPriority; at: number }>();
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private readonly source: PoolPrioritySource) {}

  /** Sets one root's class now, as a duty job start does before its first request. */
  async set(sessionId: string, priority: PoolPriority): Promise<void> {
    const now = (this.source.now ?? Date.now)();
    try {
      await this.source.set(sessionId, priority);
      this.applied.set(sessionId, priority);
      this.failed.delete(sessionId);
    } catch (error) {
      this.failed.set(sessionId, { priority, at: now });
      this.source.log?.(`pool priority ${priority} for ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  sync(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do {
        this.again = false;
        await this.once().catch(error => this.source.log?.(`pool priority sync failed: ${error instanceof Error ? error.message : String(error)}`));
      } while (this.again);
    })().finally(() => { this.running = null; });
    return this.running;
  }

  private async once(): Promise<void> {
    const rows = await this.source.rows();
    const wanted = poolPriorities(rows, await this.source.duties(rows));
    const now = (this.source.now ?? Date.now)();
    for (const id of [...this.applied.keys()]) if (!wanted.has(id)) this.applied.delete(id);
    for (const [id, priority] of wanted) {
      if (this.applied.get(id) === priority) continue;
      const failed = this.failed.get(id);
      if (failed?.priority === priority && now - failed.at < PRIORITY_RETRY_MS) continue;
      await this.set(id, priority);
    }
  }
}
