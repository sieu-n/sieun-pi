import { PROGRESS_MS } from "./checkin-findings.ts";
import { type JobFact, OPEN, quote } from "./checkin-steps.ts";
import { noticeStands } from "./no-report.ts";
import { JOB_NOTICE_PREFIX } from "./shared/chat-feed.ts";

/**
 * A job at work on an open step that sent its chat no report for PROGRESS_MS, the no-progress window: since its last message to the chat or since
 * it started working (`workingSince`, by child id), whichever is later. A thread owner is left out, since its chat reads its transcript, and so is a
 * job the server has not seen start, and a job asleep on a board.wake (`JobFact.wake`), which the ask would wake. Chat health 10-13: in 27 of the 32 hours that counted in no_progress_hours, a step the check-in listed as moving
 * had a job at work that had not reported for the hour, and the check-in job, a root session, cannot message the chat's subagents.
 */
export type StepJob = JobFact & { item: NonNullable<JobFact["item"]> };
export function silentJobs(facts: readonly JobFact[], workingSince: (key: string) => number | undefined, now: number): StepJob[] {
  return facts.filter((fact): fact is StepJob => {
    const started = workingSince(fact.key);
    if (fact.state !== "working" || fact.wake !== undefined || fact.key.startsWith("thread:") || !fact.item || !OPEN.has(fact.item.status) || started === undefined) return false;
    return now - Math.max(started, fact.lastMessage?.at ?? 0) >= PROGRESS_MS;
  });
}

/** The ask the chat sends a silent job: the answer should carry facts (commits, runs, counts), since only a report with one moves its goal. */
export const STATUS_ASK = "Status check: in 2 or 3 lines, what you finished since your last report, with its commits, runs or counts, and what is next.";
/**
 * The server's line to the chat for a silent job (`silentJobs`), the same text for the whole silence, so `noticeStands` sends it once until the job
 * next messages the chat.
 */
export const statusAskLine = (fact: StepJob): string =>
  `${JOB_NOTICE_PREFIX}${fact.name} has worked on ${fact.item.id} ${quote(fact.item.text)} for over an hour with no report: send it one short status ask now with ` +
  `\`await agent_message.send(${JSON.stringify(STATUS_ASK)}, receiver_role="child", receiver_name=${JSON.stringify(fact.name)})\`, end your turn, and put the facts ` +
  `it answers in ${fact.item.id}'s note`;

/**
 * The status-ask lines the server steers into the chat at a check-in: one per silent job (`silentJobs`), left out while the chat already holds
 * it with no message from the job after it (`noticeStands`), so a silence gets one ask, also across restarts.
 */
export const statusAsks = (messages: Parameters<typeof noticeStands>[0], facts: readonly JobFact[], workingSince: (key: string) => number | undefined, now: number): string[] =>
  silentJobs(facts, workingSince, now).flatMap(fact => { const line = statusAskLine(fact); return noticeStands(messages, fact.name, line) ? [] : [line]; });
