/** One run that an interruption stopped, as `skills/resume-paused-sessions/scripts/resume_paused.py --json` reports it. */
export interface InterruptedRun {
  id: string;
  name: string;
  kind?: string;
  /**
   * "error": the last turn failed on a network or sign-in error. "cut_off": the turn ended with no reply after a tool call.
   * "empty_reply": the model returned an empty reply that asked for a tool, so the turn ended.
   * "hung": it showed working with no activity for 30 min; Resume aborts it before it messages the head.
   * "worker_failed": its Prime worker died, so it takes no command; Resume reopens its head from the saved file.
   * "worker_stopped": the daemon shut its worker down in the middle of the turn, which wrote "Request was aborted".
   * "aborted": a step owner's turn was aborted with no reply (--owners). "never_started": a spawned step owner whose worker stopped before its
   * first task reached it; it gets that task. "daemon_restart": a daemon restart or a Prime update stopped the turn.
   */
  reason: "error" | "cut_off" | "empty_reply" | "hung" | "worker_failed" | "worker_stopped" | "aborted" | "never_started" | "daemon_restart";
  session_id?: string;
  head_session_id?: string;
  /** The box the run is on, when it is not this one. */
  host?: string;
  /** A hung run whose last entry is an assistant reply that failed on an interruption error: Prime sleeps in its provider retry. */
  retry_error?: string;
  /** Why a run asleep in its provider retry is not aborted: a stop record names it or did not read, or pi-pool's answer is a hold or unknown. */
  retry_blocked?: string;
  error: string;
  errored_at: string;
  head: string;
}

export interface InterruptedHead {
  id: string;
  name: string;
  working: boolean;
  paused_in_tree: string[];
  /** `relayed_through`: the parent that got the message for a stopped subagent the daemon no longer holds. */
  result: string | { deliveryStatus?: string; deliveryMode?: string; relayed_through?: string } | { error: string };
}

/** A run `--direct` or `--include-children` messaged itself, and the answer. */
export interface InterruptedChild { id: string; name: string; head: string; result: InterruptedHead["result"] }

export interface InterruptedReport {
  paused: InterruptedRun[];
  heads: InterruptedHead[];
  children?: InterruptedChild[];
  checked_at: string;
  /** Each box the pass did not finish and why, such as a SIGTERM from the caller's timeout while it read another box. `host` null is this box. */
  incomplete?: { host: string | null; error: string }[];
  /** Cut runs whose turn an archive stopped with no recorded cause, or with one that gives no leave to continue (`error` names it). Never resumed. */
  unresolved?: UnresolvedStop[];
  /** Cut runs a record says were stopped on purpose: an rlm ledger delete, the chat's delete or archive, or a stop reason on the archive line. */
  stopped?: RecordedStop[];
  /** Cut runs left for now because pi-pool holds their tree; the chat service asks the pool again at each one's `pool_at` (`PoolHeldJobs`). */
  held?: PoolHeldRun[];
  /** Cut runs that the owner's archive of their chat after their last message stops (resumeJobs), so the job sweep can name them once. */
  archived?: RecordedStop[];
  /** Cut runs the job sweep's --owed pass leaves alone, since no work is owed to them (resume_paused.py work_owed). */
  unowed?: UnowedRun[];
}

/** A cut run whose work moved on: no chat, open step, live parent, tool call or unanswered message holds it. `cut` is how its turn ended. */
export interface UnowedRun {
  id: string;
  name: string;
  session_id: string;
  head: string;
  head_session_id: string;
  cut: string;
  cut_error: string;
  cut_at?: string | null;
  host?: string;
}

/**
 * A cut run whose tree pi-pool holds: `tree` is the top-level session pi-pool keys it by, `held_by` the hold, and `pool_at` when the pool says
 * the tree can run again (resume_paused.py pool_free_at), null when it does not say. A null provider is never admitted.
 */
export interface PoolHeldRun {
  id: string;
  name: string;
  session_id: string;
  head: string;
  head_session_id: string;
  tree: string;
  provider: string | null;
  errored_at: string | null;
  held_by: string;
  pool_at: string | null;
  host?: string;
}

/** What decides whether a run or an unresolved stop belongs to the chats' jobs. */
export type JobOf = Pick<InterruptedRun, "session_id" | "head_session_id">;

export interface UnresolvedStop {
  id: string;
  name: string;
  session_id: string;
  head: string;
  head_session_id: string;
  archived_at?: string;
  error: string;
  host?: string;
}

export interface RecordedStop {
  id: string;
  name: string;
  session_id: string;
  head: string;
  head_session_id: string;
  stopped_at?: string | null;
  stopped_by: string;
  /** How the run's last turn ended (an InterruptedRun reason), its error text and that message's time: why the turn stopped, apart from `stopped_by`. */
  cut?: string;
  cut_error?: string;
  cut_at?: string | null;
  host?: string;
}
