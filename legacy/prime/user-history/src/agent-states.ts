/**
 * What each loaded Prime session is doing, from the daemon's own session rows, for Settings > Hosts' "N working, M waiting" and the Whole
 * system duty's quiet_agent_gb (src/mac-usable-watch.ts `agentLine`). A row reads `activity: "working"` for a session at work and also for
 * one that only waits: on the model provider's retry after a 429, or on the pool's token helper ("this session waits for its slot at ...").
 * At 23:46:30Z on 10-18 the daemon read 220 of 228 live sessions as working while almost none streamed, and the Hosts line, which read the
 * pi-pool queue that is turned off, said 0 working.
 *
 * - `working` streams from the model, runs a tool, or compacts.
 * - `children` does none of that and waits on a subagent of its own that still runs.
 * - `retry` does none of that and still holds its turn open, which is a wait on the provider or the pool. A run that waits for a pi-pool
 *   slot reads `isStreaming` true, because the pool holds its model call, and Prime names the wait in `waitingFor` ("a turn, place 2 of 58").
 *   At 01:20Z on 10-27 all 59 queued runs on us-metal02 read so, and Settings > Hosts counted them working beside the 12 that held a slot.
 * - `idle` holds no turn.
 * - `hung` runs a tool call that wrote nothing for an hour with no progress (src/hung-calls.ts), read from the watch's newest minute. On 10-19
 *   three such calls read working for 9 to 13 h, so us-metal02 never read 0 working from 01:43Z to 11:10Z.
 */
export type AgentState = "working" | "children" | "retry" | "idle" | "hung";
export type AgentCounts = Record<AgentState, number>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A row's state, or null for a row the daemon holds no session for (stopped, archived, or not a row). `hung` names the hung calls' sessions. */
export function agentState(row: unknown, hung: ReadonlySet<string> = new Set()): AgentState | null {
  if (!isRecord(row) || (row.lifecycle !== "live" && row.lifecycle !== "draft") || typeof row.activeSessionId !== "string") return null;
  if (typeof row.sessionId === "string" && hung.has(row.sessionId)) return "hung";
  const waits = typeof row.waitingFor === "string" && row.waitingFor.trim() !== "";
  if (!waits && (row.isStreaming === true || row.isRunningTools === true || row.isCompacting === true)) return "working";
  if (row.hasRunningRlmChildren === true) return "children";
  if (waits || row.activity === "working" || row.isSessionActive === true) return "retry";
  return "idle";
}

/** How many loaded sessions are in each state. */
export function agentCounts(rows: readonly unknown[], hung: ReadonlySet<string> = new Set()): AgentCounts {
  const counts: AgentCounts = { working: 0, children: 0, retry: 0, idle: 0, hung: 0 };
  for (const row of rows) {
    const state = agentState(row, hung);
    if (state) counts[state]++;
  }
  return counts;
}

/**
 * A box's counts for Settings > Hosts: its daemon rows' states (`agentCounts`) with its own pi-pool queue as a floor, `pool` the sessions that
 * hold a slot and those queued for one. A queued run waits on the pool whether or not its row says so yet, and a slot holder streams. Null,
 * so the card reads "sessions not read", while no row is loaded and the pool holds nothing: in the first minute after a new Prime supervisor
 * (16:48:56Z after the reboot and 16:55:30Z after a supervisor restart on 10-27) the rows read no live session and the pool 0 working, 0
 * queued, while CI guests, Docker and jobs' units kept the CPU busy, and the card said "0 working, 0 waiting".
 */
export function hostCounts(rows: readonly unknown[], pool: { working: number; queued: number } | null, hung: ReadonlySet<string> = new Set()): AgentCounts | null {
  const counts = agentCounts(rows, hung);
  const loaded = counts.working + counts.children + counts.retry + counts.idle + counts.hung;
  if (!loaded && !(pool && (pool.working || pool.queued))) return null;
  if (!pool) return counts;
  return { ...counts, working: Math.max(counts.working, pool.working - counts.hung), retry: Math.max(counts.retry, pool.queued) };
}
