import { homedir } from "node:os";
import { join } from "node:path";
import type { AppsChat, AppsDutyRow, AppsJobRow, AppsSession } from "../../src/apps-step-owners.ts";
import type { ChatBoard } from "../../src/shared/types.ts";
import { pendingWakes, type Wake } from "../../src/wakes.ts";
import { BASE } from "./apps-chat.ts";
import type { FleetDuty } from "./duty-fleet.ts";

/**
 * The chats of the new chat app (apps/chat on :5184), which the Chat system duty (d9, chat-system.ts) counts beside the Prime chats. Since
 * 10-29 vent, seo, mcp and others run there, and their Prime copies sit paused. The d9 run at 07:14Z on 11-03 read only the Prime chats and
 * reported duties_green_pct 75 while :5184 showed vent d2, seo d1 and seo d2 red. sw factory runs those chats, so d9 counts them and sends them
 * no push (AI harness VP, 11-03).
 */

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

/** The wakes the app still owes, from its wakes folder. */
export const appsWakes = (now: number, dir = APPS_WAKES_DIR): Promise<Wake[]> => pendingWakes(dir, now);
