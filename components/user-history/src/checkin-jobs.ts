import { CLOSED, type JobFact, OPEN, ownerLabel, quote, type StepView } from "./checkin-steps.ts";
import { zTime } from "./checkin-goals.ts";

/**
 * The check-in pushes the jobs the chat coordinates (owner 10-16: "incompetance in our check in logic that didn't push the coordinator job").
 * On 10-16 the "IG index gaps" chat's checklist sat at 0 of 3 for hours after its job "instagram index gaps" died at 00:19:57Z with "RLM
 * quiescence wait cancelled", and in the AI harness chat 9 jobs sat 1 to 3 hours with no progress and no report while its check-ins steered
 * none. Each run, a job of the chat with no progress for one check-in interval gets a nudge that says what it owes; after two intervals, or
 * when its last turn ended in an error, the server restarts it with that message. Progress is a report that carries a fact (`factsAt`) or a
 * change to a step it owns; activity alone is not. A job asleep on a board.wake, queued for a slot, or cancelled is left alone.
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
  coordinated: (fact: JobFact) => boolean, movedAt: (view: StepView) => number): { pushes: JobPush[]; memos: Record<string, JobMemo> } {
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
    if (fact.wake || fact.queued || (memo.pushed !== undefined && now - memo.pushed < everyMs && memo.pushed >= since)) return [];
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

/** The one line the chat gets about the pushes of a run; null when there were none. `failed` holds the jobs the server could not reach. */
export function jobPushLine(pushes: readonly JobPush[], failed: ReadonlySet<string> = new Set()): string | null {
  if (!pushes.length) return null;
  const done = pushes.filter(push => !failed.has(push.fact.key));
  const names = (act: JobAct) => done.filter(push => push.act === act).map(push => ownerLabel(push.fact));
  const parts = [
    ...names("restart").length ? [`restarted ${names("restart").join(", ")}`] : [],
    ...names("nudge").length ? [`nudged ${names("nudge").join(", ")}`] : [],
    ...failed.size ? [`could not reach ${pushes.filter(push => failed.has(push.fact.key)).map(push => ownerLabel(push.fact)).join(", ")}, so start a job in its place`] : [],
  ];
  return `Check-in: ${parts.join("; ")}, because nothing moved on their work.`;
}
