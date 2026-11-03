import { homedir } from "node:os";
import { join } from "node:path";
import { OPEN, walk } from "../../src/checkin-steps.ts";
import type { DutyMetric, DutyRunRecord, DutySchedule } from "../../src/shared/chat-duties.ts";
import { effectiveRun, metricStreaks, missStreak } from "../../src/shared/duty-streak.ts";
import type { ChatBoard, PlanItem } from "../../src/shared/types.ts";
import { type OwnerReads, stepSessions, unmovedSteps, type WaitLinks, withDescendantActivity } from "../../src/unmoved-steps.ts";
import { pendingWakes, type Wake } from "../../src/wakes.ts";
import { BASE } from "./apps-chat.ts";
import { agingUntil, leadMetric, type FleetDuty, verdictNow } from "./duty-fleet.ts";

/**
 * The chats of the new chat app (apps/chat on :5184), which the Chat system duty (d9, chat-system.ts) counts beside the Prime chats. Since
 * 10-29 vent, seo, mcp and others run there, and their Prime copies sit paused. The d9 run at 07:14Z on 11-03 read only the Prime chats and
 * reported duties_green_pct 75 while :5184 showed vent d2, seo d1 and seo d2 red. sw factory runs those chats, so d9 counts them and sends them
 * no push (AI harness VP, 11-03).
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
/** The app's wakes folder (apps/chat server/wakes.ts, `<data dir>/wakes`), read only. */
export const APPS_WAKES_DIR = join(process.env.APPS_CHAT_DATA_DIR ?? join(homedir(), ".pi/agent/chat"), "wakes");

type Get = (url: string) => Promise<unknown>;
const getJson: Get = async url => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json() as Promise<unknown>;
};

/** Every chat the :5184 app lists (not archived, no test agent) with its board, duties and jobs; `error` names the read that failed. */
export async function readAppsChats(base = BASE, get: Get = getJson): Promise<{ chats: AppsChat[]; sessions: AppsSession[]; error?: string }> {
  try {
    const sessions = (await get(`${base}/api/conversations`) as AppsSession[]).filter(row => typeof row.id === "string");
    const agents = await get(`${base}/api/agents`) as { id: string; name: string; kind?: string; archived?: boolean; thread?: string; status?: string; updatedAt?: number }[];
    const chats = await Promise.all(agents.filter(agent => agent.kind === "chat" && !agent.archived).map(async (agent): Promise<AppsChat> => {
      const at = `${base}/api/agents/${encodeURIComponent(agent.id)}`;
      const [board, duties, jobs, checkIn] = await Promise.all([get(`${at}/board`), get(`${at}/duties`), get(`${at}/agents`), get(`${at}/check-in`)]) as
        [{ board?: ChatBoard | null }, { duties?: AppsDutyRow[] }, { agents?: AppsJobRow[] }, { everyMs?: number }];
      return { id: agent.id, name: agent.name, board: board.board ?? null, duties: duties.duties ?? [], jobs: jobs.agents ?? [],
        ...agent.thread ? { thread: agent.thread } : {}, working: agent.status === "working", ...agent.updatedAt ? { updatedAt: agent.updatedAt } : {},
        ...typeof checkIn.everyMs === "number" ? { everyMs: checkIn.everyMs } : {} };
    }));
    return { chats, sessions };
  } catch (error) {
    return { chats: [], sessions: [], error: error instanceof Error ? error.message : String(error) };
  }
}

const measured = (run: DutyRunRecord): boolean => { const verdict = effectiveRun(run).verdict; return verdict === "met" || verdict === "missed"; };

/**
 * A chat's active duties as d9's fleet reads a Prime chat's (`dutyFleet`): green by the newest reading (`verdictNow`), pending before the first
 * measured run, and for a red one its lead metric, its miss streak and its fix. A fix is an open step linked `<dutyId>/<metricKey>` whose job
 * works now or sleeps on a wake the app owes (`appsOwnerReads`), or that waits on a time still ahead (`waitUntil`) with a job named, as a Prime
 * fix job asleep on its board.wake counts as live, or that the chat itself watches (`heldByChat`).
 * `stuck` marks a red duty with no fix and no duty job at work, unless it is red only on counts that age out.
 */
export function appsChatDuties(chat: AppsChat, now: number, reads: AppsOwnerReads = appsOwnerReads(chat, [], [], now)): FleetDuty[] {
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
    const entry: FleetDuty = { chat: chat.id, duty: row.duty.id, name: row.duty.name, green: verdict === "met", misses: missStreak(own), stuck: false,
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

/** The d9 line of a :5184 red duty with no fix: what it misses and the duty field a fix step needs, with no ask, since d9 sends it no push. */
export function appsStuckLine(duty: FleetDuty, chatName: string): string {
  const metric = duty.metric;
  return `${chatName}: ${duty.name} (${duty.duty}) read off target in ${duty.misses === 1 ? "its last run" : `its last ${duty.misses} runs`}` +
    `${metric ? `, ${metric.key} ${metric.value} against ${metric.op} ${metric.target}` : ""}, and no open step linked to it ` +
    `(duty field ${duty.duty}/${metric?.key ?? "<metricKey>"}) has a job at work, asleep on a wake or waiting on a time; sw factory runs this chat, so d9 counts it and sends no push`;
}

const plainName = (name: string): string => name.replace(/[([][^)\]]*[)\]]/g, "").trim().toLowerCase();

/**
 * The Prime chats that moved to :5184, whose paused copies d9 stops counting so nothing counts twice: a Prime chat whose duties folder a :5184
 * chat's imported runs name (`importPrime` keeps each run's detail path, such as `browser-chat/duties/01a14dd5-.../d1-261028-0704.json`), or
 * whose name matches a :5184 chat's once tags like "(temp)" are dropped ("(temp) mcp" and "mcp").
 */
export function movedPrimeChats(apps: readonly AppsChat[], prime: ReadonlyMap<string, string>): Set<string> {
  const named = new Set(apps.map(chat => plainName(chat.name)));
  const cited = new Set(apps.flatMap(chat => chat.duties.flatMap(row => row.runs.flatMap(run => {
    const match = /browser-chat\/duties\/([0-9a-f-]{36})\//.exec(run.detail ?? "");
    return match ? [match[1]!] : [];
  }))));
  return new Set([...prime].filter(([id, name]) => cited.has(id) || named.has(plainName(name))).map(([id]) => id));
}

/** The share of green duties over the judged ones, floored to a tenth as `dutyFleet` floors it, so one red duty reads under 100. */
export function greenPct(duties: readonly Pick<FleetDuty, "green" | "pending">[]): number {
  const judged = duties.filter(duty => !duty.pending);
  return judged.length ? Math.floor(1000 * judged.filter(duty => duty.green).length / judged.length) / 10 : 100;
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

/** The wakes the app still owes, from its wakes folder. */
export const appsWakes = (now: number, dir = APPS_WAKES_DIR): Promise<Wake[]> => pendingWakes(dir, now);
