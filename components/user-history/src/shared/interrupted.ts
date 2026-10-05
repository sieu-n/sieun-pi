/** One run that an interruption stopped, as `skills/resume-paused-sessions/scripts/resume_paused.py --json` reports it. */
export interface InterruptedRun {
  id: string;
  name: string;
  kind?: string;
  /** "error": the last turn failed on a network or sign-in error. "cut_off": the turn ended with no reply after a tool call. */
  reason: "error" | "cut_off";
  error: string;
  errored_at: string;
  head: string;
}

export interface InterruptedHead {
  id: string;
  name: string;
  working: boolean;
  paused_in_tree: string[];
  result: string | { deliveryStatus?: string; deliveryMode?: string };
}

export interface InterruptedReport {
  paused: InterruptedRun[];
  heads: InterruptedHead[];
  checked_at: string;
}
