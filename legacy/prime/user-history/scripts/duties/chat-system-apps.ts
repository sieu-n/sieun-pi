import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppsChat, AppsDutyRow, AppsJobRow, AppsSession } from "../../src/apps-step-owners.ts";
import type { ChatBoard } from "../../src/shared/types.ts";
import { owedWakes, parseWake, pendingWakes, TICKED, type Wake } from "../../src/wakes.ts";
import { BASE } from "./apps-chat.ts";
import type { FleetDuty } from "./duty-fleet.ts";

/**
 * The chats of the new chat app (apps/chat on :5184), which the Chat system duty (d9, chat-system.ts) counts beside the Prime chats. Since
 * 10-29 vent, seo, mcp and others run there, and their Prime copies sit paused. The d9 run at 07:14Z on 11-03 read only the Prime chats and
 * reported duties_green_pct 75 while :5184 showed vent d2, seo d1 and seo d2 red. sw factory runs those chats, so d9 counts them and sends them
 * no push (AI harness VP, 11-03).
 */

/** The app's data dir, read only. */
export const APPS_DATA_DIR = process.env.APPS_CHAT_DATA_DIR ?? join(homedir(), ".pi/agent/chat");
/** The app's wakes folder (apps/chat server/wakes.ts, `<data dir>/wakes`), which keeps the wakes until the app moves them into chat.sqlite. */
export const APPS_WAKES_DIR = join(APPS_DATA_DIR, "wakes");

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
 * The wakes the app still owes: chat.sqlite's `wakes` rows once the app moved its wakes there (a `wakes` row of db_kinds with imported_at, as
 * apps/chat server/chat-records.ts `movedKinds` reads it), else the wakes folder's files. The folder's `.ticked` stamp counts either way.
 */
export async function appsWakes(now: number, dataDir = APPS_DATA_DIR): Promise<Wake[]> {
  const rows = wakeRows(join(dataDir, "chat.sqlite"));
  if (!rows) return pendingWakes(join(dataDir, "wakes"), now);
  const ticked = Date.parse(await readFile(join(dataDir, "wakes", TICKED), "utf8").catch(() => ""));
  return owedWakes(rows, Number.isFinite(ticked) ? ticked : undefined, now);
}

/** The wakes in the app's chat.sqlite, or null while the app keeps them as files. */
function wakeRows(file: string): Wake[] | null {
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM db_kinds WHERE kind = 'wakes' AND imported_at IS NOT NULL").get()) return null;
    return (db.prepare("SELECT body FROM wakes ORDER BY id").all() as { body: string }[]).flatMap(row => parseWake(JSON.parse(row.body)) ?? []);
  } catch (error) {
    if (/no such table: db_kinds/.test(String((error as Error).message))) return null;
    throw error;
  } finally {
    db.close();
  }
}
