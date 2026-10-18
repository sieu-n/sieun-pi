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
   * first task reached it; it gets that task.
   */
  reason: "error" | "cut_off" | "empty_reply" | "hung" | "worker_failed" | "worker_stopped" | "aborted" | "never_started";
  session_id?: string;
  head_session_id?: string;
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
}
