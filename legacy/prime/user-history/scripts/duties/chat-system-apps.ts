import { OPEN, walk } from "../../src/checkin-steps.ts";
import type { DutyMetric, DutyRunRecord } from "../../src/shared/chat-duties.ts";
import { effectiveRun, metricStreaks, missStreak } from "../../src/shared/duty-streak.ts";
import type { ChatBoard, PlanItem } from "../../src/shared/types.ts";
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
}
/** One job of a chat as `GET /api/agents/:id/agents` lists it: its name and whether it works now. */
export interface AppsJobRow { name: string; state: string }
export interface AppsChat { id: string; name: string; board: ChatBoard | null; duties: AppsDutyRow[]; jobs: AppsJobRow[] }

type Get = (url: string) => Promise<unknown>;
const getJson: Get = async url => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json() as Promise<unknown>;
};

/** Every chat the :5184 app lists (not archived, no test agent) with its board, duties and jobs; `error` names the read that failed. */
export async function readAppsChats(base = BASE, get: Get = getJson): Promise<{ chats: AppsChat[]; error?: string }> {
  try {
    const agents = await get(`${base}/api/agents`) as { id: string; name: string; kind?: string; archived?: boolean }[];
    const chats = await Promise.all(agents.filter(agent => agent.kind === "chat" && !agent.archived).map(async (agent): Promise<AppsChat> => {
      const at = `${base}/api/agents/${encodeURIComponent(agent.id)}`;
      const [board, duties, jobs] = await Promise.all([get(`${at}/board`), get(`${at}/duties`), get(`${at}/agents`)]) as
        [{ board?: ChatBoard | null }, { duties?: AppsDutyRow[] }, { agents?: AppsJobRow[] }];
      return { id: agent.id, name: agent.name, board: board.board ?? null, duties: duties.duties ?? [], jobs: jobs.agents ?? [] };
    }));
    return { chats };
  } catch (error) {
    return { chats: [], error: error instanceof Error ? error.message : String(error) };
  }
}

const measured = (run: DutyRunRecord): boolean => { const verdict = effectiveRun(run).verdict; return verdict === "met" || verdict === "missed"; };

/**
 * A chat's active duties as d9's fleet reads a Prime chat's (`dutyFleet`): green by the newest reading (`verdictNow`), pending before the first
 * measured run, and for a red one its lead metric, its miss streak and its fix. A fix is an open step linked `<dutyId>/<metricKey>` whose job
 * works now, or that waits on a time still ahead (`waitUntil`) with a job named, as a Prime fix job asleep on its board.wake counts as live.
 * `stuck` marks a red duty with no fix and no duty job at work, unless it is red only on counts that age out.
 */
export function appsChatDuties(chat: AppsChat, now: number): FleetDuty[] {
  const working = new Set(chat.jobs.filter(job => job.state === "working").map(job => job.name));
  const steps: PlanItem[] = [];
  walk(chat.board?.plan ?? [], item => { steps.push(item); });
  const live = (item: PlanItem, link: string): boolean => OPEN.has(item.status) && item.duty === link && item.job !== undefined &&
    (working.has(item.job) || Date.parse(item.waitUntil ?? "") > now);
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
      if (entry.metric?.key === key) entry.metric.fix = { step: step.id, job: step.job!, live: true };
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
    `(duty field ${duty.duty}/${metric?.key ?? "<metricKey>"}) has a job at work or waiting on a time; sw factory runs this chat, so d9 counts it and sends no push`;
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
