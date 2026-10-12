import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { StepView } from "./chat-checkin.ts";
import type { PlanItem } from "./shared/types.ts";

/*
 * Work spread and stale timers (owner 10-12, c51): "you seem to be using waaay too much on that ONE old session when it will be so much more
 * efficient to spawn subagents for each part. you be the mapper that defines the graph workflow ... also kill some deprecated heartbeat that
 * don't do anything, especially since you (and crawler VP) have Check-in heartbeat".
 */

const clip = (text: string, max = 60) => text.length > max ? text.slice(0, max - 1) + "\u2026" : text;
const quote = (text: string) => `"${clip(text)}"`;

/** One other session that holds too much of a goal's open work: `steps` of the goal's `open` open steps. */
export interface SessionLoad { goal: { id: string; text: string }; thread: { id: string; name: string }; steps: PlanItem[]; open: number }
/** A session holds too much of a goal when it owns more than this many of its open steps. */
export const SESSION_LOAD_MAX = 3;
/**
 * The other sessions that carry too much of one goal: per open goal, a thread owns more than SESSION_LOAD_MAX of its open steps, or more than
 * half of them when the goal has at least 4. A thread is another session the step names as its owner (a `thread:` link, a session id or name);
 * the chat's own steps, its subagents and the roots it started (`jobs`, ids or names from the job registry) never count.
 */
export function oneSessionLoad(views: readonly StepView[], jobs: readonly string[] = []): SessionLoad[] {
  const own = new Set(jobs);
  const goals = new Map<string, { goal: { id: string; text: string }; open: number; by: Map<string, { thread: { id: string; name: string }; steps: PlanItem[] }> }>();
  for (const view of views) {
    const goal = view.goal ?? { id: view.item.id, text: view.item.text };
    const entry = goals.get(goal.id) ?? { goal, open: 0, by: new Map() };
    goals.set(goal.id, entry);
    entry.open++;
    const owner = view.mine ? undefined : view.owner;
    if (!owner?.key.startsWith("thread:")) continue;
    const id = owner.key.slice("thread:".length);
    if (own.has(id) || own.has(owner.name)) continue;
    const held = entry.by.get(id) ?? { thread: { id, name: owner.name }, steps: [] };
    held.steps.push(view.item);
    entry.by.set(id, held);
  }
  return [...goals.values()].flatMap(({ goal, open, by }) => [...by.values()]
    .filter(held => held.steps.length > SESSION_LOAD_MAX || (open >= 4 && held.steps.length * 2 > open)).map(held => ({ goal, ...held, open })));
}
export const sessionLoadLine = ({ goal, thread, steps, open }: SessionLoad): string =>
  `${goal.id} ${quote(goal.text)} has ${steps.length} of its ${open} open steps on the ${clip(thread.name, 40)} thread (thread:${thread.id}): ` +
  `${steps.map(item => item.id).join(", ")}. Split these into your own jobs per part: map the parts and their order, start one job or subagent ` +
  "per part with rlm.spawn, set each step's job to it, and tell that thread it no longer owns them";

/** One entry of a session's `scheduled-jobs.json` (Prime Agent's schedules), as far as the check-in reads it. */
export interface ScheduledJob { id: string; source?: string; status?: string; label?: string; prompt?: string; schedule?: { expression?: string } }
/** `<home>/.prime/agent/session-artifacts/<chat id>/scheduled-jobs.json`, where Prime Agent keeps a session's heartbeats. */
export const heartbeatsFile = (chatId: string, home: string = homedir()): string => join(home, ".prime", "agent", "session-artifacts", chatId, "scheduled-jobs.json");
/** The schedules in a `scheduled-jobs.json`; none when the file is missing or unreadable. */
export function readHeartbeats(file: string): ScheduledJob[] {
  try {
    const jobs = (JSON.parse(readFileSync(file, "utf8")) as { jobs?: unknown }).jobs;
    return Array.isArray(jobs) ? jobs.filter((job): job is ScheduledJob => typeof job === "object" && job !== null && typeof (job as ScheduledJob).id === "string") : [];
  } catch {
    return [];
  }
}
/** Words in a heartbeat's label or prompt that name work the check-in already does: a check-in, the board, watching, monitoring, status, nudging. */
const CHECK_IN_WORK = /\bcheck[- ]?ins?\b|\bboard\b|\bwatch(?:er|ers|es|ing)?\b|\bmonitor(?:s|ing)?\b|\bstatus\b|\bnudge[sd]?\b|\bguides?\b|\bstall(?:s|ed)?\b|\bprogress\b/i;
/** The chat's own active rlm heartbeats whose label or prompt names check-in work: the check-in covers them. */
export const redundantHeartbeats = (jobs: readonly ScheduledJob[]): ScheduledJob[] =>
  jobs.filter(job => job.source === "rlm_heartbeat" && job.status === "active" && CHECK_IN_WORK.test(`${job.label ?? ""}\n${job.prompt ?? ""}`));
export const heartbeatLine = (job: ScheduledJob): string =>
  `heartbeat ${quote(job.label ?? job.id)}${job.schedule?.expression ? ` (${job.schedule.expression})` : ""}, ${quote((job.prompt ?? "").replace(/\s+/g, " "))}: ` +
  `the check-in covers this. Ask the chat to delete it in its own REPL with \`await rlm_heartbeat.delete("${job.id}")\``;
