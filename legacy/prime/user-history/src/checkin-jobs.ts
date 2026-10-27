import { CLOSED, type JobFact, OPEN, ownerLabel, poolWait, quote, type StepView } from "./checkin-steps.ts";
import { zTime } from "./checkin-goals.ts";

/**
 * The check-in pushes the jobs the chat coordinates (owner 10-16: "incompetance in our check in logic that didn't push the coordinator job").
 * On 10-16 the "IG index gaps" chat's checklist sat at 0 of 3 for hours after its job "instagram index gaps" died at 00:19:57Z with "RLM
 * quiescence wait cancelled", and in the AI harness chat 9 jobs sat 1 to 3 hours with no progress and no report while its check-ins steered
 * none. Each run, a job of the chat with no progress for one check-in interval gets a nudge that says what it owes; after two intervals, or
 * when its last turn ended in an error, the server restarts it with that message. Progress is a report that carries a fact (`factsAt`) or a
 * change to a step it owns; activity alone is not. A job asleep on a board.wake, queued for a slot or holding one, or cancelled is left alone, and so is a job
 * the owner holds (`held.job`, a thread of a chat whose check-in he paused) or whose every open step he holds (`held.step`: For you, parked by
 * his correction, or a waitUntil still ahead). On 10-18 the old job "checkin pushes goals" owned 6 steps that all waited on For you t51 for
 * the owner's focus pause, and each check-in counted it as a job to push.
 */

/** What the check-in keeps per job: when its progress mark last moved, that mark, and when the check-in last pushed it. */
export interface JobMemo { mark: number; since: number; pushed?: number }
export type JobAct = "nudge" | "restart";
export interface JobPush { fact: JobFact; act: JobAct; idleMs: number; owes: string[]; why: string }

/**
 * The pushes of this run and the memos to keep. `coordinated` says which facts are the chat's own jobs (its subagents and the roots it
 * started); `movedAt` is when a step's record last moved (`recordedAt`).
 */
export function jobPushes(facts: readonly JobFact[], views: readonly StepView[], memos: Readonly<Record<string, JobMemo>> | undefined, everyMs: number, now: number,
  coordinated: (fact: JobFact) => boolean, movedAt: (view: StepView) => number,
  held: { job?: (fact: JobFact) => boolean; step?: (view: StepView) => boolean } = {}): { pushes: JobPush[]; memos: Record<string, JobMemo> } {
  const kept: Record<string, JobMemo> = {};
  const pushes = facts.flatMap((fact): JobPush[] => {
    if (!coordinated(fact) || fact.cancelled) return [];
    const owned = views.filter(view => view.owner?.key === fact.key && OPEN.has(view.item.status) && !CLOSED.has(view.item.status));
    if (fact.state !== "working" && !owned.length) return [];
    const mark = Math.max(fact.lastMessage?.factsAt ?? 0, ...owned.map(movedAt));
    const before = memos?.[fact.key];
    const since = !before ? mark || now : mark > before.mark ? mark : before.since;
    const memo: JobMemo = { mark, since, ...(before?.pushed !== undefined ? { pushed: before.pushed } : {}) };
    kept[fact.key] = memo;
    // A job waiting on the token pool, queued for a working slot, parked on a provider limit or in its turn (streaming or in a tool call) is not pushed, and the wait does
    // not count as time with no progress: a restart aborts the waiting model request and puts the job at the end of the queue again.
    if (poolWait(fact) || fact.slotPark || fact.queued || fact.parkedUntil !== undefined || fact.retrying || fact.inTurn) { memo.since = now; return []; }
    // A park Prime's wake dropped gets the resume pass's one continue first (resume_paused.py); a push comes only after a check-in interval
    // with no turn since, a real stall. 10-28: the AI harness check-in nudged "buzz ui study" while it was only queued.
    if (fact.parkDropped !== undefined && now - fact.parkDropped < everyMs) return [];
    if (fact.wake || (memo.pushed !== undefined && now - memo.pushed < everyMs && memo.pushed >= since)) return [];
    if (held.job?.(fact) || (owned.length && held.step && owned.every(held.step))) return [];
    const idleMs = now - since;
    const failed = fact.state === "failed" || (fact.state === "ended" && fact.error !== undefined);
    const act: JobAct | null = failed || idleMs >= 2 * everyMs ? "restart" : idleMs >= everyMs ? "nudge" : null;
    if (!act) return [];
    memo.pushed = now;
    const why = failed ? `its last turn ended in an error${fact.error ? ` (${fact.error.trim().slice(0, 80)})` : ""}`
      : `nothing moved for ${Math.round(idleMs / 60_000)} min, since ${zTime(since)}`;
    return [{ fact, act, idleMs, owes: owned.map(view => view.item.text), why }];
  });
  return { pushes, memos: kept };
}

/** What a job owes, in words: its open steps by title, at most two named. */
const owesText = (owes: readonly string[]): string => !owes.length ? "a report to the chat" :
  owes.length === 1 ? quote(owes[0]!) : `${quote(owes[0]!)} and ${owes.length - 1} more open ${owes.length === 2 ? "step" : "steps"}`;

/** The message the server sends the job: what it owes, why it is pushed, and the ask. */
export function jobPushMessage({ act, owes, why }: JobPush): string {
  const head = act === "restart" ? "The check-in restarted you" : "The check-in is checking on you";
  return `${head}: you owe ${owesText(owes)}, and ${why}. Send the chat what you have now with the numbers, then do the next action that moves it. ` +
    "If you are blocked, say on what in that report.";
}

/** The push results the chat receives. A failed request has unknown delivery: a restart can time out after its prompt was accepted. */
export function jobPushLine(pushes: readonly JobPush[], failed: ReadonlySet<string> = new Set()): string | null {
  if (!pushes.length) return null;
  const done = pushes.filter(push => !failed.has(push.fact.key));
  const unconfirmed = pushes.filter(push => failed.has(push.fact.key) && push.owes.length > 0);
  const names = (act: JobAct) => done.filter(push => push.act === act).map(push => ownerLabel(push.fact));
  const parts = [
    ...names("restart").length ? [`restarted ${names("restart").join(", ")}`] : [],
    ...names("nudge").length ? [`nudged ${names("nudge").join(", ")}`] : [],
  ];
  const sent = parts.length ? `${parts.join("; ")}, because nothing moved on their work.` : "";
  // mac-management 10-19 16:44Z: a failed push called four live jobs lost; email template made another tool call ten seconds later.
  const uncertain = unconfirmed.length ? `Could not confirm delivery to ${unconfirmed.map(({ fact }) => `${ownerLabel(fact)} (${fact.sessionId ?? fact.key})`).join(", ")}. ` +
    "The message may already be queued or accepted. Check each existing session's current state, queued messages, provider wait and recent progress before retrying; keep its session and model. " +
    "A delivery failure does not mean the job stopped. Resume the existing job when possible; replace it only after confirming it cannot be resumed and still owns unfinished work." : "";
  return sent || uncertain ? `Check-in: ${[sent, uncertain].filter(Boolean).join(" ")}` : null;
}
