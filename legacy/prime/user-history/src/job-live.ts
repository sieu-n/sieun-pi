import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { tailLines } from "./cut-end.ts";
import { waking } from "./wakes.ts";
import { BRIEFS_DIR, owedBrief } from "./brief-keeper.ts";

/**
 * Why a session that does not work now is about to run, else null: a board.wake the chat service still holds for it, a run of it waiting in
 * pi-pool's turn queue (`queued`, or `kept` on an account wait), or a continue the watchdog sent it within RESENT_MS. The first two are the
 * state the watchdog checks before it calls a subagent wedged (components/watchdog/wd_common.py pending_wake and pool_queued, 3a8746c2), so
 * the alert bridge and the watchdog read a waiting job the same way.
 *
 * On 10-25 the watchdog stopped alert triage Crawler VP 07:43 (01a1753b) and sent it a continue at 23:49:35Z, the bridge read it as ended
 * at 23:50:07Z, and the continue's run reached pi-pool's queue at 23:50:12Z. The bridge started a second job, 08:50, on the same fires.
 */
export interface LivePaths { wakes: string; turns: string; watchdogLog: string; briefs?: string }

export const livePaths = (dataDir: string, home = homedir()): LivePaths => ({ wakes: join(dataDir, "wakes"), briefs: join(dataDir, BRIEFS_DIR),
  turns: join(process.env.PI_POOL_DIR || join(home, ".config/pi-pool"), "turns.json"), watchdogLog: join(home, ".prime/agent/watchdog/log.jsonl") });

/**
 * How long a watchdog continue counts as landing. Its run took 37 s to reach pi-pool's queue on 10-25 (23:49:35Z to 23:50:12Z), with a load
 * of 147.6 and 70.95 GiB of swap in use (watchdog cron.jsonl at 23:50:13Z). A run in the queue counts by itself.
 */
export const RESENT_MS = 5 * 60_000;
/** The watchdog log's tail to read: the log grew 14.6 MB from 10-18 to 10-25, about 13 KB per 10 min, so 256 KB holds some 3 h. */
const LOG_TAIL_BYTES = 256 * 1024;

/** Whether pi-pool's turns.json holds a run of `session` waiting for a slot (`queued`) or kept for its account wait (`kept`). */
export async function poolHolds(turnsFile: string, session: string): Promise<boolean> {
  try {
    const turns = JSON.parse(await readFile(turnsFile, "utf8")) as { queued?: Record<string, unknown>; kept?: Record<string, unknown> };
    return [turns.queued, turns.kept].some(part => part !== null && typeof part === "object" && session in part);
  } catch { return false; }
}

/** When the watchdog last sent `session` a message it took (send_rc 0) at or after `since`, from its log's tail, else null. */
export async function watchdogSent(logFile: string, session: string, since: number): Promise<number | null> {
  let latest: number | null = null;
  for (const line of await tailLines(logFile, LOG_TAIL_BYTES).catch(() => [] as string[])) {
    if (!line.includes(session)) continue;
    let entry: { sid?: unknown; method?: unknown; send_rc?: unknown; at?: unknown };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.sid !== session || entry.send_rc !== 0 || typeof entry.method !== "string" || !entry.method.includes("send") || typeof entry.at !== "string") continue;
    const at = Date.parse(entry.at);
    if (at >= since && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

export async function jobLive(paths: LivePaths, session: string, now: number): Promise<string | null> {
  if (await waking(paths.wakes, session)) return "its board.wake is pending";
  if (await poolHolds(paths.turns, session)) return "its run waits in pi-pool's turn queue";
  // A job the chat service started whose brief the keeper still owes or sent within RESENT_MS (brief-keeper.ts `serviceBriefs`): on 10-27
  // the bridge read 01a17dd0 as ended at 16:49:42Z, 48 s after the supervisor restart lost its brief, and started a second triage job.
  const owed = paths.briefs ? await owedBrief(paths.briefs, session, now, RESENT_MS) : null;
  if (owed) return owed.sent ? `the brief keeper sent it its lost brief at ${new Date(owed.sent.at).toISOString().slice(11, 19)}Z` : "the brief keeper still owes it its brief";
  const sent = await watchdogSent(paths.watchdogLog, session, now - RESENT_MS);
  return sent === null ? null : `the watchdog sent it a continue at ${new Date(sent).toISOString().slice(11, 19)}Z`;
}
