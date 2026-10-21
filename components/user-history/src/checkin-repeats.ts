import type { FlaggedSlice } from "./shared/chat-duties.ts";

/**
 * Findings that repeat (owner 10-12 in the AI harness thread: "when i told you to organize plan ... that's a failure mode that would have
 * been the check-in's duty"). Each check-in run keeps how many runs in a row flagged each finding (`flagStreaks`, in the check-in memory).
 * A finding flagged in REPEAT_RUNS or more runs in a row heads the next brief: the last check-in saw it and the board did not change. On
 * 10-12 frontend bro's check-ins judged p93 and p96 "looks done" wrong in 4 and 5 runs in a row and kept them open, and the false match
 * reached the code only at the daily Chat system run. A wrong finding goes to CHAT_SYSTEM_THREAD, whose Chat system duty owns these checks.
 */
export const REPEAT_RUNS = 2;
/** The thread whose Chat system duty owns the check-in's checks (owner 10-12: "one of you (this chat thread)'s duty (the Chat system duty)"). */
export const CHAT_SYSTEM_THREAD = "AI harness developer environment VP";
/** A finding's key across runs: its kind and item, the key `unfixed_flags` counts too. */
export const flagKey = (slice: Pick<FlaggedSlice, "kind" | "item">): string => slice.item ? `${slice.kind} ${slice.item}` : slice.kind;
/** This run's streak per finding: one more than the last run's for a finding flagged again, 1 for a new one; a finding not flagged now drops. */
export function flagStreaks(previous: Readonly<Record<string, number>> | undefined, flagged: readonly Pick<FlaggedSlice, "kind" | "item">[]): Record<string, number> {
  const streaks: Record<string, number> = {};
  for (const slice of flagged) { const key = flagKey(slice); streaks[key] ??= (previous?.[key] ?? 0) + 1; }
  return streaks;
}
/**
 * Kinds Flagged again leaves out. A stuck step shows its streak in the Stuck steps section. An off-pace goal with a live owner is steered from
 * the goal section on its push schedule (quietPush) and is not judged (board skill check-ins.md item 11), so no board op clears it: on 10-21
 * Crawler VP's check-ins listed p828, p826, p681 and p146 under Flagged again 6 runs in a row while the goal section said to send nothing.
 */
const NOT_REPEATED: ReadonlySet<string> = new Set(["stuck_steps", "goals_off_pace"]);
/** The findings flagged in REPEAT_RUNS or more runs in a row, longest streak first, each with its count. */
export function repeatLines(streaks: Readonly<Record<string, number>>, flagged: readonly FlaggedSlice[]): string[] {
  const seen = new Set<string>();
  return flagged.flatMap(slice => {
    const key = flagKey(slice);
    const runs = streaks[key] ?? 0;
    if (NOT_REPEATED.has(slice.kind) || runs < REPEAT_RUNS || seen.has(key)) return [];
    seen.add(key);
    return [{ runs, line: `${slice.kind}: ${slice.excerpt} (flagged in ${runs} check-ins in a row)` }];
  }).sort((a, b) => b.runs - a.runs).map(entry => entry.line);
}
/** The head of the Flagged again section. */
export const REPEAT_HEAD = "Flagged again (the last check-in saw each of these and the board did not change. Fix each in this run with board ops on " +
  "evidence. If a finding is wrong, keep the item and send the " + CHAT_SYSTEM_THREAD + " thread one message with the chat, the item id, its text, " +
  "note and waitFor, and why the finding is wrong, so the Chat system duty fixes that check; keeping it open without that message is not an answer)";
