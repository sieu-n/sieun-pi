import { BRIEF_ITEMS } from "./shared/brief-cap.ts";
import { OPEN, walk } from "./checkin-steps.ts";
import { agingUntil } from "./duty-push.ts";
import type { DutyMetric, DutyRunRecord, DutySchedule } from "./shared/chat-duties.ts";
import { effectiveRun, leadMetric, metricStreaks, missStreak, type MetricStreak, verdictNow } from "./shared/duty-streak.ts";
import type { ChatBoard, PlanItem } from "./shared/types.ts";
import { type OwnerReads, stepSessions, unmovedLine, unmovedSteps, type WaitLinks, withDescendantActivity } from "./unmoved-steps.ts";
import type { Wake } from "./wakes.ts";

/**
 * Who owns each open step and red duty of a chat of the new chat app (apps/chat on :5184). The Chat system duty (d9, scripts/duties/chat-system.ts)
 * counts by these rules, and the app's own clock tells each chat what they find (apps/chat server/step-owners.ts), so the chat gives each one an
 * owner before d9 reads it. Until 11-03 only d9 read them: at 09:03Z it counted vent's p126 waiting on the release owner and chrome extension's p20
 * waiting on mac-management, each with no wake and no job, and no part of :5184 had told either chat.
 */

/** One duty as `GET /api/agents/:id/duties` lists it, with the fields d9 reads. */
export interface AppsDutyRow {
  duty: { id: string; name: string; status: string; metrics: DutyMetric[] };
  paused: boolean; running: boolean; runs: DutyRunRecord[];
  /** When its next scheduled run starts, and its schedule, which sets when the run after that one starts. */
  nextAt?: number; schedule?: DutySchedule;
}
/** One job of a chat as `GET /api/agents/:id/agents` lists it: its name, whether it works now, its session and its last write. */
export interface AppsJobRow { name: string; state: string; sessionId?: string; sender?: string; lastActivityAt?: string }
export interface AppsChat {
  id: string; name: string; board: ChatBoard | null; duties: AppsDutyRow[]; jobs: AppsJobRow[];
  /** The chat's own work thread, whether it works now and when it last wrote, as `GET /api/agents` lists it. */
  thread?: string; working?: boolean; updatedAt?: number;
  /** Its check-in interval (`GET /api/agents/:id/check-in`), which sets the live window its steps' owners get, as a Prime chat's does. */
  everyMs?: number;
}
/** One thread or job as `GET /api/conversations` lists it: its id (`<thread>` or `<thread>:<conversation>`), name, state, last write and parent. */
export interface AppsSession { id: string; name?: string; status?: string; lastActivityAt?: number; parent?: string }
/** A :5184 chat's active duty as d9's fleet reads it (`FleetDuty` in scripts/duties/duty-fleet.ts has the same fields). */
export interface AppsDuty {
  chat: string; duty: string; name: string; green: boolean; pending?: true; misses: number;
  metric?: MetricStreak; fix?: string; working?: string; agingUntil?: number; stuck: boolean;
}

const measured = (run: DutyRunRecord): boolean => { const verdict = effectiveRun(run).verdict; return verdict === "met" || verdict === "missed"; };

/**
 * A chat's active duties as d9's fleet reads a Prime chat's (`dutyFleet`): green by the newest reading (`verdictNow`), pending before the first
 * measured run, and for a red one its lead metric, its miss streak and its fix. A fix is an open step linked `<dutyId>/<metricKey>` whose job
 * works now or sleeps on a wake the app owes (`appsOwnerReads`), or that waits on a time still ahead (`waitUntil`) with a job named, as a Prime
 * fix job asleep on its board.wake counts as live, or that the chat itself watches (`heldByChat`).
 * `stuck` marks a red duty with no fix and no duty job at work, unless it is red only on counts that age out.
 */
export function appsChatDuties(chat: AppsChat, now: number, reads: AppsOwnerReads = appsOwnerReads(chat, [], [], now)): AppsDuty[] {
  const working = new Set(chat.jobs.filter(job => job.state === "working").map(job => job.name));
  const steps: PlanItem[] = [];
  walk(chat.board?.plan ?? [], item => { steps.push(item); });
  const awake = (item: PlanItem): boolean => stepSessions(item, reads.named).some(session => reads.live.has(session) || (reads.activity.get(session) ?? -Infinity) >= now) ||
    heldByChat(item, chat, reads.threadWakes, now);
  const live = (item: PlanItem, link: string): boolean => OPEN.has(item.status) && item.duty === link && (awake(item) ||
    (item.job !== undefined && (working.has(item.job) || Date.parse(item.waitUntil ?? "") > now)));
  return chat.duties.filter(row => !row.paused && row.duty.status === "active").map(row => {
    const runs = [...row.runs].sort((a, b) => b.at - a.at);
    const own = runs.filter(measured);
    const verdict = verdictNow(runs);
    const entry: AppsDuty = { chat: chat.id, duty: row.duty.id, name: row.duty.name, green: verdict === "met", misses: missStreak(own), stuck: false,
      ...verdict === undefined ? { pending: true as const } : {} };
    if (entry.green || entry.pending) return entry;
    const streaks = metricStreaks(own);
    const metric = leadMetric(row.duty.metrics, streaks);
    if (metric) Object.assign(entry, { metric: { ...metric }, misses: metric.misses });
    // A run's recorded fix is the :5184 card's, which names no step after its job ends, so the board's linked steps decide it here.
    delete entry.metric?.fix;
    const until = agingUntil(runs);
    if (until !== undefined && until > now) entry.agingUntil = until;
    for (const key of new Set([...metric ? [metric.key] : [], ...streaks.map(streak => streak.key)])) {
      const step = steps.find(item => live(item, `${row.duty.id}/${key}`));
      if (!step) continue;
      entry.fix = step.id;
      if (entry.metric?.key === key) entry.metric.fix = { step: step.id, ...step.job ? { job: step.job } : {}, live: true };
      break;
    }
    const job = runs.find(run => run.job)?.job;
    if (!entry.fix && (row.running || (job && working.has(job.name)))) entry.working = job?.name ?? "its duty run";
    entry.stuck = !entry.fix && !entry.working && entry.agingUntil === undefined;
    return entry;
  });
}

/**
 * A :5184 wake's session (`<thread>--<conversation>`, server/wakes.ts `wakeSession`) as the app's job rows name it: the thread alone for its
 * first conversation, a root job or the chat itself, and `<thread>:<conversation>` for a subagent in it.
 */
export const wakeRowSession = (session: string): string => {
  const at = session.lastIndexOf("--");
  const conversation = at > 0 ? Number(session.slice(at + 2)) : NaN;
  if (!Number.isInteger(conversation)) return session;
  return conversation === 1 ? session.slice(0, at) : `${session.slice(0, at)}:${conversation}`;
};


/**
 * A :5184 chat's owner reads, as `rowOwnerReads` builds a Prime chat's from its catalog row: the chat and each job wrote at its last activity,
 * or now while it works, each job's name and sender name its session, and a session asleep on a wake the app still owes is live.
 */
export function appsOwnerReads(chat: AppsChat, sessions: readonly AppsSession[], wakes: readonly Wake[], now: number): AppsOwnerReads {
  const activity = new Map<string, number>();
  const named = new Map<string, string[]>();
  const wrote = (session: string, at: number) => { if (Number.isFinite(at) && at > (activity.get(session) ?? -Infinity)) activity.set(session, at); };
  if (chat.thread) wrote(chat.thread, chat.working ? now : chat.updatedAt ?? NaN);
  // Every thread and job of the app, so a step owned by a root job (a solo thread no chat row lists) reads its job's last write.
  for (const row of sessions) wrote(row.id, row.status === "working" ? now : row.lastActivityAt ?? NaN);
  for (const job of chat.jobs) {
    if (job.sessionId === undefined) continue;
    wrote(job.sessionId, job.state === "working" ? now : Date.parse(job.lastActivityAt ?? ""));
    for (const name of new Set([job.name, job.sender])) if (name && !named.get(name)?.includes(job.sessionId)) named.set(name, [...named.get(name) ?? [], job.sessionId]);
  }
  // A job waiting on its own subagents moves its step while they work (`withDescendantActivity`).
  const parents = new Map(sessions.flatMap(row => row.parent ? [[row.id, row.parent] as const] : []));
  // A subagent of a job, at any depth below the chat, names its session too. At 09:16Z on 11-03 d9 counted agent factory's p72 and p73 stuck while
  // "fast agents list" and "fast accounts and usage", subagents of its d2 duty job, worked on them, since the chat's job rows list no subagent of a root job.
  const roots = new Set([chat.id, ...chat.thread ? [chat.thread] : []]);
  const below = (row: AppsSession): boolean => {
    const seen = new Set<string>();
    for (let up = row.parent; up !== undefined && !seen.has(up); up = parents.get(up)) { if (roots.has(up)) return true; seen.add(up); }
    return false;
  };
  for (const row of sessions) if (row.name && below(row) && !named.get(row.name)?.includes(row.id)) named.set(row.name, [...named.get(row.name) ?? [], row.id]);
  const threadWakes = chat.thread ? wakes.filter(wake => wake.session.startsWith(`${chat.thread}--`)) : [];
  return { activity: withDescendantActivity(activity, parents), live: new Set(wakes.map(wake => wakeRowSession(wake.session))), named, threadWakes };
}

/** A :5184 chat's owner reads with the wakes its own thread still owes, which hold a step their note names (`heldByChat`). */
export interface AppsOwnerReads extends OwnerReads { threadWakes: readonly Wake[] }

const SCHEDULE_MS = (schedule: DutySchedule): number => schedule.kind === "daily" ? 86_400_000 : schedule.minutes * 60_000;

/**
 * Whether the chat itself watches a step that names no job: a wake its own thread still owes names the step in its note or goes off at the
 * step's waitUntil, or the step is the fix of a red duty whose next run (or the run at work now) is the last one before the step's waitUntil,
 * since a missed run briefs its duty job with that fix step (apps/chat server/duty-run.ts `dutyJobBrief`). At 07:51Z on 11-03 d9 counted 6
 * such steps stuck: seo's p67, p68, p81 and p102 and vent's p117 slept on the chat thread's wakes, and vent's p123 (d2/old_model_calls_24h)
 * waited until 21:50Z for d2's 21:44Z run.
 */
export function heldByChat(item: PlanItem, chat: AppsChat, threadWakes: readonly Wake[], now: number): boolean {
  const until = Date.parse(item.waitUntil ?? "");
  const named = new RegExp(`\\b${item.id.replace(/[^\w-]/g, "")}\\b`);
  if (threadWakes.some(wake => named.test(wake.note) || (wake.on.kind === "time" && wake.on.at === until))) return true;
  if (!(until > now) || !item.duty) return false;
  const row = chat.duties.find(entry => item.duty!.startsWith(`${entry.duty.id}/`));
  if (!row || row.paused || row.duty.status !== "active" || verdictNow([...row.runs].sort((a, b) => b.at - a.at)) === "met") return false;
  if (row.running) return true;
  return row.nextAt !== undefined && row.schedule !== undefined && row.nextAt <= until && until < row.nextAt + SCHEDULE_MS(row.schedule);
}

/** The open steps of a :5184 chat that nobody moves, read as a paused Prime chat's are (`unmovedSteps`), with its own owner reads. */
export function appsStuckSteps(chat: AppsChat, reads: AppsOwnerReads, now: number, links?: WaitLinks): PlanItem[] {
  return unmovedSteps(chat.board, now, chat.everyMs, reads, links).filter(item => !heldByChat(item, chat, reads.threadWakes, now));
}

/** What nobody owns in a :5184 chat: its open steps nobody moves (`appsStuckSteps`) and its red duties with no live fix (`appsChatDuties` stuck). */
export interface AppsOwnerGaps { steps: PlanItem[]; duties: AppsDuty[]; reads: AppsOwnerReads }

export function appsOwnerGaps(chat: AppsChat, sessions: readonly AppsSession[], wakes: readonly Wake[], now: number, links?: WaitLinks): AppsOwnerGaps {
  const reads = appsOwnerReads(chat, sessions, wakes, now);
  return { steps: appsStuckSteps(chat, reads, now, links), duties: appsChatDuties(chat, now, reads).filter(duty => duty.stuck), reads };
}

/** A key that changes when the set of gaps changes, so a chat is told a new gap at once and the same ones again only after its live window. */
export const appsGapsKey = ({ steps, duties }: Pick<AppsOwnerGaps, "steps" | "duties">): string =>
  [...steps.map(step => step.id), ...duties.map(duty => duty.duty)].join(",");

/** One red duty with no fix in a notice: what it misses and the `duty` field its fix step needs. */
export function appsDutyLine(duty: AppsDuty): string {
  const metric = duty.metric;
  return `${duty.duty} "${duty.name}" is red${metric ? `, ${metric.key} ${metric.value} against ${metric.op} ${metric.target}` : ""}, and no open step ` +
    `with duty ${duty.duty}/${metric?.key ?? "<metricKey>"} has a job at work, a wake or a waitUntil before its next run`;
}

/**
 * The turn a :5184 chat gets for what nobody owns (`appsOwnerGaps`), with the moves the d9 rules credit: a job named in the step's job field, a
 * board.wake of the chat whose note names the step, the other chat's step that carries the wait, an open For you todo, or closing the step.
 */
export function appsOwnerNotice(gaps: AppsOwnerGaps, windowMs: number): string {
  const lines = [...gaps.steps.map(step => unmovedLine(step, gaps.reads)), ...gaps.duties.map(appsDutyLine)];
  const rest = lines.length - BRIEF_ITEMS;
  const listed = [...lines.slice(0, BRIEF_ITEMS), ...rest > 0 ? [`and ${rest} more`] : []];
  return `[board] Nobody owns these, so the Chat system duty (d9) counts them stuck: ${listed.join("; ")}. ` +
    `You are told again every ${Math.round(windowMs / 60_000)} min while they stay this way. Give each one an owner this turn. ` +
    "For work, start a job and put its name in the step's job field. For a wait on another chat, a release or a box, set a board.wake on the thing " +
    "it waits for (check=, run= or at=) with the step id in its note, such as note=\"p12: release owner ships 1159418d29\". When another chat's open " +
    "step carries the wait, write it as \"<chat name>'s p123\" in waitFor. Link a wait on the owner to its open For you todo, or close the step " +
    "with its evidence. A red duty needs an open step whose duty field is <dutyId>/<metricKey>, with a job at work on it.";
}
