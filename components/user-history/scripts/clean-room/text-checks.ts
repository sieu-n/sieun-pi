/** Text checks shared by the clean-room scenarios: the owner's rule c80 says a chat or job prompt gets a headline number, at most 3 plain items and a detail file path, never a list of step ids or flag kinds. */

/** The finding keys the check-in code names (`rg -o 'kind: "[a-z_]+"' src/chat-checkin.ts src/checkin-*.ts src/shared/chat-duties.ts` in release-293f722). */
export const FLAG_KINDS = ["stuck_steps", "stalled_steps", "finished_open", "no_progress", "goal_gaps", "goals_off_pace", "loose_goals", "orphan_steps", "stale_steps", "idle_goals",
  "blocked_on_others", "due_late", "extra_goals", "goals_to_fold", "goals_without_duty", "held_elsewhere", "open_under_closed", "scope_misses", "wait_met",
  "go_missing", "go_waiting", "job_end_silent", "job_end_unrecorded", "job_ended", "no_owner", "owner_no_todo", "merges_without_go", "requirements_missing",
  "one_session_load", "redundant_heartbeats", "startup_failure"];

/** Flag kinds named in a text, leaving out a duty link such as `checkin/goal_gaps` or `d1/ig_reads_per_s`. */
export function flagHits(text: string): string[] {
  const hits = new Set<string>();
  for (const kind of FLAG_KINDS) {
    for (const match of text.matchAll(new RegExp(`(^|[^A-Za-z0-9_/])${kind}(?![A-Za-z0-9_])`, "g"))) if (match) hits.add(kind);
  }
  return [...hits];
}
/** Paragraphs (blocks between blank lines) that name 4 or more distinct step ids, each with its ids. */
export function stepIdLists(text: string): string[][] {
  return text.split(/\n\s*\n/).map(block => [...new Set(block.match(/\bp\d{1,4}\b/g) ?? [])]).filter(ids => ids.length >= 4);
}
/** Whether a text names a number as a whole token: 14.9 matches "14.9%" but not "114.9" or "14.95". */
export const names = (text: string, value: string): boolean => new RegExp(`(^|[^0-9.])${value.replace(".", "\\.")}(?![0-9]|\\.[0-9])`).test(text);
/** A check-in report's shape: its non-empty lines past one line that holds only a detail file path, and whether it names `value`. */
export function reportShape(text: string, value: string): { lines: number; ok: boolean; namesGoal: boolean } {
  const lines = text.split("\n").map(line => line.trim()).filter(Boolean).filter(line => !/^\[agent-message from [^\]]*\]$/.test(line));
  const pathLine = lines.findIndex(line => /^(detail:?\s*)?[`]?[~/][^\s`]+[`]?\.?$/i.test(line));
  const counted = pathLine >= 0 ? lines.length - 1 : lines.length;
  return { lines: counted, ok: counted <= 3, namesGoal: names(text, value) };
}
