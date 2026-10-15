import { type EndStateView, stuckLine } from "./checkin-end-state.ts";
import { plural } from "./checkin-steps.ts";
import { cappedLines } from "./shared/brief-cap.ts";
import type { SessionRow } from "./shared/types.ts";

/** The state the chat's row lists for each of its jobs (a subagent or a create_session root), by session id. */
export const jobStateMap = (row: Pick<SessionRow, "agents">): Map<string, string> =>
  new Map((row.agents ?? []).flatMap(agent => agent.sessionId && (agent.link === "subagent" || agent.link === "root") ? [[agent.sessionId, agent.state ?? ""] as const] : []));

/** Whether a job that worked in `before` no longer does in `after`: its turn ended, it failed, or it left the row (archived or deleted). */
export const jobStopped = (before: ReadonlyMap<string, string> | undefined, after: ReadonlyMap<string, string>): boolean =>
  before !== undefined && [...before].some(([session, state]) => state === "working" && after.get(session) !== "working");

/**
 * The open steps whose owner is dead, from the check-in's end states: a step whose job is gone, or whose owner is a root the chat started
 * (`roots`, names or session ids from the job registry) that failed or ended `graceMs` or more ago, so its report had time to land. Another
 * chat's thread and a subagent owner are left out; the open-steps notice tells a subagent's end. `end` names the owner end, so one end is told
 * once and a new end of the same step is told again.
 */
export function deadOwnerSteps(entries: readonly EndStateView[], roots: ReadonlySet<string>, graceMs: number, now: number): { entry: EndStateView; end: string }[] {
  return entries.flatMap(entry => {
    if (entry.state !== "job_ended" && entry.state !== "thread") return [];
    const owner = entry.view.owner;
    if (!owner) return entry.state === "job_ended" ? [{ entry, end: `gone:${entry.view.item.job ?? ""}` }] : [];
    if (!owner.key.startsWith("thread:") || !(roots.has(owner.name) || roots.has(owner.key.slice("thread:".length)))) return [];
    const ended = owner.state === "failed" || (owner.activityAt !== undefined && now - owner.activityAt >= graceMs);
    return ended ? [{ entry, end: `${owner.key}:${owner.state}:${owner.activityAt ?? ""}` }] : [];
  });
}

/** The steer the step scan sends: one line per dead-owner step (`stuckLine`), at most BRIEF_ITEMS of them, and the file that lists the rest (`detail`). */
export const deadOwnerNotice = (entries: readonly EndStateView[], now: number, detail?: string): string =>
  `Step scan: ${plural(entries.length, "open step")} ${entries.length === 1 ? "has" : "have"} no live owner. Give each a live owner, a For you todo, ` +
  `or a close now:\n${cappedLines(deadOwnerLines(entries, now), detail)}`;

/** Each dead-owner step as the step scan names it, for its notice and the notice's detail file. */
export const deadOwnerLines = (entries: readonly EndStateView[], now: number): string[] => entries.map(entry => stuckLine(entry, now));
